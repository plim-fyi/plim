mod common;
use common::*;

use plim_server::admin::{admin_addr_ok, admin_app, admin_bind_allowed, is_loopback_host};

const HOST: &str = "localhost:3001";

/// A file-backed database (the admin connection is a second, read-only
/// connection, which an in-memory database can't provide).
struct TempDb(std::path::PathBuf);

impl TempDb {
    fn new() -> Self {
        TempDb(std::env::temp_dir().join(format!("plim-admin-test-{}.db", hex::encode(rand_bytes()))))
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path()));
        }
    }
}

fn rand_bytes() -> [u8; 8] {
    let mut b = [0u8; 8];
    getrandom(&mut b);
    b
}

fn getrandom(b: &mut [u8]) {
    use std::io::Read;
    std::fs::File::open("/dev/urandom").unwrap().read_exact(b).unwrap();
}

struct Setup {
    _db: TempDb,
    state: AppState,
    public: Router,
    admin: Router,
}

fn setup(quota: i64) -> Setup {
    let db = TempDb::new();
    let state = AppState::new(config(db.path(), quota, false)).unwrap();
    Setup { public: app(state.clone()), admin: admin_app(state.clone()), state, _db: db }
}

async fn admin_json(s: &Setup, path: &str) -> Value {
    let (status, _, body) = get_with_host(&s.admin, path, Some(HOST)).await;
    assert_eq!(status, StatusCode::OK, "{path}: {}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).unwrap()
}

/// Two accounts: A writes 3 updates (10, 20, 30 bytes) over two docs and adds
/// a second vault key; B only logs in.
async fn populate(s: &Setup) -> (User, User) {
    let a = User::new(1, ACCT);
    let b = User::new(2, "fedcba9876543210fedcba9876543210");
    assert_eq!(signup(&s.public, &a).await, StatusCode::CREATED);
    assert_eq!(signup(&s.public, &b).await, StatusCode::CREATED);
    let ta = login(&s.public, &a.sk).await.unwrap();
    login(&s.public, &b.sk).await.unwrap();
    for (doc, len) in [("index", 10), ("aa", 20), ("aa", 30)] {
        let (st, _) = call(&s.public, "POST", &format!("/api/docs/{doc}/updates"), Some(&ta), Some(a.blob(doc, "update", 1, 0, &vec![7; len]))).await;
        assert_eq!(st, StatusCode::OK);
    }
    let (st, _) = call(&s.public, "POST", "/api/keyring", Some(&ta), Some(a.keyring_entry(2))).await;
    assert_eq!(st, StatusCode::OK);
    (a, b)
}

#[tokio::test]
async fn overview_reports_metadata_totals() {
    let s = setup(1000);
    populate(&s).await;
    let v = admin_json(&s, "/admin/api/overview").await;
    assert_eq!(v["accounts"], 2);
    assert_eq!(v["documents"], 2);
    assert_eq!(v["updates"], 3);
    assert_eq!(v["snapshots"], 0);
    assert_eq!(v["used_bytes"], 60);
    assert_eq!(v["quota_total_bytes"], 2000);
    assert_eq!(v["active_sessions"], 2);
    assert_eq!(v["rotated_accounts"], 1);
    assert_eq!(v["new_accounts"]["day"], 2);
    // Both are active: A wrote, B logged in.
    assert_eq!(v["active_accounts"]["day"], 2);
    assert!(v["db_bytes"].as_u64().unwrap() > 0);
    assert_eq!(v["config"]["quota_bytes"], 1000);
    assert!(v["counters"]["requests"].as_u64().unwrap() >= 9);
}

#[tokio::test]
async fn timeseries_storage_and_accounts() {
    let s = setup(100);
    populate(&s).await;

    let ts = admin_json(&s, "/admin/api/timeseries?days=7").await;
    let days = ts["days"].as_array().unwrap();
    assert_eq!(days.len(), 7);
    let today = days.last().unwrap();
    assert_eq!((today["signups"].as_i64(), today["updates"].as_i64()), (Some(2), Some(3)));
    assert_eq!((today["bytes"].as_i64(), today["active_writers"].as_i64()), (Some(60), Some(1)));
    assert!(days[..6].iter().all(|d| d["signups"] == 0 && d["updates"] == 0));

    // Quota 100: A uses 60% (bucket 60–70), B 0% (bucket 0–10).
    let st = admin_json(&s, "/admin/api/storage").await;
    let counts: Vec<i64> = st["buckets"].as_array().unwrap().iter().map(|b| b["accounts"].as_i64().unwrap()).collect();
    assert_eq!(counts, [1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);

    let acc = admin_json(&s, "/admin/api/accounts?sort=storage").await;
    assert_eq!(acc["total"], 2);
    let rows = acc["accounts"].as_array().unwrap();
    assert_eq!(rows[0]["id_short"], &ACCT[..8]);
    assert_eq!(rows[0]["used_bytes"], 60);
    assert_eq!(rows[0]["quota_pct"], 60.0);
    assert_eq!(rows[0]["docs"], 2);
    assert_eq!(rows[0]["updates"], 3);
    assert_eq!(rows[0]["key_version"], 2);
    assert!(rows[0]["last_write_at"].is_i64());
    assert!(rows[1]["last_write_at"].is_null() && rows[1]["last_login_at"].is_i64());
    // Only short ids leave the server.
    assert!(!acc.to_string().contains(ACCT));
    // Sort parameter is whitelisted; anything else falls back to created.
    admin_json(&s, "/admin/api/accounts?sort=created_at;DROP%20TABLE%20accounts").await;
    assert_eq!(admin_json(&s, "/admin/api/overview").await["accounts"], 2);
}

/// Two shares of A's (one turned off), each with an update; a version of a
/// private note and one of a shared note.
#[tokio::test]
async fn shared_notes_and_versions_are_counted() {
    use plim_core::crypto::share_keys;
    let s = setup(1 << 20);
    let (a, _) = populate(&s).await;
    let ta = login(&s.public, &a.sk).await.unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let share_blob = |id: &str, seed: u8, kind: &str, covers: u64, ct: &[u8]| {
        let keys = share_keys(&[seed; 32]);
        let nonce = [3u8; 12];
        let sig = keys.signing.sign(&sig::share_blob_msg(id, kind, covers, &nonce, ct));
        json!({ "covers_seq": covers, "nonce": b64(&nonce), "ciphertext": b64(ct), "sig": b64(&sig.to_bytes()) })
    };
    for (id, seed) in [("00112233445566778899aabbccddeeff", 9), ("ffeeddccbbaa99887766554433221100", 10)] {
        let keys = share_keys(&[seed; 32]);
        let body = json!({
            "share_id": id,
            "pubkey": b64(&keys.pubkey),
            "read_hash": b64(&sig::sha256(&keys.read_token)),
            "update": share_blob(id, seed, "update", 0, &[1; 40]),
        });
        let (st, v) = call(&s.public, "POST", "/api/shares", Some(&ta), Some(body)).await;
        assert!(st.is_success(), "{v}");
    }
    let (st, _) = share_action(&s.public, &a, &ta, "ffeeddccbbaa99887766554433221100", "revoke").await;
    assert!(st.is_success());
    let id = "00112233445566778899aabbccddeeff";
    let (st, _) = call(&s.public, "POST", &format!("/api/shares/{id}/versions"), None, Some(share_blob(id, 9, "version", now, &[2; 7]))).await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, _) = call(&s.public, "POST", "/api/docs/aa/versions", Some(&ta), Some(a.blob("aa", "version", 1, now, &[3; 5]))).await;
    assert_eq!(st, StatusCode::CREATED);

    let v = admin_json(&s, "/admin/api/overview").await;
    let sh = &v["shares"];
    assert_eq!((sh["active"].as_i64(), sh["revoked"].as_i64(), sh["owners"].as_i64()), (Some(1), Some(1), Some(1)));
    assert_eq!((sh["new_week"].as_i64(), sh["updates"].as_i64(), sh["bytes"].as_i64()), (Some(2), Some(2), Some(80)));
    let ver = &v["versions"];
    assert_eq!((ver["private"].as_i64(), ver["shared"].as_i64()), (Some(1), Some(1)));
    assert_eq!((ver["notes"].as_i64(), ver["bytes"].as_i64()), (Some(2), Some(12)));
    assert_eq!(v["live"]["connections"], 0);
    assert_eq!(v["live"]["presence_relayed"], 0);
    assert_eq!(v["config"]["version_every_secs"], 3600);

    let ts = admin_json(&s, "/admin/api/timeseries?days=2").await;
    let today = ts["days"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((today["share_updates"].as_i64(), today["share_bytes"].as_i64()), (Some(2), Some(80)));
    assert_eq!((today["new_shares"].as_i64(), today["versions"].as_i64()), (Some(2), Some(2)));

    let acc = admin_json(&s, "/admin/api/accounts?sort=storage").await;
    let row = &acc["accounts"][0];
    assert_eq!((row["shares"].as_i64(), row["versions"].as_i64()), (Some(1), Some(2)));
}

#[tokio::test]
async fn admin_connection_is_read_only() {
    let s = setup(1000);
    populate(&s).await;
    let r = s.state.with_admin_db(|c| c.execute("DELETE FROM accounts", []));
    assert!(r.is_err(), "write through the admin connection must fail");
    assert_eq!(admin_json(&s, "/admin/api/overview").await["accounts"], 2);
}

#[tokio::test]
async fn host_header_guard_blocks_dns_rebinding() {
    let s = setup(1000);
    for host in [Some("evil.example"), Some("evil.example:3001"), Some("127.0.0.2:3001"), None] {
        let (status, _, _) = get_with_host(&s.admin, "/admin/api/overview", host).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{host:?}");
    }
    // Any port: a container's published host port can differ from the listener's.
    for host in ["localhost:3001", "127.0.0.1:3001", "[::1]:3001", "LOCALHOST:3001", "localhost", "localhost:8080", "[::1]"] {
        let (status, headers, _) = get_with_host(&s.admin, "/admin/api/overview", Some(host)).await;
        assert_eq!(status, StatusCode::OK, "{host}");
        assert_eq!(headers["content-security-policy"], plim_server::CSP);
        assert_eq!(headers["cache-control"], "no-store");
    }
}

#[tokio::test]
async fn admin_api_is_not_on_the_public_port() {
    let s = setup(1000);
    let (status, _, _) = get_with_host(&s.public, "/admin/api/overview", Some("localhost:3000")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn dashboard_page_and_icons_are_served() {
    let s = setup(1000);
    for path in ["/", "/icon.svg", "/favicon.ico", "/admin.js"] {
        let (status, headers, _) = get_with_host(&s.admin, path, Some(HOST)).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers["content-security-policy"], plim_server::CSP);
        assert_eq!(headers["cache-control"], "no-cache", "{path}");
    }
}

#[tokio::test]
async fn counters_track_failed_logins_and_rate_limits() {
    let s = setup(1000);
    let a = User::new(1, ACCT);
    signup(&s.public, &a).await;
    // A login with the wrong key fails with 401.
    assert!(login(&s.public, &SigningKey::from_bytes(&[9; 32])).await.is_err());
    // /api/pow allows 20 requests per minute per IP.
    for _ in 0..22 {
        call(&s.public, "POST", "/api/pow", None, Some(json!({}))).await;
    }
    let c = &admin_json(&s, "/admin/api/overview").await["counters"];
    assert_eq!(c["failed_logins"], 1);
    assert!(c["rate_limited"].as_u64().unwrap() >= 1);
    assert!(c["client_errors"].as_u64().unwrap() >= 2);
}

#[tokio::test]
async fn an_upload_refused_for_its_size_is_counted() {
    // (#444: the body limit was outside the counters, so the dashboard never saw these.)
    let s = setup(1000);
    let before = admin_json(&s, "/admin/api/overview").await["counters"]["client_errors"].as_u64().unwrap();
    let too_big = "x".repeat(s.state.cfg().max_body_bytes() + 1);
    let req = axum::http::Request::post("/api/docs/c0ffee/updates")
        .header("content-type", "application/json")
        .header("content-length", too_big.len())
        .body(axum::body::Body::from(too_big))
        .unwrap();
    let res = tower::ServiceExt::oneshot(s.public.clone(), req).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let after = admin_json(&s, "/admin/api/overview").await["counters"]["client_errors"].as_u64().unwrap();
    assert_eq!(after, before + 1);
}

#[test]
fn loopback_host_parsing() {
    for ok in ["localhost", "localhost:1", "127.0.0.1:65535", "[::1]:3001", "[::1]", " LocalHost:3001 "] {
        assert!(is_loopback_host(ok), "{ok}");
    }
    for bad in ["evil.example", "localhost.evil.example", "127.0.0.1.nip.io:3001", "127.0.0.2", "[::2]:3001", "", "[::1"] {
        assert!(!is_loopback_host(bad), "{bad}");
    }
}

#[test]
fn non_loopback_admin_bind_needs_opt_in() {
    let any: std::net::SocketAddr = "0.0.0.0:3001".parse().unwrap();
    let lo: std::net::SocketAddr = "127.0.0.1:3001".parse().unwrap();
    assert!(admin_bind_allowed(&lo, false));
    assert!(!admin_bind_allowed(&any, false));
    assert!(admin_bind_allowed(&any, true));
}

#[tokio::test]
async fn healthz_is_ok_and_not_counted_as_api_traffic() {
    let s = setup(1000);
    let before = admin_json(&s, "/admin/api/overview").await["counters"]["requests"].clone();
    for _ in 0..3 {
        let (status, headers, body) = get_with_host(&s.public, "/healthz", Some("localhost:3000")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["cache-control"], "no-store");
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({ "ok": true }));
    }
    assert_eq!(admin_json(&s, "/admin/api/overview").await["counters"]["requests"], before);
}

#[test]
fn admin_address_must_be_loopback() {
    for ok in ["127.0.0.1:3001", "[::1]:3001", "127.0.0.5:9"] {
        assert!(admin_addr_ok(&ok.parse().unwrap()), "{ok}");
    }
    for bad in ["0.0.0.0:3001", "[::]:3001", "192.168.1.10:3001", "10.0.0.1:3001"] {
        assert!(!admin_addr_ok(&bad.parse().unwrap()), "{bad}");
    }
}

/// The dashboard may only see metadata: encrypted columns can be measured
/// with LENGTH() but never selected.
#[test]
fn admin_queries_never_read_encrypted_content() {
    let src = include_str!("../src/admin.rs").replace("LENGTH(ciphertext)", "");
    let words: Vec<&str> = src.split(|c: char| !(c.is_alphanumeric() || c == '_')).collect();
    for forbidden in ["ciphertext", "wrapped", "nonce", "sig"] {
        assert!(!words.contains(&forbidden), "admin.rs mentions `{forbidden}`");
    }
}

/// Apps connected (#392): how many, how many used this week, the notes they reach; none of what's
/// in them. (A connection with its list note's holder, and one turned off.)
#[tokio::test]
async fn connections_are_counted() {
    use plim_core::crypto::{connection_keys, holder_keys, share_keys};
    let s = setup(1 << 20);
    let (a, _) = populate(&s).await;
    let ta = login(&s.public, &a.sk).await.unwrap();
    let v = admin_json(&s, "/admin/api/overview").await;
    assert_eq!(v["connections"]["active"], 0);
    for (cid, secret) in [("c0ffeec0ffeec0ffeec0ffeec0ffee01", 1u8), ("c0ffeec0ffeec0ffeec0ffeec0ffee02", 2)] {
        let ck = connection_keys(&[secret; 32]);
        let (st, v) = call(&s.public, "POST", "/api/connections", Some(&ta), Some(json!({ "connection_id": cid, "name": "Claude", "pubkey": b64(&ck.pubkey) }))).await;
        assert!(st.is_success(), "{v}");
    }
    // The first's list note, and its holder.
    let share = "00112233445566778899aabbccddeeff";
    let keys = share_keys(&[9; 32]);
    let nonce = [3u8; 12];
    let sig = keys.signing.sign(&sig::share_blob_msg(share, "update", 0, &nonce, &[1; 8]));
    let body = json!({ "share_id": share, "pubkey": b64(&keys.pubkey), "read_hash": b64(&sig::sha256(&keys.read_token)),
        "update": { "covers_seq": 0, "nonce": b64(&nonce), "ciphertext": b64(&[1; 8]), "sig": b64(&sig.to_bytes()) } });
    assert!(call(&s.public, "POST", "/api/shares", Some(&ta), Some(body)).await.0.is_success());
    let hk = holder_keys(&[7; 32]);
    let holder = json!({ "holder_id": "0123456789abcdef0123456789abcdef", "share_id": share, "role": "edit", "token_hash": b64(&sig::sha256(&hk.token)),
        "nonce": b64(&[4; 12]), "ciphertext": b64(&[5; 48]), "connection_id": "c0ffeec0ffeec0ffeec0ffeec0ffee01" });
    let (st, v) = call(&s.public, "POST", "/api/holders", Some(&ta), Some(holder)).await;
    assert!(st.is_success(), "{v}");
    // Used: its holder read.
    let (st, _) = call_with(&s.public, "GET", "/api/holders/0123456789abcdef0123456789abcdef", None, None, &[("x-holder-token", hex::encode(hk.token))]).await;
    assert!(st.is_success());
    // The second turned off.
    let (st, _) = signed(&s.public, &a.sk, &a.account_id, &ta, "POST", "/api/connections/c0ffeec0ffeec0ffeec0ffeec0ffee02/revoke", sig::action::REVOKE_CONNECTION, "c0ffeec0ffeec0ffeec0ffeec0ffee02", &[], None).await;
    assert!(st.is_success());
    let c = &admin_json(&s, "/admin/api/overview").await["connections"];
    assert_eq!((c["active"].as_i64(), c["revoked"].as_i64(), c["owners"].as_i64(), c["used_week"].as_i64(), c["holders"].as_i64(), c["new_week"].as_i64()),
        (Some(1), Some(1), Some(1), Some(1), Some(1), Some(2)), "{c}");
}
