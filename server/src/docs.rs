//! A private note's endpoints: list, read, write (updates and snapshots), close, reopen, delete.
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::account::account_pubkey;
use crate::auth::{ActionSig, Session, verify_action};
use crate::db::now;
use crate::sig;
use crate::store::{Doc, NewBlob};
use crate::{ApiError, AppState, b64, bad_request, quota, valid_doc_id};

fn key_version_exists(conn: &Connection, account_id: &str, v: u64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM keyring WHERE account_id = ?1 AND key_version = ?2)",
        params![account_id, v as i64],
        |r| r.get(0),
    )
}

fn check_doc_id(doc_id: &str) -> Result<(), ApiError> {
    if valid_doc_id(doc_id) { Ok(()) } else { Err(bad_request("invalid doc_id")) }
}

/// One of the account's notes, where its history is kept (store.rs).
fn private<'a>(account: &'a str, doc: &'a str) -> Doc<'a> {
    Doc::Private { account, doc }
}

pub async fn list_docs(State(st): State<AppState>, s: Session) -> Result<Json<Value>, ApiError> {
    let db = st.db();
    let mut stmt = db.prepare(
        "SELECT doc_id FROM updates WHERE account_id = ?1
         UNION SELECT doc_id FROM snapshots WHERE account_id = ?1",
    )?;
    let docs = stmt
        .query_map([&s.account_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "docs": docs })))
}

#[derive(Deserialize)]
pub struct AfterQuery {
    after: Option<i64>,
}

/// Remove a note's data for good (emptying the trash): every update and
/// snapshot of the doc, then recount the account's usage. The note index
/// can't be deleted this way. Signed with the account's key (#144).
pub async fn delete_doc(
    State(st): State<AppState>,
    s: Session,
    a: ActionSig,
    Path(doc_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    check_doc_id(&doc_id)?;
    if doc_id == "index" {
        return Err(bad_request("the note index can't be deleted"));
    }
    verify_action(&st, &s.account_id, &a, sig::action::DELETE_DOC, &doc_id, &[])?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    // Kept for 30 days, so it can be restored (#253).
    crate::trash::keep_doc(&tx, &s.account_id, &doc_id, st.cfg().quota_bytes)?;
    private(&s.account_id, &doc_id).delete_all(&tx)?;
    // No more writes to it: a device that hasn't heard yet can't bring it back (#119).
    tx.execute(
        "INSERT OR REPLACE INTO gone_docs (account_id, doc_id, gone_at) VALUES (?1, ?2, ?3)",
        params![s.account_id, doc_id, now()],
    )?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// No more writes to a doc, its data kept: a note about to be shared is
/// closed first, then its final text read and copied into the share, so an
/// edit another device sends meanwhile is refused (and kept there, to move
/// into the share) rather than landing after the copy and being lost (#119).
/// Signed with the account's key (#144): it stops the note taking edits.
pub async fn close_doc(
    State(st): State<AppState>,
    s: Session,
    a: ActionSig,
    Path(doc_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    check_doc_id(&doc_id)?;
    if doc_id == "index" {
        return Err(bad_request("the note index can't be closed"));
    }
    verify_action(&st, &s.account_id, &a, sig::action::CLOSE_DOC, &doc_id, &[])?;
    st.db().execute(
        "INSERT OR REPLACE INTO gone_docs (account_id, doc_id, gone_at) VALUES (?1, ?2, ?3)",
        params![s.account_id, doc_id, now()],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

/// A deleted doc used again: the note's text comes back to it when it stops
/// being shared, or sharing it failed after it was closed. (Fine for one that isn't gone.)
/// Signed with the account's key (#144): it would let a deleted note's id take edits again.
pub async fn reopen_doc(
    State(st): State<AppState>,
    s: Session,
    a: ActionSig,
    Path(doc_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    check_doc_id(&doc_id)?;
    verify_action(&st, &s.account_id, &a, sig::action::REOPEN_DOC, &doc_id, &[])?;
    st.db().execute("DELETE FROM gone_docs WHERE account_id = ?1 AND doc_id = ?2", params![s.account_id, doc_id])?;
    Ok(StatusCode::NO_CONTENT)
}

/// Returns everything needed to bring a client at `after` up to date: the
/// latest snapshot if it covers more than the client has, plus later updates.
pub async fn get_doc(
    State(st): State<AppState>,
    s: Session,
    Path(doc_id): Path<String>,
    Query(q): Query<AfterQuery>,
) -> Result<Json<Value>, ApiError> {
    check_doc_id(&doc_id)?;
    let after = q.after.unwrap_or(0).max(0);
    Ok(Json(private(&s.account_id, &doc_id).since(&st.db(), after)?))
}

#[derive(Deserialize)]
pub struct BlobReq {
    pub(crate) key_version: u64,
    #[serde(default)]
    pub(crate) covers_seq: u64,
    nonce: String,
    ciphertext: String,
    sig: String,
}

pub(crate) struct Blob {
    pub(crate) nonce: Vec<u8>,
    pub(crate) ciphertext: Vec<u8>,
    pub(crate) sig: Vec<u8>,
}

impl Blob {
    /// To store, under the key version it was sent with.
    pub(crate) fn stored(&self, req: &BlobReq) -> NewBlob<'_> {
        NewBlob { key_version: Some(req.key_version as i64), nonce: &self.nonce, ciphertext: &self.ciphertext, sig: &self.sig }
    }
}

/// A snapshot's covers_seq, if it may be stored: not ahead of the head (409 if behind the latest
/// snapshot). The same for a private note and a shared one.
pub(crate) fn check_covers(conn: &Connection, doc: &Doc, covers: u64) -> Result<i64, ApiError> {
    let covers = covers as i64;
    if covers > doc.head(conn)? {
        return Err(bad_request("covers_seq is ahead of the server"));
    }
    if covers < doc.latest_snapshot(conn)? {
        return Err(ApiError(StatusCode::CONFLICT, "a newer snapshot exists"));
    }
    Ok(covers)
}

/// Decode a blob and verify the account's current key signed it.
pub(crate) fn verify_blob(
    st: &AppState,
    conn: &Connection,
    account_id: &str,
    doc_id: &str,
    kind: &str,
    req: &BlobReq,
) -> Result<Blob, ApiError> {
    check_doc_id(doc_id)?;
    let gone: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM gone_docs WHERE account_id = ?1 AND doc_id = ?2)",
        params![account_id, doc_id],
        |r| r.get(0),
    )?;
    if gone {
        return Err(ApiError(StatusCode::GONE, "this note was moved or deleted"));
    }
    let blob = Blob { nonce: b64(&req.nonce)?, ciphertext: b64(&req.ciphertext)?, sig: b64(&req.sig)? };
    if blob.nonce.len() != 12 {
        return Err(bad_request("nonce must be 12 bytes"));
    }
    if blob.ciphertext.len() > st.cfg().max_blob_bytes {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "blob too large"));
    }
    if !key_version_exists(conn, account_id, req.key_version)? {
        return Err(bad_request("unknown key_version"));
    }
    let pubkey = account_pubkey(conn, account_id)?;
    let msg = sig::blob_msg(
        account_id,
        doc_id,
        kind,
        req.key_version,
        req.covers_seq,
        &blob.nonce,
        &blob.ciphertext,
    );
    if !sig::verify(&pubkey, &msg, &blob.sig) {
        return Err(bad_request("bad signature"));
    }
    Ok(blob)
}

pub async fn post_update(
    State(st): State<AppState>,
    s: Session,
    Path(doc_id): Path<String>,
    Json(req): Json<BlobReq>,
) -> Result<Json<Value>, ApiError> {
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let blob = verify_blob(&st, &tx, &s.account_id, &doc_id, "update", &req)?;
    let len = blob.ciphertext.len() as i64;
    quota::check(&tx, &s.account_id, len, st.cfg().quota_bytes)?;
    let seq = private(&s.account_id, &doc_id).append(&tx, &blob.stored(&req), now())?;
    quota::add(&tx, &s.account_id, len)?;
    tx.commit()?;
    drop(db);
    st.live().publish_update(&s.account_id, &doc_id, seq, req.key_version, &req.nonce, &req.ciphertext);
    Ok(Json(json!({ "seq": seq })))
}

pub async fn post_snapshot(
    State(st): State<AppState>,
    s: Session,
    Path(doc_id): Path<String>,
    Json(req): Json<BlobReq>,
) -> Result<Json<Value>, ApiError> {
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let blob = verify_blob(&st, &tx, &s.account_id, &doc_id, "snapshot", &req)?;
    let doc = private(&s.account_id, &doc_id);
    let covers = check_covers(&tx, &doc, req.covers_seq)?;
    // Older snapshots are superseded; optionally prune covered updates too.
    let grows = blob.ciphertext.len() as i64 - doc.freed_by_snapshot(&tx, covers, st.cfg().prune_on_snapshot)?;
    quota::check(&tx, &s.account_id, grows, st.cfg().quota_bytes)?;
    doc.put_snapshot(&tx, covers, &blob.stored(&req), st.cfg().prune_on_snapshot, now())?;
    quota::add(&tx, &s.account_id, grows)?;
    tx.commit()?;
    drop(db);
    st.live().publish_snapshot(&s.account_id, &doc_id, covers, req.key_version, &req.nonce, &req.ciphertext);
    Ok(Json(json!({ "covers_seq": covers })))
}

