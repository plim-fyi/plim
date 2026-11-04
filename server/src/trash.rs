//! A deleted note's or share's data, kept for 30 days so it can be restored (#253).
//!
//! Deleting a note (`DELETE /docs/{id}`) or a share (`DELETE /shares/{id}`) moves every row
//! of it into one `trash` row: out of reach of every read and sync at once (it's gone as far
//! as anyone can tell), and not counted in the account's used_bytes, so sharing a note (which
//! deletes its private copy) doesn't cost its size twice. An account's trash holds at most
//! its quota; past that, the oldest goes first. `db::sweep` removes what's older than 30
//! days; deleting the account removes it all at once.
//!
//! The app restores a note deleted forever from "Recently deleted" (`POST
//! /trash/{doc|share}/{id}/restore`, signed with the account's key as deleting is, #144):
//! its rows go back as they were, and count again. Its history is read and written back by the
//! note store (store.rs), a private note's and a shared one's alike.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{ActionSig, Session, verify_action};
use crate::db::now;
use crate::store::{Doc, History};
use crate::{ApiError, AppState, b64, b64e, bad_request, quota, sig};

/// How long a deleted note's data is kept.
pub const KEEP_SECS: i64 = 30 * 86_400;

const NOT_IN_TRASH: ApiError = ApiError(StatusCode::NOT_FOUND, "not in the trash (or kept no longer)");
const TAKEN: ApiError = ApiError(StatusCode::CONFLICT, "something is there again: it can't be restored over it");

/// A share's own row (its keys' public halves, and whether its links were turned off).
#[derive(Serialize, Deserialize)]
struct ShareRow {
    pubkey: String,
    read_hash: String,
    created_at: i64,
    revoked_at: Option<i64>,
}

/// Everything of a deleted note or share: as stored in `trash.payload`, so its form stays
/// (`share`, then `updates`, `snapshots` and `versions` beside it).
#[derive(Serialize, Deserialize, Default)]
struct Kept {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    share: Option<ShareRow>,
    #[serde(flatten)]
    history: History,
}

/// A note's data into the trash, before it's deleted (nothing if it holds nothing). Replaces
/// what was kept of it before.
pub fn keep_doc(conn: &Connection, account: &str, doc_id: &str, quota: i64) -> rusqlite::Result<()> {
    let history = Doc::Private { account, doc: doc_id }.read_all(conn)?;
    put(conn, account, "doc", doc_id, &Kept { share: None, history }, quota)
}

/// A share's data into the trash, before it's deleted. Its owner's.
pub fn keep_share(conn: &Connection, account: &str, share_id: &str, quota: i64) -> rusqlite::Result<()> {
    let share = conn
        .query_row(
            "SELECT pubkey, read_hash, created_at, revoked_at FROM shares WHERE share_id = ?1",
            [share_id],
            |r| Ok(ShareRow { pubkey: b64e(&r.get::<_, Vec<u8>>(0)?), read_hash: b64e(&r.get::<_, Vec<u8>>(1)?), created_at: r.get(2)?, revoked_at: r.get(3)? }),
        )
        .optional()?;
    let Some(share) = share else { return Ok(()) };
    let history = Doc::Shared { share: share_id }.read_all(conn)?;
    put(conn, account, "share", share_id, &Kept { share: Some(share), history }, quota)
}

fn put(conn: &Connection, account: &str, kind: &str, target: &str, kept: &Kept, quota: i64) -> rusqlite::Result<()> {
    if kept.share.is_none() && kept.history.is_empty() {
        return Ok(());
    }
    let payload = serde_json::to_vec(kept).expect("JSON");
    conn.execute(
        "INSERT OR REPLACE INTO trash (account_id, kind, target, deleted_at, bytes, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![account, kind, target, now(), kept.history.bytes(), payload],
    )?;
    // At most the account's quota of it: the oldest goes first (never the one just kept).
    loop {
        let total: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM trash WHERE account_id = ?1", [account], |r| r.get(0))?;
        if total <= quota {
            return Ok(());
        }
        let gone = conn.execute(
            "DELETE FROM trash WHERE rowid = (SELECT rowid FROM trash WHERE account_id = ?1 AND NOT (kind = ?2 AND target = ?3)
               ORDER BY deleted_at, rowid LIMIT 1)",
            params![account, kind, target],
        )?;
        if gone == 0 {
            return Ok(());
        }
    }
}

/// What the account can restore: `{ "trash": [{ kind, target, deleted_at, bytes }] }`, most
/// recently deleted first.
pub async fn list(State(st): State<AppState>, s: Session) -> Result<Json<Value>, ApiError> {
    let db = st.db();
    let mut stmt = db.prepare("SELECT kind, target, deleted_at, bytes FROM trash WHERE account_id = ?1 AND deleted_at >= ?2 ORDER BY deleted_at DESC")?;
    let trash = stmt
        .query_map(params![s.account_id, now() - KEEP_SECS], |r| {
            Ok(json!({ "kind": r.get::<_, String>(0)?, "target": r.get::<_, String>(1)?, "deleted_at": r.get::<_, i64>(2)?, "bytes": r.get::<_, i64>(3)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "trash": trash })))
}

/// Restore a note's (`kind` "doc") or a share's ("share") data as it was when it was deleted:
/// signed with the account's key (#144), refused if something is there again (409) or it
/// wouldn't fit the quota (507). The trash row goes.
pub async fn restore(
    State(st): State<AppState>,
    s: Session,
    a: ActionSig,
    Path((kind, target)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let action = match kind.as_str() {
        "doc" if crate::valid_doc_id(&target) => sig::action::RESTORE_DOC,
        "share" if crate::shares::valid_share_id(&target) => sig::action::RESTORE_SHARE,
        _ => return Err(bad_request("invalid trash entry")),
    };
    verify_action(&st, &s.account_id, &a, action, &target, &[])?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let payload: Option<Vec<u8>> = tx
        .query_row(
            "SELECT payload FROM trash WHERE account_id = ?1 AND kind = ?2 AND target = ?3 AND deleted_at >= ?4",
            params![s.account_id, kind, target, now() - KEEP_SECS],
            |r| r.get(0),
        )
        .optional()?;
    let kept: Kept = serde_json::from_slice(&payload.ok_or(NOT_IN_TRASH)?).map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "a corrupt trash entry"))?;
    quota::check(&tx, &s.account_id, kept.history.bytes(), st.cfg().quota_bytes)?;
    if kind == "doc" {
        let doc = Doc::Private { account: &s.account_id, doc: &target };
        if doc.exists(&tx)? {
            return Err(TAKEN);
        }
        doc.write_all(&tx, &kept.history)?;
        // It takes edits again (deleting it closed it, #119).
        tx.execute("DELETE FROM gone_docs WHERE account_id = ?1 AND doc_id = ?2", params![s.account_id, target])?;
    } else {
        let share = kept.share.as_ref().ok_or(NOT_IN_TRASH)?;
        if tx.prepare("SELECT 1 FROM shares WHERE share_id = ?1")?.exists([&target])? {
            return Err(TAKEN);
        }
        tx.execute(
            "INSERT INTO shares (share_id, owner_account, pubkey, read_hash, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![target, s.account_id, b64(&share.pubkey)?, b64(&share.read_hash)?, share.created_at, share.revoked_at],
        )?;
        Doc::Shared { share: &target }.write_all(&tx, &kept.history)?;
    }
    tx.execute("DELETE FROM trash WHERE account_id = ?1 AND kind = ?2 AND target = ?3", params![s.account_id, kind, target])?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trash row kept before the note store (#411) still reads, and writes back the same.
    #[test]
    fn payloads_kept_before_still_read() {
        let old = r#"{"share":{"pubkey":"AA==","read_hash":"AQ==","created_at":5,"revoked_at":null},
            "updates":[{"seq":1,"created_at":6,"nonce":"Ag==","ciphertext":"AwQ=","sig":"BQ=="}],
            "snapshots":[{"covers_seq":1,"created_at":7,"nonce":"Bg==","ciphertext":"Bw==","sig":"CA=="}],
            "versions":[]}"#;
        let kept: Kept = serde_json::from_str(old).unwrap();
        assert_eq!((kept.history.updates.len(), kept.history.snapshots[0].covers_seq, kept.history.bytes()), (1, Some(1), 3));
        let again: serde_json::Value = serde_json::to_value(&kept).unwrap();
        assert_eq!(again, serde_json::from_str::<serde_json::Value>(old).unwrap());
        let private = r#"{"updates":[{"seq":2,"key_version":3,"created_at":6,"nonce":"Ag==","ciphertext":"AwQ=","sig":"BQ=="}],"snapshots":[],"versions":[{"key_version":3,"created_at":8,"nonce":"Ag==","ciphertext":"AA==","sig":"BQ=="}]}"#;
        let kept: Kept = serde_json::from_str(private).unwrap();
        assert!(kept.share.is_none());
        assert_eq!(serde_json::to_value(&kept).unwrap(), serde_json::from_str::<serde_json::Value>(private).unwrap());
    }
}
