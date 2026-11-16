//! Where this machine keeps its secrets: the device's key (the seed its signing key and vault key
//! come from) and, after `plim mcp setup`, the local MCP connection's secret. There's no device
//! passphrase (before 0.22.0 there was, and `plim remember`).
//!
//! Where a keychain is running (Secret Service on Linux: GNOME Keyring, KWallet, KeePassXC; the
//! Keychain on macOS) they're kept there, unlocked with your login. A machine without one (a
//! headless server, a container) keeps them in files only you can read, as an SSH key without a
//! passphrase is: `<data>/<account>.key` (and `.mcp.key`), mode 0600, refused if anyone else
//! can read them. `PLIM_CREDENTIALS_STORE=keychain` or `=file` picks one instead of the first
//! that works.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::config;

/// The keyring's service name.
const SERVICE: &str = "plim";

/// Where a secret is kept (the device file says which, for its key).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Store {
    Keychain,
    File,
}

/// Which secret.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// The device's key: the seed.
    Device,
    /// The local MCP connection (`plim mcp setup`): its id and secret.
    Mcp,
}

impl Kind {
    fn suffix(self) -> &'static str {
        match self {
            Kind::Device => "key",
            Kind::Mcp => "mcp",
        }
    }
}

/// Where, in words: "in this machine's keychain", "in ~/.local/share/plim/….key".
pub fn describe(store: Store, account_id: &str, kind: Kind) -> String {
    match store {
        Store::Keychain => "in this machine's keychain".into(),
        Store::File => match file_path(account_id, kind) {
            Ok(p) => format!("in {} (readable only by you)", p.display()),
            Err(_) => "in a file only you can read".into(),
        },
    }
}

/// The store `PLIM_CREDENTIALS_STORE` asks for, if it does.
fn forced() -> Result<Option<Store>> {
    match config::env("CREDENTIALS_STORE").as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some("keychain") => Ok(Some(Store::Keychain)),
        Some("file") => Ok(Some(Store::File)),
        Some(other) => bail!("PLIM_CREDENTIALS_STORE is \"{other}\": it's keychain or file"),
    }
}

/// Keep a secret: in the store asked for, else the keychain, else a file. Where it went.
pub fn put(account_id: &str, kind: Kind, secret: &[u8]) -> Result<Store> {
    let text = B64.encode(secret);
    match forced()? {
        Some(Store::Keychain) => {
            keychain_put(account_id, kind, &text)?;
            Ok(Store::Keychain)
        }
        Some(Store::File) => {
            file_put(account_id, kind, &text)?;
            Ok(Store::File)
        }
        None => match keychain_put(account_id, kind, &text) {
            Ok(()) => Ok(Store::Keychain),
            Err(_) => {
                file_put(account_id, kind, &text)?;
                Ok(Store::File)
            }
        },
    }
}

/// A secret kept in `store`.
pub fn get(store: Store, account_id: &str, kind: Kind) -> Result<Vec<u8>> {
    let text = match store {
        Store::Keychain => entry(account_id, kind)?.get_password().map_err(|e| anyhow::anyhow!("not in this machine's keychain ({e})"))?,
        Store::File => file_get(account_id, kind)?,
    };
    B64.decode(text.trim()).context("what's kept isn't readable")
}

/// A secret, wherever it's kept (the store asked for, else the keychain, then a file): where, and it.
pub fn find(account_id: &str, kind: Kind) -> Result<Option<(Store, Vec<u8>)>> {
    let stores = match forced()? {
        Some(s) => vec![s],
        None => vec![Store::Keychain, Store::File],
    };
    for store in stores {
        let here = match store {
            Store::Keychain => entry(account_id, kind).is_ok_and(|e| e.get_password().is_ok()),
            Store::File => file_path(account_id, kind).is_ok_and(|p| p.exists()),
        };
        if here {
            return Ok(Some((store, get(store, account_id, kind)?)));
        }
    }
    Ok(None)
}

/// Forget a secret wherever it might be; whether it was anywhere.
pub fn forget(account_id: &str, kind: Kind) -> bool {
    let in_keychain = entry(account_id, kind).is_ok_and(|e| e.delete_credential().is_ok());
    let in_file = file_path(account_id, kind).is_ok_and(|p| fs::remove_file(p).is_ok());
    in_keychain || in_file
}

/// Everything kept for an account: its key, its MCP connection, and the passphrase older
/// versions remembered (under the account's id alone).
pub fn forget_all(account_id: &str) {
    forget(account_id, Kind::Device);
    forget(account_id, Kind::Mcp);
    if let Ok(e) = Entry::new(SERVICE, account_id) {
        let _ = e.delete_credential();
    }
}

fn entry(account_id: &str, kind: Kind) -> Result<Entry> {
    let user = format!("{account_id}:{}", kind.suffix());
    #[cfg(target_os = "linux")]
    {
        use keyring::secret_service::SsCredential;
        let c = SsCredential::new_with_target(None, SERVICE, &user)?;
        Ok(Entry::new_with_credential(Box::new(c)))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(Entry::new(SERVICE, &user)?)
    }
}

fn keychain_put(account_id: &str, kind: Kind, text: &str) -> Result<()> {
    entry(account_id, kind)?.set_password(text).map_err(|e| anyhow::anyhow!("this machine's keychain didn't take it ({e})"))
}

fn file_path(account_id: &str, kind: Kind) -> Result<PathBuf> {
    let name = match kind {
        Kind::Device => format!("{account_id}.key"),
        Kind::Mcp => format!("{account_id}.mcp.key"),
    };
    Ok(config::paths()?.data.join(name))
}

fn file_put(account_id: &str, kind: Kind, text: &str) -> Result<()> {
    let data = config::paths()?.data;
    config::private_dir(&data)?;
    write_private(&file_path(account_id, kind)?, text)
}

fn file_get(account_id: &str, kind: Kind) -> Result<String> {
    read_private(&file_path(account_id, kind)?)
}

/// Written whole (a temporary file, then renamed), mode 0600 from the start.
fn write_private(path: &std::path::Path, text: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
    f.write_all(text.as_bytes())?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Read, unless anyone but you can read it (as ssh refuses a key that others can).
fn read_private(path: &std::path::Path) -> Result<String> {
    let meta = fs::metadata(path).with_context(|| format!("{} is missing", path.display()))?;
    if meta.permissions().mode() & 0o077 != 0 {
        bail!("{} can be read by others: `chmod 600 {}` (or sign in again)", path.display(), path.display());
    }
    Ok(fs::read_to_string(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file as the store keeps one (a machine without a keychain): 0600 from the start, read
    /// back, refused once others can read it. (The whole path, PLIM_HOME and the store chosen, is
    /// in tests/credentials.rs, in a process of its own.)
    #[test]
    fn a_private_file_is_kept_private() {
        let dir = std::env::temp_dir().join(format!("plim-keychain-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("acct.key");
        write_private(&path, "c2VjcmV0").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(read_private(&path).unwrap().trim(), "c2VjcmV0");
        write_private(&path, "bmV3").unwrap();
        assert_eq!(read_private(&path).unwrap().trim(), "bmV3", "replaced whole");

        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let e = read_private(&path).unwrap_err().to_string();
        assert!(e.contains("can be read by others"), "{e}");
        let _ = fs::remove_dir_all(&dir);
    }
}
