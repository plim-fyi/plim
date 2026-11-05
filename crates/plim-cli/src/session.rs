//! An unlocked, logged-in session: identity, account, keyring and local store.
//! Mirrors `web/core/account.js` and `web/core/keyring.js`.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::json;
use plim_core::crypto::{self, Identity, doc_key, random_bytes, unwrap_vault_key, wrap_vault_key};
use plim_core::pow;

use crate::api::{Api, KeyringEntryJson};
use crate::config;
use crate::store::Store;

/// Unwrapped vault keys by version.
#[derive(Default)]
pub struct Keyring {
    keys: BTreeMap<u64, [u8; 32]>,
}

impl Keyring {
    /// Entries this phrase can't open are left out, with a warning: a phrase change that wasn't
    /// finished registered its new key under the new phrase (the web app finishes it; see
    /// web/core/keyring.js). Notes under such a key can't be opened here.
    pub fn from_entries(id: &Identity, account_id: &str, entries: &[KeyringEntryJson]) -> Result<Self> {
        let mut kr = Keyring::default();
        for e in entries {
            match unwrap_vault_key(id, account_id, e.key_version, &B64.decode(&e.nonce)?, &B64.decode(&e.wrapped)?) {
                Ok(key) => {
                    kr.keys.insert(e.key_version, key);
                }
                Err(_) => eprintln!("{}", LOCKED_KEY_HINT.replace("vN", &format!("v{}", e.key_version))),
            }
        }
        if kr.keys.is_empty() {
            return Err(anyhow!(if entries.is_empty() { "the server returned no vault keys" } else { "none of the vault keys opens with this phrase" }));
        }
        Ok(kr)
    }

    pub fn current(&self) -> u64 {
        *self.keys.keys().next_back().expect("keyring is never empty")
    }

    pub fn doc_key(&self, version: u64, doc_id: &str) -> Result<[u8; 32]> {
        let vk = self.keys.get(&version).ok_or_else(|| anyhow!("{}", LOCKED_KEY_HINT.replace("vN", &format!("v{version}"))))?;
        Ok(doc_key(vk, doc_id))
    }
}

const LOCKED_KEY_HINT: &str = "vault key vN can't be opened with this phrase: a phrase change wasn't finished. Sign in to the web app with this phrase; it asks for the new one and finishes the change.";

#[cfg(test)]
mod tests {
    use super::*;
    use plim_core::crypto::{random_bytes, wrap_vault_key};

    #[test]
    fn a_vault_key_under_another_phrase_is_left_out_with_a_hint() {
        let (me, other) = (Identity::from_seed(&[1; 64]), Identity::from_seed(&[2; 64]));
        let entry = |id: &Identity, v: u64| {
            let e = wrap_vault_key(id, "acct", v, &random_bytes::<32>());
            KeyringEntryJson { key_version: v, nonce: B64.encode(e.nonce), wrapped: B64.encode(e.wrapped), sig: B64.encode(e.sig) }
        };
        let kr = Keyring::from_entries(&me, "acct", &[entry(&me, 1), entry(&other, 2)]).unwrap();
        assert_eq!(kr.current(), 1);
        assert!(kr.doc_key(2, "d").unwrap_err().to_string().contains("v2 can't be opened"));
        assert!(Keyring::from_entries(&me, "acct", &[entry(&other, 2)]).err().unwrap().to_string().contains("none of the vault keys"));
    }
}

pub struct Session {
    pub api: Api,
    pub identity: Arc<Identity>,
    pub account_id: String,
    pub keyring: RwLock<Keyring>,
    pub store: Store,
    /// Set when the server served an older keyring than this device has seen.
    pub keyring_rollback: Option<(u64, u64)>,
    /// The server's largest accepted blob (`GET /account`); uploads are split to fit.
    max_blob: AtomicUsize,
}

/// What servers that don't report a limit accept.
pub const DEFAULT_MAX_BLOB: usize = 1024 * 1024;

impl Session {
    /// Log in and open the local store for the account.
    pub async fn open(api: Api, identity: Arc<Identity>) -> Result<Arc<Self>> {
        let login = api.login(&identity).await?;
        let keyring = Keyring::from_entries(&identity, &login.account_id, &login.keyring)?;
        let paths = config::paths()?;
        config::private_dir(&paths.data)?;
        let store = Store::open(&paths.data.join(format!("{}.db", login.account_id)))?;
        // Rollback check for the keyring (see checkKeyring in web/core/account.js).
        let (seen, current) = (store.key_version()?, keyring.current());
        let keyring_rollback = if current < seen {
            Some((seen, current))
        } else {
            if current > seen {
                store.set_key_version(current)?;
            }
            None
        };
        let max_blob = match api.get("/account").await {
            Ok(a) => a["max_blob_bytes"].as_u64().map_or(DEFAULT_MAX_BLOB, |n| n as usize),
            Err(_) => DEFAULT_MAX_BLOB,
        };
        Ok(Arc::new(Session {
            api,
            identity,
            account_id: login.account_id,
            keyring: RwLock::new(keyring),
            store,
            keyring_rollback,
            max_blob: AtomicUsize::new(max_blob),
        }))
    }

    /// No account, only a shared note's link (#130): a share is sealed with its link's
    /// keys, so no vault keys are needed, and nothing is kept on this device (one-shot
    /// commands). Fails if the link no longer works.
    pub async fn for_link(api: Api, share: &crate::sync::ShareHome) -> Result<Arc<Self>> {
        let status = api.get_share(&format!("/shares/{}", share.id), &share.token_hex()).await.map_err(|e| match e.status() {
            Some(404 | 410) => anyhow!("this link doesn't work any more (its note's sharing was turned off or the links replaced)"),
            _ => e.into(),
        })?;
        if status["status"] == "revoked" {
            bail!("this link doesn't work any more (its note's sharing was turned off or the links replaced)");
        }
        Self::guest(api, status["max_blob_bytes"].as_u64().map_or(DEFAULT_MAX_BLOB, |n| n as usize))
    }

    /// No account: only shared notes, through their keys (a link's, a holder's, #369), nothing
    /// kept on this device.
    pub fn guest(api: Api, max_blob: usize) -> Result<Arc<Self>> {
        Ok(Arc::new(Session {
            api,
            identity: Arc::new(Identity::from_seed(&plim_core::crypto::random_bytes::<64>())), // (never used)
            account_id: String::new(),
            keyring: RwLock::new(Keyring::default()),
            store: Store::in_memory()?,
            keyring_rollback: None,
            max_blob: AtomicUsize::new(max_blob),
        }))
    }

    pub fn max_blob(&self) -> usize {
        self.max_blob.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn set_max_blob(&self, n: usize) {
        self.max_blob.store(n, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub fn for_test(api: Api, identity: Arc<Identity>, account_id: &str, keyring: Keyring) -> Arc<Self> {
        Arc::new(Session {
            api,
            identity,
            account_id: account_id.into(),
            keyring: RwLock::new(keyring),
            store: Store::in_memory().unwrap(),
            keyring_rollback: None,
            max_blob: AtomicUsize::new(DEFAULT_MAX_BLOB),
        })
    }
}

/// Register a new account (with signup proof-of-work). Returns the account id.
pub async fn create_account(api: &Api, identity: &Identity) -> Result<String> {
    let account_id = hex::encode(random_bytes::<16>());
    let vault_key = random_bytes::<32>();
    let entry = wrap_vault_key(identity, &account_id, 1, &vault_key);
    let p = api.post("/pow", &json!({})).await?;
    let salt_b64 = p["salt"].as_str().context("bad pow challenge")?.to_string();
    let salt = B64.decode(&salt_b64)?;
    let difficulty = p["difficulty"].as_u64().context("bad pow challenge")? as u32;
    let nonce = tokio::task::spawn_blocking(move || pow::solve(&salt, difficulty)).await?;
    api.post(
        "/accounts",
        &json!({
            "account_id": account_id,
            "pubkey": B64.encode(identity.pubkey),
            "keyring_entry": {
                "key_version": 1,
                "nonce": B64.encode(entry.nonce),
                "wrapped": B64.encode(&entry.wrapped),
                "sig": B64.encode(entry.sig),
            },
            "pow_salt": salt_b64,
            "pow_nonce": nonce,
        }),
    )
    .await?;
    Ok(account_id)
}

pub fn identity_from_seed(seed: &[u8]) -> Arc<Identity> {
    Arc::new(crypto::Identity::from_seed(seed))
}
