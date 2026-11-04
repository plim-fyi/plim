//! The account's own endpoints: its usage, its keyring, its passkeys, and changing its key.
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{ActionSig, ClientIp, KeyringEntry, Session, insert_keyring, verify_action, verify_keyring_entry};
use crate::db::now;
use crate::sig::{self, TAG_ROTATE_NEW, TAG_ROTATE_OLD};
use crate::{ApiError, AppState, b64, b64e, bad_request, quota};

pub(crate) fn account_pubkey(conn: &Connection, account_id: &str) -> rusqlite::Result<Vec<u8>> {
    conn.query_row("SELECT pubkey FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))
}

pub async fn get_account(State(st): State<AppState>, s: Session) -> Result<Json<Value>, ApiError> {
    let used = quota::used_bytes(&st.db(), &s.account_id)?;
    let history = quota::history_bytes(&st.db(), &s.account_id)?;
    Ok(Json(json!({
        "account_id": s.account_id,
        "used_bytes": used,
        "history_bytes": history,
        "quota_bytes": st.cfg().quota_bytes,
        "max_blob_bytes": st.cfg().max_blob_bytes,
        "version_every_secs": st.cfg().version_every_secs,
        "connector_url": st.cfg().connector_url,
    })))
}

pub async fn add_keyring(
    State(st): State<AppState>,
    s: Session,
    Json(entry): Json<KeyringEntry>,
) -> Result<Json<Value>, ApiError> {
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let max: i64 = tx.query_row(
        "SELECT COALESCE(MAX(key_version), 0) FROM keyring WHERE account_id = ?1",
        [&s.account_id],
        |r| r.get(0),
    )?;
    if entry.key_version as i64 != max + 1 {
        return Err(ApiError(StatusCode::CONFLICT, "key_version must be the next version"));
    }
    let pubkey = account_pubkey(&tx, &s.account_id)?;
    let d = verify_keyring_entry(&entry, &s.account_id, &pubkey)?;
    insert_keyring(&tx, &s.account_id, &d)?;
    tx.commit()?;
    Ok(Json(json!({ "key_version": entry.key_version })))
}

const MAX_PASSKEYS: i64 = 20;

/// SHA-256 of a WebAuthn credential id, as lowercase hex.
fn check_cred_hash(h: &str) -> Result<(), ApiError> {
    if h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err(bad_request("invalid cred_hash"))
    }
}

#[derive(Deserialize)]
pub struct PasskeyReq {
    cred_hash: String,
    nonce: String,
    ciphertext: String,
}

/// Save (or replace) a passkey's encrypted copy of the recovery entropy. Signed with the
/// account's key, over the copy itself (#144): replacing it with another would stop that
/// passkey signing in.
pub async fn put_passkey(
    State(st): State<AppState>,
    s: Session,
    a: ActionSig,
    Json(req): Json<PasskeyReq>,
) -> Result<Json<Value>, ApiError> {
    check_cred_hash(&req.cred_hash)?;
    let (nonce, ciphertext) = (b64(&req.nonce)?, b64(&req.ciphertext)?);
    if nonce.len() != 12 || ciphertext.is_empty() || ciphertext.len() > 128 {
        return Err(bad_request("invalid passkey entry"));
    }
    let copy = [nonce.as_slice(), ciphertext.as_slice()].concat();
    verify_action(&st, &s.account_id, &a, sig::action::PUT_PASSKEY, &req.cred_hash, &copy)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let owner: Option<String> = tx
        .query_row("SELECT account_id FROM passkeys WHERE cred_hash = ?1", [&req.cred_hash], |r| r.get(0))
        .optional()?;
    match owner {
        Some(o) if o != s.account_id => return Err(ApiError(StatusCode::CONFLICT, "passkey belongs to another account")),
        Some(_) => {
            tx.execute(
                "UPDATE passkeys SET nonce = ?2, ciphertext = ?3 WHERE cred_hash = ?1",
                params![req.cred_hash, nonce, ciphertext],
            )?;
        }
        None => {
            let count: i64 =
                tx.query_row("SELECT COUNT(*) FROM passkeys WHERE account_id = ?1", [&s.account_id], |r| r.get(0))?;
            if count >= MAX_PASSKEYS {
                return Err(ApiError(StatusCode::CONFLICT, "too many passkeys"));
            }
            tx.execute(
                "INSERT INTO passkeys (cred_hash, account_id, nonce, ciphertext, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![req.cred_hash, s.account_id, nonce, ciphertext, now()],
            )?;
        }
    }
    tx.commit()?;
    Ok(Json(json!({ "cred_hash": req.cred_hash })))
}

pub async fn list_passkeys(State(st): State<AppState>, s: Session) -> Result<Json<Value>, ApiError> {
    let db = st.db();
    let mut stmt = db.prepare(
        "SELECT cred_hash, created_at, last_used_at FROM passkeys WHERE account_id = ?1 ORDER BY created_at",
    )?;
    let passkeys = stmt
        .query_map([&s.account_id], |r| {
            Ok(json!({
                "cred_hash": r.get::<_, String>(0)?,
                "created_at": r.get::<_, i64>(1)?,
                "last_used_at": r.get::<_, Option<i64>>(2)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "passkeys": passkeys })))
}

/// Remove a passkey's copy: it can't sign in on a new device any more. Signed with the
/// account's key (#144).
pub async fn delete_passkey(
    State(st): State<AppState>,
    s: Session,
    a: ActionSig,
    Path(cred_hash): Path<String>,
) -> Result<StatusCode, ApiError> {
    check_cred_hash(&cred_hash)?;
    verify_action(&st, &s.account_id, &a, sig::action::DELETE_PASSKEY, &cred_hash, &[])?;
    st.db().execute(
        "DELETE FROM passkeys WHERE cred_hash = ?1 AND account_id = ?2",
        params![cred_hash, s.account_id],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

/// Unauthenticated: a new device has only the passkey, not a session. The
/// entry is useless without the passkey's PRF secret.
pub async fn passkey_signin(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    Path(cred_hash): Path<String>,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "auth", 60)?;
    check_cred_hash(&cred_hash)?;
    let db = st.db();
    let row: Option<(Vec<u8>, Vec<u8>)> = db
        .query_row("SELECT nonce, ciphertext FROM passkeys WHERE cred_hash = ?1", [&cred_hash], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let (nonce, ciphertext) = row.ok_or(ApiError(StatusCode::NOT_FOUND, "passkey not set up for sign-in"))?;
    db.execute("UPDATE passkeys SET last_used_at = ?2 WHERE cred_hash = ?1 AND COALESCE(last_used_at, 0) < ?2 - 60", params![cred_hash, now()])?;
    Ok(Json(json!({ "nonce": b64e(&nonce), "ciphertext": b64e(&ciphertext) })))
}

#[derive(Deserialize)]
pub struct RotateReq {
    new_pubkey: String,
    keyring: Vec<KeyringEntry>,
    old_sig: String,
    new_sig: String,
    #[serde(default)]
    prune: bool,
}

/// Swap the account's signing key (recovery phrase change). The old key
/// authorizes the change, the new key proves possession, and the whole
/// keyring is replaced with copies wrapped under the new phrase.
pub async fn rotate(
    State(st): State<AppState>,
    s: Session,
    Json(req): Json<RotateReq>,
) -> Result<Json<Value>, ApiError> {
    let new_pubkey = b64(&req.new_pubkey)?;
    if new_pubkey.len() != 32 {
        return Err(bad_request("invalid pubkey"));
    }
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let old_pubkey = account_pubkey(&tx, &s.account_id)?;
    let old_ok = sig::verify(
        &old_pubkey,
        &sig::rotate_msg(TAG_ROTATE_OLD, &s.account_id, &new_pubkey),
        &b64(&req.old_sig)?,
    );
    let new_ok = sig::verify(
        &new_pubkey,
        &sig::rotate_msg(TAG_ROTATE_NEW, &s.account_id, &new_pubkey),
        &b64(&req.new_sig)?,
    );
    if !old_ok || !new_ok {
        return Err(bad_request("bad rotation signature"));
    }

    let existing: Vec<i64> = tx
        .prepare("SELECT key_version FROM keyring WHERE account_id = ?1 ORDER BY key_version")?
        .query_map([&s.account_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut submitted: Vec<i64> = req.keyring.iter().map(|e| e.key_version as i64).collect();
    submitted.sort_unstable();
    if submitted != existing {
        return Err(bad_request("keyring must contain exactly the existing key versions"));
    }
    let entries = req
        .keyring
        .iter()
        .map(|e| verify_keyring_entry(e, &s.account_id, &new_pubkey))
        .collect::<Result<Vec<_>, _>>()?;

    let new_hash = sig::pubkey_hash(&new_pubkey);
    let taken: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounts WHERE pubkey_hash = ?1 AND id != ?2)",
        params![new_hash, s.account_id],
        |r| r.get(0),
    )?;
    if taken {
        return Err(ApiError(StatusCode::CONFLICT, "public key already in use"));
    }

    tx.execute("DELETE FROM keyring WHERE account_id = ?1", [&s.account_id])?;
    for e in &entries {
        insert_keyring(&tx, &s.account_id, e)?;
    }
    tx.execute(
        "UPDATE accounts SET pubkey = ?2, pubkey_hash = ?3 WHERE id = ?1",
        params![s.account_id, new_pubkey, new_hash],
    )?;

    if req.prune {
        // Drop data encrypted under older vault keys, but only where a
        // current-version snapshot already covers it.
        let current = *existing.last().unwrap_or(&1);
        tx.execute(
            "DELETE FROM updates WHERE account_id = ?1 AND key_version < ?2 AND seq <= COALESCE(
                (SELECT MAX(covers_seq) FROM snapshots sn
                 WHERE sn.account_id = updates.account_id AND sn.doc_id = updates.doc_id
                   AND sn.key_version = ?2), 0)",
            params![s.account_id, current],
        )?;
        tx.execute(
            "DELETE FROM snapshots WHERE account_id = ?1 AND key_version < ?2",
            params![s.account_id, current],
        )?;
        // Versions too (the client re-encrypts them first: any still under an old key go).
        tx.execute(
            "DELETE FROM versions WHERE account_id = ?1 AND key_version < ?2",
            params![s.account_id, current],
        )?;
        quota::recompute(&tx, &s.account_id)?;
    }

    // Every existing session belonged to the old key, and every passkey
    // entry holds the old phrase.
    tx.execute("DELETE FROM sessions WHERE account_id = ?1", [&s.account_id])?;
    tx.execute("DELETE FROM passkeys WHERE account_id = ?1", [&s.account_id])?;
    // What was deleted was signed with the old key: restored, the apps would take it for forged (#253).
    tx.execute("DELETE FROM trash WHERE account_id = ?1", [&s.account_id])?;
    tx.commit()?;
    drop(db);
    st.live().kick(&s.account_id); // its live sockets belong to the old sessions too
    Ok(Json(json!({ "ok": true })))
}
