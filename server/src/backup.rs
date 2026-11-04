//! `plim-server --backup <file>`: a consistent copy of the database while the server runs.
//!
//! SQLite's `VACUUM INTO` reads one snapshot of the database (whatever the write-ahead log holds,
//! too) and writes it out compacted, while the server goes on writing. The copy is made beside the
//! target (`<file>.tmp`), checked (`PRAGMA integrity_check`), and only then renamed over it: a
//! failed run leaves the previous backup as it was, never half of a new one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

/// What a backup wrote.
#[derive(Debug)]
pub struct Copied {
    pub bytes: u64,
    pub accounts: i64,
}

pub fn backup(db_path: &str, out: &Path) -> Result<Copied, String> {
    if !Path::new(db_path).is_file() {
        return Err(format!("no database at {db_path}"));
    }
    let tmp = PathBuf::from(format!("{}.tmp", out.display()));
    let _ = std::fs::remove_file(&tmp); // (left by a run that failed)
    let err = |what: &str, e: rusqlite::Error| format!("{what}: {e}");

    let db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| err(&format!("opening {db_path}"), e))?;
    db.busy_timeout(Duration::from_secs(30)).map_err(|e| err("busy timeout", e))?;
    let target = tmp.to_str().ok_or("the backup's path isn't UTF-8")?;
    db.execute("VACUUM INTO ?1", [target]).map_err(|e| err("copying", e))?;
    drop(db);

    let checked = (|| {
        let copy = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let ok: String = copy.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        let accounts: i64 = copy.query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))?;
        Ok::<_, rusqlite::Error>((ok, accounts))
    })();
    let (ok, accounts) = match checked {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(err("checking the copy", e));
        }
    };
    if ok != "ok" {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("the copy failed its integrity check: {ok}"));
    }
    std::fs::rename(&tmp, out).map_err(|e| format!("moving the copy to {}: {e}", out.display()))?;
    let bytes = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    Ok(Copied { bytes, accounts })
}
