use std::collections::VecDeque;
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rusqlite::Connection;

/// How many connections the server keeps open (#260). Reads run alongside each other and
/// alongside a write (WAL); writes wait for each other (busy_timeout), one at a time, as
/// SQLite needs. More than the handful that are ever busy at once is wasted memory.
pub const CONNECTIONS: usize = 4;
/// How long a connection waits for another's write to finish before giving up.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The server's connections to its database, handed out one per request (`get`). Before,
/// one connection behind one lock: every request waited on every other, a slow query held
/// up the whole server, and a handler taking the lock twice deadlocked (#144).
pub struct Pool(Arc<PoolInner>);

struct PoolInner {
    idle: Mutex<VecDeque<Connection>>,
    returned: Condvar,
    /// ":memory:" is one database per connection, so a pool of them needs a file: a temporary
    /// one (tests), removed with the pool.
    temp: Option<PathBuf>,
}

static TEMP_DBS: AtomicU64 = AtomicU64::new(0);

impl Pool {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let temp = (path == ":memory:")
            .then(|| std::env::temp_dir().join(format!("plim-{}-{}.db", std::process::id(), TEMP_DBS.fetch_add(1, Ordering::Relaxed))));
        let path = temp.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
        let first = open(&path)?;
        prepare(&first)?;
        let mut idle = VecDeque::from([first]);
        for _ in 1..CONNECTIONS {
            let conn = Connection::open(&path)?;
            prepare(&conn)?;
            idle.push_back(conn);
        }
        Ok(Pool(Arc::new(PoolInner { idle: Mutex::new(idle), returned: Condvar::new(), temp })))
    }

    /// The temporary file standing in for ":memory:", if that's what was opened.
    pub fn temp_path(&self) -> Option<&std::path::Path> {
        self.0.temp.as_deref()
    }

    /// A connection, until it's dropped. Waits when all of them are out.
    pub fn get(&self) -> DbConn {
        let mut idle = self.0.idle.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(conn) = idle.pop_front() {
                return DbConn { conn: Some(conn), pool: self.0.clone() };
            }
            idle = self.0.returned.wait(idle).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// What every connection needs (the schema and WAL are the database's, set once by `open`).
fn prepare(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
}

impl Drop for PoolInner {
    fn drop(&mut self) {
        if let Some(path) = &self.temp {
            self.idle.lock().unwrap_or_else(|e| e.into_inner()).clear(); // (closed before the file goes)
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        }
    }
}

/// A pool's connection, back in the pool when dropped. Used as a `Connection`.
pub struct DbConn {
    conn: Option<Connection>,
    pool: Arc<PoolInner>,
}

impl Deref for DbConn {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("a pooled connection")
    }
}

impl DerefMut for DbConn {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("a pooled connection")
    }
}

impl Drop for DbConn {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.pool.idle.lock().unwrap_or_else(|e| e.into_inner()).push_back(conn);
            self.pool.returned.notify_one();
        }
    }
}

/// A transaction that writes. It takes the database's write lock at once (BEGIN IMMEDIATE), so
/// two of them wait for each other (busy_timeout) rather than both reading first and then
/// deadlocking when each tries to write.
pub fn write_tx(conn: &mut Connection) -> rusqlite::Result<rusqlite::Transaction<'_>> {
    conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    id          TEXT PRIMARY KEY,
    pubkey_hash TEXT NOT NULL UNIQUE,
    pubkey      BLOB NOT NULL,
    used_bytes  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keyring (
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    key_version INTEGER NOT NULL,
    nonce       BLOB NOT NULL,
    wrapped     BLOB NOT NULL,
    sig         BLOB NOT NULL,
    PRIMARY KEY (account_id, key_version)
);

CREATE TABLE IF NOT EXISTS updates (
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    doc_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    key_version INTEGER NOT NULL,
    nonce       BLOB NOT NULL,
    ciphertext  BLOB NOT NULL,
    sig         BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (account_id, doc_id, seq)
);

-- Updates are append-only: rows may be pruned once covered by a snapshot,
-- but never modified.
CREATE TRIGGER IF NOT EXISTS updates_append_only
BEFORE UPDATE ON updates
BEGIN
    SELECT RAISE(ABORT, 'updates are append-only');
END;

CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    doc_id      TEXT NOT NULL,
    covers_seq  INTEGER NOT NULL,
    key_version INTEGER NOT NULL,
    nonce       BLOB NOT NULL,
    ciphertext  BLOB NOT NULL,
    sig         BLOB NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_doc ON snapshots (account_id, doc_id, covers_seq);

CREATE TABLE IF NOT EXISTS challenges (
    nonce       BLOB PRIMARY KEY,
    pubkey_hash TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  BLOB PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    expires_at  INTEGER NOT NULL
);

-- Passkey sign-in: the account's recovery entropy, encrypted on the client
-- with the passkey's PRF secret. Keyed by SHA-256 of the credential id (hex).
CREATE TABLE IF NOT EXISTS passkeys (
    cred_hash    TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id),
    nonce        BLOB NOT NULL,
    ciphertext   BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys (account_id);

-- Shared notes: a note anyone with its link can open. The server knows the
-- share's public signing key (writes must be signed with it), a hash of the
-- read token (reads must present it), and the owning account (its quota).
CREATE TABLE IF NOT EXISTS shares (
    share_id      TEXT PRIMARY KEY,
    owner_account TEXT NOT NULL REFERENCES accounts(id),
    pubkey        BLOB NOT NULL,
    read_hash     BLOB NOT NULL,
    created_at    INTEGER NOT NULL,
    revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares (owner_account);

-- A holder of a shared note's keys (#369): a link given to someone, or a connection, each
-- with a secret of its own. The row points at the note's current share and holds that
-- share's keys sealed to the holder's secret; the server serves it to the holder's token
-- (SHA-256 kept, as a share's read token's is) and never sees a key. Replacing the note's
-- links re-seals each holder kept to the new share, so links can be taken back one by one.
CREATE TABLE IF NOT EXISTS holders (
    holder_id     TEXT PRIMARY KEY,
    owner_account TEXT NOT NULL REFERENCES accounts(id),
    share_id      TEXT NOT NULL,
    role          TEXT NOT NULL,
    token_hash    BLOB NOT NULL,
    nonce         BLOB NOT NULL,
    ciphertext    BLOB NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS holders_share ON holders (share_id);

-- A connection (#369): an app (Claude) the owner connected to their notes. It signs with a key
-- of its own (challenge-response, as an account does) to create notes on the owner's behalf;
-- everything else it does goes through its holders' rows (holders.connection_id) and the share
-- endpoints. Revoked: its holders are gone and it can do nothing more.
CREATE TABLE IF NOT EXISTS connections (
    connection_id TEXT PRIMARY KEY,
    owner_account TEXT NOT NULL REFERENCES accounts(id),
    name          TEXT NOT NULL,
    pubkey        BLOB NOT NULL,
    pubkey_hash   TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS connections_owner ON connections (owner_account);

CREATE TABLE IF NOT EXISTS share_updates (
    share_id   TEXT NOT NULL REFERENCES shares(share_id),
    seq        INTEGER NOT NULL,
    nonce      BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    sig        BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (share_id, seq)
);

-- A note's private doc that was deleted (the note shared, or deleted for good):
-- it takes no more writes, so a device's late upload can't bring it back
-- (#119). Stopping sharing reopens it (docs.rs, reopen_doc).
CREATE TABLE IF NOT EXISTS gone_docs (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    doc_id     TEXT NOT NULL,
    gone_at    INTEGER NOT NULL,
    PRIMARY KEY (account_id, doc_id)
);

-- A note's history (#60): earlier versions of its text, encrypted and signed
-- by the client (created_at is in the signature: the time it was taken).
-- Thinned as new ones arrive (versions.rs, keep).
CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    doc_id      TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    nonce       BLOB NOT NULL,
    ciphertext  BLOB NOT NULL,
    sig         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_doc ON versions (account_id, doc_id, created_at);

-- A shared note's history: as versions, but encrypted with the share's key and
-- signed with its signing key (anyone with the edit link can save one).
CREATE TABLE IF NOT EXISTS share_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id   TEXT NOT NULL REFERENCES shares(share_id),
    created_at INTEGER NOT NULL,
    nonce      BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    sig        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS share_versions_share ON share_versions (share_id, created_at);

CREATE TABLE IF NOT EXISTS share_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id   TEXT NOT NULL REFERENCES shares(share_id),
    covers_seq INTEGER NOT NULL,
    nonce      BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    sig        BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_snapshots_share ON share_snapshots (share_id, covers_seq);

CREATE TABLE IF NOT EXISTS pow_challenges (
    salt        BLOB PRIMARY KEY,
    difficulty  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);

-- A deleted note's or share's data, kept for a while so it can be restored (#253,
-- trash.rs): every row of it, as the JSON `payload`. Out of reach of every read and
-- sync, not counted in used_bytes (`bytes`: its blobs, as they were counted).
CREATE TABLE IF NOT EXISTS trash (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind       TEXT NOT NULL,
    target     TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    payload    BLOB NOT NULL,
    PRIMARY KEY (account_id, kind, target)
);
"#;

pub fn open(path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Additive changes for databases created by earlier versions.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has_last_login = conn
        .prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'last_login_at'")?
        .exists([])?;
    if !has_last_login {
        conn.execute("ALTER TABLE accounts ADD COLUMN last_login_at INTEGER", [])?;
    }
    conn.execute("CREATE INDEX IF NOT EXISTS updates_created ON updates (created_at)", [])?;
    // A holder that is a connection's (#369): which, so revoking it takes its holders with it.
    let has_connection = conn.prepare("SELECT 1 FROM pragma_table_info('holders') WHERE name = 'connection_id'")?.exists([])?;
    if !has_connection {
        conn.execute("ALTER TABLE holders ADD COLUMN connection_id TEXT", [])?;
    }
    conn.execute("CREATE INDEX IF NOT EXISTS holders_connection ON holders (connection_id)", [])?;
    // A shared note's blobs by their nonce (#516): one posted again is the one stored, not another.
    conn.execute("CREATE INDEX IF NOT EXISTS share_updates_nonce ON share_updates (share_id, nonce)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS share_versions_nonce ON share_versions (share_id, nonce)", [])?;
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Drop expired challenges and sessions. Called opportunistically.
pub fn sweep(conn: &Connection) -> rusqlite::Result<()> {
    let t = now();
    conn.execute("DELETE FROM challenges WHERE expires_at < ?1", [t])?;
    conn.execute("DELETE FROM sessions WHERE expires_at < ?1", [t])?;
    conn.execute("DELETE FROM pow_challenges WHERE expires_at < ?1", [t])?;
    conn.execute("DELETE FROM trash WHERE deleted_at < ?1", [t - crate::trash::KEEP_SECS])?;
    // Holders of a share that's gone and can't be restored any more (#408): nothing opens them.
    conn.execute(
        "DELETE FROM holders WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.share_id = holders.share_id)
           AND NOT EXISTS (SELECT 1 FROM trash k WHERE k.kind = 'share' AND k.target = holders.share_id)",
        [],
    )?;
    Ok(())
}

/// Delete updates already covered by each doc's snapshot, and recount the
/// affected accounts' usage. Returns (rows deleted, bytes freed). Run at
/// startup when pruning is on, so data stored before it was enabled shrinks too.
pub fn prune_covered(conn: &Connection) -> rusqlite::Result<(usize, i64)> {
    const COVERED: &str = "EXISTS (SELECT 1 FROM snapshots s WHERE s.account_id = u.account_id
                           AND s.doc_id = u.doc_id AND s.covers_seq >= u.seq)";
    let tx = conn.unchecked_transaction()?;
    let (rows, bytes): (i64, i64) = tx.query_row(
        &format!("SELECT COUNT(*), COALESCE(SUM(LENGTH(ciphertext)), 0) FROM updates u WHERE {COVERED}"),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if rows > 0 {
        let accounts: Vec<String> = tx
            .prepare(&format!("SELECT DISTINCT account_id FROM updates u WHERE {COVERED}"))?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        tx.execute(&format!("DELETE FROM updates AS u WHERE {COVERED}"), [])?;
        for a in &accounts {
            crate::quota::recompute(&tx, a)?;
        }
    }
    tx.commit()?;
    Ok((rows as usize, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweeping_drops_holders_of_shares_gone_for_good_only() {
        let conn = open(":memory:").unwrap();
        conn.execute("INSERT INTO accounts (id, pubkey_hash, pubkey, created_at) VALUES ('a', 'h', x'00', 0)", []).unwrap();
        conn.execute("INSERT INTO shares (share_id, owner_account, pubkey, read_hash, created_at) VALUES ('live', 'a', x'00', x'00', 0)", []).unwrap();
        conn.execute("INSERT INTO trash (account_id, kind, target, deleted_at, bytes, payload) VALUES ('a', 'share', 'binned', ?1, 0, x'00')", [now()]).unwrap();
        for (holder, share) in [("h1", "live"), ("h2", "binned"), ("h3", "gone")] {
            conn.execute(
                "INSERT INTO holders (holder_id, owner_account, share_id, role, token_hash, nonce, ciphertext, created_at) VALUES (?1, 'a', ?2, 'read', x'00', x'00', x'00', 0)",
                [holder, share],
            )
            .unwrap();
        }
        sweep(&conn).unwrap();
        let left: Vec<String> = conn.prepare("SELECT holder_id FROM holders ORDER BY holder_id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(left, ["h1", "h2"], "a live share's, and one still restorable from the trash");
    }
}
