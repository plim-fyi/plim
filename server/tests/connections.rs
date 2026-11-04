//! Connections (#369): an app connected to a vault, /api/connections.
mod common;
use common::*;

use base64::engine::general_purpose::STANDARD as B64;
use plim_core::crypto::{HeldKeys, connection_holder_secret, connection_keys, holder_keys, seal_held_keys, share_keys};

const CONN: &str = "c0ffeec0ffeec0ffeec0ffeec0ffee01";
const SHARE: &str = "00112233445566778899aabbccddeeff";
const SHARE2: &str = "ffeeddccbbaa99887766554433221100";
const HOLDER: &str = "0123456789abcdef0123456789abcdef";

fn share_body(id: &str, seed: u8) -> Value {
    let k = share_keys(&[seed; 32]);
    let (nonce, ct) = ([3u8; 12], b"ciphertext");
    let sig = k.signing.sign(&sig::share_blob_msg(id, "update", 0, &nonce, ct));
    json!({
        "share_id": id, "pubkey": b64(&k.pubkey), "read_hash": b64(&sig::sha256(&k.read_token)),
        "update": { "covers_seq": 0, "nonce": b64(&nonce), "ciphertext": b64(ct), "sig": b64(&sig.to_bytes()) },
    })
}

async fn owner(app: &Router, seed: u8, account: &str) -> (User, String) {
    let u = User::new(seed, account);
    signup(app, &u).await;
    let t = login(app, &u.sk).await.unwrap();
    (u, t)
}

async fn used(app: &Router, t: &str) -> i64 {
    call(app, "GET", "/api/account", Some(t), None).await.1["used_bytes"].as_i64().unwrap()
}

#[tokio::test]
async fn a_connection_is_made_given_notes_as_holders_makes_notes_and_is_turned_off() {
    let app = test_app(1 << 20, false);
    let (u, t) = owner(&app, 1, ACCT).await;
    let secret = [0x5a; 32];
    let ck = connection_keys(&secret);

    // Made by its owner, with the key it signs with; listed, named.
    let (status, body) = call(&app, "POST", "/api/connections", Some(&t), Some(json!({ "connection_id": CONN, "name": "  Claude  ", "pubkey": b64(&ck.pubkey) }))).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(call(&app, "POST", "/api/connections", Some(&t), Some(json!({ "connection_id": CONN, "name": "Claude", "pubkey": b64(&ck.pubkey) }))).await.0, StatusCode::CONFLICT);
    assert_eq!(call(&app, "POST", "/api/connections", Some(&t), Some(json!({ "connection_id": SHARE2, "name": "", "pubkey": b64(&ck.pubkey) }))).await.0, StatusCode::BAD_REQUEST);
    let list = call(&app, "GET", "/api/connections", Some(&t), None).await.1;
    assert_eq!(list["connections"].as_array().unwrap().len(), 1);
    assert_eq!(list["connections"][0]["name"], "Claude", "(whitespace tidied)");
    assert_eq!(list["connections"][0]["holders"], 0);
    assert!(list["connections"][0]["last_used_at"].is_null());

    // A note granted to it: a holder of the connection's, its secret from the connection's.
    assert_eq!(call(&app, "POST", "/api/shares", Some(&t), Some(share_body(SHARE, 9))).await.0, StatusCode::CREATED);
    let hk = holder_keys(&connection_holder_secret(&secret, HOLDER));
    let sealed = seal_held_keys(&hk.seal_key, HOLDER, SHARE, &HeldKeys::Edit { seed: [9; 32] });
    let holder = |connection: &str| {
        json!({ "holder_id": HOLDER, "share_id": SHARE, "role": "edit", "token_hash": b64(&sig::sha256(&hk.token)),
            "nonce": b64(&sealed.nonce), "ciphertext": b64(&sealed.ciphertext), "connection_id": connection })
    };
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(holder(SHARE2))).await.0, StatusCode::NOT_FOUND, "not a connection of the owner's");
    let (status, body) = call(&app, "POST", "/api/holders", Some(&t), Some(holder(CONN))).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    // A second device asking for one on the same note, with an id of its own: it gets the first's.
    let mut again = holder(CONN);
    again["holder_id"] = json!("fedcba9876543210fedcba9876543210");
    let (status, body) = call(&app, "POST", "/api/holders", Some(&t), Some(again)).await;
    assert_eq!((status, body["holder_id"].as_str()), (StatusCode::OK, Some(HOLDER)), "one holder per connection and note: {body}");
    let holder_path = format!("/api/holders/{HOLDER}");
    let holder_headers = [("x-holder-token", hex::encode(hk.token))];
    let get_holder = || call_with(&app, "GET", &holder_path, None, None, &holder_headers);
    assert_eq!(get_holder().await.0, StatusCode::OK);
    let list = call(&app, "GET", "/api/connections", Some(&t), None).await.1;
    assert_eq!(list["connections"][0]["holders"], 1);
    assert!(list["connections"][0]["last_used_at"].is_i64(), "using a holder of its is using it: {list}");
    // Its holders, for its owner (#465): each with its share, and how many others hold that share.
    let (status, hs) = call(&app, "GET", &format!("/api/connections/{CONN}/holders"), Some(&t), None).await;
    assert_eq!(status, StatusCode::OK, "{hs}");
    assert_eq!(hs["holders"].as_array().unwrap().len(), 1);
    assert_eq!((hs["holders"][0]["holder_id"].as_str(), hs["holders"][0]["share_id"].as_str(), hs["holders"][0]["others"].as_i64()), (Some(HOLDER), Some(SHARE), Some(0)));
    assert!(hs["holders"][0].get("ciphertext").is_none(), "never its keys");

    // A note made on the owner's behalf: signed with the connection's key, counted for the owner.
    let before = used(&app, &t).await;
    let nonce = challenge(&app, &ck.signing).await;
    let headers = action_headers(&ck.signing, CONN, sig::action::CONNECTION_CREATE_SHARE, SHARE2, &nonce, &[]);
    let (status, body) = call_with(&app, "POST", &format!("/api/connections/{CONN}/shares"), None, Some(share_body(SHARE2, 4)), &headers).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(used(&app, &t).await > before, "the owner's storage");
    let k2 = share_keys(&[4; 32]);
    assert_eq!(call_with(&app, "GET", &format!("/api/shares/{SHARE2}"), None, None, &[("x-share-token", hex::encode(k2.read_token))]).await.0, StatusCode::OK);
    // Signed by someone else, for another share, or with a used challenge: refused.
    let stranger = plim_core::crypto::connection_keys(&[0x11; 32]);
    let nonce = challenge(&app, &stranger.signing).await;
    let headers = action_headers(&stranger.signing, CONN, sig::action::CONNECTION_CREATE_SHARE, "0000000000000000000000000000000a", &nonce, &[]);
    assert_eq!(call_with(&app, "POST", &format!("/api/connections/{CONN}/shares"), None, Some(share_body("0000000000000000000000000000000a", 5)), &headers).await.0, StatusCode::FORBIDDEN);
    let nonce = challenge(&app, &ck.signing).await;
    let headers = action_headers(&ck.signing, CONN, sig::action::CONNECTION_CREATE_SHARE, "0000000000000000000000000000000b", &nonce, &[]);
    assert_eq!(call_with(&app, "POST", &format!("/api/connections/{CONN}/shares"), None, Some(share_body("0000000000000000000000000000000a", 5)), &headers).await.0, StatusCode::FORBIDDEN, "another target");
    assert_eq!(call_with(&app, "POST", &format!("/api/connections/{CONN}/shares"), None, Some(share_body("0000000000000000000000000000000b", 5)), &headers).await.0, StatusCode::FORBIDDEN, "the challenge was used up");
    assert_eq!(call_with(&app, "POST", &format!("/api/connections/{CONN}/shares"), None, Some(share_body("0000000000000000000000000000000b", 5)), &[]).await.0, StatusCode::FORBIDDEN, "no signature");

    // Someone else can't see or rename it.
    let (_, stranger_t) = owner(&app, 2, "beefbeefbeefbeefbeefbeefbeefbeef").await;
    assert_eq!(call(&app, "GET", "/api/connections", Some(&stranger_t), None).await.1["connections"].as_array().unwrap().len(), 0);
    assert_eq!(call(&app, "PATCH", &format!("/api/connections/{CONN}"), Some(&stranger_t), Some(json!({ "name": "Mine" }))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, "GET", &format!("/api/connections/{CONN}/holders"), Some(&stranger_t), None).await.0, StatusCode::NOT_FOUND, "nor its holders");
    assert_eq!(call(&app, "PATCH", &format!("/api/connections/{CONN}"), Some(&t), Some(json!({ "name": "Claude (web)" }))).await.0, StatusCode::NO_CONTENT);
    assert_eq!(call(&app, "GET", "/api/connections", Some(&t), None).await.1["connections"][0]["name"], "Claude (web)");

    // Turned off: signed by the owner; its holders go, it can make no more notes, the list says so.
    check_needs_signature(&app, &u, &t, "POST", &format!("/api/connections/{CONN}/revoke"), sig::action::REVOKE_CONNECTION, CONN, &[], None, StatusCode::NO_CONTENT).await;
    assert_eq!(get_holder().await.0, StatusCode::NOT_FOUND);
    let nonce = challenge(&app, &ck.signing).await;
    let headers = action_headers(&ck.signing, CONN, sig::action::CONNECTION_CREATE_SHARE, "0000000000000000000000000000000c", &nonce, &[]);
    assert_eq!(call_with(&app, "POST", &format!("/api/connections/{CONN}/shares"), None, Some(share_body("0000000000000000000000000000000c", 6)), &headers).await.0, StatusCode::GONE);
    assert_eq!(call(&app, "POST", "/api/holders", Some(&t), Some(holder(CONN))).await.0, StatusCode::GONE, "no new holders for it");
    let list = call(&app, "GET", "/api/connections", Some(&t), None).await.1;
    assert!(list["connections"][0]["revoked_at"].is_i64());
    assert_eq!(list["connections"][0]["holders"], 0);
    // The record removed, signed.
    check_needs_signature(&app, &u, &t, "DELETE", &format!("/api/connections/{CONN}"), sig::action::DELETE_CONNECTION, CONN, &[], None, StatusCode::NO_CONTENT).await;
    assert_eq!(call(&app, "GET", "/api/connections", Some(&t), None).await.1["connections"].as_array().unwrap().len(), 0);
    let _ = B64;
}

/// A connection's requests count against its own allowance (#394), not the connector's address
/// that every user's Claude shares; unsigned, or signed wrong, they count by address as before.
#[tokio::test]
async fn a_connection_has_a_rate_allowance_of_its_own() {
    let app = test_app(1 << 20, false);
    let (_, t) = owner(&app, 1, ACCT).await;
    let secret = [0x5a; 32];
    let ck = connection_keys(&secret);
    assert_eq!(call(&app, "POST", "/api/connections", Some(&t), Some(json!({ "connection_id": CONN, "name": "Claude", "pubkey": b64(&ck.pubkey) }))).await.0, StatusCode::CREATED);
    assert_eq!(call(&app, "POST", "/api/shares", Some(&t), Some(share_body(SHARE, 9))).await.0, StatusCode::CREATED);
    let token = hex::encode(share_keys(&[9; 32]).read_token);
    let minute = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() / 60;
    let signed = b64(&ck.signing.sign(&sig::conn_rate_msg(CONN, minute)).to_bytes());
    let as_conn = vec![("x-share-token", token.clone()), ("x-tiro-connection", CONN.to_string()), ("x-tiro-connection-sig", signed)];
    let as_addr = vec![("x-share-token", token.clone())];
    let path = format!("/api/shares/{SHARE}");
    // The connection's whole allowance, then one too many: refused for it alone.
    for _ in 0..600 {
        assert_eq!(call_with(&app, "GET", &path, None, None, &as_conn).await.0, StatusCode::OK);
    }
    assert_eq!(call_with(&app, "GET", &path, None, None, &as_conn).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(call_with(&app, "GET", &path, None, None, &as_addr).await.0, StatusCode::OK, "the address's allowance is untouched");
    // Signed by another key, or for another connection: counted by address.
    let forged = b64(&connection_keys(&[1; 32]).signing.sign(&sig::conn_rate_msg(CONN, minute)).to_bytes());
    let bad = vec![("x-share-token", token.clone()), ("x-tiro-connection", CONN.to_string()), ("x-tiro-connection-sig", forged)];
    assert_eq!(call_with(&app, "GET", &path, None, None, &bad).await.0, StatusCode::OK, "a bad signature falls back to the address");
}
