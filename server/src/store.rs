//! Where a note's encrypted history is kept (#411): its updates, its latest snapshot and its saved
//! versions, the same for a private note and a shared one.
//!
//! A private note's rows are the account's (`updates`, `snapshots`, `versions`, keyed by account
//! and doc, with the vault key version that encrypted each); a shared note's are the share's
//! (`share_updates`, `share_snapshots`, `share_versions`, keyed by share). The routes check who may
//! read or write (a session and the account's key, or the share's key and read token) and what it
//! costs (quota); this module only stores and serves.
//!
//! What a client gets back is as before: a private note's rows carry their `key_version`, a shared
//! note's their `sig` (its readers check it themselves, #77).

use rusqlite::types::ToSql;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{b64, b64e, ApiError};

/// A note's history: an account's own note, or a shared one.
#[derive(Clone, Copy, Debug)]
pub enum Doc<'a> {
    Private { account: &'a str, doc: &'a str },
    Shared { share: &'a str },
}

/// One stored blob, as a row is: an update (`seq`), a snapshot (`covers_seq`) or a version, with the
/// vault key version for a private note's. The trash keeps them in this form (trash.rs), so it
/// mustn't change.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Row {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covers_seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_version: Option<i64>,
    pub created_at: i64,
    pub nonce: String,
    pub ciphertext: String,
    pub sig: String,
}

/// Everything of a note's history, as the trash keeps it.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct History {
    pub updates: Vec<Row>,
    pub snapshots: Vec<Row>,
    pub versions: Vec<Row>,
}

impl History {
    pub fn is_empty(&self) -> bool {
        self.updates.is_empty() && self.snapshots.is_empty() && self.versions.is_empty()
    }

    /// Its blobs' bytes, as they count against the quota.
    pub fn bytes(&self) -> i64 {
        [&self.updates, &self.snapshots, &self.versions]
            .iter()
            .flat_map(|rows| rows.iter())
            .map(|r| b64(&r.ciphertext).map(|c| c.len() as i64).unwrap_or(0))
            .sum()
    }
}

/// A blob to store: decoded, its signature already checked by the route.
pub struct NewBlob<'b> {
    pub key_version: Option<i64>,
    pub nonce: &'b [u8],
    pub ciphertext: &'b [u8],
    pub sig: &'b [u8],
}

type Params<'p> = Vec<(&'static str, &'p dyn ToSql)>;

impl<'a> Doc<'a> {
    fn private(&self) -> bool {
        matches!(self, Doc::Private { .. })
    }

    fn table(&self, kind: &str) -> String {
        if self.private() { kind.to_string() } else { format!("share_{kind}") }
    }

    /// The rows' key, as SQL over named parameters.
    fn key(&self) -> &'static str {
        if self.private() { "account_id = :a AND doc_id = :d" } else { "share_id = :s" }
    }

    /// The key's columns and values, for an INSERT.
    fn key_columns(&self) -> (&'static str, &'static str) {
        if self.private() { ("account_id, doc_id, key_version", ":a, :d, :kv") } else { ("share_id", ":s") }
    }

    fn params(&self) -> Params<'_> {
        match self {
            Doc::Private { account, doc } => vec![(":a", account as &dyn ToSql), (":d", doc as &dyn ToSql)],
            Doc::Shared { share } => vec![(":s", share as &dyn ToSql)],
        }
    }

    /// The highest sequence number stored (updates may have been pruned, so snapshots count too).
    pub fn head(&self, conn: &Connection) -> rusqlite::Result<i64> {
        let sql = format!(
            "SELECT MAX((SELECT COALESCE(MAX(seq), 0) FROM {u} WHERE {k}), (SELECT COALESCE(MAX(covers_seq), 0) FROM {s} WHERE {k}))",
            u = self.table("updates"),
            s = self.table("snapshots"),
            k = self.key()
        );
        conn.query_row(&sql, &*self.params(), |r| r.get(0))
    }

    /// The bytes its blobs take: updates, snapshot and versions.
    pub fn bytes(&self, conn: &Connection) -> rusqlite::Result<i64> {
        let sum = |kind: &str| format!("(SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM {} WHERE {})", self.table(kind), self.key());
        conn.query_row(&format!("SELECT {} + {} + {}", sum("updates"), sum("snapshots"), sum("versions")), &*self.params(), |r| r.get(0))
    }

    /// A row as the client gets it: with its key version (private) or its signature (shared).
    fn row_json(&self, mut v: Value, key_version: i64, sig: Vec<u8>) -> Value {
        if self.private() {
            v["key_version"] = key_version.into();
        } else {
            v["sig"] = b64e(&sig).into();
        }
        v
    }

    /// What brings a client at `after` up to date: the snapshot if it covers more than that, and
    /// the updates after it, with the head. (GET …/doc and the live socket's history.)
    pub fn since(&self, conn: &Connection, after: i64) -> rusqlite::Result<Value> {
        let kv = if self.private() { "key_version" } else { "0" };
        let snapshot = conn
            .query_row(
                &format!("SELECT covers_seq, {kv}, nonce, ciphertext, sig FROM {} WHERE {} ORDER BY covers_seq DESC, id DESC LIMIT 1", self.table("snapshots"), self.key()),
                &*self.params(),
                |r| {
                    let covers: i64 = r.get(0)?;
                    let v = json!({ "covers_seq": covers, "nonce": b64e(&r.get::<_, Vec<u8>>(2)?), "ciphertext": b64e(&r.get::<_, Vec<u8>>(3)?) });
                    Ok((covers, self.row_json(v, r.get(1)?, r.get(4)?)))
                },
            )
            .optional()?;
        let (snapshot_json, base) = match snapshot {
            Some((covers, v)) if covers > after => (v, covers),
            _ => (Value::Null, after),
        };
        let mut params = self.params();
        params.push((":after", &base));
        let mut stmt = conn.prepare(&format!("SELECT seq, {kv}, nonce, ciphertext, sig FROM {} WHERE {} AND seq > :after ORDER BY seq", self.table("updates"), self.key()))?;
        let updates = stmt
            .query_map(&*params, |r| {
                let v = json!({ "seq": r.get::<_, i64>(0)?, "nonce": b64e(&r.get::<_, Vec<u8>>(2)?), "ciphertext": b64e(&r.get::<_, Vec<u8>>(3)?) });
                Ok(self.row_json(v, r.get(1)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({ "snapshot": snapshot_json, "updates": updates, "head": self.head(conn)? }))
    }

    /// An update, after the head. Returns its seq.
    pub fn append(&self, conn: &Connection, blob: &NewBlob, now: i64) -> rusqlite::Result<i64> {
        let seq = self.head(conn)? + 1;
        let (cols, vals) = self.key_columns();
        let mut params = self.params();
        params.extend([(":kv", &blob.key_version as &dyn ToSql), (":seq", &seq), (":n", &blob.nonce), (":c", &blob.ciphertext), (":g", &blob.sig), (":t", &now)]);
        if !self.private() {
            params.retain(|(k, _)| *k != ":kv");
        }
        conn.execute(&format!("INSERT INTO {} ({cols}, seq, nonce, ciphertext, sig, created_at) VALUES ({vals}, :seq, :n, :c, :g, :t)", self.table("updates")), &*params)?;
        Ok(seq)
    }

    /// The newest snapshot's covers_seq, or -1 when there's none.
    pub fn latest_snapshot(&self, conn: &Connection) -> rusqlite::Result<i64> {
        conn.query_row(&format!("SELECT COALESCE(MAX(covers_seq), -1) FROM {} WHERE {}", self.table("snapshots"), self.key()), &*self.params(), |r| r.get(0))
    }

    /// The bytes a snapshot covering `covers` frees: the snapshot it replaces, and (when `prune`) the
    /// updates it covers.
    pub fn freed_by_snapshot(&self, conn: &Connection, covers: i64, prune: bool) -> rusqlite::Result<i64> {
        let old: i64 = conn.query_row(&format!("SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM {} WHERE {}", self.table("snapshots"), self.key()), &*self.params(), |r| r.get(0))?;
        if !prune {
            return Ok(old);
        }
        let mut params = self.params();
        params.push((":covers", &covers));
        let pruned: i64 = conn.query_row(&format!("SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM {} WHERE {} AND seq <= :covers", self.table("updates"), self.key()), &*params, |r| r.get(0))?;
        Ok(old + pruned)
    }

    /// The snapshot replaced (and, with `prune`, the updates it covers dropped). The route has
    /// checked `covers` (not ahead of the head, not behind the latest snapshot) and the quota.
    pub fn put_snapshot(&self, conn: &Connection, covers: i64, blob: &NewBlob, prune: bool, now: i64) -> rusqlite::Result<()> {
        conn.execute(&format!("DELETE FROM {} WHERE {}", self.table("snapshots"), self.key()), &*self.params())?;
        if prune {
            let mut params = self.params();
            params.push((":covers", &covers));
            conn.execute(&format!("DELETE FROM {} WHERE {} AND seq <= :covers", self.table("updates"), self.key()), &*params)?;
        }
        let (cols, vals) = self.key_columns();
        let mut params = self.params();
        params.extend([(":kv", &blob.key_version as &dyn ToSql), (":cv", &covers), (":n", &blob.nonce), (":c", &blob.ciphertext), (":g", &blob.sig), (":t", &now)]);
        if !self.private() {
            params.retain(|(k, _)| *k != ":kv");
        }
        conn.execute(&format!("INSERT INTO {} ({cols}, covers_seq, nonce, ciphertext, sig, created_at) VALUES ({vals}, :cv, :n, :c, :g, :t)", self.table("snapshots")), &*params)?;
        Ok(())
    }

    // ---- versions (#60) ----

    /// Its versions, newest first: [{id, created_at, size}].
    pub fn versions(&self, conn: &Connection) -> rusqlite::Result<Vec<Value>> {
        let mut stmt = conn.prepare(&format!("SELECT id, created_at, LENGTH(ciphertext) FROM {} WHERE {} ORDER BY created_at DESC, id DESC", self.table("versions"), self.key()))?;
        stmt.query_map(&*self.params(), |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "created_at": r.get::<_, i64>(1)?, "size": r.get::<_, i64>(2)? })))?
            .collect()
    }

    /// One version, to decrypt: with its key version (private) or signature (shared).
    pub fn version(&self, conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
        let kv = if self.private() { "key_version" } else { "0" };
        let mut params = self.params();
        params.push((":id", &id));
        conn.query_row(&format!("SELECT created_at, {kv}, nonce, ciphertext, sig FROM {} WHERE id = :id AND {}", self.table("versions"), self.key()), &*params, |r| {
            let v = json!({ "id": id, "created_at": r.get::<_, i64>(0)?, "nonce": b64e(&r.get::<_, Vec<u8>>(2)?), "ciphertext": b64e(&r.get::<_, Vec<u8>>(3)?) });
            Ok(self.row_json(v, r.get(1)?, r.get(4)?))
        })
        .optional()
    }

    /// When a version was taken, if it's one of this note's.
    pub fn version_time(&self, conn: &Connection, id: i64) -> rusqlite::Result<Option<i64>> {
        let mut params = self.params();
        params.push((":id", &id));
        conn.query_row(&format!("SELECT created_at FROM {} WHERE id = :id AND {}", self.table("versions"), self.key()), &*params, |r| r.get(0)).optional()
    }

    /// A version saved (kept: a note's history is whole, its oldest going only to make room, quota.rs).
    pub fn save_version(&self, conn: &Connection, created_at: i64, blob: &NewBlob) -> rusqlite::Result<i64> {
        let (cols, vals) = self.key_columns();
        let mut params = self.params();
        params.extend([(":kv", &blob.key_version as &dyn ToSql), (":t", &created_at), (":n", &blob.nonce), (":c", &blob.ciphertext), (":g", &blob.sig)]);
        if !self.private() {
            params.retain(|(k, _)| *k != ":kv");
        }
        conn.execute(&format!("INSERT INTO {} ({cols}, created_at, nonce, ciphertext, sig) VALUES ({vals}, :t, :n, :c, :g)", self.table("versions")), &*params)?;
        Ok(conn.last_insert_rowid())
    }

    /// Its versions taken before `before` deleted for good (forgetting its history). Returns how many.
    pub fn forget_versions(&self, conn: &Connection, before: i64) -> rusqlite::Result<usize> {
        let mut params = self.params();
        params.push((":before", &before));
        conn.execute(&format!("DELETE FROM {} WHERE {} AND created_at < :before", self.table("versions"), self.key()), &*params)
    }

    /// A version encrypted again (a phrase change), keeping its time. (Private notes only.)
    pub fn replace_version(&self, conn: &Connection, id: i64, blob: &NewBlob) -> rusqlite::Result<()> {
        let mut params = self.params();
        params.extend([(":id", &id as &dyn ToSql), (":kv", &blob.key_version), (":n", &blob.nonce), (":c", &blob.ciphertext), (":g", &blob.sig)]);
        conn.execute(&format!("UPDATE {} SET key_version = :kv, nonce = :n, ciphertext = :c, sig = :g WHERE id = :id AND {}", self.table("versions"), self.key()), &*params)?;
        Ok(())
    }

    // ---- all of it: for the trash (#253) ----

    /// Every row of its history, as the trash keeps it.
    pub fn read_all(&self, conn: &Connection) -> rusqlite::Result<History> {
        let rows = |kind: &str, extra: &str, order: &str| -> rusqlite::Result<Vec<Row>> {
            let kv = if self.private() { "key_version" } else { "NULL" };
            let mut stmt = conn.prepare(&format!("SELECT created_at, nonce, ciphertext, sig, {extra}, {kv} FROM {} WHERE {} ORDER BY {order}", self.table(kind), self.key()))?;
            stmt.query_map(&*self.params(), |r| {
                let n: Option<i64> = r.get(4)?;
                Ok(Row {
                    created_at: r.get(0)?,
                    nonce: b64e(&r.get::<_, Vec<u8>>(1)?),
                    ciphertext: b64e(&r.get::<_, Vec<u8>>(2)?),
                    sig: b64e(&r.get::<_, Vec<u8>>(3)?),
                    seq: if kind == "updates" { n } else { None },
                    covers_seq: if kind == "snapshots" { n } else { None },
                    key_version: r.get(5)?,
                })
            })?
            .collect()
        };
        Ok(History { updates: rows("updates", "seq", "seq")?, snapshots: rows("snapshots", "covers_seq", "id")?, versions: rows("versions", "NULL", "id")? })
    }

    /// Whether anything of its history is stored.
    pub fn exists(&self, conn: &Connection) -> rusqlite::Result<bool> {
        let any = |kind: &str| format!("SELECT 1 FROM {} WHERE {}", self.table(kind), self.key());
        conn.prepare(&format!("{} UNION ALL {}", any("updates"), any("snapshots")))?.exists(&*self.params())
    }

    /// Every row of its history gone.
    pub fn delete_all(&self, conn: &Connection) -> rusqlite::Result<()> {
        for kind in ["updates", "snapshots", "versions"] {
            conn.execute(&format!("DELETE FROM {} WHERE {}", self.table(kind), self.key()), &*self.params())?;
        }
        Ok(())
    }

    /// Its history put back as it was (restoring from the trash).
    pub fn write_all(&self, conn: &Connection, h: &History) -> Result<(), ApiError> {
        type Bytes = Vec<u8>;
        let decoded = |r: &Row| -> Result<(Bytes, Bytes, Bytes), ApiError> { Ok((b64(&r.nonce)?, b64(&r.ciphertext)?, b64(&r.sig)?)) };
        let (cols, vals) = self.key_columns();
        for (kind, rows) in [("updates", &h.updates), ("snapshots", &h.snapshots), ("versions", &h.versions)] {
            let extra = match kind {
                "updates" => ", seq",
                "snapshots" => ", covers_seq",
                _ => "",
            };
            let extra_val = if extra.is_empty() { "" } else { ", :x" };
            let sql = format!("INSERT INTO {} ({cols}, created_at, nonce, ciphertext, sig{extra}) VALUES ({vals}, :t, :n, :c, :g{extra_val})", self.table(kind));
            for r in rows {
                let (nonce, ct, sig) = decoded(r)?;
                let x = r.seq.or(r.covers_seq);
                let mut params = self.params();
                params.extend([(":kv", &r.key_version as &dyn ToSql), (":t", &r.created_at), (":n", &nonce), (":c", &ct), (":g", &sig)]);
                if !extra.is_empty() {
                    params.push((":x", &x));
                }
                if !self.private() {
                    params.retain(|(k, _)| *k != ":kv");
                }
                conn.execute(&sql, &*params)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = crate::db::open(":memory:").unwrap();
        c.execute("INSERT INTO accounts (id, pubkey_hash, pubkey, created_at) VALUES ('a', 'h', x'00', 0)", []).unwrap();
        c.execute("INSERT INTO shares (share_id, owner_account, pubkey, read_hash, created_at) VALUES ('s', 'a', x'00', x'00', 0)", []).unwrap();
        c
    }

    fn blob(kv: Option<i64>, ct: &[u8]) -> NewBlob<'_> {
        NewBlob { key_version: kv, nonce: b"twelve bytes", ciphertext: ct, sig: b"sig" }
    }

    /// The same history, kept the same way, for a private note and a shared one.
    #[test]
    fn a_private_note_and_a_shared_one_alike() {
        let c = conn();
        for (doc, kv) in [(Doc::Private { account: "a", doc: "d1" }, Some(1)), (Doc::Shared { share: "s" }, None)] {
            assert_eq!((doc.head(&c).unwrap(), doc.latest_snapshot(&c).unwrap(), doc.exists(&c).unwrap()), (0, -1, false));
            assert_eq!(doc.append(&c, &blob(kv, b"one"), 10).unwrap(), 1);
            assert_eq!(doc.append(&c, &blob(kv, b"two!"), 11).unwrap(), 2);
            assert_eq!(doc.append(&c, &blob(kv, b"3"), 12).unwrap(), 3);
            assert_eq!(doc.bytes(&c).unwrap(), 8);
            // A snapshot of the first two: it frees them (pruning), and the head stays.
            assert_eq!(doc.freed_by_snapshot(&c, 2, true).unwrap(), 7);
            assert_eq!(doc.freed_by_snapshot(&c, 2, false).unwrap(), 0);
            doc.put_snapshot(&c, 2, &blob(kv, b"snap"), true, 13).unwrap();
            assert_eq!((doc.head(&c).unwrap(), doc.latest_snapshot(&c).unwrap(), doc.bytes(&c).unwrap()), (3, 2, 5));
            assert_eq!(doc.append(&c, &blob(kv, b"four"), 14).unwrap(), 4, "after the head, updates or snapshot");
            // What a client gets: from the start, the snapshot and what's after it; from 3, just 4.
            let all = doc.since(&c, 0).unwrap();
            assert_eq!((all["snapshot"]["covers_seq"].as_i64(), all["updates"].as_array().unwrap().len(), all["head"].as_i64()), (Some(2), 2, Some(4)));
            let late = doc.since(&c, 3).unwrap();
            assert!(late["snapshot"].is_null());
            assert_eq!(late["updates"][0]["seq"], 4);
            // A private note's rows carry their key version; a shared note's, their signature.
            assert_eq!(all["updates"][0].get("key_version").is_some(), kv.is_some());
            assert_eq!(all["snapshot"].get("sig").is_some(), kv.is_none());
            // Versions: saved, listed newest first, read back, and their time.
            let v1 = doc.save_version(&c, 100, &blob(kv, b"v1")).unwrap();
            let v2 = doc.save_version(&c, 150, &blob(kv, b"v22")).unwrap();
            let list = doc.versions(&c).unwrap();
            assert_eq!(list.iter().map(|v| v["id"].as_i64().unwrap()).collect::<Vec<_>>(), [v2, v1]);
            assert_eq!(list[0]["size"], 3);
            assert_eq!(doc.version(&c, v1).unwrap().unwrap()["created_at"], 100);
            assert_eq!(doc.version_time(&c, v2).unwrap(), Some(150));
            // All of it read out, deleted, and written back as it was (the trash).
            let before = doc.since(&c, 0).unwrap();
            let history = doc.read_all(&c).unwrap();
            assert_eq!((history.updates.len(), history.snapshots.len(), history.versions.len(), history.bytes()), (2, 1, 2, 14));
            doc.delete_all(&c).unwrap();
            assert!(!doc.exists(&c).unwrap());
            assert_eq!(doc.bytes(&c).unwrap(), 0);
            doc.write_all(&c, &history).unwrap();
            assert_eq!(doc.since(&c, 0).unwrap(), before);
            assert_eq!(doc.versions(&c).unwrap().len(), 2);
        }
        // Each note only sees its own rows.
        let other = Doc::Private { account: "a", doc: "d2" };
        assert_eq!((other.head(&c).unwrap(), other.bytes(&c).unwrap()), (0, 0));
    }

    #[test]
    fn a_phrase_change_re_encrypts_a_private_version_keeping_its_time() {
        let c = conn();
        let doc = Doc::Private { account: "a", doc: "d1" };
        let id = doc.save_version(&c, 100, &blob(Some(1), b"old")).unwrap();
        doc.replace_version(&c, id, &blob(Some(2), b"newer")).unwrap();
        let v = doc.version(&c, id).unwrap().unwrap();
        assert_eq!((v["key_version"].as_i64(), v["created_at"].as_i64()), (Some(2), Some(100)));
        assert_eq!(doc.versions(&c).unwrap()[0]["size"], 5);
    }
}
