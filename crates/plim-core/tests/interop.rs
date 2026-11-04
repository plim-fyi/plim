//! The Rust client must open data sealed by the web app (fixture written by
//! `node web/tests/run.mjs --write-fixture`). The reverse direction is checked
//! by the JS suite against `interop-rust.json` (see examples/interop_fixture.rs).

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use plim_core::crypto::{HeldKeys, Identity, doc_key, holder_keys, open_blob, open_held_keys, share_keys, unwrap_vault_key};
use plim_core::sig;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Map, Out, Transact, Update};

#[test]
fn rust_opens_data_sealed_by_js() {
    let fx: serde_json::Value =
        serde_json::from_str(include_str!("../../../web/tests/fixtures/interop-js.json")).unwrap();
    let s = |k: &str| fx[k].as_str().unwrap();
    let b = |v: &serde_json::Value| B64.decode(v.as_str().unwrap()).unwrap();

    // Same phrase → same identity as the web app.
    let id = Identity::from_mnemonic(s("phrase")).unwrap();
    assert_eq!(id.pubkey_hash, s("pubkey_hash"));

    let kr = &fx["keyring"];
    let (nonce, wrapped) = (b(&kr["nonce"]), b(&kr["wrapped"]));
    assert!(sig::verify(&id.pubkey, &sig::keyring_msg(s("account_id"), 1, &nonce, &wrapped), &b(&kr["sig"])));
    let vault_key = unwrap_vault_key(&id, s("account_id"), 1, &nonce, &wrapped).unwrap();
    assert_eq!(hex::encode(vault_key), s("vault_key"));

    let u = &fx["update"];
    let key = doc_key(&vault_key, s("doc_id"));
    let bytes = open_blob(&key, s("account_id"), s("doc_id"), "update", 1, &b(&u["nonce"]), &b(&u["ciphertext"])).unwrap();

    let doc = Doc::new();
    let body = doc.get_or_insert_text("body");
    let notes = doc.get_or_insert_map("notes");
    doc.transact_mut().apply_update(Update::decode_v1(&bytes).unwrap()).unwrap();
    let txn = doc.transact();
    assert_eq!(body.get_string(&txn), s("text"));
    let Some(Out::YMap(note)) = notes.get(&txn, "n1") else { panic!("nested map missing") };
    assert_eq!(note.get(&txn, "title").unwrap().to_string(&txn), s("title"));

    // A holder's keys sealed by the web app (#369): the same token, and both copies open.
    let h = &fx["holder"];
    let hs = |k: &str| h[k].as_str().unwrap();
    let secret: [u8; 32] = hex::decode(hs("secret")).unwrap().try_into().unwrap();
    let hk = holder_keys(&secret);
    assert_eq!(hex::encode(hk.token), hs("token"));
    let seed: [u8; 32] = hex::decode(hs("share_seed")).unwrap().try_into().unwrap();
    let (e, r) = (&h["edit"], &h["read"]);
    let opened = open_held_keys(&hk.seal_key, e["holder_id"].as_str().unwrap(), hs("share_id"), &b(&e["nonce"]), &b(&e["ciphertext"])).unwrap();
    assert_eq!(opened, HeldKeys::Edit { seed });
    let sk = share_keys(&seed);
    let opened = open_held_keys(&hk.seal_key, r["holder_id"].as_str().unwrap(), hs("share_id"), &b(&r["nonce"]), &b(&r["ciphertext"])).unwrap();
    assert_eq!(opened, HeldKeys::Read { enc_key: sk.enc_key, pubkey: sk.pubkey });
    // Not for another holder.
    assert!(open_held_keys(&hk.seal_key, r["holder_id"].as_str().unwrap(), hs("share_id"), &b(&e["nonce"]), &b(&e["ciphertext"])).is_err());

    // A connection's keys (#369): from the same secret, the same keys as the web app derives.
    let c = &fx["connection"];
    let cs = |k: &str| c[k].as_str().unwrap();
    let secret: [u8; 32] = hex::decode(cs("secret")).unwrap().try_into().unwrap();
    let ck = plim_core::crypto::connection_keys(&secret);
    assert_eq!(hex::encode(ck.pubkey), cs("pubkey"));
    assert_eq!(ck.pubkey_hash, cs("pubkey_hash"));
    assert_eq!(ck.list_holder_id, cs("list_holder_id"));
    assert_eq!(hex::encode(ck.list_holder_secret), cs("list_holder_secret"));
    assert_eq!(hex::encode(plim_core::crypto::connection_holder_secret(&secret, cs("holder_id"))), cs("holder_secret"));
}
