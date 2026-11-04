//! Holders (#369): a shared note's keys held by more than one link, /api/holders.
mod common;
use common::*;

use base64::engine::general_purpose::STANDARD as B64;

use plim_core::crypto::{HeldKeys, HolderKeys, ShareKeys, holder_keys, open_held_keys, seal_held_keys, share_keys};

const SHARE: &str = "00112233445566778899aabbccddeeff";
const SHARE2: &str = "ffeeddccbbaa99887766554433221100";
const HOLDER: &str = "0123456789abcdef0123456789abcdef";

struct Share {
    id: String,
    keys: ShareKeys,
    seed: [u8; 32],
}

impl Share {
    fn new(id: &str, seed: u8) -> Self {
        Share { id: id.into(), keys: share_keys(&[seed; 32]), seed: [seed; 32] }
    }
    fn create_body(&self) -> Value {
        let (nonce, ct) = ([3u8; 12], b"ciphertext");
        let sig = self.keys.signing.sign(&sig::share_blob_msg(&self.id, "update", 0, &nonce, ct));
        json!({
            "share_id": self.id,
            "pubkey": b64(&self.keys.pubkey),
            "read_hash": b64(&sig::sha256(&self.keys.read_token)),
            "update": { "covers_seq": 0, "nonce": b64(&nonce), "ciphertext": b64(ct), "sig": b64(&sig.to_bytes()) },
        })
    }
}

/// A holder's secret and keys, and the request that registers it for `share` with `held`.
struct Holder {
    id: String,
    keys: HolderKeys,
}

impl Holder {
    fn new(id: &str, secret: u8) -> Self {
        Holder { id: id.into(), keys: holder_keys(&[secret; 32]) }
    }
    fn token(&self) -> String {
        hex::encode(self.keys.token)
    }
    fn sealed(&self, share_id: &str, held: &HeldKeys) -> (String, String) {
        let s = seal_held_keys(&self.keys.seal_key, &self.id, share_id, held);
        (b64(&s.nonce), b64(&s.ciphertext))
    }
    fn create_body(&self, share_id: &str, held: &HeldKeys) -> Value {
        let (nonce, ciphertext) = self.sealed(share_id, held);
        json!({ "holder_id": self.id, "share_id": share_id, "role": held.role(), "token_hash": b64(&sig::sha256(&self.keys.token)), "nonce": nonce, "ciphertext": ciphertext })
    }
    async fn get(&self, app: &Router, token: &str) -> (StatusCode, Value) {
        call_with(app, "GET", &format!("/api/holders/{}", self.id), None, None, &[("x-holder-token", token.to_string())]).await
    }
}

async fn owner(app: &Router, seed: u8, account: &str) -> (User, String) {
    let u = User::new(seed, account);
    signup(app, &u).await;
    let t = login(app, &u.sk).await.unwrap();
    (u, t)
}

#[tokio::test]
async fn a_holder_gets_the_shares_keys_with_its_token_and_only_its_owner_manages_it() {
    let app = test_app(1 << 20, false);
    let (u, t) = owner(&app, 1, ACCT).await;
    let share = Share::new(SHARE, 9);
    assert_eq!(call(&app, "POST", "/api/shares", Some(&t), Some(share.create_body())).await.0, StatusCode::CREATED);

    // Registered by the share's owner: the share's seed, sealed to the holder.
    let h = Holder::new(HOLDER, 7);
    let held = HeldKeys::Edit { seed: share.seed };
    let (status, body) = call(&app, "POST", "/api/holders", Some(&t), Some(h.create_body(SHARE, &held))).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(h.create_body(SHARE, &held))).await.0, StatusCode::CONFLICT, "the same id twice");

    // With its token, the holder gets the row and opens the keys: the share's seed.
    let (status, row) = h.get(&app, &h.token()).await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["share_id"], SHARE);
    assert_eq!(row["role"], "edit");
    assert!(row["created_at"].as_i64().is_some_and(|t| t > 0), "when it was made (#505): {row}");
    let opened = open_held_keys(
        &h.keys.seal_key,
        &h.id,
        SHARE,
        &B64.decode(row["nonce"].as_str().unwrap()).unwrap(),
        &B64.decode(row["ciphertext"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(opened, held);
    // Sealed to this holder and share only: another holder's key, or another share's id, opens nothing.
    assert!(open_held_keys(&holder_keys(&[8; 32]).seal_key, &h.id, SHARE, &[0; 12], &[0; 49]).is_err());
    assert!(
        open_held_keys(
            &h.keys.seal_key,
            &h.id,
            SHARE2,
            &B64.decode(row["nonce"].as_str().unwrap()).unwrap(),
            &B64.decode(row["ciphertext"].as_str().unwrap()).unwrap()
        )
        .is_err()
    );
    // The wrong token, or none, looks like no such holder.
    assert_eq!(h.get(&app, &hex::encode([0u8; 32])).await.0, StatusCode::NOT_FOUND);
    assert_eq!(h.get(&app, "").await.0, StatusCode::NOT_FOUND);
    assert_eq!(h.get(&app, "zz").await.0, StatusCode::NOT_FOUND);

    // The owner sees its holders (never their keys), with when each was last used.
    let (status, list) = call(&app, "GET", &format!("/api/shares/{SHARE}/holders"), Some(&t), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["holders"].as_array().unwrap().len(), 1);
    assert_eq!(list["holders"][0]["holder_id"], HOLDER);
    assert_eq!(list["holders"][0]["role"], "edit");
    assert!(list["holders"][0]["last_used_at"].is_i64(), "used just now: {list}");
    assert!(list["holders"][0].get("ciphertext").is_none() && list["holders"][0].get("nonce").is_none());

    // Someone else can't add a holder to it, list them, or re-seal one.
    let (_, stranger) = owner(&app, 2, "beefbeefbeefbeefbeefbeefbeefbeef").await;
    let other = Holder::new("abcdefabcdefabcdefabcdefabcdefab", 5);
    assert_eq!(call(&app, "POST", "/api/holders", Some(&stranger), Some(other.create_body(SHARE, &held))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, "GET", &format!("/api/shares/{SHARE}/holders"), Some(&stranger), None).await.0, StatusCode::NOT_FOUND);
    let (nonce, ciphertext) = h.sealed(SHARE, &held);
    let reseal = json!({ "share_id": SHARE, "role": "edit", "nonce": nonce, "ciphertext": ciphertext });
    assert_eq!(call(&app, "PUT", &format!("/api/holders/{HOLDER}"), Some(&stranger), Some(reseal)).await.0, StatusCode::NOT_FOUND);

    // Replacing the links: the holder re-sealed to the new share (a read holder now), the old share deleted.
    let share2 = Share::new(SHARE2, 4);
    assert_eq!(call(&app, "POST", "/api/shares", Some(&t), Some(share2.create_body())).await.0, StatusCode::CREATED);
    let held2 = HeldKeys::Read { enc_key: share2.keys.enc_key, pubkey: share2.keys.pubkey };
    let (nonce, ciphertext) = h.sealed(SHARE2, &held2);
    let (status, body) = call(&app, "PUT", &format!("/api/holders/{HOLDER}"), Some(&t), Some(json!({ "share_id": SHARE2, "role": "read", "nonce": nonce, "ciphertext": ciphertext }))).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(share_action(&app, &u, &t, SHARE, "delete").await.0, StatusCode::NO_CONTENT);
    let (status, row) = h.get(&app, &h.token()).await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["share_id"], SHARE2);
    assert_eq!(row["role"], "read", "re-sealed as a read holder");
    let opened = open_held_keys(
        &h.keys.seal_key,
        &h.id,
        SHARE2,
        &B64.decode(row["nonce"].as_str().unwrap()).unwrap(),
        &B64.decode(row["ciphertext"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(opened, held2);

    // Taking the holder away needs the owner's signature (#144); then its token finds nothing.
    check_needs_signature(&app, &u, &t, "DELETE", &format!("/api/holders/{HOLDER}"), sig::action::DELETE_HOLDER, HOLDER, &[], None, StatusCode::NO_CONTENT).await;
    assert_eq!(h.get(&app, &h.token()).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, "GET", &format!("/api/shares/{SHARE2}/holders"), Some(&t), None).await.1["holders"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn a_holder_of_a_share_turned_off_or_gone_is_told_so_and_a_share_has_at_most_fifty() {
    let app = test_app(1 << 20, false);
    let (u, t) = owner(&app, 1, ACCT).await;
    let share = Share::new(SHARE, 9);
    assert_eq!(call(&app, "POST", "/api/shares", Some(&t), Some(share.create_body())).await.0, StatusCode::CREATED);
    let held = HeldKeys::Read { enc_key: share.keys.enc_key, pubkey: share.keys.pubkey };
    let h = Holder::new(HOLDER, 7);
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(h.create_body(SHARE, &held))).await.0, StatusCode::CREATED);
    assert_eq!(h.get(&app, &h.token()).await.0, StatusCode::OK);
    // The links turned off: the holder hears so (and can't be added to it).
    assert_eq!(share_action(&app, &u, &t, SHARE, "revoke").await.0, StatusCode::NO_CONTENT);
    assert_eq!(h.get(&app, &h.token()).await.0, StatusCode::GONE);
    let late = Holder::new("abcdefabcdefabcdefabcdefabcdefab", 5);
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(late.create_body(SHARE, &held))).await.0, StatusCode::GONE);
    // The share deleted: gone too.
    assert_eq!(share_action(&app, &u, &t, SHARE, "delete").await.0, StatusCode::NO_CONTENT);
    assert_eq!(h.get(&app, &h.token()).await.0, StatusCode::GONE);

    // At most fifty holders a share.
    let share2 = Share::new(SHARE2, 4);
    assert_eq!(call(&app, "POST", "/api/shares", Some(&t), Some(share2.create_body())).await.0, StatusCode::CREATED);
    let held2 = HeldKeys::Read { enc_key: share2.keys.enc_key, pubkey: share2.keys.pubkey };
    for i in 0..50u8 {
        let hi = Holder::new(&format!("{:032x}", 1000 + i as u64), i);
        assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(hi.create_body(SHARE2, &held2))).await.0, StatusCode::CREATED, "holder {i}");
    }
    let one_more = Holder::new(&format!("{:032x}", 2000u64), 99);
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(one_more.create_body(SHARE2, &held2))).await.0, StatusCode::CONFLICT);
    // Bad requests: a role that isn't one, a short token hash, a nonce that isn't 12 bytes.
    let mut bad = one_more.create_body(SHARE2, &held2);
    bad["role"] = json!("owner");
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(bad)).await.0, StatusCode::BAD_REQUEST);
    let mut bad = one_more.create_body(SHARE2, &held2);
    bad["token_hash"] = json!(b64(&[1u8; 16]));
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(bad)).await.0, StatusCode::BAD_REQUEST);
    let mut bad = one_more.create_body(SHARE2, &held2);
    bad["nonce"] = json!(b64(&[1u8; 8]));
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(bad)).await.0, StatusCode::BAD_REQUEST);
}
