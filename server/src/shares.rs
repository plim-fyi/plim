//! Shared notes (#70): a note anyone with its link can open.
//!
//! The server never sees a key. It knows each share's public signing key and
//! accepts only writes signed with it (an edit link carries the seed it comes
//! from), and a SHA-256 of the read token, which reads must present (any link
//! carries the encryption key it comes from). Storage counts against the
//! account that shared the note.
//!
//! Reads send the read token as hex in `X-Share-Token` (not the URL, which
//! ends up in logs).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{ActionSig, Session, verify_action};
use crate::connections::RateWho;
use crate::db::now;
use crate::sig::{self, sha256};
use crate::store::{Doc, NewBlob};
use crate::{ApiError, AppState, b64, bad_request, quota};

/// Shares one account may have (a note given to a connection is one, #369: a tag's worth at a time).
pub const MAX_SHARES_PER_ACCOUNT: i64 = 2000;
/// Writes per minute from one address (guests have no account to limit).
const WRITES_PER_MINUTE: u32 = 600;
/// Reads per minute from one address (a read checks a token: no guessing at speed).
pub const READS_PER_MINUTE: u32 = 600;
/// One shared note may use at most this share of its owner's quota, so
/// someone with an edit link can't take all of it.
const SHARE_QUOTA_DIVISOR: i64 = 4;
const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "no such share");
const SHARE_FULL: ApiError = ApiError(StatusCode::INSUFFICIENT_STORAGE, "this shared note is full");
const REVOKED: ApiError = ApiError(StatusCode::GONE, "this link was revoked");

pub fn valid_share_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub struct ShareRow {
    pub owner: String,
    pub pubkey: Vec<u8>,
    pub revoked: bool,
}

fn load(conn: &Connection, id: &str) -> rusqlite::Result<Option<(ShareRow, Vec<u8>)>> {
    conn.query_row(
        "SELECT owner_account, pubkey, revoked_at IS NOT NULL, read_hash FROM shares WHERE share_id = ?1",
        [id],
        |r| Ok((ShareRow { owner: r.get(0)?, pubkey: r.get(1)?, revoked: r.get(2)? }, r.get(3)?)),
    )
    .optional()
}

/// The share, if `token` (hex) is its read token. Unknown and wrong token look the same.
pub fn with_read_token(conn: &Connection, id: &str, token: &str) -> Result<ShareRow, ApiError> {
    if !valid_share_id(id) {
        return Err(NOT_FOUND);
    }
    let token = hex::decode(token).map_err(|_| NOT_FOUND)?;
    match load(conn, id)? {
        Some((share, read_hash)) if read_hash == sha256(&token) => Ok(share),
        _ => Err(NOT_FOUND),
    }
}

fn token_header(headers: &HeaderMap) -> &str {
    headers.get("x-share-token").and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// A share the caller owns (session), for revoke and delete.
fn owned(conn: &Connection, id: &str, account: &str) -> Result<ShareRow, ApiError> {
    match (valid_share_id(id), load(conn, id)?) {
        (true, Some((share, _))) if share.owner == account => Ok(share),
        _ => Err(NOT_FOUND),
    }
}

/// A shared note, where its history is kept (store.rs).
fn shared(id: &str) -> Doc<'_> {
    Doc::Shared { share: id }
}

/// Room in a shared note for it to grow from `size` by `grows` bytes, within its cap: its oldest
/// versions deleted first, as far as needed (its history is whole while there's room, and never
/// stops it being edited). Then 507 if it still wouldn't fit.
fn fit_share(tx: &rusqlite::Connection, st: &AppState, id: &str, owner: &str, size: i64, grows: i64) -> Result<(), ApiError> {
    let cap = st.cfg().quota_bytes / SHARE_QUOTA_DIVISOR;
    if grows <= 0 || size + grows <= cap {
        return Ok(());
    }
    let mut over = size + grows - cap;
    let oldest: Vec<(i64, i64)> = tx
        .prepare("SELECT id, LENGTH(ciphertext) FROM share_versions WHERE share_id = ?1 ORDER BY created_at, id")?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if oldest.iter().map(|o| o.1).sum::<i64>() < over {
        return Err(SHARE_FULL); // (not enough even with all of it gone: none of it deleted)
    }
    let mut freed = false;
    for (vid, len) in oldest {
        if over <= 0 {
            break;
        }
        tx.execute("DELETE FROM share_versions WHERE id = ?1", [vid])?;
        over -= len;
        freed = true;
    }
    if freed {
        quota::recompute(tx, owner)?;
    }
    if over > 0 {
        return Err(SHARE_FULL);
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct BlobReq {
    #[serde(default)]
    covers_seq: u64,
    nonce: String,
    ciphertext: String,
    sig: String,
}

struct Blob {
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    sig: Vec<u8>,
}

impl Blob {
    /// To store (a shared note's blobs have no vault key version).
    fn stored(&self) -> NewBlob<'_> {
        NewBlob { key_version: None, nonce: &self.nonce, ciphertext: &self.ciphertext, sig: &self.sig }
    }
}

/// Decode a blob and check it's signed with the share's key, as `kind`.
fn verify(st: &AppState, id: &str, pubkey: &[u8], kind: &str, req: &BlobReq) -> Result<Blob, ApiError> {
    let blob = Blob { nonce: b64(&req.nonce)?, ciphertext: b64(&req.ciphertext)?, sig: b64(&req.sig)? };
    if blob.nonce.len() != 12 {
        return Err(bad_request("nonce must be 12 bytes"));
    }
    // Updates are signed with covers_seq 0, which isn't stored: clients check them against 0.
    if kind == "update" && req.covers_seq != 0 {
        return Err(bad_request("an update covers nothing"));
    }
    if blob.ciphertext.len() > st.cfg().max_blob_bytes {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "blob too large"));
    }
    let msg = sig::share_blob_msg(id, kind, req.covers_seq, &blob.nonce, &blob.ciphertext);
    if !sig::verify(pubkey, &msg, &blob.sig) {
        return Err(bad_request("not signed with this share's key"));
    }
    Ok(blob)
}

/**
 * The row a blob was stored as before, if it was (#516): `table`'s `key` column for the share's
 * blob with this nonce, ciphertext and signature. A blob is signed once, its nonce random, so the
 * same one is that blob posted again: a client retrying, or someone who read it (a view link
 * gets editors' signed blobs) replaying it to fill the note and push its history out. Either way
 * the stored one answers, and nothing is added. (An update pruned by a snapshot is gone, so it
 * could be stored once more: bounded by the note's own history, against keeping every nonce.)
 */
fn stored_before(tx: &Connection, table: &str, key: &str, id: &str, blob: &Blob) -> rusqlite::Result<Option<i64>> {
    tx.query_row(&format!("SELECT {key} FROM {table} WHERE share_id = ?1 AND nonce = ?2 AND ciphertext = ?3 AND sig = ?4"), params![id, blob.nonce, blob.ciphertext, blob.sig], |r| r.get(0)).optional()
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub(crate) share_id: String,
    pubkey: String,
    read_hash: String,
    /// The note's content so far, as update #1.
    update: BlobReq,
}

/// Share a note: register the share's keys (public half and read-token hash)
/// with its content so far. Only an account can share.
pub async fn create(State(st): State<AppState>, s: Session, Json(req): Json<CreateReq>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    insert_share(&st, &tx, &s.account_id, &req)?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "share_id": req.share_id }))))
}

/// A share registered for `owner` with its content so far, within the owner's quota and count
/// (as `create`; a connection makes one on its owner's behalf, connections.rs).
pub(crate) fn insert_share(st: &AppState, tx: &Connection, owner: &str, req: &CreateReq) -> Result<(), ApiError> {
    if !valid_share_id(&req.share_id) {
        return Err(bad_request("invalid share_id"));
    }
    let (pubkey, read_hash) = (b64(&req.pubkey)?, b64(&req.read_hash)?);
    if pubkey.len() != 32 || read_hash.len() != 32 {
        return Err(bad_request("invalid share"));
    }
    let blob = verify(st, &req.share_id, &pubkey, "update", &req.update)?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM shares WHERE owner_account = ?1", [owner], |r| r.get(0))?;
    if count >= MAX_SHARES_PER_ACCOUNT {
        return Err(ApiError(StatusCode::CONFLICT, "too many shared notes"));
    }
    let len = blob.ciphertext.len() as i64;
    quota::check(tx, owner, len, st.cfg().quota_bytes)?;
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO shares (share_id, owner_account, pubkey, read_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![req.share_id, owner, pubkey, read_hash, now()],
    )?;
    if inserted == 0 {
        return Err(ApiError(StatusCode::CONFLICT, "share already exists"));
    }
    shared(&req.share_id).append(tx, &blob.stored(), now())?; // (update #1)
    quota::add(tx, owner, len)?;
    Ok(())
}

/// Whether a link still works, before connecting (browsers hide why a
/// WebSocket was refused, so a revoked link would otherwise look offline).
pub async fn status(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-read", READS_PER_MINUTE)?;
    let share = with_read_token(&st.db(), &id, token_header(&headers))?;
    // With the largest blob, which guests have no account to ask about: uploads are split to fit.
    Ok(Json(json!({ "status": if share.revoked { "revoked" } else { "ok" }, "max_blob_bytes": st.cfg().max_blob_bytes,
        "version_every_secs": st.cfg().version_every_secs })))
}

#[derive(Deserialize)]
pub struct AfterQuery {
    after: Option<i64>,
}

/// Like GET /docs/{id}: the latest snapshot if it covers more than `after`, and the updates after it.
pub async fn get_doc(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    Query(q): Query<AfterQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-read", READS_PER_MINUTE)?;
    let db = st.db();
    let share = with_read_token(&db, &id, token_header(&headers))?;
    if share.revoked {
        return Err(REVOKED);
    }
    // (Each blob with its signature: clients check it came from an edit link themselves, #77.)
    Ok(Json(shared(&id).since(&db, q.after.unwrap_or(0).max(0))?))
}

/// An edit, from anyone with an edit link (signed with the share's key; no session).
pub async fn post_update(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    Json(req): Json<BlobReq>,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-write", WRITES_PER_MINUTE)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let share = match (valid_share_id(&id), load(&tx, &id)?) {
        (true, Some((share, _))) => share,
        _ => return Err(NOT_FOUND),
    };
    if share.revoked {
        return Err(REVOKED);
    }
    let blob = verify(&st, &id, &share.pubkey, "update", &req)?;
    if let Some(seq) = stored_before(&tx, "share_updates", "seq", &id, &blob)? {
        return Ok(Json(json!({ "seq": seq })));
    }
    let len = blob.ciphertext.len() as i64;
    let size = shared(&id).bytes(&tx)?;
    fit_share(&tx, &st, &id, &share.owner, size, len)?;
    quota::check(&tx, &share.owner, len, st.cfg().quota_bytes)?;
    let seq = shared(&id).append(&tx, &blob.stored(), now())?;
    quota::add(&tx, &share.owner, len)?;
    tx.commit()?;
    drop(db);
    st.live().publish_share_update(&id, seq, &req.nonce, &req.ciphertext, &req.sig);
    Ok(Json(json!({ "seq": seq })))
}

/// A compacted copy of the whole note (any editor may make one).
pub async fn post_snapshot(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    Json(req): Json<BlobReq>,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-write", WRITES_PER_MINUTE)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let share = match (valid_share_id(&id), load(&tx, &id)?) {
        (true, Some((share, _))) => share,
        _ => return Err(NOT_FOUND),
    };
    if share.revoked {
        return Err(REVOKED);
    }
    let blob = verify(&st, &id, &share.pubkey, "snapshot", &req)?;
    let doc = shared(&id);
    let covers = crate::docs::check_covers(&tx, &doc, req.covers_seq)?;
    // A snapshot that prunes updates usually shrinks a full share: allowed.
    let grows = blob.ciphertext.len() as i64 - doc.freed_by_snapshot(&tx, covers, st.cfg().prune_on_snapshot)?;
    let size = doc.bytes(&tx)?;
    fit_share(&tx, &st, &id, &share.owner, size, grows)?;
    quota::check(&tx, &share.owner, grows, st.cfg().quota_bytes)?;
    doc.put_snapshot(&tx, covers, &blob.stored(), st.cfg().prune_on_snapshot, now())?;
    quota::add(&tx, &share.owner, grows)?;
    tx.commit()?;
    drop(db);
    st.live().publish_share_snapshot(&id, covers, &req.nonce, &req.ciphertext, &req.sig);
    Ok(Json(json!({ "covers_seq": covers })))
}

/// Revoke: the link stops working at once (open sockets are told); the data
/// stays until the owner deletes it. To keep sharing, the owner shares again
/// with a new key and link. Signed with the owner's key (#144).
pub async fn revoke(State(st): State<AppState>, s: Session, a: ActionSig, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    owned(&st.db(), &id, &s.account_id)?;
    verify_action(&st, &s.account_id, &a, sig::action::REVOKE_SHARE, &id, &[])?;
    let db = st.db();
    db.execute("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?2) WHERE share_id = ?1", params![id, now()])?;
    drop(db);
    st.live().publish_share_revoked(&id);
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a share and everything in it (the note was deleted for good, or made private again).
/// Signed with the owner's key (#144). (Someone else's, or one already gone: 404, before that.)
pub async fn delete(State(st): State<AppState>, s: Session, a: ActionSig, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    owned(&st.db(), &id, &s.account_id)?;
    verify_action(&st, &s.account_id, &a, sig::action::DELETE_SHARE, &id, &[])?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    owned(&tx, &id, &s.account_id)?;
    crate::trash::keep_share(&tx, &s.account_id, &id, st.cfg().quota_bytes)?; // (restorable for 30 days, #253)
    delete_share(&tx, &id)?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    drop(db);
    st.live().publish_share_revoked(&id);
    Ok(StatusCode::NO_CONTENT)
}

pub fn delete_share(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    shared(id).delete_all(conn)?;
    conn.execute("DELETE FROM shares WHERE share_id = ?1", [id])?;
    Ok(())
}

// ---- history (#60): a shared note's versions ----
// As a private note's (versions.rs), but under the share's keys: read with
// the read token, saved by anyone with the edit link (signed with the share's
// key, as kind "version" with its time in covers_seq), and counted toward the
// share's cap and the owner's quota.

#[derive(Deserialize)]
pub struct ForgetQuery {
    before: i64,
}

/// DELETE /shares/{id}/versions?before=T: its history before T deleted for good, by its owner only,
/// signed (as for a private note: versions.rs forget). Someone with its link can't.
pub async fn forget_versions(State(st): State<AppState>, s: Session, a: ActionSig, Path(id): Path<String>, Query(q): Query<ForgetQuery>) -> Result<Json<Value>, ApiError> {
    owned(&st.db(), &id, &s.account_id)?;
    verify_action(&st, &s.account_id, &a, sig::action::FORGET_HISTORY, &id, q.before.to_string().as_bytes())?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    owned(&tx, &id, &s.account_id)?;
    let deleted = shared(&id).forget_versions(&tx, q.before)?;
    quota::recompute(&tx, &s.account_id)?;
    tx.commit()?;
    Ok(Json(json!({ "deleted": deleted })))
}

/// GET /shares/{id}/versions: [{id, created_at, size}], newest first.
pub async fn list_versions(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-read", READS_PER_MINUTE)?;
    let db = st.db();
    if with_read_token(&db, &id, token_header(&headers))?.revoked {
        return Err(REVOKED);
    }
    Ok(Json(json!({ "versions": shared(&id).versions(&db)? })))
}

/// GET /shares/{id}/versions/{vid}: one, with its signature (clients check it, #77).
pub async fn get_version(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path((id, vid)): Path<(String, i64)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "share-read", READS_PER_MINUTE)?;
    let db = st.db();
    if with_read_token(&db, &id, token_header(&headers))?.revoked {
        return Err(REVOKED);
    }
    shared(&id).version(&db, vid)?.map(Json).ok_or(ApiError(StatusCode::NOT_FOUND, "no such version"))
}

/// POST /shares/{id}/versions: save one (an edit link's signature; no session).
pub async fn post_version(
    State(st): State<AppState>,
    RateWho(ip): RateWho,
    Path(id): Path<String>,
    Json(req): Json<BlobReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    st.rate_limit(ip, "share-write", WRITES_PER_MINUTE)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let share = match (valid_share_id(&id), load(&tx, &id)?) {
        (true, Some((share, _))) => share,
        _ => return Err(NOT_FOUND),
    };
    if share.revoked {
        return Err(REVOKED);
    }
    let blob = verify(&st, &id, &share.pubkey, "version", &req)?;
    if let Some(vid) = stored_before(&tx, "share_versions", "id", &id, &blob)? {
        return Ok((StatusCode::OK, Json(json!({ "id": vid, "kept": true }))));
    }
    let created_at = crate::versions::check_time(req.covers_seq)?;
    let len = blob.ciphertext.len() as i64;
    let size = shared(&id).bytes(&tx)?;
    fit_share(&tx, &st, &id, &share.owner, size, len)?;
    quota::check(&tx, &share.owner, len, st.cfg().quota_bytes)?;
    let vid = shared(&id).save_version(&tx, created_at, &blob.stored())?;
    quota::recompute(&tx, &share.owner)?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "id": vid, "kept": true }))))
}
