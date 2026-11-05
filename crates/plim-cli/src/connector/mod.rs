//! `plim mcp --http` (#369): the connector, Plim as a remote MCP server, so Claude (claude.ai, the
//! desktop and mobile apps, Claude Code: anything that speaks MCP over HTTP) reads and writes a
//! user's notes with what the user granted it, from anywhere, with no `plim` on their machine.
//!
//! It holds no notes and no keys of its own. Connecting is OAuth, as MCP clients expect it:
//! `/authorize` sends the user to their Plim app's consent page (`/connect`), which makes a
//! connection (plim-core connection_keys: a signing key, a list note held through a derived
//! holder, holders for the notes granted) and hands the connection's secret back to `/complete`
//! in the URL fragment. The token the client then gets is that secret, sealed with this
//! process's key (`--secret-file`): the connector keeps nothing between requests, and a token
//! alone opens nothing without the server's holders rows, which the owner can turn off at once.
//!
//! With a token, a request opens the connection's list note (what it was granted: holder id →
//! note, its title and tags, the role; what the connector did, 'activity'), and each note through
//! its holder (sharing::resolve_holder) with the secret derived for it. A note it makes is a share
//! of the owner's (POST /connections/{id}/shares, signed with the connection's key), listed with
//! its seed until the owner's app adopts it and gives the connection a holder for it.
//!
//! Tools and instructions are `mcp`'s; the scope here is what the owner granted, not flags.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use serde_json::{Value, json};
use plim_core::crypto::{self, random_bytes};
use plim_core::sig;

use crate::mcp;
use crate::writer::WriterSession;

/// Its pages' look (#418): Plim's colours, light or dark as the device is.
macro_rules! page_css {
    () => {
        ":root{color-scheme:light dark;--bg:#f6f5f2;--text:#1c1b19;--muted:#6b6860;--accent:#3f5bd8;--code:#ebe8e1}\
         @media (prefers-color-scheme:dark){:root{--bg:#141414;--text:#ecebe7;--muted:#9b988f;--accent:#7d93ff;--code:#2a2927}}\
         body{font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:34em;margin:5em auto;padding:0 1.25em;background:var(--bg);color:var(--text)}\
         h1{font-size:1.35rem;margin:0 0 .8em}a{color:var(--accent)}.muted{color:var(--muted)}\
         code{background:var(--code);padding:.1em .35em;border-radius:5px;font-size:.92em;overflow-wrap:anywhere}"
    };
}

mod oauth;
mod tools;

#[cfg(test)]
pub(crate) use oauth::redirect_host;
use oauth::{COMPLETE_HTML, auth_metadata, authorize, complete, complete_page, register, resource_metadata, token};
use tools::Conn;

/// How long a token opens the connection: a day for the access token (the client refreshes it
/// without the user), 90 days for the refresh token: each refresh gives a new one, so a client in
/// use stays connected and one left unused for 90 days doesn't (#390). Turning the connection off in
/// Plim ends both at once.
const ACCESS_SECS: u64 = 24 * 3600;
const REFRESH_SECS: u64 = 90 * 24 * 3600;
/// How long the user has to say yes, and the client to redeem its code.
const PENDING_SECS: u64 = 10 * 60;
const CODE_SECS: u64 = 5 * 60;
/// Activity entries kept in the list note.
const ACTIVITY_KEPT: u32 = 200;

pub struct Opts {
    pub listen: SocketAddr,
    /// Its own address as clients reach it (`https://mcp.example.com`).
    pub public_url: String,
    /// The Plim server's.
    pub server: String,
    /// 32 bytes sealing tokens and client ids; made if missing.
    pub secret_file: std::path::PathBuf,
}

/// Run until stopped.
pub async fn serve(opts: Opts) -> Result<()> {
    let key = load_key(&opts.secret_file)?;
    let c = Arc::new(Connector::new(&opts.public_url, &opts.server, key));
    let listener = tokio::net::TcpListener::bind(opts.listen).await.with_context(|| format!("can't listen on {}", opts.listen))?;
    eprintln!("plim mcp: connector at {} for {}, listening on {} ({})", c.public, c.plim, opts.listen, crate::VERSION);
    axum::serve(listener, router(c).into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

fn load_key(path: &std::path::Path) -> Result<[u8; 32]> {
    if let Ok(bytes) = std::fs::read(path) {
        return bytes.try_into().map_err(|_| anyhow!("{} isn't 32 bytes", path.display()));
    }
    let key = random_bytes::<32>();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    eprintln!("plim mcp: made {} (tokens are sealed with it: keep it, and keep it private)", path.display());
    Ok(key)
}

pub struct Connector {
    public: String,
    plim: String,
    key: [u8; 32],
    /// Consent under way: auth id → what the client asked.
    pending: Mutex<HashMap<String, Pending>>,
    /// Consent given, code not yet redeemed.
    codes: Mutex<HashMap<String, Grant>>,
}

struct Pending {
    /// Whom it was started for (#406): a few at a time each.
    from: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    state: Option<String>,
    /// A cookie set on the browser that started it, which /complete must bring back: consent
    /// given in another browser, to a /connect link passed on, makes no connection.
    bind: String,
    until: Instant,
}

struct Grant {
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    connection_id: String,
    secret: [u8; 32],
    until: Instant,
}

impl Connector {
    pub fn new(public_url: &str, server: &str, key: [u8; 32]) -> Self {
        Connector {
            public: public_url.trim_end_matches('/').to_string(),
            plim: server.trim_end_matches('/').to_string(),
            key,
            pending: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
        }
    }

    /// Something sealed to this process: base64url(nonce ‖ ciphertext), bound to what it is.
    fn seal(&self, kind: &str, v: &Value) -> String {
        let s = crypto::encrypt(&self.key, v.to_string().as_bytes(), format!("tiro/v1/connector-{kind}").as_bytes());
        let mut bytes = s.nonce.to_vec();
        bytes.extend(s.ciphertext);
        B64URL.encode(bytes)
    }

    fn open(&self, kind: &str, token: &str) -> Option<Value> {
        let bytes = B64URL.decode(token.trim()).ok()?;
        if bytes.len() < 12 {
            return None;
        }
        let plain = crypto::decrypt(&self.key, &bytes[..12], &bytes[12..], format!("tiro/v1/connector-{kind}").as_bytes()).ok()?;
        serde_json::from_slice(&plain).ok()
    }

    fn token(&self, kind: &str, connection_id: &str, secret: &[u8; 32], secs: u64) -> String {
        self.seal("token", &json!({ "t": kind, "c": connection_id, "s": B64.encode(secret), "e": now() + secs }))
    }

    /// The connection a token names, if it's of the kind and still good.
    fn connection_of(&self, kind: &str, token: &str) -> Option<(String, [u8; 32])> {
        let v = self.open("token", token)?;
        if v["t"] != kind || v["e"].as_u64()? < now() {
            return None;
        }
        let secret: [u8; 32] = B64.decode(v["s"].as_str()?).ok()?.try_into().ok()?;
        Some((v["c"].as_str()?.to_string(), secret))
    }

    fn sweep(&self) {
        let t = Instant::now();
        self.pending.lock().unwrap().retain(|_, p| p.until > t);
        self.codes.lock().unwrap().retain(|_, g| g.until > t);
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub fn router(c: Arc<Connector>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(|| async { "ok" }))
        .route("/.well-known/oauth-protected-resource", get(resource_metadata))
        .route("/.well-known/oauth-protected-resource/mcp", get(resource_metadata))
        .route("/.well-known/oauth-authorization-server", get(auth_metadata))
        .route("/register", post(register))
        .route("/authorize", get(authorize))
        .route("/complete", get(complete_page).post(complete))
        .route("/token", post(token))
        .route("/mcp", post(mcp_post).get(|| async { StatusCode::METHOD_NOT_ALLOWED }).delete(|| async { StatusCode::NO_CONTENT }))
        .layer(axum::middleware::map_response(security_headers))
        .with_state(c)
}

/**
 * On every response (#407), as the Plim server's: its pages run only the `/complete` page's own
 * script (by its hash), talk only to here, can't be framed, and send no referrer on.
 */
async fn security_headers(mut res: Response) -> Response {
    static CSP: std::sync::LazyLock<header::HeaderValue> = std::sync::LazyLock::new(|| {
        let script = COMPLETE_HTML.split("<script>").nth(1).and_then(|s| s.split("</script>").next()).unwrap_or_default();
        let csp = format!(
            "default-src 'none'; script-src 'sha256-{}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            B64.encode(sig::sha256(script.as_bytes()))
        );
        header::HeaderValue::from_str(&csp).expect("a valid header")
    });
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, CSP.clone());
    h.insert(header::X_CONTENT_TYPE_OPTIONS, header::HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, header::HeaderValue::from_static("no-referrer"));
    h.insert(header::X_FRAME_OPTIONS, header::HeaderValue::from_static("DENY"));
    h.insert(header::STRICT_TRANSPORT_SECURITY, header::HeaderValue::from_static("max-age=31536000"));
    res
}

type St = State<Arc<Connector>>;

async fn index(State(c): St) -> Html<String> {
    Html(format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Plim connector</title>\
         <style>{css}</style>\
         <h1>Plim for Claude</h1><p>This is the connector for <a href='{t}'>{t}</a>. In Claude, add a connector with the address \
         <code>{p}/mcp</code>: it will send you to your notes to say which tags Claude may use.</p>\
         <p class=muted>You can change or take that back any time in Plim, under Settings → Connections.</p>",
        css = page_css!(),
        t = c.plim,
        p = c.public
    ))
}

// ---- MCP over HTTP ----

/// A JSON-RPC message (one, or a batch) with a token, answered with JSON.
async fn mcp_post(State(c): St, headers: HeaderMap, body: String) -> Response {
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    let Some((cid, secret)) = c.connection_of("access", bearer) else {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\"", c.public))],
            axum::Json(json!({ "error": "invalid_token", "error_description": "a token for this connector is needed (connect it in Claude)" })),
        )
            .into_response();
    };
    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return axum::Json(mcp::error(Value::Null, -32700, &format!("not JSON: {e}"))).into_response(),
    };
    // Its MCP session (#505): handed out at initialize (Mcp-Session-Id), sent back with each
    // request after, so the versions its changes leave name one session ("amber fox"). Nothing is
    // kept here: the name comes from the id. (Not for access: the token is.)
    let initializing = |m: &Value| m.get("method").and_then(Value::as_str) == Some("initialize");
    let starts = match &msg {
        Value::Array(msgs) => msgs.iter().any(initializing),
        m => initializing(m),
    };
    let asked = headers.get(MCP_SESSION).and_then(|v| v.to_str().ok()).filter(|s| valid_session_id(s)).map(str::to_string);
    let new_id = if asked.is_none() && starts { Some(hex::encode(random_bytes::<16>())) } else { None };
    let session = asked.as_deref().or(new_id.as_deref()).map(WriterSession::of);
    let mut conn = Conn::new(&c.plim, &cid, secret, session);
    let mut res = match msg {
        Value::Array(msgs) => {
            let mut out = Vec::new();
            for m in msgs {
                if let Some(r) = mcp::dispatch(&mut conn, m).await {
                    out.push(r);
                }
            }
            if out.is_empty() { StatusCode::ACCEPTED.into_response() } else { axum::Json(Value::Array(out)).into_response() }
        }
        m => match mcp::dispatch(&mut conn, m).await {
            Some(r) => axum::Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    };
    if let Some(id) = new_id
        && let Ok(v) = header::HeaderValue::from_str(&id)
    {
        res.headers_mut().insert(MCP_SESSION, v);
    }
    res
}

/// The header an MCP session's id goes in (Streamable HTTP).
const MCP_SESSION: &str = "mcp-session-id";

/// An MCP session id as the spec allows it (visible ASCII), and not absurdly long.
fn valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_graphic())
}
