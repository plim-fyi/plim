//! Helpers shared by the server integration tests.
#![allow(dead_code, unused_imports)]

pub use axum::Router;
pub use axum::body::Body;
pub use axum::http::{Request, StatusCode};
pub use base64::Engine;
pub use base64::engine::general_purpose::STANDARD as B64;
pub use ed25519_dalek::{Signer, SigningKey};
pub use plim_server::sig::{self, TAG_ROTATE_NEW, TAG_ROTATE_OLD};
pub use plim_server::{AppState, Config, app, pow};
pub use http_body_util::BodyExt;
pub use serde_json::{Value, json};
pub use tower::ServiceExt;

pub fn config(db_path: &str, quota: i64, prune: bool) -> Config {
    Config {
        db_path: db_path.into(),
        web_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../web").into(),
        pow_bits: 8,
        quota_bytes: quota,
        max_blob_bytes: 1024 * 1024,
        prune_on_snapshot: prune,
        admin_web_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../admin").into(),
        proxy: Default::default(),
        public_url: None,
        version_every_secs: 3600,
        max_accounts: None,
        connector_url: None,
    }
}

pub fn test_app(quota: i64, prune: bool) -> Router {
    app(AppState::new(config(":memory:", quota, prune)).unwrap())
}

/// GET with an explicit Host header (None = no Host header at all).
pub async fn get_with_host(app: &Router, path: &str, host: Option<&str>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut req = Request::builder().uri(path);
    if let Some(h) = host {
        req = req.header("host", h);
    }
    let res = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    (status, headers, res.into_body().collect().await.unwrap().to_bytes().to_vec())
}

pub async fn call(app: &Router, method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let body = body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty);
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// `call`, with more headers.
pub async fn call_with(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, String)],
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    for (name, value) in headers {
        req = req.header(*name, value);
    }
    let body = body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty);
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// A fresh challenge for `sk`'s account (POST /auth/challenge), as raw bytes.
pub async fn challenge(app: &Router, sk: &SigningKey) -> Vec<u8> {
    let hash = sig::pubkey_hash(&sk.verifying_key().to_bytes());
    let (_, ch) = call(app, "POST", "/api/auth/challenge", None, Some(json!({ "pubkey_hash": hash }))).await;
    B64.decode(ch["nonce"].as_str().unwrap()).unwrap()
}

/// The headers of a destructive action signed with `sk` for `account` (#144): `action` on
/// `target`, with `data`, over `nonce`.
pub fn action_headers(sk: &SigningKey, account: &str, action: &str, target: &str, nonce: &[u8], data: &[u8]) -> Vec<(&'static str, String)> {
    let sig = sk.sign(&sig::action_msg(account, action, target, nonce, data));
    vec![("x-tiro-nonce", b64(nonce)), ("x-tiro-sig", b64(&sig.to_bytes()))]
}

/// A destructive action, as the clients make it (#144): a fresh challenge, signed with `sk`.
#[allow(clippy::too_many_arguments)]
pub async fn signed(
    app: &Router,
    sk: &SigningKey,
    account: &str,
    token: &str,
    method: &str,
    path: &str,
    action: &str,
    target: &str,
    data: &[u8],
    body: Option<Value>,
) -> (StatusCode, Value) {
    let nonce = challenge(app, sk).await;
    call_with(app, method, path, Some(token), body, &action_headers(sk, account, action, target, &nonce, data)).await
}

/// A destructive action (#144) is refused with only a session; with a signature for another
/// action, another target, other data or by another key; and with a challenge already used (a
/// refused try uses it up too). With a fresh, right signature it's `ok`.
#[allow(clippy::too_many_arguments)]
pub async fn check_needs_signature(
    app: &Router,
    u: &User,
    token: &str,
    method: &str,
    path: &str,
    action: &str,
    target: &str,
    data: &[u8],
    body: Option<Value>,
    ok: StatusCode,
) {
    let refused = StatusCode::FORBIDDEN;
    let send = |headers: Vec<(&'static str, String)>| {
        let body = body.clone();
        async move { call_with(app, method, path, Some(token), body, &headers).await.0 }
    };
    assert_eq!(send(vec![]).await, refused, "{path}: a session alone");
    let n = challenge(app, &u.sk).await;
    assert_eq!(send(action_headers(&u.sk, &u.account_id, "delete-account", target, &n, data)).await, refused, "{path}: another action");
    assert_eq!(send(action_headers(&u.sk, &u.account_id, action, target, &n, data)).await, refused, "{path}: a challenge used by a refused try");
    let n = challenge(app, &u.sk).await;
    assert_eq!(send(action_headers(&u.sk, &u.account_id, action, "someone-else", &n, data)).await, refused, "{path}: another target");
    let n = challenge(app, &u.sk).await;
    assert_eq!(send(action_headers(&u.sk, &u.account_id, action, target, &n, b"other data")).await, refused, "{path}: other data");
    let n = challenge(app, &u.sk).await;
    let stranger = SigningKey::from_bytes(&[42; 32]);
    assert_eq!(send(action_headers(&stranger, &u.account_id, action, target, &n, data)).await, refused, "{path}: another key");
    let n = challenge(app, &u.sk).await;
    let right = action_headers(&u.sk, &u.account_id, action, target, &n, data);
    assert_eq!(send(right.clone()).await, ok, "{path}: signed");
    // (Refused, or for what's gone now, not found: never done twice.)
    let again = send(right).await;
    assert!(again == refused || again == StatusCode::NOT_FOUND, "{path}: the same signature again: {again}");
}

/// A share's links turned off (`what`: "revoke") or the share deleted ("delete"), signed with
/// `u`'s key as its owner's client signs it (#144).
pub async fn share_action(app: &Router, u: &User, token: &str, id: &str, what: &str) -> (StatusCode, Value) {
    let (method, path, action) = match what {
        "revoke" => ("POST", format!("/api/shares/{id}/revoke"), sig::action::REVOKE_SHARE),
        _ => ("DELETE", format!("/api/shares/{id}"), sig::action::DELETE_SHARE),
    };
    signed(app, &u.sk, &u.account_id, token, method, &path, action, id, &[], None).await
}

/// A passkey's copy, as signed when it's saved: its nonce, then its ciphertext.
pub fn passkey_copy(entry: &Value) -> Vec<u8> {
    let field = |k: &str| B64.decode(entry[k].as_str().unwrap()).unwrap();
    [field("nonce"), field("ciphertext")].concat()
}

pub fn b64(b: &[u8]) -> String {
    B64.encode(b)
}

pub fn solve(salt: &[u8], bits: u32) -> u64 {
    (0..).find(|&n| pow::check(salt, n, bits)).unwrap()
}

pub struct User {
    pub sk: SigningKey,
    pub account_id: String,
}

impl User {
    pub fn new(seed: u8, account_id: &str) -> Self {
        User { sk: SigningKey::from_bytes(&[seed; 32]), account_id: account_id.into() }
    }
    pub fn pubkey(&self) -> Vec<u8> {
        self.sk.verifying_key().to_bytes().to_vec()
    }
    pub fn keyring_entry(&self, version: u64) -> Value {
        let nonce = [5u8; 12];
        let wrapped = [version as u8; 48];
        let sig = self.sk.sign(&sig::keyring_msg(&self.account_id, version, &nonce, &wrapped));
        json!({ "key_version": version, "nonce": b64(&nonce), "wrapped": b64(&wrapped), "sig": b64(&sig.to_bytes()) })
    }
    pub fn blob(&self, doc: &str, kind: &str, version: u64, covers: u64, ct: &[u8]) -> Value {
        let nonce = [9u8; 12];
        let msg = sig::blob_msg(&self.account_id, doc, kind, version, covers, &nonce, ct);
        json!({ "key_version": version, "covers_seq": covers, "nonce": b64(&nonce),
                "ciphertext": b64(ct), "sig": b64(&self.sk.sign(&msg).to_bytes()) })
    }
}

pub async fn signup(app: &Router, u: &User) -> StatusCode {
    let (_, pow) = call(app, "POST", "/api/pow", None, Some(json!({}))).await;
    let salt = B64.decode(pow["salt"].as_str().unwrap()).unwrap();
    let nonce = solve(&salt, pow["difficulty"].as_u64().unwrap() as u32);
    let (s, _) = call(app, "POST", "/api/accounts", None, Some(json!({
        "account_id": u.account_id, "pubkey": b64(&u.pubkey()), "keyring_entry": u.keyring_entry(1),
        "pow_salt": pow["salt"], "pow_nonce": nonce,
    }))).await;
    s
}

pub async fn login(app: &Router, sk: &SigningKey) -> Result<String, StatusCode> {
    let hash = sig::pubkey_hash(&sk.verifying_key().to_bytes());
    let (_, ch) = call(app, "POST", "/api/auth/challenge", None, Some(json!({ "pubkey_hash": hash }))).await;
    let nonce = B64.decode(ch["nonce"].as_str().unwrap()).unwrap();
    let sig = sk.sign(&sig::auth_msg(&nonce, &hash));
    let (s, v) = call(app, "POST", "/api/auth/verify", None, Some(json!({
        "pubkey_hash": hash, "nonce": ch["nonce"], "sig": b64(&sig.to_bytes()) }))).await;
    if s == StatusCode::OK { Ok(v["token"].as_str().unwrap().to_string()) } else { Err(s) }
}

pub const ACCT: &str = "0123456789abcdef0123456789abcdef";
