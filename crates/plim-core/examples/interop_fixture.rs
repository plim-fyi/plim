//! Writes web/tests/fixtures/interop-rust.json: data sealed by the Rust client
//! that the JS test suite must be able to open.
//!   cargo run -p plim-core --example interop_fixture

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use plim_core::crypto::{HeldKeys, Identity, doc_key, holder_keys, seal_blob, seal_held_keys, share_keys, wrap_vault_key};
use yrs::{Any, Doc, Map, MapPrelim, ReadTxn, StateVector, Text, Transact};

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn main() {
    let id = Identity::from_mnemonic(PHRASE).unwrap();
    let account_id = "aabbccddeeff00112233445566778899";
    let doc_id = "3f1c2a9e-0000-4000-8000-000000000002";
    let vault_key = [0x22u8; 32];
    let text = "hello from Rust — ünïcödé ✓";

    let doc = Doc::new();
    let body = doc.get_or_insert_text("body");
    let notes = doc.get_or_insert_map("notes");
    {
        let mut txn = doc.transact_mut();
        body.insert(&mut txn, 0, text);
        notes.insert(&mut txn, "n1", MapPrelim::from([("title", Any::from("Rust title")), ("deleted", Any::Bool(false))]));
    }
    let update = doc.transact().encode_state_as_update_v1(&StateVector::default());

    let kr = wrap_vault_key(&id, account_id, 1, &vault_key);
    let blob = seal_blob(&id, &doc_key(&vault_key, doc_id), account_id, doc_id, "update", 1, 0, &update);
    // A holder's copies of a share's keys (#369), sealed here: the JS side must open both.
    let share_seed = [0x5au8; 32];
    let share_id = "00112233445566778899aabbccddeeff";
    let sk = share_keys(&share_seed);
    let holder_secret = [0x77u8; 32];
    let hk = holder_keys(&holder_secret);
    let edit_holder = "0123456789abcdef0123456789abcdef";
    let read_holder = "fedcba9876543210fedcba9876543210";
    let edit = seal_held_keys(&hk.seal_key, edit_holder, share_id, &HeldKeys::Edit { seed: share_seed });
    let read = seal_held_keys(&hk.seal_key, read_holder, share_id, &HeldKeys::Read { enc_key: sk.enc_key, pubkey: sk.pubkey });

    // A connection's keys from its secret (#369): the JS side must derive the same.
    let conn_secret = [0x5au8; 32];
    let ck = plim_core::crypto::connection_keys(&conn_secret);

    let fx = serde_json::json!({
        "connection": {
            "secret": hex::encode(conn_secret),
            "pubkey": hex::encode(ck.pubkey),
            "pubkey_hash": ck.pubkey_hash,
            "list_holder_id": ck.list_holder_id,
            "list_holder_secret": hex::encode(ck.list_holder_secret),
            "holder_id": edit_holder,
            "holder_secret": hex::encode(plim_core::crypto::connection_holder_secret(&conn_secret, edit_holder)),
        },
        "holder": {
            "secret": hex::encode(holder_secret),
            "token": hex::encode(hk.token),
            "share_id": share_id,
            "share_seed": hex::encode(share_seed),
            "edit": { "holder_id": edit_holder, "nonce": B64.encode(edit.nonce), "ciphertext": B64.encode(&edit.ciphertext) },
            "read": { "holder_id": read_holder, "nonce": B64.encode(read.nonce), "ciphertext": B64.encode(&read.ciphertext) },
        },
        "phrase": PHRASE,
        "pubkey_hash": id.pubkey_hash,
        "account_id": account_id,
        "doc_id": doc_id,
        "vault_key": hex::encode(vault_key),
        "keyring": { "key_version": 1, "nonce": B64.encode(kr.nonce), "wrapped": B64.encode(&kr.wrapped), "sig": B64.encode(kr.sig) },
        "update": { "key_version": 1, "nonce": B64.encode(blob.nonce), "ciphertext": B64.encode(&blob.ciphertext), "sig": B64.encode(blob.sig) },
        "text": text,
        "title": "Rust title",
    });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/tests/fixtures/interop-rust.json");
    std::fs::write(path, serde_json::to_string_pretty(&fx).unwrap() + "\n").unwrap();
    println!("wrote {path}");
}
