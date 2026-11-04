//! Asking: a line, a secret, the device passphrase (remembered, from the environment, or typed).

use std::io::{BufRead, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, bail};
use plim_core::crypto::unlock_seed;

use crate::config::Device;
use crate::keychain;

/// Read a line; from the terminal with a visible prompt, or plain stdin when piped.
pub(crate) fn prompt_line(label: &str) -> Result<String> {
    if std::io::stdin().is_terminal() {
        eprint!("{label}");
        std::io::stderr().flush()?;
    }
    let mut s = String::new();
    std::io::stdin().lock().read_line(&mut s)?;
    Ok(s.trim_end_matches(['\n', '\r']).to_string())
}

/// Set once stdin has been consumed as note content (`plim add` with piped text).
pub(crate) static STDIN_IS_DATA: AtomicBool = AtomicBool::new(false);

/// Read a secret without echo on a terminal; plain stdin when piped (scripts,
/// tests). If stdin carries note content, ask on the controlling terminal.
pub(crate) fn prompt_secret(label: &str) -> Result<String> {
    if std::io::stdin().is_terminal() || STDIN_IS_DATA.load(Ordering::Relaxed) {
        rpassword::prompt_password(label).context("no terminal to ask for the passphrase on (set PLIM_PASSPHRASE)")
    } else {
        prompt_line(label)
    }
}

/// Where the device passphrase came from: a wrong one from the keychain says so, not "wrong passphrase".
#[derive(PartialEq)]
enum PassFrom {
    Env,
    Remembered,
    Typed,
}

/// The device passphrase: `PLIM_PASSPHRASE` (or `TIRO_PASSPHRASE`) for automation, then the one
/// remembered on this machine (`plim remember`, #360), otherwise a prompt.
fn device_passphrase(account_id: &str) -> Result<(String, PassFrom)> {
    if let Some(p) = crate::config::env("PASSPHRASE") {
        return Ok((p, PassFrom::Env));
    }
    if let Some((_, p)) = keychain::get(account_id) {
        return Ok((p, PassFrom::Remembered));
    }
    Ok((prompt_secret("Device passphrase: ")?, PassFrom::Typed))
}

/// The seed, unlocked with the device passphrase; a remembered one that no longer opens it
/// (the device signed in again with another) is asked for instead, on a terminal.
pub(crate) async fn unlock_device(device: &Device) -> Result<Vec<u8>> {
    let (passphrase, from) = device_passphrase(&device.account_id)?;
    let try_unlock = |passphrase: String| {
        let locked = device.locked_seed();
        tokio::task::spawn_blocking(move || unlock_seed(&locked?, &passphrase).map_err(|_| anyhow::anyhow!("wrong passphrase")))
    };
    match try_unlock(passphrase).await? {
        Err(_) if from == PassFrom::Remembered => {
            if !std::io::stdin().is_terminal() {
                bail!("the passphrase remembered on this machine doesn't open this device's key — run `plim remember`");
            }
            eprintln!("The passphrase remembered on this machine doesn't open this device's key (run `plim remember` to update it).");
            try_unlock(prompt_secret("Device passphrase: ")?).await?
        }
        r => r,
    }
}

/// After signing in on a terminal: offer to remember the passphrase, so plim stops asking.
pub(crate) fn offer_to_remember(account_id: &str, passphrase: &str) -> Result<()> {
    if !std::io::stdin().is_terminal() {
        return Ok(());
    }
    let answer = prompt_line("Remember the passphrase on this machine, so plim doesn't ask for it? [Y/n] ")?;
    if answer.trim().is_empty() || answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes") {
        match keychain::set(account_id, passphrase) {
            Ok(store) => eprintln!("Remembered {}. `plim remember --off` forgets it.", store.describe()),
            Err(e) => eprintln!("Not remembered: {e}. plim will ask for it."),
        }
    }
    Ok(())
}

pub(crate) fn new_device_passphrase() -> Result<String> {
    if std::io::stdin().is_terminal() {
        eprintln!("\nChoose a device passphrase. It encrypts your key on this machine only;");
        eprintln!("anyone with this machine and the passphrase can open your notes.");
    }
    loop {
        let a = prompt_secret("Device passphrase: ")?;
        if a.chars().count() < 8 {
            eprintln!("Use at least 8 characters.");
            continue;
        }
        if std::io::stdin().is_terminal() && prompt_secret("Repeat it: ")? != a {
            eprintln!("Passphrases don't match.");
            continue;
        }
        return Ok(a);
    }
}

