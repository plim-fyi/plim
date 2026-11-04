//! JSON client for the server API. Mirrors `web/core/api.js` and the login half
//! of `web/core/account.js`.

use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use plim_core::crypto::Identity;
use plim_core::sig::{action_msg, auth_msg, delete_account_msg};

/// Sent with every request, so the server's logs can tell the terminal client apart.
const USER_AGENT: &str = concat!("plim/", env!("CARGO_PKG_VERSION"));

#[derive(Debug)]
pub enum ApiError {
    /// The server answered with an error status.
    Http(u16, String),
    /// The server could not be reached.
    Network(String),
    /// Not sent: the server is plain http:// and not on this machine (`allowed`).
    Insecure(String),
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Http(s, _) => Some(*s),
            ApiError::Network(_) | ApiError::Insecure(_) => None,
        }
    }

    pub fn is_offline(&self) -> bool {
        matches!(self, ApiError::Network(_))
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http(s, m) => write!(f, "server error {s}: {m}"),
            ApiError::Network(m) => write!(f, "can't reach the server: {m}"),
            ApiError::Insecure(base) => write!(
                f,
                "not sending anything to {base}: it's plain http://, so your session and share keys would cross the \
                 network unencrypted (your notes stay encrypted). Use its https:// address, or, if you mean it, \
                 --insecure-http (PLIM_INSECURE_HTTP=1). A server on this machine (localhost, 127.0.0.1) is fine."
            ),
        }
    }
}

impl std::error::Error for ApiError {}

/// `--insecure-http` (or PLIM_INSECURE_HTTP=1): plain http:// to any server, not only this machine.
static INSECURE_HTTP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn allow_insecure_http(yes: bool) {
    INSECURE_HTTP.store(yes, std::sync::atomic::Ordering::Relaxed);
}

/**
 * Whether a server address may carry this client's requests (#148): https:// always; plain
 * http:// only to this machine (localhost, a *.localhost name, 127.0.0.0/8, ::1), or with
 * --insecure-http. Over plain http:// to anywhere else, the session token, share read tokens and
 * holder tokens, and request metadata travel in the clear (the notes stay encrypted).
 */
pub fn allowed(base: &str, insecure_ok: bool) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else { return false };
    match url.scheme() {
        "https" => true,
        "http" => {
            let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
            insecure_ok
                || match host.parse::<std::net::IpAddr>() {
                    Ok(ip) => ip.is_loopback(),
                    Err(_) => host == "localhost" || host.ends_with(".localhost"),
                }
        }
        _ => false,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KeyringEntryJson {
    pub key_version: u64,
    pub nonce: String,
    pub wrapped: String,
    pub sig: String,
}

pub struct LoginResult {
    pub account_id: String,
    pub keyring: Vec<KeyringEntryJson>,
}

/// The sessions this process signed in to (server, token): ended when it's done (`end_sessions`,
/// #146), not left to be valid for another 15 minutes.
static STARTED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/**
 * End every session this process signed in to (#146): a token that leaked (a log, a proxy) stops
 * working when the command does. Best effort, briefly: one already expired, or a server out of
 * reach, is left as it is (it expires on its own).
 */
pub async fn end_sessions() {
    let started = std::mem::take(&mut *STARTED.lock().unwrap());
    end(started).await;
}

/// End these sessions (server, token), best effort.
async fn end(sessions: Vec<(String, String)>) {
    if sessions.is_empty() {
        return;
    }
    let Ok(http) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).user_agent(USER_AGENT).build() else { return };
    for (base, token) in sessions {
        let _ = http.post(format!("{base}/api/auth/logout")).bearer_auth(token).send().await;
    }
}

pub struct Api {
    http: reqwest::Client,
    base: String,
    token: Mutex<Option<String>>,
    /// Used to renew the session transparently when it expires.
    identity: Mutex<Option<Arc<Identity>>>,
    /// The connector's (#394): every request signed as this connection's, so the server counts it
    /// against the connection's own allowance rather than the connector's address.
    connection: Option<(String, ed25519_dalek::SigningKey)>,
}

impl Api {
    pub fn new(base: &str) -> Self {
        Api {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .user_agent(USER_AGENT)
                .build()
                .expect("HTTP client"),
            base: base.trim_end_matches('/').to_string(),
            token: Mutex::new(None),
            identity: Mutex::new(None),
            connection: None,
        }
    }

    /// Requests made for a connection (the connector's, #394).
    pub fn for_connection(mut self, id: &str, key: ed25519_dalek::SigningKey) -> Self {
        self.connection = Some((id.to_string(), key));
        self
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        self.send_with(method, path, body, &[]).await
    }

    /// GET something of a shared note (#80): its read token in X-Share-Token, which is
    /// what the server checks (no session needed).
    pub async fn get_share(&self, path: &str, token_hex: &str) -> Result<Value, ApiError> {
        self.send_with(reqwest::Method::GET, path, None, &[("x-share-token", token_hex)]).await
    }

    /// A holder's row (#369), with its token: which share the note is in, and its sealed keys.
    pub async fn get_holder(&self, holder_id: &str, token_hex: &str) -> Result<Value, ApiError> {
        self.send_with(reqwest::Method::GET, &format!("/holders/{holder_id}"), None, &[("x-holder-token", token_hex)]).await
    }

    async fn send_with(&self, method: reqwest::Method, path: &str, body: Option<&Value>, headers: &[(&str, &str)]) -> Result<Value, ApiError> {
        if !allowed(&self.base, INSECURE_HTTP.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err(ApiError::Insecure(self.base.clone()));
        }
        let mut req = self.http.request(method, format!("{}/api{path}", self.base));
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        if let Some((id, key)) = &self.connection {
            use ed25519_dalek::Signer;
            let minute = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() / 60);
            let sig = key.sign(&plim_core::sig::conn_rate_msg(id, minute));
            req = req.header("x-tiro-connection", id.as_str()).header("x-tiro-connection-sig", B64.encode(sig.to_bytes()));
        }
        if let Some(t) = self.token.lock().unwrap().clone() {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let sent = crate::notes::device_now_ms();
        let res = req.send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        // How far this device's clock is off (notes::now_ms).
        let date = res.headers().get(reqwest::header::DATE).and_then(|d| d.to_str().ok());
        crate::notes::saw_server_date(date, sent, crate::notes::device_now_ms());
        let status = res.status().as_u16();
        let data: Value = res.json().await.unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let msg = data["error"].as_str().unwrap_or("request failed").to_string();
            return Err(ApiError::Http(status, msg));
        }
        Ok(data)
    }

    /// Send a request; on 401 with an identity available, log in again and retry once.
    pub async fn request(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        self.request_with(method, path, body, &[]).await
    }

    async fn request_with(&self, method: reqwest::Method, path: &str, body: Option<&Value>, headers: &[(&str, &str)]) -> Result<Value, ApiError> {
        match self.send_with(method.clone(), path, body, headers).await {
            Err(ApiError::Http(401, _)) if self.token.lock().unwrap().is_some() => {
                let identity = self.identity.lock().unwrap().clone();
                let Some(identity) = identity else { return Err(ApiError::Http(401, "unauthorized".into())) };
                self.login(&identity).await?;
                self.send_with(method, path, body, headers).await
            }
            other => other,
        }
    }

    /// What can't be undone, or locks something out (#144): deleting a note or a share,
    /// turning a share's links off, closing or reopening a note. The account's key signs a
    /// fresh challenge for `action` (plim_core::sig::action) on `target`, sent with the
    /// request: a session alone can't do it. As the web app's signedRequest. (An expired
    /// session's retry sends the same signature: the server checks the session first.)
    pub async fn signed(
        &self,
        identity: &Identity,
        account_id: &str,
        method: reqwest::Method,
        path: &str,
        action: &str,
        target: &str,
    ) -> Result<Value, ApiError> {
        let ch = self.request(reqwest::Method::POST, "/auth/challenge", Some(&json!({ "pubkey_hash": identity.pubkey_hash }))).await?;
        let nonce_b64 = ch["nonce"].as_str().unwrap_or_default().to_string();
        let nonce = B64.decode(&nonce_b64).map_err(|_| ApiError::Http(500, "bad challenge".into()))?;
        let sig = B64.encode(identity.sign(&action_msg(account_id, action, target, &nonce, &[])));
        self.request_with(method, path, None, &[("x-tiro-nonce", &nonce_b64), ("x-tiro-sig", &sig)]).await
    }

    pub async fn get(&self, path: &str) -> Result<Value, ApiError> {
        self.request(reqwest::Method::GET, path, None).await
    }

    /// POST with extra headers (a connection's signature, #369).
    pub async fn post_with(&self, path: &str, body: &Value, headers: &[(&str, &str)]) -> Result<Value, ApiError> {
        self.request_with(reqwest::Method::POST, path, Some(body), headers).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        self.request(reqwest::Method::POST, path, Some(body)).await
    }

    /// Challenge/response login with the identity's signing key.
    pub async fn login(&self, identity: &Arc<Identity>) -> Result<LoginResult, ApiError> {
        *self.token.lock().unwrap() = None;
        let ch = self.send(reqwest::Method::POST, "/auth/challenge", Some(&json!({ "pubkey_hash": identity.pubkey_hash }))).await?;
        let nonce_b64 = ch["nonce"].as_str().unwrap_or_default();
        let nonce = B64.decode(nonce_b64).map_err(|_| ApiError::Http(500, "bad challenge".into()))?;
        let sig = identity.sign(&auth_msg(&nonce, &identity.pubkey_hash));
        let r = self
            .send(
                reqwest::Method::POST,
                "/auth/verify",
                Some(&json!({ "pubkey_hash": identity.pubkey_hash, "nonce": nonce_b64, "sig": B64.encode(sig) })),
            )
            .await?;
        *self.token.lock().unwrap() = r["token"].as_str().map(String::from);
        if let Some(t) = r["token"].as_str() {
            STARTED.lock().unwrap().push((self.base.clone(), t.to_string()));
        }
        *self.identity.lock().unwrap() = Some(identity.clone());
        Ok(LoginResult {
            account_id: r["account_id"].as_str().unwrap_or_default().to_string(),
            keyring: serde_json::from_value(r["keyring"].clone()).unwrap_or_default(),
        })
    }

    /// Delete the signed-in account and everything of it on the server (#51):
    /// its key signs a fresh challenge, so a session alone can't (as the web app).
    pub async fn delete_account(&self, identity: &Identity, account_id: &str) -> Result<(), ApiError> {
        let ch = self.send(reqwest::Method::POST, "/auth/challenge", Some(&json!({ "pubkey_hash": identity.pubkey_hash }))).await?;
        let nonce_b64 = ch["nonce"].as_str().unwrap_or_default();
        let nonce = B64.decode(nonce_b64).map_err(|_| ApiError::Http(500, "bad challenge".into()))?;
        let sig = identity.sign(&delete_account_msg(account_id, &nonce));
        self.send(reqwest::Method::POST, "/account/delete", Some(&json!({ "nonce": nonce_b64, "sig": B64.encode(sig) }))).await?;
        *self.token.lock().unwrap() = None;
        *self.identity.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #148: https:// anywhere; plain http:// only to this machine, or with --insecure-http.
    #[test]
    fn plain_http_only_to_this_machine() {
        for ok in ["https://plim.fyi", "https://notes.example.com:8443/", "http://localhost:3000", "http://LOCALHOST",
                   "http://plim.localhost:8080", "http://127.0.0.1:3000", "http://127.8.9.10", "http://[::1]:3000"] {
            assert!(allowed(ok, false), "{ok} should be allowed");
        }
        for no in ["http://example.com", "http://plim.fyi", "http://192.168.1.20:3000", "http://10.0.0.5",
                   "http://[2001:db8::1]", "http://localhost.example.com", "ftp://plim.fyi", "not a url", ""] {
            assert!(!allowed(no, false), "{no} should be refused");
        }
        assert!(allowed("http://192.168.1.20:3000", true), "--insecure-http lets plain http:// through");
        assert!(!allowed("ftp://plim.fyi", true), "but nothing that isn't http(s)");
    }

    /// Refused before anything is sent (nothing listens at the address: it isn't tried).
    #[tokio::test]
    async fn a_remote_plain_http_server_gets_nothing() {
        let api = Api::new("http://192.0.2.1:9");
        match api.get("/account").await {
            Err(ApiError::Insecure(base)) => assert_eq!(base, "http://192.0.2.1:9"),
            other => panic!("expected Insecure, got {other:?}"),
        }
        let msg = ApiError::Insecure("http://example.com".into()).to_string();
        assert!(msg.contains("--insecure-http") && msg.contains("https://"), "{msg}");
        assert!(!ApiError::Insecure(String::new()).is_offline(), "not taken for offline: it wouldn't pass with time");
    }

    /// A command's sessions end with it (#146): the token stops working at once.
    #[tokio::test]
    async fn ended_sessions_stop_working() {
        let srv = crate::sync_tests::server().await;
        let id = crate::sync_tests::vault(&srv).await;
        let api = Api::new(&srv.url);
        api.login(&id).await.unwrap();
        let token = api.token.lock().unwrap().clone().unwrap();
        assert!(api.get("/account").await.is_ok());
        end(vec![(srv.url.trim_end_matches('/').to_string(), token.clone())]).await;
        let after = reqwest::Client::new().get(format!("{}/api/account", srv.url.trim_end_matches('/'))).bearer_auth(&token).send().await.unwrap();
        assert_eq!(after.status().as_u16(), 401);
    }
}
