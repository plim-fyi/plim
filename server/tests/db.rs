//! The database connections (#260): a pool, not one connection behind one lock, so a slow
//! request doesn't hold up the others, and reads go on while something writes.
mod common;
use common::*;

use std::time::Duration;

fn state_and_app() -> (AppState, Router) {
    let st = AppState::new(config(":memory:", 1 << 20, false)).unwrap();
    (st.clone(), app(st))
}

async fn signed_in(app: &Router) -> (User, String) {
    let u = User::new(1, ACCT);
    signup(app, &u).await;
    let t = login(app, &u.sk).await.unwrap();
    (u, t)
}

/// With a connection busy elsewhere (a slow query), and with a write transaction open on
/// another, a request still gets through at once: readers don't wait (WAL). A write waits its
/// turn. (Two threads, as the server has many: a waiting write blocks the thread it's on.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_connection_doesnt_hold_up_other_requests() {
    let (st, app) = state_and_app();
    let (u, t) = signed_in(&app).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"text"))).await;

    let _busy = st.db(); // (a query that takes its time, on this connection)
    let mut writing = st.db();
    let tx = plim_server::db::write_tx(&mut writing).unwrap();
    tx.execute("INSERT INTO gone_docs (account_id, doc_id, gone_at) VALUES (?1, 'zz', 0)", [ACCT]).unwrap(); // (uncommitted)

    let quick = tokio::time::timeout(Duration::from_secs(1), call(&app, "GET", "/api/docs", Some(&t), None)).await;
    let (s, v) = quick.expect("a read waited on the busy connections");
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["docs"], json!(["aa"]));
    // A write waits for the open transaction, then goes through (busy_timeout), rather than failing.
    let later = tokio::spawn({
        let (app, t, blob) = (app.clone(), t.clone(), u.blob("bb", "update", 1, 0, b"more"));
        async move { call(&app, "POST", "/api/docs/bb/updates", Some(&t), Some(blob)).await.0 }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!later.is_finished(), "a write went through while another transaction had the write lock");
    tx.rollback().unwrap();
    drop(writing);
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), later).await.unwrap().unwrap(), StatusCode::OK);
}

/// Many writes at once, from different requests, all land: they take turns, none is refused
/// as "database is locked".
#[tokio::test]
async fn writes_from_many_requests_at_once_all_land() {
    let (_, app) = state_and_app();
    let (u, t) = signed_in(&app).await;
    let posts = (0..16).map(|i| {
        let (app, t) = (app.clone(), t.clone());
        let doc = format!("d{i:02}");
        let blob = u.blob(&doc, "update", 1, 0, &[i as u8; 64]);
        tokio::spawn(async move { call(&app, "POST", &format!("/api/docs/{doc}/updates"), Some(&t), Some(blob)).await.0 })
    });
    for p in posts {
        assert_eq!(p.await.unwrap(), StatusCode::OK);
    }
    let (_, v) = call(&app, "GET", "/api/docs", Some(&t), None).await;
    assert_eq!(v["docs"].as_array().unwrap().len(), 16);
    let (_, v) = call(&app, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["used_bytes"], 16 * 64, "every write counted once");
}

/// A pool's temporary database (":memory:") is gone with it.
#[test]
fn a_temporary_database_is_removed_with_its_pool() {
    let pool = plim_server::db::Pool::open(":memory:").unwrap();
    let path = pool.temp_path().expect("a temporary file").to_owned();
    assert!(path.exists());
    assert!(plim_server::db::Pool::open("/tmp/plim-db-test-named.db").unwrap().temp_path().is_none(), "a named file isn't temporary");
    std::fs::remove_file("/tmp/plim-db-test-named.db").ok();
    drop(pool);
    assert!(!path.exists(), "{}", path.display());
    assert!(!path.with_extension("db-wal").exists());
}
