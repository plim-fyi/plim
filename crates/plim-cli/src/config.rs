//! Local files: the device key file (seed locked with the device passphrase)
//! and per-account data directories.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use plim_core::crypto::LockedSeed;

pub const DEFAULT_SERVER: &str = "http://127.0.0.1:3000";

pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
}

/// A setting from the environment by its name after the prefix (#568): `PLIM_<name>`, else the
/// older `TIRO_<name>` (what scripts and services set before the rename keeps working).
pub fn env(name: &str) -> Option<String> {
    std::env::var(format!("PLIM_{name}")).ok().or_else(|| std::env::var(format!("TIRO_{name}")).ok())
}

/// `PLIM_HOME` (or `TIRO_HOME`) overrides everything (handy for tests and multiple identities);
/// otherwise the platform config/data directories, plim's (`~/.config/plim`, `~/.local/share/plim`;
/// tiro's before 0.17.0: a device signed in before then signs in again, or moves the two folders).
pub fn paths() -> Result<Paths> {
    if let Some(home) = env("HOME") {
        let home = PathBuf::from(home);
        return Ok(Paths { config: home.join("config"), data: home.join("data") });
    }
    let dirs = directories::ProjectDirs::from("", "", "plim").context("cannot determine home directory")?;
    Ok(Paths { config: dirs.config_dir().into(), data: dirs.data_dir().into() })
}

pub fn private_dir(path: &PathBuf) -> Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    Ok(())
}

/// The account this device is signed in to, with its seed locked by the device passphrase.
#[derive(Serialize, Deserialize)]
pub struct Device {
    pub server: String,
    pub account_id: String,
    pub pubkey_hash: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
    pub iterations: u32,
}

impl Device {
    pub fn new(server: &str, account_id: &str, pubkey_hash: &str, locked: &LockedSeed) -> Self {
        Device {
            server: server.into(),
            account_id: account_id.into(),
            pubkey_hash: pubkey_hash.into(),
            salt: B64.encode(locked.salt),
            nonce: B64.encode(locked.nonce),
            ciphertext: B64.encode(&locked.ciphertext),
            iterations: locked.iterations,
        }
    }

    pub fn locked_seed(&self) -> Result<LockedSeed> {
        Ok(LockedSeed {
            salt: B64.decode(&self.salt)?.try_into().map_err(|_| anyhow::anyhow!("corrupt device file"))?,
            nonce: B64.decode(&self.nonce)?.try_into().map_err(|_| anyhow::anyhow!("corrupt device file"))?,
            ciphertext: B64.decode(&self.ciphertext)?,
            iterations: self.iterations,
        })
    }
}

fn device_path() -> Result<PathBuf> {
    Ok(paths()?.config.join("device.json"))
}

pub fn load_device() -> Result<Option<Device>> {
    let path = device_path()?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(&path)?).context("corrupt device file")?))
}

pub fn require_device() -> Result<Device> {
    match load_device()? {
        Some(d) => Ok(d),
        None => bail!("not signed in on this device — run `plim login` (or `plim init` for a new vault)"),
    }
}

pub fn save_device(device: &Device) -> Result<()> {
    let p = paths()?;
    private_dir(&p.config)?;
    let path = device_path()?;
    let tmp = path.with_extension("tmp");
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(&serde_json::to_vec_pretty(device)?)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn remove_device() -> Result<bool> {
    let path = device_path()?;
    if path.exists() {
        fs::remove_file(path)?;
        return Ok(true);
    }
    Ok(false)
}

/// `--server` flag, then `PLIM_SERVER` (or `TIRO_SERVER`), then the device file, then the default.
pub fn server_url(flag: Option<&str>, device: Option<&Device>) -> String {
    flag.map(String::from)
        .or_else(|| env("SERVER"))
        .or_else(|| device.map(|d| d.server.clone()))
        .unwrap_or_else(|| DEFAULT_SERVER.into())
        .trim_end_matches('/')
        .to_string()
}
