//! Canonical message encoding and Ed25519 verification.
//!
//! Every signed message is a sequence of length-prefixed fields
//! (u32 big-endian length, then the bytes). The first field is always a
//! domain tag, so a signature made for one purpose can never verify as
//! another. Integers are encoded as 8-byte big-endian. This MUST stay in
//! sync with `web/core/sig.js`.

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub const TAG_AUTH: &str = "tiro/v1/auth";
pub const TAG_BLOB: &str = "tiro/v1/blob";
pub const TAG_KEYRING: &str = "tiro/v1/keyring";
pub const TAG_ROTATE_OLD: &str = "tiro/v1/rotate-old";
pub const TAG_ROTATE_NEW: &str = "tiro/v1/rotate-new";
pub const TAG_BLOB_AAD: &str = "tiro/v1/blob-aad";
pub const TAG_KEYRING_AAD: &str = "tiro/v1/keyring-aad";
pub const TAG_SHARE_BLOB: &str = "tiro/v1/share-blob";
pub const TAG_SHARE_AAD: &str = "tiro/v1/share-aad";
pub const TAG_DELETE_ACCOUNT: &str = "tiro/v1/delete-account";
pub const TAG_ACTION: &str = "tiro/v1/action";
pub const TAG_HOLDER_AAD: &str = "tiro/v1/holder-aad";
pub const TAG_CONN_RATE: &str = "tiro/v1/conn-rate";

/// What a connection signs to have its requests counted as its own, not its connector's address
/// (#394): its id and the minute (unix time / 60). Proves nothing else; replayed within the
/// minute it only moves a request into that connection's own allowance.
pub fn conn_rate_msg(connection_id: &str, minute: u64) -> Vec<u8> {
    encode(TAG_CONN_RATE, &[Field::Str(connection_id), Field::U64(minute)])
}

pub enum Field<'a> {
    Bytes(&'a [u8]),
    Str(&'a str),
    U64(u64),
}

pub fn encode(tag: &str, fields: &[Field]) -> Vec<u8> {
    let mut out = Vec::new();
    push(&mut out, tag.as_bytes());
    for f in fields {
        match f {
            Field::Bytes(b) => push(&mut out, b),
            Field::Str(s) => push(&mut out, s.as_bytes()),
            Field::U64(n) => push(&mut out, &n.to_be_bytes()),
        }
    }
    out
}

fn push(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

pub fn verify(pubkey: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (<&[u8; 32]>::try_from(pubkey), <&[u8; 64]>::try_from(sig)) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(pk) else {
        return false;
    };
    vk.verify_strict(msg, &Signature::from_bytes(sig)).is_ok()
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).as_slice().to_vec()
}

pub fn pubkey_hash(pubkey: &[u8]) -> String {
    hex::encode(sha256(pubkey))
}

#[allow(clippy::too_many_arguments)]
pub fn blob_msg(
    account_id: &str,
    doc_id: &str,
    kind: &str,
    key_version: u64,
    covers_seq: u64,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Vec<u8> {
    encode(
        TAG_BLOB,
        &[
            Field::Str(account_id),
            Field::Str(doc_id),
            Field::Str(kind),
            Field::U64(key_version),
            Field::U64(covers_seq),
            Field::Bytes(nonce),
            Field::Bytes(ciphertext),
        ],
    )
}

pub fn keyring_msg(account_id: &str, key_version: u64, nonce: &[u8], wrapped: &[u8]) -> Vec<u8> {
    encode(
        TAG_KEYRING,
        &[
            Field::Str(account_id),
            Field::U64(key_version),
            Field::Bytes(nonce),
            Field::Bytes(wrapped),
        ],
    )
}

/// AES-GCM associated data binding a blob to its account, doc, kind and key version.
pub fn blob_aad(account_id: &str, doc_id: &str, kind: &str, key_version: u64) -> Vec<u8> {
    encode(
        TAG_BLOB_AAD,
        &[Field::Str(account_id), Field::Str(doc_id), Field::Str(kind), Field::U64(key_version)],
    )
}

/// AES-GCM associated data binding a wrapped vault key to its account and version.
pub fn keyring_aad(account_id: &str, key_version: u64) -> Vec<u8> {
    encode(TAG_KEYRING_AAD, &[Field::Str(account_id), Field::U64(key_version)])
}

/// What a shared note's update or snapshot is signed as, with the share's
/// own key (anyone with an edit link can write; nobody else can).
pub fn share_blob_msg(share_id: &str, kind: &str, covers_seq: u64, nonce: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    encode(
        TAG_SHARE_BLOB,
        &[Field::Str(share_id), Field::Str(kind), Field::U64(covers_seq), Field::Bytes(nonce), Field::Bytes(ciphertext)],
    )
}

/// AES-GCM associated data binding a shared note's blob to its share and kind.
pub fn share_aad(share_id: &str, kind: &str) -> Vec<u8> {
    encode(TAG_SHARE_AAD, &[Field::Str(share_id), Field::Str(kind)])
}

/// AES-GCM associated data binding a holder's sealed copy of a share's keys (#369) to the
/// holder and the share it's for.
pub fn holder_aad(holder_id: &str, share_id: &str) -> Vec<u8> {
    encode(TAG_HOLDER_AAD, &[Field::Str(holder_id), Field::Str(share_id)])
}

pub fn auth_msg(nonce: &[u8], pubkey_hash: &str) -> Vec<u8> {
    encode(TAG_AUTH, &[Field::Bytes(nonce), Field::Str(pubkey_hash)])
}

pub fn rotate_msg(tag: &str, account_id: &str, new_pubkey: &[u8]) -> Vec<u8> {
    encode(tag, &[Field::Str(account_id), Field::Bytes(new_pubkey)])
}

/// Deleting an account: signed with its key over a fresh challenge (POST
/// /auth/challenge), so a session alone (a stolen token) can't do it.
pub fn delete_account_msg(account_id: &str, nonce: &[u8]) -> Vec<u8> {
    encode(TAG_DELETE_ACCOUNT, &[Field::Str(account_id), Field::Bytes(nonce)])
}

/// What can't be undone, or locks something out (#144): deleting a note or a share,
/// turning a share's links off, closing or reopening a note to writes, replacing or
/// removing a passkey's copy. Signed with the account's key over a fresh challenge
/// (POST /auth/challenge), naming the action and what it's done to, so a session
/// alone (a stolen token) can't do it, and a signature for one can't do another.
/// `data`: what the action puts there, if anything (a passkey's copy: its nonce,
/// then its ciphertext).
pub fn action_msg(account_id: &str, action: &str, target: &str, nonce: &[u8], data: &[u8]) -> Vec<u8> {
    encode(
        TAG_ACTION,
        &[Field::Str(account_id), Field::Str(action), Field::Str(target), Field::Bytes(nonce), Field::Bytes(data)],
    )
}

/// The actions `action_msg` names.
pub mod action {
    pub const DELETE_DOC: &str = "delete-doc";
    pub const CLOSE_DOC: &str = "close-doc";
    pub const REOPEN_DOC: &str = "reopen-doc";
    pub const DELETE_SHARE: &str = "delete-share";
    pub const REVOKE_SHARE: &str = "revoke-share";
    pub const PUT_PASSKEY: &str = "put-passkey";
    pub const DELETE_PASSKEY: &str = "delete-passkey";
    /// A note's or share's data, deleted, back from the trash (#253).
    pub const RESTORE_DOC: &str = "restore-doc";
    pub const RESTORE_SHARE: &str = "restore-share";
    /// A holder of a shared note's keys taken away (#369).
    pub const DELETE_HOLDER: &str = "delete-holder";
    /// A note's history before a time, deleted for good (target: the note, or its share; data: the time).
    pub const FORGET_HISTORY: &str = "forget-history";
    /// A connection (#369) turned off, or its record removed: by its owner.
    pub const REVOKE_CONNECTION: &str = "revoke-connection";
    pub const DELETE_CONNECTION: &str = "delete-connection";
    /// A note made on the owner's behalf: by the connection's key, the target the new share's id.
    pub const CONNECTION_CREATE_SHARE: &str = "connection-create-share";
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as B64;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn domain_tags_separate_signatures() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let auth = auth_msg(b"nonce", "abc");
        let sig = sk.sign(&auth).to_bytes();
        assert!(verify(&pk, &auth, &sig));
        // Same payload bytes under a different tag must not verify.
        let other = encode(TAG_BLOB, &[Field::Bytes(b"nonce"), Field::Str("abc")]);
        assert!(!verify(&pk, &other, &sig));
    }

    #[test]
    fn length_prefix_prevents_field_shifting() {
        let a = encode(TAG_AUTH, &[Field::Str("ab"), Field::Str("c")]);
        let b = encode(TAG_AUTH, &[Field::Str("a"), Field::Str("bc")]);
        assert_ne!(a, b);
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let msg = blob_msg("acct", "doc", "update", 1, 0, &[1; 12], b"cipher");
        let sig = sk.sign(&msg).to_bytes();
        assert!(verify(&pk, &msg, &sig));
        let bad = blob_msg("acct", "doc", "update", 1, 0, &[1; 12], b"cipheR");
        assert!(!verify(&pk, &bad, &sig));
    }

    /// Fixture produced by the JS client (`web/tests/run.mjs --write-fixture`),
    /// proving both sides encode and sign identically.
    #[test]
    fn js_fixture_verifies() {
        let fx: serde_json::Value =
            serde_json::from_str(include_str!("../../../web/tests/fixtures/sig.json")).unwrap();
        let s = |k: &str| fx[k].as_str().unwrap().to_string();
        let b = |k: &str| B64.decode(s(k)).unwrap();
        let pubkey = b("pubkey");
        assert_eq!(pubkey_hash(&pubkey), s("pubkey_hash"));
        let msg = blob_msg(
            &s("account_id"),
            &s("doc_id"),
            &s("kind"),
            fx["key_version"].as_u64().unwrap(),
            fx["covers_seq"].as_u64().unwrap(),
            &b("nonce"),
            &b("ciphertext"),
        );
        assert_eq!(B64.encode(&msg), s("blob_msg"));
        assert!(verify(&pubkey, &msg, &b("blob_sig")));
        let amsg = auth_msg(&b("auth_nonce"), &s("pubkey_hash"));
        assert!(verify(&pubkey, &amsg, &b("auth_sig")));
        assert!(!verify(&pubkey, &msg, &b("auth_sig")));
        // Deleting the account (#51): the same bytes signed on both sides, and not
        // a sign-in signature passed off as one.
        let dmsg = delete_account_msg(&s("account_id"), &b("auth_nonce"));
        assert_eq!(B64.encode(&dmsg), s("delete_msg"));
        assert!(verify(&pubkey, &dmsg, &b("delete_sig")));
        assert!(!verify(&pubkey, &dmsg, &b("auth_sig")));
        // A destructive action (#144): the same bytes on both sides, and it names its
        // action and target (not the same signature for another).
        let data = [b("nonce"), b("ciphertext")].concat();
        let amsg = action_msg(&s("account_id"), action::PUT_PASSKEY, &s("doc_id"), &b("auth_nonce"), &data);
        assert_eq!(B64.encode(&amsg), s("action_msg"));
        assert!(verify(&pubkey, &amsg, &b("action_sig")));
        let other = action_msg(&s("account_id"), action::DELETE_PASSKEY, &s("doc_id"), &b("auth_nonce"), &data);
        assert!(!verify(&pubkey, &other, &b("action_sig")));
        let elsewhere = action_msg(&s("account_id"), action::PUT_PASSKEY, "another", &b("auth_nonce"), &data);
        assert!(!verify(&pubkey, &elsewhere, &b("action_sig")));
    }
}
