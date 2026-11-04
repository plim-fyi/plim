//! Connections (#369): an app (Claude, through the connector) the owner connected to their
//! notes. The owner's app makes it from a random secret (plim-core connection_keys): an
//! Ed25519 key it signs with, and holders for the notes granted to it (holders.connection_id),
//! each note's keys sealed to a secret of that holder's; the connection's own list note is one.
//!
//! It reads and writes notes through its holders' rows and the share endpoints, like anyone
//! with a link, so the only thing it does as itself is make a note on the owner's behalf:
//! POST /connections/{id}/shares, signed with its key over a fresh challenge (as an owner's
//! destructive actions are, #144), the share then the owner's (quota, count) like any other.
//!
//! The owner: creates, lists, renames; revoke turns it off at once (its holders go with it,
//! and the owner's app replaces the granted notes' links, so what it could still open goes
//! too); delete removes the record.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{ActionSig, Session, verify_action};
use crate::db::now;
use crate::shares::{CreateReq as ShareReq, insert_share, valid_share_id};
use crate::sig::{self, pubkey_hash};
use crate::{ApiError, AppState, b64, bad_request};

/**
 * Whom a request counts against, for rate limits (#394): the connection, when it says so and signs
 * it (X-Tiro-Connection: its id, X-Tiro-Connection-Sig: its key over `sig::conn_rate_msg` for this
 * minute or the last), and it's on; else the client's address. Every user's Claude reaches the
 * server from the connector's one address: counted by address, they'd share one allowance.
 */
pub struct RateWho(pub crate::RateSubject);

impl axum::extract::FromRequestParts<AppState> for RateWho {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let crate::auth::ClientIp(ip) = crate::auth::ClientIp::from_request_parts(parts, st).await?;
        let header = |k: &str| parts.headers.get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
        if let (Some(id), Some(signed)) = (header("x-tiro-connection"), header("x-tiro-connection-sig"))
            && signed_by(st, &id, &signed)
        {
            return Ok(RateWho(crate::RateSubject::Connection(id)));
        }
        Ok(RateWho(crate::RateSubject::Ip(ip)))
    }
}

/// Whether `signed` is the connection's signature over this minute's (or the last's) rate message.
fn signed_by(st: &AppState, id: &str, signed: &str) -> bool {
    use base64::Engine;
    if !valid_share_id(id) {
        return false;
    }
    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(signed) else { return false };
    let pubkey: Option<Vec<u8>> = st
        .db()
        .query_row("SELECT pubkey FROM connections WHERE connection_id = ?1 AND revoked_at IS NULL", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let Some(pubkey) = pubkey else { return false };
    let minute = (now() / 60) as u64;
    [minute, minute.saturating_sub(1)].iter().any(|m| sig::verify(&pubkey, &sig::conn_rate_msg(id, *m), &sig_bytes))
}

/// Connections one account may have.
const MAX_PER_ACCOUNT: i64 = 20;
const MAX_NAME: usize = 60;
const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "no such connection");
const REVOKED: ApiError = ApiError(StatusCode::GONE, "this connection was turned off");

/// The connection, if the caller owns it and it's on.
pub(crate) fn owned_live(conn: &Connection, id: &str, account: &str) -> Result<(), ApiError> {
    if !valid_share_id(id) {
        return Err(NOT_FOUND);
    }
    let live: Option<bool> = conn
        .query_row("SELECT revoked_at IS NULL FROM connections WHERE connection_id = ?1 AND owner_account = ?2", params![id, account], |r| r.get(0))
        .optional()?;
    match live {
        Some(true) => Ok(()),
        Some(false) => Err(REVOKED),
        None => Err(NOT_FOUND),
    }
}

fn clean_name(name: &str) -> Result<String, ApiError> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(bad_request("a name is 1 to 60 characters"));
    }
    Ok(name)
}

#[derive(Deserialize)]
pub struct CreateReq {
    connection_id: String,
    name: String,
    pubkey: String,
}

/// POST /connections: a connection of the caller's, with the key it will sign with.
pub async fn create(State(st): State<AppState>, s: Session, Json(req): Json<CreateReq>) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !valid_share_id(&req.connection_id) {
        return Err(bad_request("invalid connection_id"));
    }
    let name = clean_name(&req.name)?;
    let pubkey = b64(&req.pubkey)?;
    if pubkey.len() != 32 {
        return Err(bad_request("pubkey must be 32 bytes"));
    }
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM connections WHERE owner_account = ?1 AND revoked_at IS NULL", [&s.account_id], |r| r.get(0))?;
    if count >= MAX_PER_ACCOUNT {
        return Err(ApiError(StatusCode::CONFLICT, "too many connections"));
    }
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO connections (connection_id, owner_account, name, pubkey, pubkey_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![req.connection_id, s.account_id, name, pubkey, pubkey_hash(&pubkey), now()],
    )?;
    if inserted == 0 {
        return Err(ApiError(StatusCode::CONFLICT, "connection already exists"));
    }
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "connection_id": req.connection_id }))))
}

/// GET /connections: the caller's, revoked ones included (the app says "turned off").
pub async fn list(State(st): State<AppState>, s: Session) -> Result<Json<Value>, ApiError> {
    let db = st.db();
    let mut stmt = db.prepare(
        "SELECT connection_id, name, created_at, last_used_at, revoked_at,
                (SELECT COUNT(*) FROM holders WHERE holders.connection_id = connections.connection_id)
         FROM connections WHERE owner_account = ?1 ORDER BY created_at, connection_id",
    )?;
    let rows = stmt
        .query_map([&s.account_id], |r| {
            Ok(json!({
                "connection_id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "created_at": r.get::<_, i64>(2)?,
                "last_used_at": r.get::<_, Option<i64>>(3)?, "revoked_at": r.get::<_, Option<i64>>(4)?, "holders": r.get::<_, i64>(5)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "connections": rows })))
}

/// GET /connections/{id}/holders: the owner's list of a connection's holders, each with the share
/// it's on and how many holders of anyone else's that share has (never their keys). The owner's
/// app compares it with the notes it has, to find a holder left on a share no note uses (#465:
/// two devices sharing the same note at once each made one).
pub async fn holders(State(st): State<AppState>, s: Session, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let db = st.db();
    let mine: bool = valid_share_id(&id)
        && db.query_row("SELECT EXISTS(SELECT 1 FROM connections WHERE connection_id = ?1 AND owner_account = ?2)", params![id, s.account_id], |r| r.get(0))?;
    if !mine {
        return Err(NOT_FOUND);
    }
    let mut stmt = db.prepare(
        "SELECT holder_id, share_id, created_at,
                (SELECT COUNT(*) FROM holders o WHERE o.share_id = h.share_id AND o.connection_id IS NOT ?1)
         FROM holders h WHERE connection_id = ?1 AND owner_account = ?2 ORDER BY created_at, holder_id",
    )?;
    let holders = stmt
        .query_map(params![id, s.account_id], |r| {
            Ok(json!({ "holder_id": r.get::<_, String>(0)?, "share_id": r.get::<_, String>(1)?, "created_at": r.get::<_, i64>(2)?, "others": r.get::<_, i64>(3)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "holders": holders })))
}

#[derive(Deserialize)]
pub struct RenameReq {
    name: String,
}

/// PATCH /connections/{id}: its name.
pub async fn rename(State(st): State<AppState>, s: Session, Path(id): Path<String>, Json(req): Json<RenameReq>) -> Result<StatusCode, ApiError> {
    let name = clean_name(&req.name)?;
    let changed = st.db().execute("UPDATE connections SET name = ?3 WHERE connection_id = ?1 AND owner_account = ?2", params![id, s.account_id, name])?;
    if changed == 0 {
        return Err(NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn mine(conn: &Connection, id: &str, account: &str) -> Result<(), ApiError> {
    let found: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM connections WHERE connection_id = ?1 AND owner_account = ?2)", params![id, account], |r| r.get(0))?;
    if found { Ok(()) } else { Err(NOT_FOUND) }
}

/// POST /connections/{id}/revoke: turned off at once, signed by the owner (#144). Its holders
/// go, so its links answer "turned off"; it can make no more notes.
pub async fn revoke(State(st): State<AppState>, s: Session, a: ActionSig, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    mine(&st.db(), &id, &s.account_id)?;
    verify_action(&st, &s.account_id, &a, sig::action::REVOKE_CONNECTION, &id, &[])?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    tx.execute("UPDATE connections SET revoked_at = COALESCE(revoked_at, ?2) WHERE connection_id = ?1", params![id, now()])?;
    tx.execute("DELETE FROM holders WHERE connection_id = ?1", [&id])?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /connections/{id}: the record gone (revoked first if it wasn't), signed (#144).
pub async fn delete(State(st): State<AppState>, s: Session, a: ActionSig, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    mine(&st.db(), &id, &s.account_id)?;
    verify_action(&st, &s.account_id, &a, sig::action::DELETE_CONNECTION, &id, &[])?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    tx.execute("DELETE FROM holders WHERE connection_id = ?1", [&id])?;
    tx.execute("DELETE FROM connections WHERE connection_id = ?1 AND owner_account = ?2", params![id, s.account_id])?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /connections/{id}/shares: a note made by the connection on its owner's behalf: a share
/// as POST /shares makes one, the owner's (quota, count), signed with the connection's key over
/// a fresh challenge for its key (X-Tiro-Nonce, X-Tiro-Sig; the target is the new share's id).
pub async fn create_share(State(st): State<AppState>, a: ActionSig, Path(id): Path<String>, Json(req): Json<ShareReq>) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !valid_share_id(&id) {
        return Err(NOT_FOUND);
    }
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let found: Option<(String, Vec<u8>, String, bool)> = tx
        .query_row(
            "SELECT owner_account, pubkey, pubkey_hash, revoked_at IS NOT NULL FROM connections WHERE connection_id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((owner, pubkey, hash, revoked)) = found else { return Err(NOT_FOUND) };
    if revoked {
        return Err(REVOKED);
    }
    // The challenge is the connection's (keyed by its pubkey hash), used up either way.
    let fresh: Option<i64> = tx
        .query_row(
            "DELETE FROM challenges WHERE nonce = ?1 AND pubkey_hash = ?2 AND expires_at >= ?3 RETURNING 1",
            params![a.nonce(), hash, now()],
            |r| r.get(0),
        )
        .optional()?;
    let msg = sig::action_msg(&id, sig::action::CONNECTION_CREATE_SHARE, &req.share_id, a.nonce(), &[]);
    if fresh.is_none() || !sig::verify(&pubkey, &msg, a.sig()) {
        tx.commit()?;
        return Err(ApiError(StatusCode::FORBIDDEN, "not signed by this connection"));
    }
    insert_share(&st, &tx, &owner, &req)?;
    tx.execute("UPDATE connections SET last_used_at = ?2 WHERE connection_id = ?1", params![id, now()])?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "share_id": req.share_id }))))
}
