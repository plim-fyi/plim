//! A note's history (#60): earlier versions of its text.
//!
//! Clients save a version (the note's whole text, encrypted with the note's
//! key and signed like its edits) at most every so often while it's edited.
//! The time it was taken is part of the signature (`covers_seq` carries it),
//! so the server can't present versions out of order, and clients can move a
//! version to a new home keeping its time (a note shared or unshared, a
//! phrase change). Every version is kept: a note's history is whole, its oldest going only when
//! room is needed (quota.rs make_room; a shared note's, shares.rs fit_share).
//!
//!   GET  /docs/{id}/versions          [{id, created_at, size}], newest first
//!   GET  /docs/{id}/versions/{vid}    one version, to decrypt
//!   POST /docs/{id}/versions          save one
//!   PUT  /docs/{id}/versions/{vid}    re-encrypt one (phrase change; same time)
//!   DELETE /docs/{id}/versions?before=T  forget its history before T (signed)

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::auth::{ActionSig, ClientIp, Session, verify_action};
use crate::db::now;
use crate::docs::{BlobReq, verify_blob};
use crate::store::Doc;
use crate::{ApiError, AppState, bad_request, quota, sig};

/// How often clients save a version while a note is edited (GET /account).
pub const VERSION_EVERY_SECS: i64 = 3600;
/// Versions saved per minute from one address.
const SAVES_PER_MINUTE: u32 = 120;
/// A version's time may be this far ahead of the server's clock.
const SKEW_SECS: i64 = 300;

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "no such version");

pub(crate) fn check_time(created_at: u64) -> Result<i64, ApiError> {
    let t = i64::try_from(created_at).map_err(|_| bad_request("bad created_at"))?;
    if t <= 0 || t > now() + SKEW_SECS {
        return Err(bad_request("a version's time must be now or earlier"));
    }
    Ok(t)
}

pub async fn list(State(st): State<AppState>, s: Session, Path(doc_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let versions = Doc::Private { account: &s.account_id, doc: &doc_id }.versions(&st.db())?;
    Ok(Json(json!({ "versions": versions, "every_secs": st.cfg().version_every_secs })))
}

pub async fn get(State(st): State<AppState>, s: Session, Path((doc_id, id)): Path<(String, i64)>) -> Result<Json<Value>, ApiError> {
    let v = Doc::Private { account: &s.account_id, doc: &doc_id }.version(&st.db(), id)?;
    v.map(Json).ok_or(NOT_FOUND)
}

/// Save a version: `covers_seq` is the time it was taken (signed).
pub async fn post(
    State(st): State<AppState>,
    s: Session,
    ClientIp(ip): ClientIp,
    Path(doc_id): Path<String>,
    Json(req): Json<BlobReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    st.rate_limit(ip, "versions", SAVES_PER_MINUTE)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let blob = verify_blob(&st, &tx, &s.account_id, &doc_id, "version", &req)?;
    let created_at = check_time(req.covers_seq)?;
    let len = blob.ciphertext.len() as i64;
    quota::check(&tx, &s.account_id, len, st.cfg().quota_bytes)?;
    let doc = Doc::Private { account: &s.account_id, doc: &doc_id };
    let id = doc.save_version(&tx, created_at, &blob.stored(&req))?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    // ("kept": always, now: for clients that read it.)
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "kept": true }))))
}

/// Re-encrypt a version under the current key (a phrase change), keeping its time.
pub async fn put(
    State(st): State<AppState>,
    s: Session,
    Path((doc_id, id)): Path<(String, i64)>,
    Json(req): Json<BlobReq>,
) -> Result<StatusCode, ApiError> {
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let doc = Doc::Private { account: &s.account_id, doc: &doc_id };
    let created_at = doc.version_time(&tx, id)?.ok_or(NOT_FOUND)?;
    let blob = verify_blob(&st, &tx, &s.account_id, &doc_id, "version", &req)?;
    if req.covers_seq as i64 != created_at {
        return Err(bad_request("a version keeps its time"));
    }
    doc.replace_version(&tx, id, &blob.stored(&req))?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
pub struct ForgetQuery {
    before: i64,
}

/// A note's versions taken before `before`, deleted for good, signed with the owner's key over the
/// note and the time (#144: a stolen session can't wipe your history). The note itself stays.
pub async fn forget(State(st): State<AppState>, s: Session, a: ActionSig, Path(doc_id): Path<String>, Query(q): Query<ForgetQuery>) -> Result<Json<Value>, ApiError> {
    verify_action(&st, &s.account_id, &a, sig::action::FORGET_HISTORY, &doc_id, q.before.to_string().as_bytes())?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let deleted = Doc::Private { account: &s.account_id, doc: &doc_id }.forget_versions(&tx, q.before)?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    Ok(Json(json!({ "deleted": deleted })))
}
