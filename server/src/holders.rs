//! Holders (#369): a shared note's keys held by more than one link, each with a secret of its
//! own, so links can be given out and taken back one by one, and a connection (Claude) given
//! a note and later turned off without touching the links people have.
//!
//! A holder's row points at the note's current share and holds that share's keys sealed to
//! the holder's secret (plim-core seal_held_keys: the seed for an edit holder, the encryption
//! key and public key for a read one). The server serves the row to whoever presents the
//! holder's token (its SHA-256 is kept, as a share's read token's is) and never sees a key.
//! Replacing a note's links makes a new share, as before, and re-seals its keys for each
//! holder kept (PUT), so their links keep working; a holder taken away (DELETE, signed by the
//! owner, #144) gets nothing, and the old share goes with its keys.
//!
//! Reads send the token as hex in `X-Holder-Token` (not the URL, which ends up in logs).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{ActionSig, Session, verify_action};
use crate::connections::RateWho;
use crate::db::now;
use crate::shares::{READS_PER_MINUTE, valid_share_id};
use crate::sig::{self, sha256};
use crate::{ApiError, AppState, b64, b64e, bad_request};

/// Holders one share may have (links given out, and connections).
const MAX_HOLDERS_PER_SHARE: i64 = 50;
/// The sealed keys: a role byte and at most two 32-byte keys, plus AES-GCM's tag.
const MAX_SEALED_BYTES: usize = 128;
const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "no such holder");
const GONE: ApiError = ApiError(StatusCode::GONE, "this link was turned off");

/// A share the caller owns, if it's there and its links are on.
fn owned_share(conn: &Connection, share_id: &str, account: &str) -> Result<(), ApiError> {
    if !valid_share_id(share_id) {
        return Err(bad_request("invalid share_id"));
    }
    let live: Option<bool> = conn
        .query_row("SELECT revoked_at IS NULL FROM shares WHERE share_id = ?1 AND owner_account = ?2", params![share_id, account], |r| r.get(0))
        .optional()?;
    match live {
        Some(true) => Ok(()),
        Some(false) => Err(GONE),
        None => Err(ApiError(StatusCode::NOT_FOUND, "no such share")),
    }
}

fn sealed(nonce: &str, ciphertext: &str) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let (nonce, ciphertext) = (b64(nonce)?, b64(ciphertext)?);
    if nonce.len() != 12 {
        return Err(bad_request("nonce must be 12 bytes"));
    }
    if ciphertext.is_empty() || ciphertext.len() > MAX_SEALED_BYTES {
        return Err(bad_request("the sealed keys are the wrong size"));
    }
    Ok((nonce, ciphertext))
}

#[derive(Deserialize)]
pub struct CreateReq {
    holder_id: String,
    share_id: String,
    role: String,
    token_hash: String,
    nonce: String,
    ciphertext: String,
    /// A connection's holder (#369): one of the caller's connections, not revoked.
    #[serde(default)]
    connection_id: Option<String>,
}

/// POST /holders: a holder of one of the caller's shares, with the share's keys sealed to it.
pub async fn create(State(st): State<AppState>, s: Session, Json(req): Json<CreateReq>) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !valid_share_id(&req.holder_id) {
        return Err(bad_request("invalid holder_id"));
    }
    if req.role != "edit" && req.role != "read" {
        return Err(bad_request("role must be edit or read"));
    }
    let token_hash = b64(&req.token_hash)?;
    if token_hash.len() != 32 {
        return Err(bad_request("token_hash must be 32 bytes"));
    }
    let (nonce, ciphertext) = sealed(&req.nonce, &req.ciphertext)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    owned_share(&tx, &req.share_id, &s.account_id)?;
    if let Some(c) = &req.connection_id {
        crate::connections::owned_live(&tx, c, &s.account_id)?;
        // One holder per connection and note: two of the owner's devices keeping a connection in
        // step may each ask. The second gets the first's id (200, not 201); a connection holder's
        // secret comes from its id and the connection's, so that device can use it as its own.
        let existing: Option<String> = tx
            .query_row("SELECT holder_id FROM holders WHERE connection_id = ?1 AND share_id = ?2", params![c, req.share_id], |r| r.get(0))
            .optional()?;
        if let Some(holder_id) = existing {
            return Ok((StatusCode::OK, Json(json!({ "holder_id": holder_id }))));
        }
    }
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM holders WHERE share_id = ?1", [&req.share_id], |r| r.get(0))?;
    if count >= MAX_HOLDERS_PER_SHARE {
        return Err(ApiError(StatusCode::CONFLICT, "this note has too many links"));
    }
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO holders (holder_id, owner_account, share_id, role, token_hash, nonce, ciphertext, created_at, connection_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![req.holder_id, s.account_id, req.share_id, req.role, token_hash, nonce, ciphertext, now(), req.connection_id],
    )?;
    if inserted == 0 {
        return Err(ApiError(StatusCode::CONFLICT, "holder already exists"));
    }
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "holder_id": req.holder_id }))))
}

/// GET /holders/{id}, with the holder's token: the share it's for, its role and its sealed
/// keys. Unknown and wrong token look the same; a share turned off or gone says so.
pub async fn get(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-read", READS_PER_MINUTE)?;
    let token = headers.get("x-holder-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let token = hex::decode(token).map_err(|_| NOT_FOUND)?;
    if !valid_share_id(&id) {
        return Err(NOT_FOUND);
    }
    let db = st.db();
    let row = db
        .query_row(
            "SELECT share_id, role, nonce, ciphertext, connection_id, created_at FROM holders WHERE holder_id = ?1 AND token_hash = ?2",
            params![id, sha256(&token)],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Vec<u8>>(2)?, r.get::<_, Vec<u8>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, i64>(5)?)),
        )
        .optional()?
        .ok_or(NOT_FOUND)?;
    let (share_id, role, nonce, ciphertext, connection, created_at) = row;
    let live: Option<bool> = db.query_row("SELECT revoked_at IS NULL FROM shares WHERE share_id = ?1", [&share_id], |r| r.get(0)).optional()?;
    if live != Some(true) {
        return Err(GONE);
    }
    // Last used, to the minute (#408): a read takes the write lock only when that changes.
    db.execute("UPDATE holders SET last_used_at = ?2 WHERE holder_id = ?1 AND COALESCE(last_used_at, 0) < ?2 - 60", params![id, now()])?;
    if let Some(c) = &connection {
        // (A revoked connection's holders are gone with it; its last use is the connection's too.)
        db.execute("UPDATE connections SET last_used_at = ?2 WHERE connection_id = ?1 AND COALESCE(last_used_at, 0) < ?2 - 60", params![c, now()])?;
    }
    // (`created_at`: when it was made, #505: an AI reads a note's history only from when it was given it.)
    Ok(Json(json!({ "share_id": share_id, "role": role, "nonce": b64e(&nonce), "ciphertext": b64e(&ciphertext), "created_at": created_at })))
}

#[derive(Deserialize)]
pub struct ResealReq {
    share_id: String,
    role: String,
    nonce: String,
    ciphertext: String,
}

/// PUT /holders/{id}: the holder's keys sealed again, for the note's new share (the owner
/// replaced the note's links and keeps this holder), with what it may do now.
pub async fn reseal(State(st): State<AppState>, s: Session, Path(id): Path<String>, Json(req): Json<ResealReq>) -> Result<StatusCode, ApiError> {
    if req.role != "edit" && req.role != "read" {
        return Err(bad_request("role must be edit or read"));
    }
    let (nonce, ciphertext) = sealed(&req.nonce, &req.ciphertext)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    owned_share(&tx, &req.share_id, &s.account_id)?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM holders WHERE share_id = ?1 AND holder_id != ?2", params![req.share_id, id], |r| r.get(0))?;
    if count >= MAX_HOLDERS_PER_SHARE {
        return Err(ApiError(StatusCode::CONFLICT, "this note has too many links"));
    }
    let changed = tx.execute(
        "UPDATE holders SET share_id = ?3, role = ?4, nonce = ?5, ciphertext = ?6 WHERE holder_id = ?1 AND owner_account = ?2",
        params![id, s.account_id, req.share_id, req.role, nonce, ciphertext],
    )?;
    if changed == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /holders/{id}: the holder taken away, signed with the owner's key (#144). Its link
/// stops working at once; what it could still open (the current share) goes when the owner
/// replaces the note's links, which the owner's app does right after.
pub async fn delete(State(st): State<AppState>, s: Session, a: ActionSig, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let mine: bool = st
        .db()
        .query_row("SELECT EXISTS(SELECT 1 FROM holders WHERE holder_id = ?1 AND owner_account = ?2)", params![id, s.account_id], |r| r.get(0))?;
    if !mine {
        return Err(NOT_FOUND);
    }
    verify_action(&st, &s.account_id, &a, sig::action::DELETE_HOLDER, &id, &[])?;
    let gone = st.db().execute("DELETE FROM holders WHERE holder_id = ?1 AND owner_account = ?2", params![id, s.account_id])?;
    if gone == 0 {
        return Err(NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// GET /shares/{id}/holders: the owner's list of a share's holders (never their keys).
pub async fn list(State(st): State<AppState>, s: Session, Path(share_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let db = st.db();
    if !valid_share_id(&share_id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "no such share"));
    }
    let mine: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM shares WHERE share_id = ?1 AND owner_account = ?2)", params![share_id, s.account_id], |r| r.get(0))?;
    if !mine {
        return Err(ApiError(StatusCode::NOT_FOUND, "no such share"));
    }
    let mut stmt = db.prepare("SELECT holder_id, role, created_at, last_used_at FROM holders WHERE share_id = ?1 ORDER BY created_at, holder_id")?;
    let holders = stmt
        .query_map([&share_id], |r| {
            Ok(json!({ "holder_id": r.get::<_, String>(0)?, "role": r.get::<_, String>(1)?, "created_at": r.get::<_, i64>(2)?, "last_used_at": r.get::<_, Option<i64>>(3)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "holders": holders })))
}
