// Prints web/tests/fixtures/share-vectors.json (shared key-derivation vectors for shared notes).
use ed25519_dalek::Signer;
use plim_core::{crypto::share_keys, sig};

fn main() {
    let seed = [7u8; 32];
    let share_id = "0123456789abcdef0123456789abcdef";
    let k = share_keys(&seed);
    let msg = sig::share_blob_msg(share_id, "update", 0, &[1; 12], b"ciphertext");
    let v = serde_json::json!({
        "seed": hex::encode(seed),
        "share_id": share_id,
        "enc_key": hex::encode(k.enc_key),
        "pubkey": hex::encode(k.pubkey),
        "read_token": hex::encode(k.read_token),
        "blob_msg": hex::encode(&msg),
        "blob_sig": hex::encode(k.signing.sign(&msg).to_bytes()),
        "aad": hex::encode(sig::share_aad(share_id, "snapshot")),
    });
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}
