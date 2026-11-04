//! Live sync over /api/live (a real listening server, so real WebSockets).
mod common;
use common::*;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use plim_server::live::MAX_SOCKETS_PER_ACCOUNT;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The app, served on a free port; returns it (for HTTP calls) and the ws:// URL.
async fn serve() -> (Router, String) {
    serve_app(test_app(1 << 20, false)).await
}

async fn serve_app(app: Router) -> (Router, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = app.clone().into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
    (app, format!("ws://{addr}/api/live"))
}

async fn connect(url: &str) -> Ws {
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

/// The next JSON message (skipping pings), or the close code.
async fn next(ws: &mut Ws) -> Result<Value, Option<u16>> {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timed out waiting for a message");
        match msg {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["type"] != "ping" {
                    return Ok(v);
                }
            }
            Some(Ok(Message::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
            Some(Ok(_)) => {}
            _ => return Err(None),
        }
    }
}

/// Nothing more arrives within `ms` (apart from pings).
async fn quiet(ws: &mut Ws, ms: u64) -> bool {
    tokio::time::timeout(Duration::from_millis(ms), next(ws)).await.is_err()
}

async fn signed_in(url: &str, token: &str) -> Ws {
    let mut ws = connect(url).await;
    send(&mut ws, json!({ "auth": token })).await;
    let ready = next(&mut ws).await.unwrap();
    assert_eq!(ready["type"], "ready");
    // The web files' version, as API responses carry it (#134).
    assert!(ready["v"].as_str().is_some_and(|v| v.len() == 12), "{ready}");
    ws
}

#[tokio::test]
async fn sign_in_is_the_first_message() {
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;

    let mut ws = connect(&url).await;
    send(&mut ws, json!({ "sub": "aa" })).await;
    assert_eq!(next(&mut ws).await, Err(Some(4401)));

    let mut ws = connect(&url).await;
    send(&mut ws, json!({ "auth": "00".repeat(32) })).await;
    assert_eq!(next(&mut ws).await, Err(Some(4401)));

    let token = login(&app, &u.sk).await.unwrap();
    signed_in(&url, &token).await;
}

#[tokio::test]
async fn history_then_live_updates_and_snapshots() {
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"one"))).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"two"))).await;

    let mut ws = signed_in(&url, &t).await;
    send(&mut ws, json!({ "sub": "aa", "after": 1 })).await;
    let doc = next(&mut ws).await.unwrap();
    assert_eq!(doc["type"], "doc");
    assert_eq!(doc["doc"], "aa");
    let seqs: Vec<i64> = doc["updates"].as_array().unwrap().iter().map(|u| u["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [2], "only what comes after `after`");

    // Uploaded over HTTP (another device): pushed at once.
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"three"))).await;
    let ev = next(&mut ws).await.unwrap();
    assert_eq!((ev["type"].as_str(), ev["seq"].as_i64()), (Some("update"), Some(3)));
    assert_eq!(ev["ciphertext"], b64(b"three"));

    let (s, v) = call(&app, "POST", "/api/docs/aa/snapshots", Some(&t), Some(u.blob("aa", "snapshot", 1, 3, b"snap"))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let ev = next(&mut ws).await.unwrap();
    assert_eq!((ev["type"].as_str(), ev["covers_seq"].as_i64()), (Some("snapshot"), Some(3)));

    // Other docs aren't pushed; after unsubscribing, neither is this one.
    call(&app, "POST", "/api/docs/bb/updates", Some(&t), Some(u.blob("bb", "update", 1, 0, b"x"))).await;
    assert!(quiet(&mut ws, 300).await);
    send(&mut ws, json!({ "unsub": "aa" })).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"four"))).await;
    assert!(quiet(&mut ws, 300).await);
}

#[tokio::test]
async fn never_sees_another_accounts_docs() {
    let (app, url) = serve().await;
    let a = User::new(1, ACCT);
    let b = User::new(2, "fedcba9876543210fedcba9876543210");
    signup(&app, &a).await;
    signup(&app, &b).await;
    let ta = login(&app, &a.sk).await.unwrap();
    let tb = login(&app, &b.sk).await.unwrap();
    call(&app, "POST", "/api/docs/aa/updates", Some(&ta), Some(a.blob("aa", "update", 1, 0, b"secret"))).await;

    let mut ws = signed_in(&url, &tb).await;
    send(&mut ws, json!({ "sub": "aa", "after": 0 })).await;
    let doc = next(&mut ws).await.unwrap();
    assert_eq!(doc["updates"].as_array().unwrap().len(), 0, "B's own (empty) doc aa, not A's");
    call(&app, "POST", "/api/docs/aa/updates", Some(&ta), Some(a.blob("aa", "update", 1, 0, b"more"))).await;
    assert!(quiet(&mut ws, 300).await);
}

#[tokio::test]
async fn concurrent_uploads_all_arrive() {
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let mut ws = signed_in(&url, &t).await;
    send(&mut ws, json!({ "sub": "aa", "after": 0 })).await;
    next(&mut ws).await.unwrap();

    let uploads: Vec<_> = (0..40)
        .map(|i| {
            let (app, t, body) = (app.clone(), t.clone(), u.blob("aa", "update", 1, 0, format!("u{i}").as_bytes()));
            tokio::spawn(async move { call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(body)).await })
        })
        .collect();
    for h in uploads {
        assert_eq!(h.await.unwrap().0, StatusCode::OK);
    }
    let mut seqs = Vec::new();
    while seqs.len() < 40 {
        seqs.push(next(&mut ws).await.unwrap()["seq"].as_i64().unwrap());
    }
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=40).collect::<Vec<_>>(), "every update, once (in any order)");
}

#[tokio::test]
async fn a_phrase_change_closes_the_accounts_sockets() {
    let (app, url) = serve().await;
    let old = User::new(1, ACCT);
    signup(&app, &old).await;
    let t = login(&app, &old.sk).await.unwrap();
    let mut ws = signed_in(&url, &t).await;

    let new = User::new(2, ACCT);
    let np = new.pubkey();
    let (s, _) = call(&app, "POST", "/api/account/rotate", Some(&t), Some(json!({
        "new_pubkey": b64(&np), "keyring": [new.keyring_entry(1)],
        "old_sig": b64(&old.sk.sign(&sig::rotate_msg(TAG_ROTATE_OLD, ACCT, &np)).to_bytes()),
        "new_sig": b64(&new.sk.sign(&sig::rotate_msg(TAG_ROTATE_NEW, ACCT, &np)).to_bytes()),
    }))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(next(&mut ws).await, Err(Some(4401)));
}

/// Signing out (#146): that session ends at once, its socket closes; the account's other session,
/// and its socket, carry on.
#[tokio::test]
async fn signing_out_ends_that_session_and_its_socket_only() {
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let (a, b) = (login(&app, &u.sk).await.unwrap(), login(&app, &u.sk).await.unwrap());
    let (mut ws_a, mut ws_b) = (signed_in(&url, &a).await, signed_in(&url, &b).await);
    assert_eq!(call(&app, "POST", "/api/auth/logout", Some(&a), None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(next(&mut ws_a).await, Err(Some(4401)), "its socket closes");
    assert_eq!(call(&app, "GET", "/api/account", Some(&a), None).await.0, StatusCode::UNAUTHORIZED, "the token works no more");
    assert_eq!(call(&app, "POST", "/api/auth/logout", Some(&a), None).await.0, StatusCode::UNAUTHORIZED, "nor to sign out again");
    assert_eq!(call(&app, "GET", "/api/account", Some(&b), None).await.0, StatusCode::OK, "the other session works");
    assert!(quiet(&mut ws_b, 300).await, "and its socket stays open");
    assert_eq!(call(&app, "POST", "/api/auth/logout", None, None).await.0, StatusCode::UNAUTHORIZED, "no session: nothing to end");
}

/// The app with its state (for reaching the database), pinging every 200 ms.
async fn serve_fast_pings() -> (AppState, Router, String) {
    let st = AppState::new(config(":memory:", 1 << 20, false)).unwrap();
    st.live().set_ping_every(Duration::from_millis(200));
    let (app, url) = serve_app(app(st.clone())).await;
    (st, app, url)
}

#[tokio::test]
async fn an_expired_session_is_asked_for_a_new_token_not_dropped() {
    let (st, app, url) = serve_fast_pings().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let mut ws = signed_in(&url, &t).await;
    send(&mut ws, json!({ "sub": "aa", "after": 0 })).await;
    next(&mut ws).await.unwrap();

    // 15 minutes pass: the session expires.
    st.db().execute("UPDATE sessions SET expires_at = 0", []).unwrap();
    assert_eq!(next(&mut ws).await.unwrap()["type"], "reauth");
    let fresh = login(&app, &u.sk).await.unwrap();
    send(&mut ws, json!({ "auth": fresh })).await;

    // Still open well past the grace period, and still pushing.
    tokio::time::sleep(Duration::from_millis(800)).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&fresh), Some(u.blob("aa", "update", 1, 0, b"after"))).await;
    let ev = next(&mut ws).await.unwrap();
    assert_eq!((ev["type"].as_str(), ev["seq"].as_i64()), (Some("update"), Some(1)));
}

#[tokio::test]
async fn an_expired_session_that_never_renews_is_closed() {
    let (st, app, url) = serve_fast_pings().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let mut ws = signed_in(&url, &t).await;
    st.db().execute("UPDATE sessions SET expires_at = 0", []).unwrap();
    assert_eq!(next(&mut ws).await.unwrap()["type"], "reauth");
    assert_eq!(next(&mut ws).await, Err(Some(4401)), "closed once the grace period (two pings) is over");
}

#[tokio::test]
async fn guests_follow_shared_notes_with_the_read_token() {
    use plim_core::crypto::share_keys;
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let id = "00112233445566778899aabbccddeeff";
    let keys = share_keys(&[9; 32]);
    let blob = |ct: &[u8]| {
        let sig = keys.signing.sign(&sig::share_blob_msg(id, "update", 0, &[3; 12], ct));
        json!({ "nonce": b64(&[3; 12]), "ciphertext": b64(ct), "sig": b64(&sig.to_bytes()) })
    };
    let (s, _) = call(&app, "POST", "/api/shares", Some(&t), Some(json!({
        "share_id": id, "pubkey": b64(&keys.pubkey), "read_hash": b64(&sig::sha256(&keys.read_token)), "update": blob(b"first"),
    }))).await;
    assert_eq!(s, StatusCode::CREATED);

    // A guest (no account) can only follow shared notes.
    let mut guest = connect(&url).await;
    send(&mut guest, json!({ "guest": true })).await;
    assert_eq!(next(&mut guest).await.unwrap()["type"], "ready");
    send(&mut guest, json!({ "sub": format!("share:{id}"), "after": 0, "token": "00".repeat(32) })).await;
    assert_eq!(next(&mut guest).await.unwrap()["type"], "denied", "wrong read token");
    send(&mut guest, json!({ "sub": format!("share:{id}"), "after": 0, "token": hex::encode(keys.read_token) })).await;
    let doc = next(&mut guest).await.unwrap();
    assert_eq!((doc["type"].as_str(), doc["doc"].as_str()), (Some("doc"), Some(format!("share:{id}").as_str())));
    assert_eq!(doc["updates"][0]["ciphertext"], b64(b"first"));
    assert_eq!(doc["updates"][0]["sig"], blob(b"first")["sig"]);

    // Someone else's edit is pushed, signed (clients check, #77); revoking tells everyone.
    call(&app, "POST", &format!("/api/shares/{id}/updates"), None, Some(blob(b"second"))).await;
    let ev = next(&mut guest).await.unwrap();
    assert_eq!((ev["type"].as_str(), ev["seq"].as_i64()), (Some("update"), Some(2)));
    assert_eq!(ev["sig"], blob(b"second")["sig"]);
    share_action(&app, &u, &t, id, "revoke").await;
    let ev = next(&mut guest).await.unwrap();
    assert_eq!((ev["type"].as_str(), ev["doc"].as_str()), (Some("revoked"), Some(format!("share:{id}").as_str())));

    // A guest asking for an account's own doc is refused.
    send(&mut guest, json!({ "sub": "aa", "after": 0 })).await;
    assert_eq!(next(&mut guest).await, Err(Some(4400)));
}

#[tokio::test]
async fn guessing_read_tokens_over_a_socket_is_rate_limited() {
    let (_, url) = serve().await;
    let mut guest = connect(&url).await;
    send(&mut guest, json!({ "guest": true })).await;
    assert_eq!(next(&mut guest).await.unwrap()["type"], "ready");
    let sub = |i: u32| json!({ "sub": "share:00112233445566778899aabbccddeeff", "after": 0, "token": format!("{i:064x}") });
    for i in 0..600 {
        send(&mut guest, sub(i)).await;
        assert_eq!(next(&mut guest).await.unwrap()["type"], "denied");
    }
    send(&mut guest, sub(600)).await;
    assert_eq!(next(&mut guest).await, Err(Some(4429)), "counted with GET /shares/{{id}}, per address");
}

#[tokio::test]
async fn presence_is_relayed_to_the_others_in_a_shared_note_and_never_stored() {
    use plim_core::crypto::share_keys;
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let id = "00112233445566778899aabbccddeeff";
    let keys = share_keys(&[9; 32]);
    let sig = keys.signing.sign(&sig::share_blob_msg(id, "update", 0, &[3; 12], b"x"));
    call(&app, "POST", "/api/shares", Some(&t), Some(json!({
        "share_id": id, "pubkey": b64(&keys.pubkey), "read_hash": b64(&sig::sha256(&keys.read_token)),
        "update": { "nonce": b64(&[3; 12]), "ciphertext": b64(b"x"), "sig": b64(&sig.to_bytes()) },
    }))).await;
    let doc = format!("share:{id}");
    let join = |ws: Ws| {
        let doc = doc.clone();
        let token = hex::encode(keys.read_token);
        async move {
            let mut ws = ws;
            send(&mut ws, json!({ "guest": true })).await;
            next(&mut ws).await.unwrap();
            send(&mut ws, json!({ "sub": doc, "after": 0, "token": token })).await;
            assert_eq!(next(&mut ws).await.unwrap()["type"], "doc");
            ws
        }
    };
    let mut a = join(connect(&url).await).await;
    let mut b = join(connect(&url).await).await;

    // A's presence reaches B, not A itself.
    send(&mut a, json!({ "presence": doc, "data": "opaque-ciphertext" })).await;
    let ev = next(&mut b).await.unwrap();
    assert_eq!((ev["type"].as_str(), ev["data"].as_str()), (Some("presence"), Some("opaque-ciphertext")));
    assert!(quiet(&mut a, 300).await, "not echoed back");

    // Only for a share the socket follows, small, and at most 10 a second.
    let mut stranger = connect(&url).await;
    send(&mut stranger, json!({ "guest": true })).await;
    next(&mut stranger).await.unwrap();
    send(&mut stranger, json!({ "presence": doc, "data": "nope" })).await;
    send(&mut a, json!({ "presence": doc, "data": "x".repeat(5000) })).await;
    assert!(quiet(&mut b, 300).await);
    for i in 0..25 {
        send(&mut a, json!({ "presence": doc, "data": format!("burst{i}") })).await;
    }
    let mut got = 0;
    while !quiet(&mut b, 300).await {
        got += 1;
    }
    assert!((1..=10).contains(&got), "{got} relayed of a burst of 25");

    // Nothing of it is stored: a newcomer gets the doc's history only.
    let c = join(connect(&url).await).await;
    drop(c);
    let (_, v) = {
        let req = Request::builder().uri(format!("/api/shares/{id}/doc?after=0")).header("x-share-token", hex::encode(keys.read_token)).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        ((), serde_json::from_slice::<Value>(&bytes).unwrap())
    };
    assert_eq!(v["updates"].as_array().unwrap().len(), 1);

    // Links turned off: everyone following is told, and their cursors stop too.
    tokio::time::sleep(Duration::from_millis(1100)).await; // (a fresh second for A's presence)
    share_action(&app, &u, &t, id, "revoke").await;
    for ws in [&mut a, &mut b] {
        assert_eq!(next(ws).await.unwrap()["type"], "revoked");
    }
    send(&mut a, json!({ "presence": doc, "data": "after revoke" })).await;
    assert!(quiet(&mut b, 300).await, "no presence once the links are off");
}

#[tokio::test]
async fn sockets_per_account_are_limited() {
    let (app, url) = serve().await;
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let mut open = Vec::new();
    for _ in 0..MAX_SOCKETS_PER_ACCOUNT {
        open.push(signed_in(&url, &t).await);
    }
    let mut extra = connect(&url).await;
    send(&mut extra, json!({ "auth": t })).await;
    assert_eq!(next(&mut extra).await, Err(Some(4429)));
    // Closing one frees a place.
    let mut first = open.remove(0);
    first.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame { code: CloseCode::Normal, reason: "".into() })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    signed_in(&url, &t).await;
}
