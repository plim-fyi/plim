use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::Json;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::now;
use crate::sig::{self, sha256};
use crate::{
    ApiError, AppState, b64, b64e, bad_request, pow, random_bytes, valid_account_id,
    valid_pubkey_hash,
};

pub const SESSION_SECS: i64 = 15 * 60;
const CHALLENGE_SECS: i64 = 2 * 60;
const POW_SECS: i64 = 5 * 60;

pub const UNAUTHORIZED: ApiError = ApiError(StatusCode::UNAUTHORIZED, "unauthorized");

/// An authenticated request. Extracting this validates the bearer token.
pub struct Session {
    pub account_id: String,
    /// SHA-256 of the bearer token: this session's row, to end it (logout, #146).
    pub token_hash: Vec<u8>,
}

impl FromRequestParts<AppState> for Session {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .and_then(|t| hex::decode(t).ok())
            .ok_or(UNAUTHORIZED)?;
        let account_id = session_account(&state.db(), &token)?;
        account_id.map(|account_id| Session { account_id, token_hash: sha256(&token) }).ok_or(UNAUTHORIZED)
    }
}

/// Refused: a destructive action without the account key's signature, or with one that isn't
/// for it (#144). 403, not 401: a client hearing 401 signs in again and retries, and a new
/// session wouldn't make this one go through.
pub const NEEDS_SIGNATURE: ApiError =
    ApiError(StatusCode::FORBIDDEN, "this needs your key's signature: update Plim and try again");

/// A destructive action's signature (#144): headers X-Tiro-Nonce, a fresh challenge (POST
/// /auth/challenge), and X-Tiro-Sig, the account key's signature over `sig::action_msg`. A
/// request without them is refused with NEEDS_SIGNATURE (an older client).
pub struct ActionSig {
    nonce: Vec<u8>,
    sig: Vec<u8>,
}

impl ActionSig {
    /// (For a signature checked against another key than the account's: a connection's, #369.)
    pub fn nonce(&self) -> &[u8] {
        &self.nonce
    }
    pub fn sig(&self) -> &[u8] {
        &self.sig
    }
}

impl FromRequestParts<AppState> for ActionSig {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &AppState) -> Result<Self, ApiError> {
        let header = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok()).and_then(|v| b64(v).ok());
        match (header("x-tiro-nonce"), header("x-tiro-sig")) {
            (Some(nonce), Some(sig)) => Ok(ActionSig { nonce, sig }),
            _ => Err(NEEDS_SIGNATURE),
        }
    }
}

/// Whether `a` is the account's signature for `action` on `target` (with `data`), over a challenge
/// of its own that's still fresh. The challenge is used up either way, as signing in uses it.
pub fn verify_action(
    st: &AppState,
    account_id: &str,
    a: &ActionSig,
    action: &str,
    target: &str,
    data: &[u8],
) -> Result<(), ApiError> {
    let db = st.db();
    let (pubkey, pubkey_hash): (Vec<u8>, String) =
        db.query_row("SELECT pubkey, pubkey_hash FROM accounts WHERE id = ?1", [account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let fresh: Option<i64> = db
        .query_row(
            "DELETE FROM challenges WHERE nonce = ?1 AND pubkey_hash = ?2 AND expires_at >= ?3 RETURNING 1",
            params![a.nonce, pubkey_hash, now()],
            |r| r.get(0),
        )
        .optional()?;
    let msg = sig::action_msg(account_id, action, target, &a.nonce, data);
    if fresh.is_none() || !sig::verify(&pubkey, &msg, &a.sig) {
        return Err(NEEDS_SIGNATURE);
    }
    Ok(())
}

/// The account a session token belongs to, if it's valid and not expired.
pub fn session_account(conn: &rusqlite::Connection, token: &[u8]) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT account_id FROM sessions WHERE token_hash = ?1 AND expires_at >= ?2",
        params![sha256(token), now()],
        |r| r.get(0),
    )
    .optional()
}

/// Client IP for rate limiting (falls back to localhost when unavailable, e.g. in tests).
pub struct ClientIp(pub IpAddr);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip())
            .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let cfg = &st.cfg().proxy;
        if !cfg.is_trusted(peer) && crate::proxy::has_forwarding_header(&parts.headers) {
            st.report_untrusted_proxy(peer.to_canonical());
        }
        Ok(ClientIp(crate::proxy::client_ip(peer, &parts.headers, cfg)))
    }
}

#[derive(Deserialize, Serialize, Clone)]
pub struct KeyringEntry {
    pub key_version: u64,
    pub nonce: String,
    pub wrapped: String,
    pub sig: String,
}

pub fn load_keyring(conn: &rusqlite::Connection, account_id: &str) -> rusqlite::Result<Vec<KeyringEntry>> {
    let mut stmt = conn.prepare(
        "SELECT key_version, nonce, wrapped, sig FROM keyring WHERE account_id = ?1 ORDER BY key_version",
    )?;
    stmt.query_map([account_id], |r| {
        Ok(KeyringEntry {
            key_version: r.get::<_, i64>(0)? as u64,
            nonce: b64e(&r.get::<_, Vec<u8>>(1)?),
            wrapped: b64e(&r.get::<_, Vec<u8>>(2)?),
            sig: b64e(&r.get::<_, Vec<u8>>(3)?),
        })
    })?
    .collect()
}

pub struct DecodedEntry {
    pub key_version: u64,
    pub nonce: Vec<u8>,
    pub wrapped: Vec<u8>,
    pub sig: Vec<u8>,
}

/// Decode a keyring entry and verify it was signed by `pubkey` for this account.
pub fn verify_keyring_entry(
    e: &KeyringEntry,
    account_id: &str,
    pubkey: &[u8],
) -> Result<DecodedEntry, ApiError> {
    let d = DecodedEntry {
        key_version: e.key_version,
        nonce: b64(&e.nonce)?,
        wrapped: b64(&e.wrapped)?,
        sig: b64(&e.sig)?,
    };
    if d.nonce.len() != 12 || d.wrapped.len() > 256 {
        return Err(bad_request("invalid keyring entry"));
    }
    let msg = sig::keyring_msg(account_id, d.key_version, &d.nonce, &d.wrapped);
    if !sig::verify(pubkey, &msg, &d.sig) {
        return Err(bad_request("bad keyring signature"));
    }
    Ok(d)
}

pub fn insert_keyring(
    conn: &rusqlite::Connection,
    account_id: &str,
    d: &DecodedEntry,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO keyring (account_id, key_version, nonce, wrapped, sig) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![account_id, d.key_version as i64, d.nonce, d.wrapped, d.sig],
    )?;
    Ok(())
}

/// Whether new accounts can be made (PLIM_MAX_ACCOUNTS): only that, not how many there are.
pub async fn signups(State(st): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({ "open": signups_open(&st, &st.db())? })))
}

fn signups_open(st: &AppState, conn: &rusqlite::Connection) -> rusqlite::Result<bool> {
    let Some(max) = st.cfg().max_accounts else { return Ok(true) };
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
    Ok(n < max)
}

const SIGNUPS_CLOSED: ApiError = ApiError(StatusCode::FORBIDDEN, "signups are closed");

pub async fn pow_challenge(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "pow", 20)?;
    // (No work for a browser to do for an account it can't make.)
    if !signups_open(&st, &st.db())? {
        return Err(SIGNUPS_CLOSED);
    }
    let salt = random_bytes::<16>();
    let difficulty = st.cfg().pow_bits;
    let db = st.db();
    crate::db::sweep(&db)?;
    db.execute(
        "INSERT INTO pow_challenges (salt, difficulty, expires_at) VALUES (?1, ?2, ?3)",
        params![salt.to_vec(), difficulty, now() + POW_SECS],
    )?;
    Ok(Json(json!({ "salt": b64e(&salt), "difficulty": difficulty })))
}

#[derive(Deserialize)]
pub struct CreateAccount {
    account_id: String,
    pubkey: String,
    keyring_entry: KeyringEntry,
    pow_salt: String,
    pow_nonce: u64,
}

pub async fn create_account(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<CreateAccount>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    st.rate_limit(ip, "accounts", 10)?;
    if !signups_open(&st, &st.db())? {
        return Err(SIGNUPS_CLOSED);
    }
    if !valid_account_id(&req.account_id) {
        return Err(bad_request("invalid account_id"));
    }
    let pubkey = b64(&req.pubkey)?;
    if pubkey.len() != 32 {
        return Err(bad_request("invalid pubkey"));
    }
    let salt = b64(&req.pow_salt)?;

    let mut db = st.db();
    // Single use: the challenge is consumed (autocommit) whether or not the
    // rest of the request succeeds.
    let difficulty: Option<u32> = db
        .query_row(
            "DELETE FROM pow_challenges WHERE salt = ?1 AND expires_at >= ?2 RETURNING difficulty",
            params![salt, now()],
            |r| r.get(0),
        )
        .optional()?;
    let Some(difficulty) = difficulty else {
        return Err(bad_request("invalid or expired proof-of-work challenge"));
    };
    if !pow::check(&salt, req.pow_nonce, difficulty) {
        return Err(bad_request("invalid proof-of-work"));
    }
    if req.keyring_entry.key_version != 1 {
        return Err(bad_request("first key_version must be 1"));
    }
    let entry = verify_keyring_entry(&req.keyring_entry, &req.account_id, &pubkey)?;

    let pubkey_hash = sig::pubkey_hash(&pubkey);
    let tx = crate::db::write_tx(&mut db)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1 OR pubkey_hash = ?2)",
        params![req.account_id, pubkey_hash],
        |r| r.get(0),
    )?;
    if exists {
        return Err(ApiError(StatusCode::CONFLICT, "account already exists"));
    }
    // Again, in the transaction: two signups at once can't both take the last place.
    if !signups_open(&st, &tx)? {
        return Err(SIGNUPS_CLOSED);
    }
    tx.execute(
        "INSERT INTO accounts (id, pubkey_hash, pubkey, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![req.account_id, pubkey_hash, pubkey, now()],
    )?;
    insert_keyring(&tx, &req.account_id, &entry)?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "account_id": req.account_id }))))
}

#[derive(Deserialize)]
pub struct ChallengeReq {
    pubkey_hash: String,
}

/// Always issues a challenge, so it does not reveal whether an account exists.
pub async fn challenge(
    State(st): State<AppState>,
    crate::connections::RateWho(ip): crate::connections::RateWho,
    Json(req): Json<ChallengeReq>,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "auth", 60)?;
    if !valid_pubkey_hash(&req.pubkey_hash) {
        return Err(bad_request("invalid pubkey_hash"));
    }
    let nonce = random_bytes::<32>();
    let db = st.db();
    crate::db::sweep(&db)?;
    db.execute(
        "INSERT INTO challenges (nonce, pubkey_hash, expires_at) VALUES (?1, ?2, ?3)",
        params![nonce.to_vec(), req.pubkey_hash, now() + CHALLENGE_SECS],
    )?;
    Ok(Json(json!({ "nonce": b64e(&nonce) })))
}

#[derive(Deserialize)]
pub struct VerifyReq {
    pubkey_hash: String,
    nonce: String,
    sig: String,
}

pub async fn verify(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<VerifyReq>,
) -> Result<Json<Value>, ApiError> {
    st.rate_limit(ip, "auth", 60)?;
    let nonce = b64(&req.nonce)?;
    let signature = b64(&req.sig)?;
    let mut db = st.db();
    let tx = crate::db::write_tx(&mut db)?;
    let found: Option<i64> = tx
        .query_row(
            "DELETE FROM challenges WHERE nonce = ?1 AND pubkey_hash = ?2 AND expires_at >= ?3 RETURNING 1",
            params![nonce, req.pubkey_hash, now()],
            |r| r.get(0),
        )
        .optional()?;
    let account: Option<(String, Vec<u8>)> = tx
        .query_row(
            "SELECT id, pubkey FROM accounts WHERE pubkey_hash = ?1",
            [&req.pubkey_hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (Some(_), Some((account_id, pubkey))) = (found, account) else {
        tx.commit()?;
        return Err(UNAUTHORIZED);
    };
    if !sig::verify(&pubkey, &sig::auth_msg(&nonce, &req.pubkey_hash), &signature) {
        tx.commit()?;
        return Err(UNAUTHORIZED);
    }
    let token = random_bytes::<32>();
    tx.execute(
        "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?1, ?2, ?3)",
        params![sha256(&token), account_id, now() + SESSION_SECS],
    )?;
    tx.execute("UPDATE accounts SET last_login_at = ?2 WHERE id = ?1", params![account_id, now()])?;
    let keyring = load_keyring(&tx, &account_id)?;
    tx.commit()?;
    Ok(Json(json!({
        "token": hex::encode(token),
        "account_id": account_id,
        "expires_in": SESSION_SECS,
        "keyring": keyring,
    })))
}

/// POST /auth/logout: this session ends at once (#146), and its live sockets close. The apps call
/// it when they lock or close, and `plim` when a command is done, so a token that leaked (a log, a
/// proxy, a shared machine) stops working then, not when it would have expired.
pub async fn logout(State(st): State<AppState>, s: Session) -> Result<StatusCode, ApiError> {
    st.db().execute("DELETE FROM sessions WHERE token_hash = ?1", [&s.token_hash])?;
    st.live().kick_session(&s.account_id, &s.token_hash);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DeleteAccountReq {
    nonce: String,
    sig: String,
}

/// Delete the signed-in account and everything of it (#51): its notes and
/// their history, its keys and passkey copies, its sessions, and the notes it
/// shared (their links stop working). Needs its key's signature over a fresh
/// challenge (POST /auth/challenge), not just the session: a stolen token
/// can't do it. A failed try uses the challenge up, as signing in does.
pub async fn delete_account(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    s: Session,
    Json(req): Json<DeleteAccountReq>,
) -> Result<StatusCode, ApiError> {
    st.rate_limit(ip, "auth", 60)?;
    let nonce = b64(&req.nonce)?;
    let signature = b64(&req.sig)?;
    let shares: Vec<String> = {
        let mut db = st.db();
        let tx = crate::db::write_tx(&mut db)?;
        let (pubkey, pubkey_hash): (Vec<u8>, String) =
            tx.query_row("SELECT pubkey, pubkey_hash FROM accounts WHERE id = ?1", [&s.account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let found: Option<i64> = tx
            .query_row(
                "DELETE FROM challenges WHERE nonce = ?1 AND pubkey_hash = ?2 AND expires_at >= ?3 RETURNING 1",
                params![nonce, pubkey_hash, now()],
                |r| r.get(0),
            )
            .optional()?;
        if found.is_none() || !sig::verify(&pubkey, &sig::delete_account_msg(&s.account_id, &nonce), &signature) {
            tx.commit()?; // (the challenge stays used)
            return Err(UNAUTHORIZED);
        }
        let shares: Vec<String> = tx
            .prepare("SELECT share_id FROM shares WHERE owner_account = ?1")?
            .query_map([&s.account_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for table in ["share_updates", "share_snapshots", "share_versions"] {
            tx.execute(&format!("DELETE FROM {table} WHERE share_id IN (SELECT share_id FROM shares WHERE owner_account = ?1)"), [&s.account_id])?;
        }
        tx.execute("DELETE FROM holders WHERE owner_account = ?1", [&s.account_id])?;
        tx.execute("DELETE FROM connections WHERE owner_account = ?1", [&s.account_id])?;
        tx.execute("DELETE FROM shares WHERE owner_account = ?1", [&s.account_id])?;
        for table in ["updates", "snapshots", "versions", "gone_docs", "trash", "keyring", "passkeys", "sessions"] {
            tx.execute(&format!("DELETE FROM {table} WHERE account_id = ?1"), [&s.account_id])?;
        }
        tx.execute("DELETE FROM challenges WHERE pubkey_hash = ?1", [&pubkey_hash])?;
        tx.execute("DELETE FROM accounts WHERE id = ?1", [&s.account_id])?;
        tx.commit()?;
        shares
    };
    // Whoever has its shared notes open hears the links stopped working; its open sockets close.
    for id in &shares {
        st.live().publish_share_revoked(id);
    }
    st.live().kick(&s.account_id);
    Ok(StatusCode::NO_CONTENT)
}
