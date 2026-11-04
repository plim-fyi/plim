//! The device passphrase, remembered on this machine (#360) so `plim` stops asking for it.
//!
//! Where a desktop keychain is running (Secret Service on Linux: GNOME Keyring, KWallet,
//! KeePassXC; Keychain on macOS) it's kept there, for good, unlocked with your login. A
//! machine without one (a headless server) gets the Linux kernel's keyring instead: the
//! user's persistent keyring, shared by all their sessions (an SSH login, a systemd timer),
//! kept until a reboot or three days without use; after either, `plim remember` again.
//! `PLIM_PASSPHRASE`, when set, still comes first.

use anyhow::{Result, bail};
use keyring::Entry;

/// The keyring's service name ("tiro" before 0.17.0: `plim remember` again after updating).
const SERVICE: &str = "plim";

/// Where a passphrase is kept, as `plim remember` says it.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Store {
    Keychain,
    KernelKeyring,
}

impl Store {
    pub fn describe(self) -> &'static str {
        match self {
            Store::Keychain => "in this machine's keychain",
            Store::KernelKeyring => "in this machine's kernel keyring, until it restarts (or 3 days unused)",
        }
    }
}

/// The places to look, in order: the keychain, then (Linux) the kernel's keyring.
fn entries(account_id: &str) -> Vec<(Store, Entry)> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Ok(e) = Entry::new(SERVICE, account_id) {
        out.push((Store::Keychain, e));
    }
    #[cfg(target_os = "linux")]
    {
        use keyring::{keyutils::KeyutilsCredential, secret_service::SsCredential};
        if let Ok(c) = SsCredential::new_with_target(None, SERVICE, account_id) {
            out.push((Store::Keychain, Entry::new_with_credential(Box::new(c))));
        }
        if let Ok(c) = KeyutilsCredential::new_with_target(None, SERVICE, account_id) {
            out.push((Store::KernelKeyring, Entry::new_with_credential(Box::new(c))));
        }
    }
    out
}

/// The passphrase remembered for this account, if there is one.
pub fn get(account_id: &str) -> Option<(Store, String)> {
    entries(account_id).into_iter().find_map(|(store, e)| e.get_password().ok().map(|p| (store, p)))
}

/// Remember it in the first place that takes it; where that was.
pub fn set(account_id: &str, passphrase: &str) -> Result<Store> {
    let mut why = Vec::new();
    for (store, e) in entries(account_id) {
        match e.set_password(passphrase) {
            Ok(()) => return Ok(store),
            Err(err) => why.push(format!("{}: {err}", store.describe())),
        }
    }
    bail!("there's no keychain on this machine to keep it in ({})", if why.is_empty() { "none found".into() } else { why.join("; ") })
}

/// Forget it everywhere it might be; whether it was anywhere.
pub fn forget(account_id: &str) -> bool {
    entries(account_id).into_iter().fold(false, |any, (_, e)| e.delete_credential().is_ok() || any)
}
