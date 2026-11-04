//! A deleted note's data, kept for 30 days so it can be restored (#253).
mod common;
use common::*;

/// The app, and its state (to age what's in the trash, and look at it).
fn state_and_app(quota: i64) -> (AppState, Router) {
    let st = AppState::new(config(":memory:", quota, false)).unwrap();
    (st.clone(), app(st))
}

async fn signed_in(app: &Router) -> (User, String) {
    let u = User::new(1, ACCT);
    signup(app, &u).await;
    let t = login(app, &u.sk).await.unwrap();
    (u, t)
}

async fn delete_doc(app: &Router, u: &User, t: &str, doc: &str) -> StatusCode {
    signed(app, &u.sk, &u.account_id, t, "DELETE", &format!("/api/docs/{doc}"), sig::action::DELETE_DOC, doc, &[], None).await.0
}

async fn restore_doc(app: &Router, u: &User, t: &str, doc: &str) -> (StatusCode, Value) {
    signed(app, &u.sk, &u.account_id, t, "POST", &format!("/api/trash/doc/{doc}/restore"), sig::action::RESTORE_DOC, doc, &[], None).await
}

async fn used(app: &Router, t: &str) -> i64 {
    call(app, "GET", "/api/account", Some(t), None).await.1["used_bytes"].as_i64().unwrap()
}

async fn trash(app: &Router, t: &str) -> Vec<Value> {
    call(app, "GET", "/api/trash", Some(t), None).await.1["trash"].as_array().unwrap().clone()
}

fn days_ago(days: i64) -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - (days * 86400) as u64
}

/// Deleted for good, a note is gone to every read and sync at once, and stops counting; it's
/// still kept, and comes back as it was (its edits, snapshot and History), signed (#144),
/// counting again and taking edits again.
#[tokio::test]
async fn a_deleted_note_is_kept_and_comes_back_as_it_was() {
    let (_, app) = state_and_app(1 << 20);
    let (u, t) = signed_in(&app).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"one"))).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"two"))).await;
    call(&app, "POST", "/api/docs/aa/snapshots", Some(&t), Some(u.blob("aa", "snapshot", 1, 1, b"snap"))).await;
    let (s, v) = call(&app, "POST", "/api/docs/aa/versions", Some(&t), Some(u.blob("aa", "version", 1, days_ago(2), b"old text"))).await;
    assert!(s.is_success(), "{v}");
    let (_, before) = call(&app, "GET", "/api/docs/aa?after=0", Some(&t), None).await;
    let size = used(&app, &t).await;
    assert_eq!(size, 3 + 3 + 4 + 8);

    assert_eq!(delete_doc(&app, &u, &t, "aa").await, StatusCode::NO_CONTENT);
    let (_, gone) = call(&app, "GET", "/api/docs/aa?after=0", Some(&t), None).await;
    assert!(gone["snapshot"].is_null() && gone["updates"].as_array().unwrap().is_empty(), "{gone}");
    let (_, list) = call(&app, "GET", "/api/docs", Some(&t), None).await;
    assert_eq!(list["docs"], json!([]));
    assert_eq!(used(&app, &t).await, 0, "the trash isn't counted");
    let kept = trash(&app, &t).await;
    assert_eq!(kept.len(), 1);
    assert_eq!((kept[0]["kind"].as_str(), kept[0]["target"].as_str(), kept[0]["bytes"].as_i64()), (Some("doc"), Some("aa"), Some(size)));

    check_needs_signature(&app, &u, &t, "POST", "/api/trash/doc/aa/restore", sig::action::RESTORE_DOC, "aa", &[], None, StatusCode::NO_CONTENT).await;
    let (_, after) = call(&app, "GET", "/api/docs/aa?after=0", Some(&t), None).await;
    assert_eq!(after, before, "as it was");
    let (_, versions) = call(&app, "GET", "/api/docs/aa/versions", Some(&t), None).await;
    assert_eq!(versions["versions"].as_array().unwrap().len(), 1, "its History too");
    assert_eq!(used(&app, &t).await, size, "counting again");
    assert!(trash(&app, &t).await.is_empty());
    let (s, _) = call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"three"))).await;
    assert_eq!(s, StatusCode::OK, "taking edits again");
    // Not twice.
    assert_eq!(restore_doc(&app, &u, &t, "aa").await.0, StatusCode::NOT_FOUND);
}

/// Restoring never writes over a note that's there again (its id used anew): 409.
#[tokio::test]
async fn a_note_there_again_isnt_restored_over() {
    let (_, app) = state_and_app(1 << 20);
    let (u, t) = signed_in(&app).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"old"))).await;
    delete_doc(&app, &u, &t, "aa").await;
    signed(&app, &u.sk, &u.account_id, &t, "POST", "/api/docs/aa/reopen", sig::action::REOPEN_DOC, "aa", &[], None).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"new"))).await;
    assert_eq!(restore_doc(&app, &u, &t, "aa").await.0, StatusCode::CONFLICT);
    let (_, doc) = call(&app, "GET", "/api/docs/aa?after=0", Some(&t), None).await;
    assert_eq!(doc["updates"][0]["ciphertext"], b64(b"new"));
}

/// After 30 days it's gone: not listed, not restorable, and swept from the database.
#[tokio::test]
async fn whats_deleted_is_kept_30_days() {
    let (st, app) = state_and_app(1 << 20);
    let (u, t) = signed_in(&app).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"text"))).await;
    delete_doc(&app, &u, &t, "aa").await;
    st.db().execute("UPDATE trash SET deleted_at = deleted_at - 29 * 86400", []).unwrap();
    assert_eq!(trash(&app, &t).await.len(), 1, "29 days on: still there");
    st.db().execute("UPDATE trash SET deleted_at = deleted_at - 2 * 86400", []).unwrap();
    assert!(trash(&app, &t).await.is_empty());
    assert_eq!(restore_doc(&app, &u, &t, "aa").await.0, StatusCode::NOT_FOUND);
    login(&app, &u.sk).await.unwrap(); // (signing in sweeps)
    let rows: i64 = st.db().query_row("SELECT COUNT(*) FROM trash", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}

/// An account's trash holds at most its quota: past that, the oldest goes first.
#[tokio::test]
async fn the_trash_holds_at_most_the_quota() {
    let (st, app) = state_and_app(1000);
    let (u, t) = signed_in(&app).await;
    for doc in ["aa", "bb"] {
        call(&app, "POST", &format!("/api/docs/{doc}/updates"), Some(&t), Some(u.blob(doc, "update", 1, 0, &[1; 600]))).await;
        delete_doc(&app, &u, &t, doc).await;
        st.db().execute("UPDATE trash SET deleted_at = deleted_at - 60", []).unwrap(); // (one after the other)
    }
    let kept = trash(&app, &t).await;
    assert_eq!(kept.iter().map(|k| k["target"].as_str().unwrap()).collect::<Vec<_>>(), ["bb"], "the oldest went");
}

/// Deleting the account removes its trash at once, as it promises.
#[tokio::test]
async fn deleting_the_account_empties_its_trash() {
    let (st, app) = state_and_app(1 << 20);
    let (u, t) = signed_in(&app).await;
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"text"))).await;
    delete_doc(&app, &u, &t, "aa").await;
    let n = challenge(&app, &u.sk).await;
    let sig = u.sk.sign(&sig::delete_account_msg(ACCT, &n));
    let (s, _) = call(&app, "POST", "/api/account/delete", Some(&t), Some(json!({ "nonce": b64(&n), "sig": b64(&sig.to_bytes()) }))).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let rows: i64 = st.db().query_row("SELECT COUNT(*) FROM trash", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}
