//! Signing in and out: `plim init`, `login`, `remember`, `logout`, `delete-account`.

use std::io::IsTerminal;

use anyhow::{Result, bail};
use plim_core::crypto::{self, generate_mnemonic, lock_seed, mnemonic_to_seed, parse_mnemonic, unlock_seed};

use crate::api::{Api, ApiError};
use crate::config::{self, Device};
use crate::prompt::{new_device_passphrase, offer_to_remember, prompt_line, prompt_secret};
use crate::session::{create_account, identity_from_seed};
use crate::vault::open_session;
use crate::{keychain, store};

pub(crate) async fn init(server: Option<&str>) -> Result<()> {
    if config::load_device()?.is_some() {
        bail!("this device is already signed in — run `plim logout` first");
    }
    let phrase = generate_mnemonic();
    let words: Vec<&str> = phrase.split(' ').collect();
    let tty = std::io::stdin().is_terminal();
    if tty {
        eprintln!("Your recovery phrase — these 12 words ARE your account. Write them down in order.");
        eprintln!("Anyone with them can read your notes; if you lose them, nobody can recover your notes.\n");
        for row in words.chunks(4).enumerate() {
            let line: Vec<String> =
                row.1.iter().enumerate().map(|(i, w)| format!("{:>2}. {:<10}", row.0 * 4 + i + 1, w)).collect();
            eprintln!("  {}", line.join(" "));
        }
        eprintln!();
        prompt_line("Press Enter once you've written them down…")?;
        eprint!("\x1b[2J\x1b[3J\x1b[H"); // clear the screen, and the scrollback where it's honoured, so the words don't linger
        let mut picks: Vec<usize> = Vec::new();
        while picks.len() < 3 {
            let i = crypto::random_bytes::<1>()[0] as usize % 12;
            if !picks.contains(&i) {
                picks.push(i);
            }
        }
        picks.sort();
        for i in picks {
            let answer = prompt_line(&format!("Word #{}: ", i + 1))?;
            if answer.trim().to_lowercase() != words[i] {
                bail!("that doesn't match — nothing was created; run `plim init` again");
            }
        }
    } else {
        // Non-interactive (scripts/tests): print the phrase to stdout.
        println!("{phrase}");
    }
    let passphrase = new_device_passphrase()?;
    let seed = mnemonic_to_seed(&phrase)?;
    let identity = identity_from_seed(&seed);
    let server_url = config::server_url(server, None);
    let api = Api::new(&server_url);
    eprintln!("Creating your vault on {server_url} (a few seconds of proof-of-work)…");
    let account_id = create_account(&api, &identity).await?;
    save_device(&server_url, &account_id, &identity.pubkey_hash, seed.to_vec(), passphrase.clone()).await?;
    offer_to_remember(&account_id, &passphrase)?;
    eprintln!("Done. Run `plim` to start writing.");
    Ok(())
}

pub(crate) async fn login(server: Option<&str>) -> Result<()> {
    if config::load_device()?.is_some() {
        bail!("this device is already signed in — run `plim logout` first");
    }
    let phrase = prompt_secret("Recovery phrase (12 words): ")?;
    parse_mnemonic(&phrase)?;
    let seed = mnemonic_to_seed(&phrase)?;
    let identity = identity_from_seed(&seed);
    let server_url = config::server_url(server, None);
    let api = Api::new(&server_url);
    let login = api.login(&identity).await.map_err(|e| match e {
        ApiError::Http(401, _) => anyhow::anyhow!("no vault found for this phrase on {server_url}"),
        e => e.into(),
    })?;
    let passphrase = new_device_passphrase()?;
    save_device(&server_url, &login.account_id, &identity.pubkey_hash, seed.to_vec(), passphrase.clone()).await?;
    offer_to_remember(&login.account_id, &passphrase)?;
    eprintln!("Signed in. Run `plim` to open your notes.");
    Ok(())
}

/// `plim remember` (#360): the passphrase, checked against this device's key, kept on this machine;
/// `--off` forgets it.
pub(crate) async fn remember(off: bool) -> Result<()> {
    let device = config::require_device()?;
    if off {
        let was = keychain::forget(&device.account_id);
        eprintln!("{}", if was { "Forgotten: plim will ask for the passphrase." } else { "Nothing was remembered on this machine." });
        return Ok(());
    }
    let passphrase = match crate::config::env("PASSPHRASE") {
        Some(p) => p,
        None => prompt_secret("Device passphrase: ")?,
    };
    let locked = device.locked_seed()?;
    let check = passphrase.clone();
    tokio::task::spawn_blocking(move || unlock_seed(&locked, &check).map_err(|_| anyhow::anyhow!("wrong passphrase"))).await??;
    let store = keychain::set(&device.account_id, &passphrase)?;
    eprintln!("Remembered {}. plim won't ask for it here; `plim remember --off` forgets it.", store.describe());
    Ok(())
}

pub(crate) async fn save_device(server: &str, account_id: &str, pubkey_hash: &str, seed: Vec<u8>, passphrase: String) -> Result<()> {
    let locked = tokio::task::spawn_blocking(move || lock_seed(&seed, &passphrase)).await?;
    config::save_device(&Device::new(server, account_id, pubkey_hash, &locked))
}

pub(crate) fn logout(force: bool) -> Result<()> {
    let Some(device) = config::load_device()? else {
        eprintln!("Not signed in.");
        return Ok(());
    };
    let db = config::paths()?.data.join(format!("{}.db", device.account_id));
    if !force && db.exists() && !store::Store::open(&db)?.outbox_docs()?.is_empty() {
        bail!("some edits haven't been uploaded yet — run `plim ls` while online first, or use --force to discard them");
    }
    config::remove_device()?;
    keychain::forget(&device.account_id);
    eprintln!("Signed out. Your recovery phrase is still needed to sign in again.");
    Ok(())
}

/// Remove plim from this machine: its config (the signed-in device's key) and data (the local
/// copies, the editor's scratch), the passphrase remembered in the keychain, the scratch folder
/// under XDG_RUNTIME_DIR, and the binary itself (`exe`; on Linux and macOS a running program's
/// file can be removed). The notes stay on the server, for the recovery phrase.
pub(crate) fn uninstall(yes: bool, exe: Option<std::path::PathBuf>) -> Result<()> {
    let paths = config::paths()?;
    let device = config::load_device().ok().flatten();
    let scratch = std::env::var("XDG_RUNTIME_DIR").ok().filter(|d| !d.is_empty()).map(|d| std::path::PathBuf::from(d).join("plim"));
    let exe = exe.and_then(|p| p.canonicalize().ok());
    eprintln!("This removes plim from this machine:");
    for (what, path) in [("its config", Some(&paths.config)), ("its data", Some(&paths.data)), ("its scratch folder", scratch.as_ref()), ("the program", exe.as_ref())] {
        if let Some(p) = path.filter(|p| p.exists()) {
            eprintln!("  - {what}: {}", p.display());
        }
    }
    if let Some(d) = &device {
        eprintln!("  - the passphrase remembered for the account signed in here, if any");
        eprintln!("Your notes stay on the server ({}): your recovery phrase opens them.", d.server);
    }
    if !yes {
        if !std::io::stdin().is_terminal() {
            bail!("not a terminal: pass --yes to go ahead");
        }
        if prompt_line("Remove it all? [y/N] ")?.trim().to_ascii_lowercase() != "y" {
            bail!("nothing removed");
        }
    }
    if let Some(d) = &device {
        keychain::forget(&d.account_id);
    }
    for p in [Some(&paths.config), Some(&paths.data), scratch.as_ref()].into_iter().flatten() {
        if p.exists() {
            std::fs::remove_dir_all(p).map_err(|e| anyhow::anyhow!("removing {}: {e}", p.display()))?;
        }
    }
    if let Some(p) = &exe {
        if let Err(e) = std::fs::remove_file(p) {
            eprintln!("Couldn't remove the program itself ({e}): rm {}", p.display());
        }
    }
    eprintln!("Removed. If you added {} to your PATH for plim, that line is yours to take out.", exe.and_then(|p| p.parent().map(|d| d.display().to_string())).unwrap_or_else(|| "its folder".into()));
    Ok(())
}

/// Delete the account (#51): what goes, typed confirmation, then the server's
/// copy and this device's (its saved key and local copy).
pub(crate) async fn delete_account(server: Option<&str>) -> Result<()> {
    let sess = open_session(server).await?;
    eprintln!("This deletes, from the server and for good:");
    eprintln!("  - all your notes, and their history");
    eprintln!("  - the notes you've shared: their links stop working for everyone");
    eprintln!("  - your passkeys' sign-in, and every device's session");
    eprintln!("It can't be undone. Passkeys stay in your password manager: delete them there.");
    if prompt_line("Type DELETE to confirm: ")?.trim() != "DELETE" {
        bail!("not deleted");
    }
    sess.api.delete_account(&sess.identity, &sess.account_id).await?;
    let account_id = sess.account_id.clone();
    drop(sess); // (closes the local database before it's removed)
    let db = config::paths()?.data.join(format!("{account_id}.db"));
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
    }
    config::remove_device()?;
    keychain::forget(&account_id);
    eprintln!("Your account was deleted, and this device signed out.");
    Ok(())
}

