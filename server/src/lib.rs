pub mod account;
pub mod admin;
pub mod assets;
pub mod auth;
pub mod backup;
pub mod connections;
pub mod db;
pub mod live;
pub mod metrics;
pub mod proxy;
pub use plim_core::{pow, sig};
pub mod quota;
pub mod docs;
pub mod holders;
pub mod shares;
pub mod store;
pub mod trash;
pub mod versions;

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::Router;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::middleware;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

/// `'wasm-unsafe-eval'` lets the app compile its own WebAssembly (web/wasm/plim.wasm,
/// fetched from 'self' like its scripts); it allows no JavaScript eval.
pub const CSP: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; \
worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Default largest single encrypted blob (one update or snapshot). */
pub const DEFAULT_MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Config {
    pub db_path: String,
    pub web_dir: PathBuf,
    pub pow_bits: u32,
    pub quota_bytes: i64,
    /// Largest single encrypted blob (an update or a snapshot); clients size
    /// their uploads to fit (it's reported by `GET /api/account`).
    pub max_blob_bytes: usize,
    /// Delete updates once a snapshot covers them (on by default). Nothing
    /// reads the old history, and it would otherwise count against the
    /// quota forever. `PLIM_PRUNE_ON_SNAPSHOT=0` keeps it.
    pub prune_on_snapshot: bool,
    /// Static files for the admin dashboard (served only on the admin listener).
    pub admin_web_dir: PathBuf,
    /// Reverse proxies (or Cloudflare Tunnel) whose client IP header is
    /// believed for rate limiting.
    pub proxy: proxy::ProxyConfig,
    /// The site's public address (`https://notes.example.com`), for the link
    /// preview tags, which need absolute URLs. From `PLIM_PUBLIC_URL`.
    pub public_url: Option<String>,
    /// How often clients save a version of a note while it's edited (#60):
    /// `PLIM_VERSION_EVERY_SECS`, an hour by default.
    pub version_every_secs: i64,
    /// At most this many accounts (`PLIM_MAX_ACCOUNTS`; unset: no limit). At
    /// the limit, signing up is refused; existing accounts are unaffected.
    pub max_accounts: Option<i64>,
    /// `PLIM_CONNECTOR_URL`: the connector (#369) that may send people to /connect to connect an
    /// app (Claude) to their notes; the app hands the connection's secret to it, so it must be
    /// this one. None: no connecting.
    pub connector_url: Option<String>,
}

/// `PLIM_PUBLIC_URL`, checked: an http(s) origin with no path, no trailing slash.
pub fn parse_public_url(v: &str) -> Option<String> {
    let v = v.trim().trim_end_matches('/');
    let host = v.strip_prefix("https://").or_else(|| v.strip_prefix("http://"))?;
    let ok = !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b"-.:[]".contains(&b));
    ok.then(|| v.to_string())
}

/// A setting that's on unless set to `0`, `false` or `off`.
pub fn on_unless_disabled(v: Option<&str>) -> bool {
    v.is_none_or(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off"))
}

/// A setting from the environment by its name after the prefix: `PLIM_<name>`, else the older
/// `TIRO_<name>` (what services set before the rename keeps working).
pub fn env(name: &str) -> Option<String> {
    std::env::var(format!("PLIM_{name}")).ok().or_else(|| std::env::var(format!("TIRO_{name}")).ok())
}

impl Config {
    /// Request body limit: a blob travels base64-encoded (×4/3) inside JSON
    /// with its signature and nonce.
    pub fn max_body_bytes(&self) -> usize {
        self.max_blob_bytes / 3 * 4 + 64 * 1024
    }

    pub fn from_env() -> Self {
        Config {
            db_path: env("DB").unwrap_or_else(|| "tiro.db".into()),
            web_dir: env("WEB")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../web"))),
            pow_bits: env("POW_BITS").and_then(|v| v.parse().ok()).unwrap_or(20),
            quota_bytes: env("QUOTA_BYTES")
                .and_then(|v| v.parse().ok())
                .unwrap_or(50 * 1024 * 1024),
            max_blob_bytes: env("MAX_BLOB_BYTES")
                .and_then(|v| v.parse().ok())
                .filter(|&n: &usize| n >= 64 * 1024)
                .unwrap_or(DEFAULT_MAX_BLOB_BYTES),
            prune_on_snapshot: on_unless_disabled(env("PRUNE_ON_SNAPSHOT").as_deref()),
            admin_web_dir: env("ADMIN_WEB")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../admin"))),
            proxy: proxy::ProxyConfig::from_env_values(
                &env("TRUSTED_PROXIES").unwrap_or_default(),
                env("CLIENT_IP_HEADER").as_deref(),
            ),
            public_url: env("PUBLIC_URL").and_then(|v| {
                let url = parse_public_url(&v);
                if url.is_none() {
                    eprintln!("plim: ignoring PLIM_PUBLIC_URL={v:?}: expected an address like https://notes.example.com");
                }
                url
            }),
            version_every_secs: env("VERSION_EVERY_SECS")
                .and_then(|v| v.parse().ok())
                .filter(|&n: &i64| n >= 1)
                .unwrap_or(versions::VERSION_EVERY_SECS),
            max_accounts: env("MAX_ACCOUNTS").and_then(|v| v.parse().ok()).filter(|&n: &i64| n >= 0),
            connector_url: env("CONNECTOR_URL").and_then(|v| {
                let url = parse_public_url(&v);
                if url.is_none() {
                    eprintln!("plim: ignoring PLIM_CONNECTOR_URL={v:?}: expected an address like https://mcp.example.com");
                }
                url
            }),
        }
    }
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

/// Requests counted this minute, by whom and which limit: (the minute, how many).
type Limiter = HashMap<(RateSubject, &'static str), (i64, u32)>;

pub struct Inner {
    pub cfg: Config,
    db: db::Pool,
    limiter: Mutex<Limiter>,
    started_at: i64,
    metrics: metrics::Metrics,
    /// Read-only connection for the admin dashboard, opened on first use.
    admin_db: Mutex<Option<rusqlite::Connection>>,
    /// Untrusted peers already reported for sending proxy headers.
    reported_proxies: Mutex<std::collections::HashSet<IpAddr>>,
    /// Live sync: who has which doc open (see live.rs).
    live: Arc<live::Hub>,
    /// The web files' version and when it was worked out (see assets::current_version).
    web_version: Mutex<Option<assets::Cached>>,
}

impl AppState {
    pub fn new(cfg: Config) -> rusqlite::Result<Self> {
        let pool = db::Pool::open(&cfg.db_path)?;
        if cfg.prune_on_snapshot {
            let (rows, bytes) = db::prune_covered(&pool.get())?;
            if rows > 0 {
                println!("plim: pruned {rows} updates already covered by snapshots ({bytes} bytes freed)");
            }
        }
        Ok(AppState(Arc::new(Inner {
            cfg,
            db: pool,
            limiter: Mutex::new(HashMap::new()),
            started_at: db::now(),
            metrics: metrics::Metrics::default(),
            admin_db: Mutex::new(None),
            reported_proxies: Mutex::new(std::collections::HashSet::new()),
            live: Arc::new(live::Hub::default()),
            web_version: Mutex::new(None),
        })))
    }

    pub fn live(&self) -> &live::Hub {
        &self.0.live
    }

    pub fn live_hub(&self) -> Arc<live::Hub> {
        self.0.live.clone()
    }

    /// Log (once per address, at most 16) when a request carries proxy headers
    /// but comes from an address not in PLIM_TRUSTED_PROXIES — this is how an
    /// operator finds out what to trust (e.g. the address cloudflared uses).
    pub fn report_untrusted_proxy(&self, peer: IpAddr) {
        let mut seen = self.0.reported_proxies.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() < 16 && seen.insert(peer) {
            eprintln!(
                "plim: {peer} sent X-Forwarded-For/CF-Connecting-IP but isn't in PLIM_TRUSTED_PROXIES, so \
                 rate limits use {peer} itself. If it is your proxy or cloudflared, add exactly that \
                 address. In a Podman network give the proxy a fixed IP (--ip) and trust only it: \
                 published ports arrive from the container's own IP, so trusting the whole subnet \
                 would let anyone reaching a published port spoof their address."
            );
        }
    }

    pub fn started_at(&self) -> i64 {
        self.0.started_at
    }

    pub fn metrics(&self) -> &metrics::Metrics {
        &self.0.metrics
    }

    /// Run `f` on a read-only connection: admin code physically cannot modify data.
    pub fn with_admin_db<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let mut guard = self.0.admin_db.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(rusqlite::Connection::open_with_flags(
                &self.0.cfg.db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?);
        }
        f(guard.as_ref().expect("opened above"))
    }

    pub fn cfg(&self) -> &Config {
        &self.0.cfg
    }

    /// A database connection for this request, back in the pool when dropped (db.rs). Take it
    /// for as little as the work needs, never across an `.await`.
    pub fn db(&self) -> db::DbConn {
        self.0.db.get()
    }

    /// Fixed one-minute window per (ip, bucket).
    /// Counted per minute for `who`: an address, or (#394) a connection whose requests come from
    /// its connector's one address, so each user's Claude has an allowance of its own.
    pub fn rate_limit(&self, who: impl Into<RateSubject>, bucket: &'static str, max: u32) -> Result<(), ApiError> {
        let window = db::now() / 60;
        let mut map = self.0.limiter.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 10_000 {
            map.retain(|_, (w, _)| *w == window);
        }
        let entry = map.entry((who.into(), bucket)).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        entry.1 += 1;
        if entry.1 > max {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "too many requests"));
        }
        Ok(())
    }
}

/// Whom a request counts against (#394): the address it came from, or a connection that signed it
/// as its own (`connections::RateWho`), whatever address its connector has.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RateSubject {
    Ip(IpAddr),
    Connection(String),
}

impl From<IpAddr> for RateSubject {
    fn from(ip: IpAddr) -> Self {
        RateSubject::Ip(ip)
    }
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("db error: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

pub fn bad_request(msg: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

pub fn b64(s: &str) -> Result<Vec<u8>, ApiError> {
    B64.decode(s).map_err(|_| bad_request("invalid base64"))
}

pub fn b64e(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut out);
    out
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn valid_account_id(s: &str) -> bool {
    is_hex(s, 32)
}

pub fn valid_pubkey_hash(s: &str) -> bool {
    is_hex(s, 64)
}

/// `index` or a client-generated id of lowercase hex/dashes (e.g. a UUID).
pub fn valid_doc_id(s: &str) -> bool {
    s == "index"
        || (!s.is_empty()
            && s.len() <= 64
            && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-')))
}

pub fn app(state: AppState) -> Router {
    let body_limit = state.cfg().max_body_bytes();
    let api = Router::new()
        .route("/pow", post(auth::pow_challenge))
        .route("/accounts", post(auth::create_account))
        .route("/signups", get(auth::signups))
        .route("/auth/challenge", post(auth::challenge))
        .route("/auth/verify", post(auth::verify))
        .route("/auth/logout", post(auth::logout))
        .route("/account", get(account::get_account))
        .route("/account/delete", post(auth::delete_account))
        .route("/account/rotate", post(account::rotate))
        .route("/keyring", post(account::add_keyring))
        .route("/live", get(live::live))
        .route("/shares", post(shares::create))
        .route("/shares/{id}", get(shares::status).delete(shares::delete))
        .route("/shares/{id}/doc", get(shares::get_doc))
        .route("/shares/{id}/updates", post(shares::post_update))
        .route("/shares/{id}/snapshots", post(shares::post_snapshot))
        .route("/shares/{id}/revoke", post(shares::revoke))
        .route("/shares/{id}/versions", get(shares::list_versions).post(shares::post_version).delete(shares::forget_versions))
        .route("/shares/{id}/versions/{vid}", get(shares::get_version))
        .route("/shares/{id}/holders", get(holders::list))
        .route("/holders", post(holders::create))
        .route("/holders/{id}", get(holders::get).put(holders::reseal).delete(holders::delete))
        .route("/connections", get(connections::list).post(connections::create))
        .route("/connections/{id}", patch(connections::rename).delete(connections::delete))
        .route("/connections/{id}/revoke", post(connections::revoke))
        .route("/connections/{id}/holders", get(connections::holders))
        .route("/connections/{id}/shares", post(connections::create_share))
        .route("/passkeys", get(account::list_passkeys).post(account::put_passkey))
        .route("/passkeys/{cred_hash}", delete(account::delete_passkey))
        .route("/passkey-signin/{cred_hash}", get(account::passkey_signin))
        .route("/docs", get(docs::list_docs))
        .route("/docs/{doc_id}", get(docs::get_doc).delete(docs::delete_doc))
        .route("/docs/{doc_id}/updates", post(docs::post_update))
        .route("/docs/{doc_id}/snapshots", post(docs::post_snapshot))
        .route("/docs/{doc_id}/close", post(docs::close_doc))
        .route("/docs/{doc_id}/reopen", post(docs::reopen_doc))
        .route("/docs/{doc_id}/versions", get(versions::list).post(versions::post).delete(versions::forget))
        .route("/docs/{doc_id}/versions/{id}", get(versions::get).put(versions::put))
        .route("/trash", get(trash::list))
        .route("/trash/{kind}/{target}/restore", post(trash::restore))
        // (Inside the counters, so an upload refused for its size is counted, #444.)
        .layer(RequestBodyLimitLayer::new(body_limit))
        .layer(middleware::from_fn_with_state(state.clone(), metrics::track))
        .layer(middleware::from_fn_with_state(state.clone(), assets::version_header))
        .layer(no_store());

    let web_dir = state.cfg().web_dir.clone();
    let router = Router::new()
        .route("/healthz", get(health).layer(no_store()))
        .nest("/api", api)
        .merge(assets::routes())
        .fallback_service(ServeDir::new(web_dir))
        // axum's limit for its extractors (2 MB by default); tower's for the raw body is on the API
        // (above: inside its counters), the only routes that take a body.
        .layer(axum::extract::DefaultBodyLimit::max(body_limit));
    security_headers(router).with_state(state)
}

/// Liveness for container health checks: the process answers and the
/// database is readable. Outside `/api`, so it isn't counted as API traffic.
async fn health(axum::extract::State(st): axum::extract::State<AppState>) -> Response {
    match st.db().query_row("SELECT 1", [], |r| r.get::<_, i64>(0)) {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({ "ok": false }))).into_response(),
    }
}

pub(crate) fn no_store() -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))
}

/// The strict CSP and related headers, shared by the public and admin apps.
///
/// Static files also get `Cache-Control: no-cache`: browsers and CDNs (e.g.
/// Cloudflare, whose default is 4 hours) must revalidate on every load, so an
/// upgrade can never mix a new page with old cached scripts. Unchanged files
/// cost a 304. Responses that already chose (`no-store` on the API) keep theirs.
/// A CDN may still override this, which is why the page links its files under
/// versioned URLs (see `assets`).
pub(crate) fn security_headers<S: Clone + Send + Sync + 'static>(router: Router<S>) -> Router<S> {
    let hdr = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::overriding(HeaderName::from_static(name), HeaderValue::from_static(value))
    };
    router
        // The page itself sets its own (with a style nonce, see assets::page_csp).
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(CSP),
        ))
        .layer(hdr("x-content-type-options", "nosniff"))
        .layer(hdr("referrer-policy", "no-referrer"))
        .layer(hdr("cross-origin-opener-policy", "same-origin"))
        .layer(hdr("cross-origin-resource-policy", "same-origin"))
        .layer(hdr("x-frame-options", "DENY"))
        // Once seen over HTTPS, the browser never loads the site over plain HTTP,
        // where a page could be swapped for one that reads a shared link's key.
        // (Ignored over HTTP, so harmless on localhost.)
        .layer(hdr("strict-transport-security", "max-age=31536000"))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
}
