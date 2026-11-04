//! Read-only admin dashboard, served on a separate loopback-only listener.
//!
//! Everything here is metadata: counts, sizes and timestamps. Queries run on a
//! read-only connection and may measure encrypted blobs only with LENGTH().

use std::collections::BTreeMap;
use std::net::SocketAddr;

use axum::Json;
use axum::Router;
use axum::extract::{Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::get;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

use crate::db::now;
use crate::{ApiError, AppState, no_store, security_headers};

const DAY: i64 = 86_400;

/// The admin listener must never be reachable from the network.
pub fn admin_addr_ok(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// Whether to bind the admin listener at `addr`. Non-loopback addresses need
/// an explicit opt-in, meant for containers whose admin port is published only
/// on the host's loopback (`-p 127.0.0.1:3001:3001`).
pub fn admin_bind_allowed(addr: &SocketAddr, allow_nonloopback: bool) -> bool {
    admin_addr_ok(addr) || allow_nonloopback
}

/// Whether a Host header names the loopback interface, on any port (a
/// container's published port may differ from the one it listens on).
/// A DNS-rebinding page arrives with the attacker's own domain, so it fails.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let name = if host.starts_with('[') {
        host.split_inclusive(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

pub fn admin_app(state: AppState) -> Router {
    let web = state.cfg().web_dir.clone();
    let api = Router::new()
        .route("/overview", get(overview))
        .route("/timeseries", get(timeseries))
        .route("/storage", get(storage))
        .route("/accounts", get(accounts))
        .layer(no_store());
    let router = Router::new()
        .nest("/admin/api", api)
        // Reuse the web app's icons rather than duplicating them.
        .route_service("/icon.svg", ServeFile::new(web.join("icon.svg")))
        .route_service("/favicon.ico", ServeFile::new(web.join("favicon.ico")))
        .fallback_service(ServeDir::new(state.cfg().admin_web_dir.clone()))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let ok = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).is_some_and(is_loopback_host);
            async move {
                if ok { next.run(req).await } else { (StatusCode::FORBIDDEN, "forbidden host").into_response() }
            }
        }));
    security_headers(router).with_state(state)
}

fn one<T: rusqlite::types::FromSql>(c: &Connection, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<T> {
    c.query_row(sql, p, |r| r.get(0))
}

fn file_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

async fn overview(State(st): State<AppState>) -> Result<Json<Value>, ApiError> {
    let t = now();
    let cfg = st.cfg().clone();
    let v = st.with_admin_db(|c| {
        let (accounts, used): (i64, i64) =
            c.query_row("SELECT COUNT(*), COALESCE(SUM(used_bytes), 0) FROM accounts", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let documents: i64 = one(
            c,
            "SELECT COUNT(*) FROM (SELECT account_id, doc_id FROM updates UNION SELECT account_id, doc_id FROM snapshots)",
            [],
        )?;
        let windows = [("day", DAY), ("week", 7 * DAY), ("month", 30 * DAY)];
        let mut new_accounts = serde_json::Map::new();
        let mut active = serde_json::Map::new();
        for (name, secs) in windows {
            let since = t - secs;
            new_accounts.insert(name.into(), json!(one::<i64>(c, "SELECT COUNT(*) FROM accounts WHERE created_at >= ?1", [since])?));
            active.insert(
                name.into(),
                json!(one::<i64>(
                    c,
                    "SELECT COUNT(*) FROM accounts a WHERE a.last_login_at >= ?1
                       OR EXISTS (SELECT 1 FROM updates u WHERE u.account_id = a.id AND u.created_at >= ?1)",
                    [since],
                )?),
            );
        }
        Ok(json!({
            "accounts": accounts,
            "documents": documents,
            "updates": one::<i64>(c, "SELECT COUNT(*) FROM updates", [])?,
            "snapshots": one::<i64>(c, "SELECT COUNT(*) FROM snapshots", [])?,
            "used_bytes": used,
            "quota_total_bytes": accounts * cfg.quota_bytes,
            "active_sessions": one::<i64>(c, "SELECT COUNT(*) FROM sessions WHERE expires_at >= ?1", [t])?,
            "rotated_accounts": one::<i64>(
                c,
                "SELECT COUNT(*) FROM (SELECT account_id FROM keyring GROUP BY account_id HAVING MAX(key_version) > 1)",
                [],
            )?,
            "new_accounts": new_accounts,
            "active_accounts": active,
            // Apps connected to accounts (#369, #392): how many, in use, and the notes they reach.
            "connections": {
                "active": one::<i64>(c, "SELECT COUNT(*) FROM connections WHERE revoked_at IS NULL", [])?,
                "revoked": one::<i64>(c, "SELECT COUNT(*) FROM connections WHERE revoked_at IS NOT NULL", [])?,
                "owners": one::<i64>(c, "SELECT COUNT(DISTINCT owner_account) FROM connections WHERE revoked_at IS NULL", [])?,
                "used_week": one::<i64>(c, "SELECT COUNT(*) FROM connections WHERE revoked_at IS NULL AND last_used_at >= ?1", [t - 7 * DAY])?,
                "new_week": one::<i64>(c, "SELECT COUNT(*) FROM connections WHERE created_at >= ?1", [t - 7 * DAY])?,
                // (Each a note it reaches, its own list note included: one each.)
                "holders": one::<i64>(c, "SELECT COUNT(*) FROM holders WHERE connection_id IS NOT NULL", [])?,
            },
            "shares": {
                "active": one::<i64>(c, "SELECT COUNT(*) FROM shares WHERE revoked_at IS NULL", [])?,
                "revoked": one::<i64>(c, "SELECT COUNT(*) FROM shares WHERE revoked_at IS NOT NULL", [])?,
                "owners": one::<i64>(c, "SELECT COUNT(DISTINCT owner_account) FROM shares WHERE revoked_at IS NULL", [])?,
                "new_week": one::<i64>(c, "SELECT COUNT(*) FROM shares WHERE created_at >= ?1", [t - 7 * DAY])?,
                "updates": one::<i64>(c, "SELECT COUNT(*) FROM share_updates", [])?,
                "snapshots": one::<i64>(c, "SELECT COUNT(*) FROM share_snapshots", [])?,
                "bytes": one::<i64>(
                    c,
                    "SELECT (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM share_updates)
                          + (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM share_snapshots)",
                    [],
                )?,
            },
            "versions": {
                "private": one::<i64>(c, "SELECT COUNT(*) FROM versions", [])?,
                "shared": one::<i64>(c, "SELECT COUNT(*) FROM share_versions", [])?,
                "notes": one::<i64>(
                    c,
                    "SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT account_id, doc_id FROM versions))
                          + (SELECT COUNT(DISTINCT share_id) FROM share_versions)",
                    [],
                )?,
                "bytes": one::<i64>(
                    c,
                    "SELECT (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM versions)
                          + (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM share_versions)",
                    [],
                )?,
            },
        }))
    })?;
    let mut v = v;
    v["db_bytes"] = json!(file_size(&cfg.db_path) + file_size(&format!("{}-wal", cfg.db_path)));
    v["uptime_secs"] = json!(t - st.started_at());
    v["live"] = st.live().stats();
    v["live_connections"] = v["live"]["connections"].clone();
    v["counters"] = st.metrics().snapshot();
    v["config"] = json!({
        "pow_bits": cfg.pow_bits,
        "quota_bytes": cfg.quota_bytes,
        "max_blob_bytes": cfg.max_blob_bytes,
        "prune_on_snapshot": cfg.prune_on_snapshot,
        "version_every_secs": cfg.version_every_secs,
        "max_accounts": cfg.max_accounts,
        "db_path": cfg.db_path,
        "trusted_proxies": cfg.proxy.describe(),
    });
    Ok(Json(v))
}

#[derive(Deserialize)]
struct DaysQuery {
    days: Option<i64>,
}

/// Per UTC day: signups, updates written, bytes written, distinct writers;
/// and shared notes' updates (and their bytes), new shares, versions saved.
async fn timeseries(State(st): State<AppState>, Query(q): Query<DaysQuery>) -> Result<Json<Value>, ApiError> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let today = now() / DAY;
    let first = today - days + 1;
    let mut rows: BTreeMap<i64, [i64; 4]> = (first..=today).map(|d| (d, [0; 4])).collect();
    let mut shared: BTreeMap<i64, [i64; 4]> = (first..=today).map(|d| (d, [0; 4])).collect();
    st.with_admin_db(|c| {
        let mut s = c.prepare("SELECT created_at / 86400, COUNT(*) FROM accounts WHERE created_at >= ?1 GROUP BY 1")?;
        for r in s.query_map([first * DAY], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (d, n) = r?;
            if let Some(row) = rows.get_mut(&d) {
                row[0] = n;
            }
        }
        let mut s = c.prepare(
            "SELECT created_at / 86400, COUNT(*), COALESCE(SUM(LENGTH(ciphertext)), 0), COUNT(DISTINCT account_id)
             FROM updates WHERE created_at >= ?1 GROUP BY 1",
        )?;
        for r in s.query_map([first * DAY], |r| Ok((r.get::<_, i64>(0)?, [r.get(1)?, r.get(2)?, r.get(3)?])))? {
            let (d, [n, bytes, writers]) = r?;
            if let Some(row) = rows.get_mut(&d) {
                row[1..].copy_from_slice(&[n, bytes, writers]);
            }
        }
        // Shared notes: [updates, bytes, new shares, versions] (private and shared).
        let per_day: [(&str, &[usize]); 4] = [
            ("SELECT created_at / 86400, COUNT(*), COALESCE(SUM(LENGTH(ciphertext)), 0) FROM share_updates WHERE created_at >= ?1 GROUP BY 1", &[0, 1]),
            ("SELECT created_at / 86400, COUNT(*) FROM shares WHERE created_at >= ?1 GROUP BY 1", &[2]),
            ("SELECT created_at / 86400, COUNT(*) FROM versions WHERE created_at >= ?1 GROUP BY 1", &[3]),
            ("SELECT created_at / 86400, COUNT(*) FROM share_versions WHERE created_at >= ?1 GROUP BY 1", &[3]),
        ];
        for (sql, cols) in per_day {
            let mut s = c.prepare(sql)?;
            let mut q = s.query([first * DAY])?;
            while let Some(r) = q.next()? {
                if let Some(row) = shared.get_mut(&r.get::<_, i64>(0)?) {
                    for (i, &col) in cols.iter().enumerate() {
                        row[col] += r.get::<_, i64>(i + 1)?;
                    }
                }
            }
        }
        Ok(())
    })?;
    let series: Vec<Value> = rows
        .into_iter()
        .zip(shared.into_values())
        .map(|((d, [signups, updates, bytes, writers]), [share_updates, share_bytes, new_shares, versions])| {
            json!({ "day": d * DAY, "signups": signups, "updates": updates, "bytes": bytes, "active_writers": writers,
                    "share_updates": share_updates, "share_bytes": share_bytes, "new_shares": new_shares, "versions": versions })
        })
        .collect();
    Ok(Json(json!({ "days": series })))
}

/// Accounts bucketed by how full they are (tenths of the quota).
async fn storage(State(st): State<AppState>) -> Result<Json<Value>, ApiError> {
    let quota = st.cfg().quota_bytes.max(1);
    let used: Vec<i64> = st.with_admin_db(|c| {
        c.prepare("SELECT used_bytes FROM accounts")?.query_map([], |r| r.get(0))?.collect()
    })?;
    let mut buckets = [0i64; 10];
    for u in used {
        buckets[((u * 10 / quota).clamp(0, 9)) as usize] += 1;
    }
    let buckets: Vec<Value> =
        buckets.iter().enumerate().map(|(i, n)| json!({ "from_pct": i * 10, "to_pct": i * 10 + 10, "accounts": n })).collect();
    Ok(Json(json!({ "quota_bytes": quota, "buckets": buckets })))
}

#[derive(Deserialize)]
struct AccountsQuery {
    sort: Option<String>,
    limit: Option<i64>,
}

async fn accounts(State(st): State<AppState>, Query(q): Query<AccountsQuery>) -> Result<Json<Value>, ApiError> {
    // Whitelisted ORDER BY clauses; nothing from the query string reaches the SQL.
    let order = match q.sort.as_deref() {
        Some("storage") => "used_bytes DESC",
        Some("active") => "MAX(COALESCE(last_write_at, 0), COALESCE(last_login_at, 0)) DESC",
        _ => "created_at DESC",
    };
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let quota = st.cfg().quota_bytes.max(1);
    let (total, rows) = st.with_admin_db(|c| {
        let total: i64 = one(c, "SELECT COUNT(*) FROM accounts", [])?;
        let sql = format!(
            "SELECT * FROM (
               SELECT a.id, a.created_at, a.used_bytes, a.last_login_at,
                 (SELECT COUNT(*) FROM (SELECT doc_id FROM updates WHERE account_id = a.id
                                         UNION SELECT doc_id FROM snapshots WHERE account_id = a.id)) AS docs,
                 (SELECT COUNT(*) FROM updates WHERE account_id = a.id) AS updates,
                 (SELECT MAX(created_at) FROM updates WHERE account_id = a.id) AS last_write_at,
                 (SELECT MAX(key_version) FROM keyring WHERE account_id = a.id) AS key_version,
                 (SELECT COUNT(*) FROM shares WHERE owner_account = a.id AND revoked_at IS NULL) AS shares,
                 (SELECT COUNT(*) FROM versions WHERE account_id = a.id)
                   + (SELECT COUNT(*) FROM share_versions v JOIN shares s ON s.share_id = v.share_id
                      WHERE s.owner_account = a.id) AS versions
               FROM accounts a)
             ORDER BY {order} LIMIT ?1"
        );
        let rows = c
            .prepare(&sql)?
            .query_map(params![limit], |r| {
                let id: String = r.get(0)?;
                let used: i64 = r.get(2)?;
                Ok(json!({
                    "id_short": &id[..8.min(id.len())],
                    "created_at": r.get::<_, i64>(1)?,
                    "used_bytes": used,
                    "quota_pct": (used as f64 * 100.0 / quota as f64 * 10.0).round() / 10.0,
                    "last_login_at": r.get::<_, Option<i64>>(3)?,
                    "docs": r.get::<_, i64>(4)?,
                    "updates": r.get::<_, i64>(5)?,
                    "last_write_at": r.get::<_, Option<i64>>(6)?,
                    "key_version": r.get::<_, Option<i64>>(7)?,
                    "shares": r.get::<_, i64>(8)?,
                    "versions": r.get::<_, i64>(9)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((total, rows))
    })?;
    Ok(Json(json!({ "total": total, "accounts": rows })))
}
