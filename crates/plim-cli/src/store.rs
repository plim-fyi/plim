//! Per-account local state in SQLite: the encrypted autosave outbox and what
//! this device has seen the server confirm (for rollback detection).
//! Mirrors `IdbOutbox` / `IdbSeen` in `web/core/vault.js`.

use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

pub struct OutboxRecord {
    pub id: i64,
    pub key_version: u64,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let existed = path.exists();
        let conn = Connection::open(path)?;
        if !existed {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        Self::init(conn)
    }

    /// Nothing kept on disk: one-shot commands with only a link (#130), and tests.
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS outbox (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 doc_id TEXT NOT NULL,
                 key_version INTEGER NOT NULL,
                 nonce BLOB NOT NULL,
                 ciphertext BLOB NOT NULL
             );
             CREATE INDEX IF NOT EXISTS outbox_doc ON outbox (doc_id);
             CREATE TABLE IF NOT EXISTS seen (doc_id TEXT PRIMARY KEY, sv BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);",
        )?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn outbox_add(&self, doc_id: &str, key_version: u64, nonce: &[u8], ciphertext: &[u8]) -> Result<()> {
        self.db().execute(
            "INSERT INTO outbox (doc_id, key_version, nonce, ciphertext) VALUES (?1, ?2, ?3, ?4)",
            params![doc_id, key_version as i64, nonce, ciphertext],
        )?;
        Ok(())
    }

    pub fn outbox_list(&self, doc_id: &str) -> Result<Vec<OutboxRecord>> {
        let db = self.db();
        let mut stmt = db.prepare("SELECT id, key_version, nonce, ciphertext FROM outbox WHERE doc_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map([doc_id], |r| {
            Ok(OutboxRecord {
                id: r.get(0)?,
                key_version: r.get::<_, i64>(1)? as u64,
                nonce: r.get(2)?,
                ciphertext: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn outbox_remove(&self, ids: &[i64]) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn outbox_docs(&self) -> Result<Vec<String>> {
        let db = self.db();
        let mut stmt = db.prepare("SELECT DISTINCT doc_id FROM outbox")?;
        Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn seen_get(&self, doc_id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.db().query_row("SELECT sv FROM seen WHERE doc_id = ?1", [doc_id], |r| r.get(0)).optional()?)
    }

    pub fn seen_set(&self, doc_id: &str, sv: &[u8]) -> Result<()> {
        self.db().execute(
            "INSERT INTO seen (doc_id, sv) VALUES (?1, ?2) ON CONFLICT(doc_id) DO UPDATE SET sv = excluded.sv",
            params![doc_id, sv],
        )?;
        Ok(())
    }

    pub fn key_version(&self) -> Result<u64> {
        let v: Option<i64> =
            self.db().query_row("SELECT value FROM meta WHERE key = 'key_version'", [], |r| r.get(0)).optional()?;
        Ok(v.unwrap_or(0) as u64)
    }

    pub fn set_key_version(&self, v: u64) -> Result<()> {
        self.db().execute(
            "INSERT INTO meta (key, value) VALUES ('key_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [v as i64],
        )?;
        Ok(())
    }
}
