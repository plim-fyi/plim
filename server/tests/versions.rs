//! A note's history: /api/docs/{id}/versions (#60).
mod common;
use common::*;

const DOC: &str = "aaaa1111-2222-3333-4444-555566667777";

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

async fn owner(app: &Router) -> (User, String) {
    let u = User::new(1, ACCT);
    signup(app, &u).await;
    let t = login(app, &u.sk).await.unwrap();
    (u, t)
}

async fn used(app: &Router, t: &str) -> i64 {
    call(app, "GET", "/api/account", Some(t), None).await.1["used_bytes"].as_i64().unwrap()
}

#[tokio::test]
async fn versions_are_saved_listed_and_read_by_their_account_only() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let path = format!("/api/docs/{DOC}/versions");
    let (_, v) = call(&app, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["version_every_secs"], 3600, "clients learn how often to save one");

    let at = now() - 3 * 86400; // three days ago: kept (one a day)
    let (st, v) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, at, b"older text"))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, now(), b"newer text"))).await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(used(&app, &t).await, 20, "they count against the quota");
    assert_eq!(call(&app, "GET", "/api/account", Some(&t), None).await.1["history_bytes"], 20, "and say how much of it is history");

    let (_, list) = call(&app, "GET", &path, Some(&t), None).await;
    let list = list["versions"].as_array().unwrap().clone();
    assert_eq!(list.len(), 2);
    assert!(list[0]["created_at"].as_u64() > list[1]["created_at"].as_u64(), "newest first");
    let (st, one) = call(&app, "GET", &format!("{path}/{}", list[1]["id"]), Some(&t), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!((one["ciphertext"].as_str(), one["created_at"].as_u64()), (Some(b64(b"older text").as_str()), Some(at)));

    // Another account sees nothing, and can't read one by its id.
    let other = User::new(2, "fedcba9876543210fedcba9876543210");
    signup(&app, &other).await;
    let t2 = login(&app, &other.sk).await.unwrap();
    let (_, list2) = call(&app, "GET", &path, Some(&t2), None).await;
    assert!(list2["versions"].as_array().unwrap().is_empty());
    let (st, _) = call(&app, "GET", &format!("{path}/{}", list[0]["id"]), Some(&t2), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = call(&app, "GET", &path, None, None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_version_must_be_signed_as_one_and_not_from_the_future() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let path = format!("/api/docs/{DOC}/versions");
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "update", 1, now(), b"x"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "an update's signature isn't a version's");
    let mut forged = u.blob(DOC, "version", 1, now() - 100, b"x");
    forged["covers_seq"] = json!(now() - 5000); // the time is in the signature
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(forged)).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, now() + 3600, b"x"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "from the future");
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 9, now(), b"x"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "an unknown key version");
}

#[tokio::test]
async fn every_version_is_kept_and_the_oldest_make_room_when_the_account_is_full() {
    let app = test_app(100, true);
    let (u, t) = owner(&app).await;
    let path = format!("/api/docs/{DOC}/versions");
    // However close together, and however old: all kept.
    let minute = (now() - 300) / 60 * 60;
    for (i, at) in [now() - 400 * 86400, minute + 1, minute + 2].into_iter().enumerate() {
        let (st, v) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, at, format!("v{i}{}", ".".repeat(28)).as_bytes()))).await;
        assert_eq!((st, v["kept"].as_bool()), (StatusCode::CREATED, Some(true)), "{v}");
    }
    assert_eq!(call(&app, "GET", &path, Some(&t), None).await.1["versions"].as_array().unwrap().len(), 3);
    assert_eq!(used(&app, &t).await, 90);
    // Full: the next one makes room by deleting the oldest, not by being refused.
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, now(), format!("v3{}", ".".repeat(28)).as_bytes()))).await;
    assert_eq!(st, StatusCode::CREATED);
    let (_, l) = call(&app, "GET", &path, Some(&t), None).await;
    let times: Vec<u64> = l["versions"].as_array().unwrap().iter().map(|v| v["created_at"].as_u64().unwrap()).collect();
    assert_eq!(times.len(), 3);
    assert!(times.iter().all(|&at| at > now() - 86400), "the year-old one went first: {times:?}");
    assert_eq!(used(&app, &t).await, 90);
    // More than all of history could free: refused, and none of it deleted.
    let (st, _) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, now(), &[b'x'; 200]))).await;
    assert_eq!(st, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(used(&app, &t).await, 90, "history kept when it couldn't have made room anyway");
}

#[tokio::test]
async fn re_encrypting_keeps_a_versions_time_and_deleting_the_note_removes_them() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let path = format!("/api/docs/{DOC}/versions");
    let at = now() - 2 * 86400;
    let (_, v) = call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, at, b"text"))).await;
    let id = v["id"].as_i64().unwrap();
    let (st, _) = call(&app, "PUT", &format!("{path}/{id}"), Some(&t), Some(u.blob(DOC, "version", 1, at + 1, b"other"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "a version keeps its time");
    let (st, _) = call(&app, "PUT", &format!("{path}/{id}"), Some(&t), Some(u.blob(DOC, "version", 1, at, b"re-encrypted"))).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, one) = call(&app, "GET", &format!("{path}/{id}"), Some(&t), None).await;
    assert_eq!(one["ciphertext"], b64(b"re-encrypted"));

    let (st, _) = signed(&app, &u.sk, &u.account_id, &t, "DELETE", &format!("/api/docs/{DOC}"), sig::action::DELETE_DOC, DOC, &[], None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, list) = call(&app, "GET", &path, Some(&t), None).await;
    assert!(list["versions"].as_array().unwrap().is_empty(), "deleting a note for good deletes its history");
    assert_eq!(used(&app, &t).await, 0);
}

#[tokio::test]
async fn a_notes_history_before_a_time_is_forgotten_signed_by_its_owner_only() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let path = format!("/api/docs/{DOC}/versions");
    let (old, mid) = (now() - 3 * 86400, now() - 86400);
    for (at, text) in [(old, b"oldest".as_slice()), (mid, b"middle"), (now(), b"newest")] {
        assert_eq!(call(&app, "POST", &path, Some(&t), Some(u.blob(DOC, "version", 1, at, text))).await.0, StatusCode::CREATED);
    }
    assert_eq!(used(&app, &t).await, 18);
    // Before the middle one: the oldest goes, signed over the note and the time (#144).
    let forget = format!("{path}?before={mid}");
    check_needs_signature(&app, &u, &t, "DELETE", &forget, sig::action::FORGET_HISTORY, DOC, mid.to_string().as_bytes(), None, StatusCode::OK).await;
    let (_, l) = call(&app, "GET", &path, Some(&t), None).await;
    let times: Vec<u64> = l["versions"].as_array().unwrap().iter().map(|v| v["created_at"].as_u64().unwrap()).collect();
    assert_eq!(times.len(), 2);
    assert!(!times.contains(&old));
    assert_eq!(used(&app, &t).await, 12, "its room freed");
    // Another account's signature on it changes nothing of this one's.
    let other = User::new(2, "fedcba9876543210fedcba9876543210");
    signup(&app, &other).await;
    let t2 = login(&app, &other.sk).await.unwrap();
    let n = challenge(&app, &other.sk).await;
    let all = format!("{path}?before={}", now() + 10);
    let (st, v) = call_with(&app, "DELETE", &all, Some(&t2), None, &action_headers(&other.sk, &other.account_id, sig::action::FORGET_HISTORY, DOC, &n, (now() + 10).to_string().as_bytes())).await;
    assert_eq!((st, v["deleted"].as_u64()), (StatusCode::OK, Some(0)), "its own (none), not this account's");
    assert_eq!(call(&app, "GET", &path, Some(&t), None).await.1["versions"].as_array().unwrap().len(), 2);
}
