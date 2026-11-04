//! OAuth, as MCP clients expect it: discovery, registration, consent (in the Plim app), tokens.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::extract::{Form, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use serde::Deserialize;
use serde_json::{Value, json};
use plim_core::crypto::random_bytes;
use plim_core::sig;

use super::{ACCESS_SECS, CODE_SECS, Grant, PENDING_SECS, Pending, REFRESH_SECS, St};


pub(super) async fn resource_metadata(State(c): St) -> axum::Json<Value> {
    axum::Json(json!({
        "resource": format!("{}/mcp", c.public),
        "authorization_servers": [c.public],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["notes"],
        "resource_name": "Plim",
    }))
}

pub(super) async fn auth_metadata(State(c): St) -> axum::Json<Value> {
    axum::Json(json!({
        "issuer": c.public,
        "authorization_endpoint": format!("{}/authorize", c.public),
        "token_endpoint": format!("{}/token", c.public),
        "registration_endpoint": format!("{}/register", c.public),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["notes"],
    }))
}

fn oauth_error(status: StatusCode, code: &str, description: &str) -> Response {
    (status, axum::Json(json!({ "error": code, "error_description": description }))).into_response()
}

/// Dynamic registration (RFC 7591): the client id is its name and redirect addresses, sealed:
/// nothing to keep here.
pub(super) async fn register(State(c): St, body: axum::Json<Value>) -> Response {
    let name = body["client_name"].as_str().unwrap_or("An app").split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(60).collect();
    let uris: Vec<String> = body["redirect_uris"].as_array().map(|a| a.iter().filter_map(|u| u.as_str().map(str::to_string)).collect()).unwrap_or_default();
    if uris.is_empty() || uris.len() > 10 || uris.iter().any(|u| redirect_host(u).is_none()) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", "redirect_uris must be https addresses (or localhost)");
    }
    let client_id = c.seal("client", &json!({ "n": name, "r": uris }));
    (
        StatusCode::CREATED,
        axum::Json(json!({
            "client_id": client_id,
            "client_name": name,
            "redirect_uris": uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(super) struct AuthorizeQuery {
    response_type: Option<String>,
    client_id: String,
    redirect_uri: String,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    state: Option<String>,
}

/// The client sends the user here; on to the Plim app's consent page they go.
pub(super) async fn authorize(State(c): St, Peer(from): Peer, Query(q): Query<AuthorizeQuery>) -> Response {
    c.sweep();
    let Some(client) = c.open("client", &q.client_id) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_client", "unknown client_id: register first");
    };
    let known = client["r"].as_array().is_some_and(|a| a.iter().any(|u| u == q.redirect_uri.as_str()));
    if !known {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri isn't one this client registered");
    }
    let back = |code: &str, desc: &str| {
        let mut url = format!("{}{}error={}&error_description={}", q.redirect_uri, sep(&q.redirect_uri), code, enc(desc));
        if let Some(s) = &q.state {
            url += &format!("&state={}", enc(s));
        }
        Redirect::to(&url).into_response()
    };
    if q.response_type.as_deref() != Some("code") {
        return back("unsupported_response_type", "only code");
    }
    let (Some(challenge), Some("S256")) = (q.code_challenge.clone(), q.code_challenge_method.as_deref()) else {
        return back("invalid_request", "PKCE with S256 is required");
    };
    let Some(to) = redirect_host(&q.redirect_uri) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri must be https (or http to this machine)");
    };
    let auth = hex::encode(random_bytes::<16>());
    {
        let mut pending = c.pending.lock().unwrap();
        let theirs = pending.values().filter(|p| p.from == from).count();
        if pending.len() >= MAX_PENDING || theirs >= MAX_PENDING_EACH {
            return oauth_error(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable", "too many connections under way: try again in a few minutes");
        }
        pending.insert(
            auth.clone(),
            Pending { from, client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: challenge, state: q.state, until: Instant::now() + Duration::from_secs(PENDING_SECS) },
        );
    }
    // (The name is the client's own say; where it sends the person back is checked: the consent
    // page shows both, so an app calling itself "Claude" can't pass for it unnoticed.)
    let name = client["n"].as_str().unwrap_or("An app");
    Redirect::to(&format!("{}/connect?auth={auth}&name={}&to={}&return={}", c.plim, enc(name), enc(&to), enc(&format!("{}/complete", c.public)))).into_response()
}

/**
 * Where a client wants the person sent back, if it may: an https address, or plain http to this
 * machine (a desktop app or Claude Code listening locally). Its host, for the consent page to show.
 */
pub(crate) fn redirect_host(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None; // (no host, or user:pass@ to fool the eye)
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split_once(']')?.0.to_string(),
        None => authority.rsplit_once(':').map_or(authority, |(h, port)| if port.bytes().all(|b| b.is_ascii_digit()) { h } else { authority }).to_string(),
    }
    .to_ascii_lowercase();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    match scheme {
        "https" if !host.is_empty() => Some(host),
        "http" if local => Some(host),
        _ => None,
    }
}

/// Consents under way at once, the most: each holds a little memory for ten minutes.
const MAX_PENDING: usize = 1000;
/// And from one address (#406), so nobody can take them all: a person connects one or two at a time.
const MAX_PENDING_EACH: usize = 10;

/**
 * Whom a request comes from, for MAX_PENDING_EACH: the address Cloudflare's tunnel says
 * (`CF-Connecting-IP`), believed only from this machine, where cloudflared runs; else the peer's.
 */
pub(super) struct Peer(String);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, _: &S) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<axum::extract::ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
        let forwarded = parts.headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<std::net::IpAddr>().ok());
        Ok(Peer(match (peer, forwarded) {
            (Some(p), Some(f)) if p.is_loopback() => f.to_string(),
            (Some(p), _) => p.to_string(),
            (None, _) => String::new(),
        }))
    }
}

fn sep(url: &str) -> &'static str {
    if url.contains('?') { "&" } else { "?" }
}

/// Percent-encoded for a query string.
fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out += &format!("%{b:02X}"),
        }
    }
    out
}

/// Where the Plim app sends the user back with the connection in the fragment (never sent to a
/// server): the page hands it to POST /complete, same origin, and goes on to the client.
pub(super) const COMPLETE_HTML: &str = concat!(
    r#"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Connecting…</title>
<style>"#,
    page_css!(),
    r#"</style>
<p id=msg class=muted>Connecting…</p>
<script>
(async () => {
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const msg = document.getElementById('msg');
  if (!p.get('auth') || !p.get('connection') || !p.get('secret')) { msg.textContent = 'Nothing to complete: start again from Claude.'; return; }
  try {
    const r = await fetch('/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auth: p.get('auth'), connection: p.get('connection'), secret: p.get('secret'), to: p.get('to') || '' }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || r.status);
    location.replace(d.redirect);
  } catch (e) { msg.textContent = 'Could not finish connecting: ' + e.message + '. Start again from Claude.'; }
})();
</script>"#
);

pub(super) async fn complete_page() -> Html<&'static str> {
    Html(COMPLETE_HTML)
}

#[derive(Deserialize)]
pub(super) struct CompleteReq {
    auth: String,
    connection: String,
    secret: String,
    /// The host the consent page showed the person as where they go back to (#403): it came to
    /// the page in a query parameter anyone can edit, so it must be this consent's real one.
    #[serde(default)]
    to: String,
}

/// Consent given: the connection and its secret, from the Plim app through the page. A code
/// for the client, to redeem for tokens.
pub(super) async fn complete(State(c): St, axum::Json(req): axum::Json<CompleteReq>) -> Response {
    c.sweep();
    let Some(p) = c.pending.lock().unwrap().remove(&req.auth) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "this connection attempt expired");
    };
    // (A link changed to show "claude.ai" while the code would go elsewhere: refused, #403.)
    if redirect_host(&p.redirect_uri).as_deref() != Some(req.to.as_str()) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "you were shown another address than this goes back to: start again from Claude");
    }
    let secret: Option<[u8; 32]> = B64URL.decode(&req.secret).ok().and_then(|b| b.try_into().ok());
    let (Some(secret), true) = (secret, req.connection.len() == 32 && req.connection.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "a bad connection");
    };
    let code = B64URL.encode(random_bytes::<32>());
    let mut url = format!("{}{}code={}", p.redirect_uri, sep(&p.redirect_uri), enc(&code));
    if let Some(s) = &p.state {
        url += &format!("&state={}", enc(s));
    }
    c.codes.lock().unwrap().insert(
        code,
        Grant {
            client_id: p.client_id,
            redirect_uri: p.redirect_uri,
            code_challenge: p.code_challenge,
            connection_id: req.connection,
            secret,
            until: Instant::now() + Duration::from_secs(CODE_SECS),
        },
    );
    axum::Json(json!({ "redirect": url })).into_response()
}

#[derive(Deserialize)]
pub(super) struct TokenReq {
    grant_type: String,
    code: Option<String>,
    code_verifier: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    refresh_token: Option<String>,
}

pub(super) async fn token(State(c): St, Form(req): Form<TokenReq>) -> Response {
    c.sweep();
    let (cid, secret) = match req.grant_type.as_str() {
        "authorization_code" => {
            let Some(g) = req.code.as_ref().and_then(|code| c.codes.lock().unwrap().remove(code)) else {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "unknown or used code");
            };
            let verifier_ok = req.code_verifier.as_deref().is_some_and(|v| B64URL.encode(sig::sha256(v.as_bytes())) == g.code_challenge);
            let client_ok = req.client_id.as_deref().is_none_or(|id| id == g.client_id);
            let uri_ok = req.redirect_uri.as_deref().is_none_or(|u| u == g.redirect_uri);
            if !(verifier_ok && client_ok && uri_ok) {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "the code's verifier, client or redirect_uri doesn't match");
            }
            (g.connection_id, g.secret)
        }
        "refresh_token" => match req.refresh_token.as_deref().and_then(|t| c.connection_of("refresh", t)) {
            Some(x) => x,
            None => return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "the refresh token expired or doesn't open"),
        },
        _ => return oauth_error(StatusCode::BAD_REQUEST, "unsupported_grant_type", "authorization_code or refresh_token"),
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({
            "access_token": c.token("access", &cid, &secret, ACCESS_SECS),
            "token_type": "Bearer",
            "expires_in": ACCESS_SECS,
            "refresh_token": c.token("refresh", &cid, &secret, REFRESH_SECS),
            "scope": "notes",
        })),
    )
        .into_response()
}

