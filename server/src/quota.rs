use axum::http::StatusCode;
use rusqlite::{Connection, params};

use crate::ApiError;

pub const STORAGE_FULL: ApiError = ApiError(StatusCode::INSUFFICIENT_STORAGE, "storage full");

pub fn used_bytes(conn: &Connection, account_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT used_bytes FROM accounts WHERE id = ?1",
        [account_id],
        |r| r.get(0),
    )
}

/// Fails with 507 if applying `delta` bytes would exceed the quota, after making room by deleting
/// the account's oldest versions (make_room). Shrinking (negative delta) is always allowed.
pub fn check(conn: &Connection, account_id: &str, delta: i64, quota: i64) -> Result<(), ApiError> {
    if delta > 0 && used_bytes(conn, account_id)? + delta > quota {
        make_room(conn, account_id, used_bytes(conn, account_id)? + delta - quota)?;
        if used_bytes(conn, account_id)? + delta > quota {
            return Err(STORAGE_FULL);
        }
    }
    Ok(())
}

/// At least `need` bytes freed, if the account's history has that many: its oldest versions deleted
/// first, its private notes' and the shared notes' it owns alike. History is whole while there's
/// room, and never stops a note being written.
pub fn make_room(conn: &Connection, account_id: &str, need: i64) -> rusqlite::Result<()> {
    let oldest: Vec<(bool, i64, i64)> = conn
        .prepare(
            "SELECT 0, id, LENGTH(ciphertext), created_at FROM versions WHERE account_id = ?1
             UNION ALL
             SELECT 1, v.id, LENGTH(v.ciphertext), v.created_at FROM share_versions v JOIN shares s ON s.share_id = v.share_id WHERE s.owner_account = ?1
             ORDER BY 4, 2",
        )?
        .query_map([account_id], |r| Ok((r.get::<_, i64>(0)? == 1, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // (Not enough even with all of it gone: none of it deleted, the write refused as before.)
    if oldest.iter().map(|o| o.2).sum::<i64>() < need {
        return Ok(());
    }
    let mut left = need;
    for (shared, id, len) in oldest {
        if left <= 0 {
            break;
        }
        conn.execute(if shared { "DELETE FROM share_versions WHERE id = ?1" } else { "DELETE FROM versions WHERE id = ?1" }, [id])?;
        left -= len;
    }
    if left < need {
        recompute(conn, account_id)?;
    }
    Ok(())
}

/// How much of the account's storage is history: its notes' versions and its shared notes'.
pub fn history_bytes(conn: &Connection, account_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM versions WHERE account_id = ?1)
              + (SELECT COALESCE(SUM(LENGTH(v.ciphertext)), 0) FROM share_versions v JOIN shares s ON s.share_id = v.share_id WHERE s.owner_account = ?1)",
        [account_id],
        |r| r.get(0),
    )
}

pub fn add(conn: &Connection, account_id: &str, delta: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE accounts SET used_bytes = MAX(0, used_bytes + ?2) WHERE id = ?1",
        params![account_id, delta],
    )?;
    Ok(())
}

/// Recount usage from stored blobs (after bulk deletes): the account's own
/// notes, plus the shared notes it owns (whoever wrote to them).
pub fn recompute(conn: &Connection, account_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE accounts SET used_bytes =
            (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM updates WHERE account_id = ?1)
          + (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM snapshots WHERE account_id = ?1)
          + (SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM versions WHERE account_id = ?1)
          + (SELECT COALESCE(SUM(LENGTH(u.ciphertext)), 0) FROM share_updates u
               JOIN shares s ON s.share_id = u.share_id WHERE s.owner_account = ?1)
          + (SELECT COALESCE(SUM(LENGTH(n.ciphertext)), 0) FROM share_snapshots n
               JOIN shares s ON s.share_id = n.share_id WHERE s.owner_account = ?1)
          + (SELECT COALESCE(SUM(LENGTH(v.ciphertext)), 0) FROM share_versions v
               JOIN shares s ON s.share_id = v.share_id WHERE s.owner_account = ?1)
         WHERE id = ?1",
        [account_id],
    )?;
    Ok(())
}
