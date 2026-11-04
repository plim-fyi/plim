//! `plim-server --backup`: a consistent copy of the database while the server has it open.

mod common;
use common::*;

use plim_server::backup::backup;
use plim_server::{AppState, app};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("plim-backup-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test]
async fn a_backup_holds_what_the_running_server_wrote() {
    let dir = temp_dir("live");
    let db = dir.join("plim.db");
    let state = AppState::new(config(db.to_str().unwrap(), 1 << 20, true)).unwrap();
    let router = app(state);
    for (seed, id) in [(1, "0123456789abcdef0123456789abcdef"), (2, "fedcba9876543210fedcba9876543210")] {
        assert_eq!(signup(&router, &User::new(seed, id)).await, axum::http::StatusCode::CREATED);
    }

    // (The server still has it open, its last writes possibly only in the write-ahead log.)
    let out = dir.join("backup.db");
    let c = backup(db.to_str().unwrap(), &out).unwrap();
    assert_eq!(c.accounts, 2, "both accounts are in the copy");
    assert!(c.bytes > 0);
    assert!(!dir.join("backup.db.tmp").exists(), "no temporary file left");
    let copy = rusqlite::Connection::open(&out).unwrap();
    let n: i64 = copy.query_row("SELECT count(*) FROM keyring", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2, "and their keyrings");
    drop(copy);

    // Again, over the last one (a leftover .tmp from a failed run is no obstacle).
    std::fs::write(dir.join("backup.db.tmp"), b"half a copy").unwrap();
    assert_eq!(signup(&router, &User::new(3, "00112233445566778899aabbccddeeff")).await, axum::http::StatusCode::CREATED);
    assert_eq!(backup(db.to_str().unwrap(), &out).unwrap().accounts, 3, "a second run replaces the first");

    // A failure leaves the previous backup as it was.
    assert!(backup(db.to_str().unwrap(), &dir.join("missing-dir/backup.db")).is_err());
    assert!(backup(dir.join("none.db").to_str().unwrap(), &out).is_err(), "no database: an error, not an empty copy");
    assert_eq!(backup(db.to_str().unwrap(), &out).unwrap().accounts, 3);
    let _ = std::fs::remove_dir_all(&dir);
}
