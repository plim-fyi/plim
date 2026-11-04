//! Client-side key derivation and encryption. Mirrors `web/core/crypto.js`,
//! `web/core/bip39.js` and `web/core/vault.js` byte for byte, so the native client and
//! the web app can open each other's data.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use aes_gcm::aead::Nonce;
use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::sig::{self, blob_aad, keyring_aad, pubkey_hash};

pub const HKDF_SALT: &[u8] = b"tiro/v1/salt";
pub const QUICK_UNLOCK_AAD: &[u8] = b"tiro/v1/quick-unlock";
pub const QUICK_UNLOCK_ITERATIONS: u32 = 600_000;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// The phrase is not a valid BIP-39 mnemonic (message is user-facing).
    Mnemonic(String),
    /// Authenticated decryption failed: wrong key, wrong context or tampered data.
    Decrypt,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Mnemonic(m) => write!(f, "{m}"),
            Error::Decrypt => write!(f, "decryption failed (wrong key or tampered data)"),
        }
    }
}

impl std::error::Error for Error {}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("OS random number generator unavailable");
    out
}

pub fn hkdf32(ikm: &[u8], info: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(HKDF_SALT), ikm)
        .expand(info.as_bytes(), &mut out)
        .expect("32 bytes is a valid HKDF output length");
    out
}

// ---- BIP-39 ----

/// Lowercase and collapse whitespace, as the web app does.
pub fn normalize_mnemonic(phrase: &str) -> String {
    phrase.split_whitespace().map(str::to_lowercase).collect::<Vec<_>>().join(" ")
}

pub fn generate_mnemonic() -> String {
    Mnemonic::from_entropy_in(Language::English, &random_bytes::<16>())
        .expect("16 bytes is valid BIP-39 entropy")
        .to_string()
}

pub fn parse_mnemonic(phrase: &str) -> Result<Mnemonic, Error> {
    let normalized = normalize_mnemonic(phrase);
    let words = normalized.split(' ').filter(|w| !w.is_empty()).count();
    if ![12, 15, 18, 21, 24].contains(&words) {
        return Err(Error::Mnemonic("Expected 12 or 24 words".into()));
    }
    Mnemonic::parse_in_normalized(Language::English, &normalized).map_err(|e| {
        Error::Mnemonic(match e {
            bip39::Error::UnknownWord(i) => {
                format!("\"{}\" is not a recovery word", normalized.split(' ').nth(i).unwrap_or("?"))
            }
            bip39::Error::InvalidChecksum => "Checksum mismatch — check the words and their order".into(),
            other => other.to_string(),
        })
    })
}

/// PBKDF2-HMAC-SHA512(phrase, "mnemonic" + passphrase, 2048) → 64-byte seed.
pub fn mnemonic_to_seed(phrase: &str) -> Result<[u8; 64], Error> {
    Ok(parse_mnemonic(phrase)?.to_seed_normalized(""))
}

// ---- identity ----

/// Keys derived from the recovery phrase: the Ed25519 signing key that
/// identifies the account, and the key-encryption key that wraps vault keys.
pub struct Identity {
    pub signing: SigningKey,
    pub pubkey: [u8; 32],
    pub pubkey_hash: String,
    kek: [u8; 32],
}

impl Identity {
    pub fn from_seed(seed: &[u8]) -> Self {
        let signing = SigningKey::from_bytes(&hkdf32(seed, "tiro/v1/sign"));
        let pubkey = signing.verifying_key().to_bytes();
        Identity { pubkey_hash: pubkey_hash(&pubkey), pubkey, signing, kek: hkdf32(seed, "tiro/v1/kek") }
    }

    pub fn from_mnemonic(phrase: &str) -> Result<Self, Error> {
        Ok(Self::from_seed(&mnemonic_to_seed(phrase)?))
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

// ---- AEAD ----

pub struct Sealed {
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

pub fn encrypt(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Sealed {
    let nonce = random_bytes::<12>();
    let ciphertext = Aes256Gcm::new(key.into())
        .encrypt(&Nonce::<Aes256Gcm>::from(nonce), Payload { msg: plaintext, aad })
        .expect("AES-GCM encryption of in-memory data cannot fail");
    Sealed { nonce, ciphertext }
}

pub fn decrypt(key: &[u8; 32], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| Error::Decrypt)?;
    Aes256Gcm::new(key.into())
        .decrypt(&Nonce::<Aes256Gcm>::from(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| Error::Decrypt)
}

// ---- key hierarchy ----

pub struct KeyringEntry {
    pub key_version: u64,
    pub nonce: [u8; 12],
    pub wrapped: Vec<u8>,
    pub sig: [u8; 64],
}

/// Wrap a vault key under the identity's KEK and sign the entry.
pub fn wrap_vault_key(id: &Identity, account_id: &str, key_version: u64, vault_key: &[u8; 32]) -> KeyringEntry {
    let s = encrypt(&id.kek, vault_key, &keyring_aad(account_id, key_version));
    let sig = id.sign(&sig::keyring_msg(account_id, key_version, &s.nonce, &s.ciphertext));
    KeyringEntry { key_version, nonce: s.nonce, wrapped: s.ciphertext, sig }
}

pub fn unwrap_vault_key(
    id: &Identity,
    account_id: &str,
    key_version: u64,
    nonce: &[u8],
    wrapped: &[u8],
) -> Result<[u8; 32], Error> {
    decrypt(&id.kek, nonce, wrapped, &keyring_aad(account_id, key_version))?
        .try_into()
        .map_err(|_| Error::Decrypt)
}

/// Per-document key = HKDF(vault key, "tiro/v1/doc:<doc_id>").
pub fn doc_key(vault_key: &[u8; 32], doc_id: &str) -> [u8; 32] {
    hkdf32(vault_key, &format!("tiro/v1/doc:{doc_id}"))
}

// ---- document blobs ----

pub struct SealedBlob {
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    pub sig: [u8; 64],
}

/// Encrypt a Yjs update/snapshot for upload and sign it for the server.
#[allow(clippy::too_many_arguments)]
pub fn seal_blob(
    id: &Identity,
    doc_key: &[u8; 32],
    account_id: &str,
    doc_id: &str,
    kind: &str,
    key_version: u64,
    covers_seq: u64,
    plaintext: &[u8],
) -> SealedBlob {
    let s = encrypt(doc_key, plaintext, &blob_aad(account_id, doc_id, kind, key_version));
    let msg = sig::blob_msg(account_id, doc_id, kind, key_version, covers_seq, &s.nonce, &s.ciphertext);
    SealedBlob { nonce: s.nonce, ciphertext: s.ciphertext, sig: id.sign(&msg) }
}

pub fn open_blob(
    doc_key: &[u8; 32],
    account_id: &str,
    doc_id: &str,
    kind: &str,
    key_version: u64,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    decrypt(doc_key, nonce, ciphertext, &blob_aad(account_id, doc_id, kind, key_version))
}

// ---- shared notes ----

/// The keys of a shared note, all from its random 32-byte seed (an edit link
/// carries the seed): the encryption key, the Ed25519 key that signs writes,
/// and the read token that lets the server know you may read. A read-only
/// link carries only the encryption key, from which the read token follows.
pub struct ShareKeys {
    pub enc_key: [u8; 32],
    pub signing: SigningKey,
    pub pubkey: [u8; 32],
    pub read_token: [u8; 32],
}

pub fn share_keys(seed: &[u8; 32]) -> ShareKeys {
    let enc_key = hkdf32(seed, "tiro/v1/share-enc");
    let signing = SigningKey::from_bytes(&hkdf32(seed, "tiro/v1/share-sign"));
    let pubkey = signing.verifying_key().to_bytes();
    ShareKeys { read_token: share_read_token(&enc_key), enc_key, signing, pubkey }
}

pub fn share_read_token(enc_key: &[u8; 32]) -> [u8; 32] {
    hkdf32(enc_key, "tiro/v1/share-read")
}

// ---- holders (#369): a share's keys held by more than one link ----

/// What a holder of a shared note has: a random 32-byte secret, carried by its link
/// (`/n/<note id>#h=<holder id>.<secret>`). From it come the token the server serves the
/// holder's row to, and the key that row's copy of the share's keys is sealed with. The row
/// points at the note's current share: replacing the links makes a new share and re-seals its
/// keys for each holder kept, so their links keep working, while a holder taken away gets
/// nothing (the old share goes, and its keys with it).
pub struct HolderKeys {
    pub token: [u8; 32],
    pub seal_key: [u8; 32],
}

pub fn holder_keys(secret: &[u8; 32]) -> HolderKeys {
    HolderKeys { token: hkdf32(secret, "tiro/v1/holder-token"), seal_key: hkdf32(secret, "tiro/v1/holder-seal") }
}

/// A share's keys as a holder holds them: an edit holder has the seed (everything), a read
/// holder the encryption key and the signing key's public half (as a view link has).
#[derive(Debug, PartialEq, Eq)]
pub enum HeldKeys {
    Edit { seed: [u8; 32] },
    Read { enc_key: [u8; 32], pubkey: [u8; 32] },
}

impl HeldKeys {
    pub fn role(&self) -> &'static str {
        match self {
            HeldKeys::Edit { .. } => "edit",
            HeldKeys::Read { .. } => "read",
        }
    }

    /// The bytes sealed: a role byte, `e` or `r`, then the keys.
    fn to_bytes(&self) -> Vec<u8> {
        match self {
            HeldKeys::Edit { seed } => [b"e".as_slice(), seed].concat(),
            HeldKeys::Read { enc_key, pubkey } => [b"r".as_slice(), enc_key, pubkey].concat(),
        }
    }

    fn from_bytes(b: &[u8]) -> Result<Self, Error> {
        let key = |at: usize| -> Result<[u8; 32], Error> { b.get(at..at + 32).and_then(|s| s.try_into().ok()).ok_or(Error::Decrypt) };
        match (b.first(), b.len()) {
            (Some(b'e'), 33) => Ok(HeldKeys::Edit { seed: key(1)? }),
            (Some(b'r'), 65) => Ok(HeldKeys::Read { enc_key: key(1)?, pubkey: key(33)? }),
            _ => Err(Error::Decrypt),
        }
    }
}

/// The share's keys sealed for a holder, bound to the holder and the share they're for.
pub fn seal_held_keys(seal_key: &[u8; 32], holder_id: &str, share_id: &str, keys: &HeldKeys) -> Sealed {
    encrypt(seal_key, &keys.to_bytes(), &sig::holder_aad(holder_id, share_id))
}

pub fn open_held_keys(seal_key: &[u8; 32], holder_id: &str, share_id: &str, nonce: &[u8], ciphertext: &[u8]) -> Result<HeldKeys, Error> {
    HeldKeys::from_bytes(&decrypt(seal_key, nonce, ciphertext, &sig::holder_aad(holder_id, share_id))?)
}

// ---- connections (#369): an app (Claude) connected to a vault ----

/// What a connection has: a random 32-byte secret (carried by the token Claude holds, sealed by
/// the connector). From it: the Ed25519 key it signs with (to make notes on the owner's behalf),
/// and its own list note's holder: an id and a secret, derived, so the connection finds its list
/// with nothing but the secret. Each note granted to it is a holder too, whose secret comes from
/// the connection secret and that holder's id (`connection_holder_secret`).
pub struct ConnectionKeys {
    pub signing: SigningKey,
    pub pubkey: [u8; 32],
    pub pubkey_hash: String,
    pub list_holder_id: String,
    pub list_holder_secret: [u8; 32],
}

pub fn connection_keys(secret: &[u8; 32]) -> ConnectionKeys {
    let signing = SigningKey::from_bytes(&hkdf32(secret, "tiro/v1/conn-sign"));
    let pubkey = signing.verifying_key().to_bytes();
    ConnectionKeys {
        pubkey_hash: pubkey_hash(&pubkey),
        pubkey,
        signing,
        list_holder_id: hex::encode(&hkdf32(secret, "tiro/v1/conn-list-id")[..16]),
        list_holder_secret: hkdf32(secret, "tiro/v1/conn-list-secret"),
    }
}

/// The secret of one of a connection's holders (a note granted to it), from the connection's
/// secret and the holder's id (random, made by the owner's app and kept in the connection's list).
pub fn connection_holder_secret(secret: &[u8; 32], holder_id: &str) -> [u8; 32] {
    hkdf32(secret, &format!("tiro/v1/conn-holder/{holder_id}"))
}

// ---- quick unlock (device passphrase) ----

pub struct LockedSeed {
    pub salt: [u8; 16],
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    pub iterations: u32,
}

fn passphrase_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    pbkdf2::pbkdf2_hmac_array::<Sha256, 32>(passphrase.as_bytes(), salt, iterations)
}

pub fn lock_seed(seed: &[u8], passphrase: &str) -> LockedSeed {
    lock_seed_with(seed, passphrase, QUICK_UNLOCK_ITERATIONS)
}

fn lock_seed_with(seed: &[u8], passphrase: &str, iterations: u32) -> LockedSeed {
    let salt = random_bytes::<16>();
    let s = encrypt(&passphrase_key(passphrase, &salt, iterations), seed, QUICK_UNLOCK_AAD);
    LockedSeed { salt, nonce: s.nonce, ciphertext: s.ciphertext, iterations }
}

pub fn unlock_seed(locked: &LockedSeed, passphrase: &str) -> Result<Vec<u8>, Error> {
    let key = passphrase_key(passphrase, &locked.salt, locked.iterations);
    decrypt(&key, &locked.nonce, &locked.ciphertext, QUICK_UNLOCK_AAD)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connections_keys_come_from_its_secret() {
        let k = connection_keys(&[0x55; 32]);
        assert_eq!(k.pubkey, k.signing.verifying_key().to_bytes());
        assert_eq!(k.pubkey_hash, pubkey_hash(&k.pubkey));
        assert_eq!(k.list_holder_id.len(), 32);
        assert_ne!(k.list_holder_secret, [0x55; 32]);
        assert_ne!(connection_holder_secret(&[0x55; 32], "a"), connection_holder_secret(&[0x55; 32], "b"));
        assert_eq!(connection_holder_secret(&[0x55; 32], "a"), connection_holder_secret(&[0x55; 32], "a"));
        assert_ne!(connection_keys(&[0x56; 32]).pubkey, k.pubkey);
    }

    /// Shared with web/tests/run.mjs, so the browser and Rust derive the same share keys.
    #[test]
    fn share_key_vectors() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../web/tests/fixtures/share-vectors.json")).unwrap();
        let seed: [u8; 32] = hex::decode(v["seed"].as_str().unwrap()).unwrap().try_into().unwrap();
        let k = share_keys(&seed);
        assert_eq!(hex::encode(k.enc_key), v["enc_key"]);
        assert_eq!(hex::encode(k.pubkey), v["pubkey"]);
        assert_eq!(hex::encode(k.read_token), v["read_token"]);
        let msg = sig::share_blob_msg(v["share_id"].as_str().unwrap(), "update", 0, &[1; 12], b"ciphertext");
        assert_eq!(hex::encode(&msg), v["blob_msg"]);
        assert_eq!(hex::encode(k.signing.sign(&msg).to_bytes()), v["blob_sig"]);
        assert_eq!(hex::encode(sig::share_aad(v["share_id"].as_str().unwrap(), "snapshot")), v["aad"]);
    }

    #[test]
    fn bip39_trezor_vectors() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../web/tests/bip39-vectors.json")).unwrap();
        for case in v["english"].as_array().unwrap() {
            let (entropy, phrase, seed) =
                (case[0].as_str().unwrap(), case[1].as_str().unwrap(), case[2].as_str().unwrap());
            let m = Mnemonic::from_entropy(&hex::decode(entropy).unwrap()).unwrap();
            assert_eq!(m.to_string(), phrase);
            assert_eq!(hex::encode(parse_mnemonic(phrase).unwrap().to_seed_normalized("TREZOR")), seed);
        }
    }

    #[test]
    fn mnemonic_validation_messages() {
        let about = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        assert!(mnemonic_to_seed(&format!("  {}  ", about.to_uppercase())).is_ok());
        let e = |p: &str| parse_mnemonic(p).unwrap_err().to_string();
        assert!(e(&"abandon ".repeat(12)).contains("Checksum"));
        assert!(e(&format!("{}notaword", "abandon ".repeat(11))).contains("not a recovery word"));
        assert!(e("abandon abandon").contains("12 or 24"));
        assert_eq!(generate_mnemonic().split(' ').count(), 12);
        assert!(parse_mnemonic(&generate_mnemonic()).is_ok());
    }

    #[test]
    fn seal_open_round_trip_and_binding() {
        let id = Identity::from_seed(&[1u8; 64]);
        let key = doc_key(&[2u8; 32], "index");
        let b = seal_blob(&id, &key, "acct", "index", "update", 1, 0, b"hello");
        assert_eq!(open_blob(&key, "acct", "index", "update", 1, &b.nonce, &b.ciphertext).unwrap(), b"hello");
        // Any change of context or ciphertext fails.
        assert_eq!(open_blob(&key, "acct", "index", "snapshot", 1, &b.nonce, &b.ciphertext), Err(Error::Decrypt));
        assert_eq!(open_blob(&key, "other", "index", "update", 1, &b.nonce, &b.ciphertext), Err(Error::Decrypt));
        let mut bad = b.ciphertext.clone();
        bad[0] ^= 1;
        assert_eq!(open_blob(&key, "acct", "index", "update", 1, &b.nonce, &bad), Err(Error::Decrypt));
        // The signature verifies with the identity's public key.
        let msg = sig::blob_msg("acct", "index", "update", 1, 0, &b.nonce, &b.ciphertext);
        assert!(sig::verify(&id.pubkey, &msg, &b.sig));
    }

    #[test]
    fn vault_key_wrap_round_trip() {
        let id = Identity::from_seed(&[3u8; 64]);
        let vk = random_bytes::<32>();
        let e = wrap_vault_key(&id, "acct", 2, &vk);
        assert_eq!(unwrap_vault_key(&id, "acct", 2, &e.nonce, &e.wrapped).unwrap(), vk);
        assert!(unwrap_vault_key(&id, "acct", 1, &e.nonce, &e.wrapped).is_err());
        let other = Identity::from_seed(&[4u8; 64]);
        assert!(unwrap_vault_key(&other, "acct", 2, &e.nonce, &e.wrapped).is_err());
        assert!(sig::verify(&id.pubkey, &sig::keyring_msg("acct", 2, &e.nonce, &e.wrapped), &e.sig));
    }

    #[test]
    fn quick_unlock_round_trip() {
        // Few iterations to keep the test fast; the stored count is honored on unlock.
        let locked = lock_seed_with(&[5u8; 64], "correct horse", 1000);
        assert_eq!(unlock_seed(&locked, "correct horse").unwrap(), vec![5u8; 64]);
        assert_eq!(unlock_seed(&locked, "wrong"), Err(Error::Decrypt));
    }
}
