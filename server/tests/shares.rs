//! Shared notes: /api/shares (#70, phase 2a).
mod common;
use common::*;

use plim_core::crypto::{ShareKeys, share_keys};

const SHARE: &str = "00112233445566778899aabbccddeeff";
const DOC: &str = "aaaa1111-2222-3333-4444-555566667777";

/// A share's keys from a fixed seed, and helpers to sign its blobs.
struct Share {
    id: String,
    keys: ShareKeys,
}

impl Share {
    fn new(id: &str, seed: u8) -> Self {
        Share { id: id.into(), keys: share_keys(&[seed; 32]) }
    }
    fn token(&self) -> String {
        hex::encode(self.keys.read_token)
    }
    fn blob(&self, kind: &str, covers: u64, ct: &[u8]) -> Value {
        let nonce = [3u8; 12];
        let sig = self.keys.signing.sign(&sig::share_blob_msg(&self.id, kind, covers, &nonce, ct));
        json!({ "covers_seq": covers, "nonce": b64(&nonce), "ciphertext": b64(ct), "sig": b64(&sig.to_bytes()) })
    }
    fn create_body(&self, ct: &[u8]) -> Value {
        json!({
            "share_id": self.id,
            "pubkey": b64(&self.keys.pubkey),
            "read_hash": b64(&sig::sha256(&self.keys.read_token)),
            "update": self.blob("update", 0, ct),
        })
    }
}

/// GET with the read token in X-Share-Token.
async fn get_with_token(app: &Router, path: &str, token: &str) -> (StatusCode, Value) {
    let req = Request::builder().uri(path).header("x-share-token", token).body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
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
async fn share_read_and_write_with_the_links_keys() {
    let app = test_app(1 << 20, false);
    let (_, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);

    // Only an account can share.
    let (st, _) = call(&app, "POST", "/api/shares", None, Some(s.create_body(b"hello"))).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, v) = call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, _) = call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;
    assert_eq!(st, StatusCode::CONFLICT);

    // Reading needs the read token; a wrong one looks like no share at all.
    let (st, v) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_eq!((st, v["status"].as_str()), (StatusCode::OK, Some("ok")));
    assert_eq!(v["max_blob_bytes"], 1024 * 1024, "guests have no account to learn the limit from");
    let (st, _) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &"00".repeat(32)).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = call(&app, "GET", &format!("/api/shares/{SHARE}/doc?after=0"), None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, v) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=0"), &s.token()).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["updates"][0]["seq"], 1);
    assert_eq!(v["updates"][0]["ciphertext"], b64(b"hello"));
    assert_eq!(v["updates"][0]["sig"], s.blob("update", 0, b"hello")["sig"], "with its signature, for clients to check (#77)");

    // Anyone with the signing key writes, without a session (a guest with an edit link)...
    let (st, v) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 0, b"guest edit"))).await;
    assert_eq!((st, v["seq"].as_i64()), (StatusCode::OK, Some(2)), "{v}");
    // ...and nobody else: another share's key, or a signature for another kind, is refused.
    let other = Share::new(SHARE, 10);
    let (st, _) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(other.blob("update", 0, b"junk"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("snapshot", 0, b"junk"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // Clients check an update's signature with covers_seq 0 (it isn't stored), so it must be signed that way.
    let (st, _) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 3, b"junk"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = call(&app, "POST", "/api/shares/ffffffffffffffffffffffffffffffff/updates", None, Some(s.blob("update", 0, b"x"))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (_, v) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=1"), &s.token()).await;
    assert_eq!(v["updates"].as_array().unwrap().len(), 1);
    assert_eq!(v["head"], 2);
}

#[tokio::test]
async fn storage_counts_against_the_owner() {
    let app = test_app(1 << 20, true);
    let (_, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(&[1; 100]))).await;
    assert_eq!(used(&app, &t).await, 100);
    call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 0, &[2; 50]))).await;
    assert_eq!(used(&app, &t).await, 150, "a guest's edit counts against the owner");

    // A snapshot replaces the updates it covers (pruning on).
    let (st, v) = call(&app, "POST", &format!("/api/shares/{SHARE}/snapshots"), None, Some(s.blob("snapshot", 2, &[3; 60]))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(used(&app, &t).await, 60);
    let (_, v) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=0"), &s.token()).await;
    assert_eq!(v["snapshot"]["sig"], s.blob("snapshot", 2, &[3; 60])["sig"]);
    let (st, _) = call(&app, "POST", &format!("/api/shares/{SHARE}/snapshots"), None, Some(s.blob("snapshot", 5, &[3; 60]))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "can't cover what the server doesn't have");

    // Full: the guest's edit is refused with 507.
    let small = test_app(120, false);
    let (_, t2) = owner(&small).await;
    call(&small, "POST", "/api/shares", Some(&t2), Some(s.create_body(&[1; 100]))).await;
    let (st, _) = call(&small, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 0, &[2; 50]))).await;
    assert_eq!(st, StatusCode::INSUFFICIENT_STORAGE);
}

/// #516: someone who can read the note gets editors' signed blobs; posting one again is answered
/// with the one stored, and nothing is added (it would fill the note and push its history out).
#[tokio::test]
async fn an_edit_or_version_posted_again_is_the_one_stored() {
    let app = test_app(1 << 20, false);
    let (_, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(&[1; 100]))).await;
    let update = s.blob("update", 0, &[2; 50]);
    let (_, first) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(update.clone())).await;
    for _ in 0..3 {
        let (st, again) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(update.clone())).await;
        assert_eq!((st, &again["seq"]), (StatusCode::OK, &first["seq"]), "the same seq: a retry hears it went through");
    }
    assert_eq!(used(&app, &t).await, 150, "stored once");
    let (_, v) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=0"), &s.token()).await;
    assert_eq!(v["updates"].as_array().unwrap().len(), 2, "the note's first update and this one");
    // Another blob under the same nonce (a client's bug, or this test's fixed nonce): its own.
    let (_, other) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 0, &[4; 50]))).await;
    assert_ne!(other["seq"], first["seq"]);

    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 60;
    let version = s.blob("version", at, b"as it was");
    let path = format!("/api/shares/{SHARE}/versions");
    let (st, first) = call(&app, "POST", &path, None, Some(version.clone())).await;
    assert_eq!(st, StatusCode::CREATED);
    let (st, again) = call(&app, "POST", &path, None, Some(version)).await;
    assert_eq!((st, &again["id"]), (StatusCode::OK, &first["id"]));
    let (_, v) = get_with_token(&app, &path, &s.token()).await;
    assert_eq!(v["versions"].as_array().unwrap().len(), 1, "kept once");
}

#[tokio::test]
async fn one_shared_note_takes_at_most_a_quarter_of_the_owners_quota() {
    let app = test_app(1000, true);
    let (_, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    let updates = format!("/api/shares/{SHARE}/updates");
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(&[1; 100]))).await;
    let (st, _) = call(&app, "POST", &updates, None, Some(s.blob("update", 0, &[2; 100]))).await;
    assert_eq!(st, StatusCode::OK);
    // 300 bytes would pass the owner's quota (1000), not the share's cap (250).
    let (st, v) = call(&app, "POST", &updates, None, Some(s.blob("update", 0, &[6; 100]))).await;
    assert_eq!((st, v["error"].as_str()), (StatusCode::INSUFFICIENT_STORAGE, Some("this shared note is full")), "{v}");
    assert_eq!(used(&app, &t).await, 200);

    // Compacting a full note still works (it shrinks), and makes room again.
    let (st, v) = call(&app, "POST", &format!("/api/shares/{SHARE}/snapshots"), None, Some(s.blob("snapshot", 2, &[3; 60]))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (st, _) = call(&app, "POST", &updates, None, Some(s.blob("update", 0, &[7; 100]))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(used(&app, &t).await, 160);
}

#[tokio::test]
async fn a_full_shared_note_makes_room_from_its_oldest_versions_before_refusing_an_edit() {
    let app = test_app(1000, true);
    let (_, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(&[1; 100]))).await;
    let versions = format!("/api/shares/{SHARE}/versions");
    for (at, b) in [(now - 86400, 4u8), (now - 60, 5u8)] {
        let (st, v) = call_with(&app, "POST", &versions, None, Some(s.blob("version", at, &[b; 40])), &[("x-share-token", s.token())]).await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
    }
    assert_eq!(used(&app, &t).await, 180);
    // 280 would pass the cap (250): the oldest version goes, the edit is kept.
    let (st, v) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 0, &[2; 100]))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(used(&app, &t).await, 240);
    let (_, l) = call_with(&app, "GET", &versions, None, None, &[("x-share-token", s.token())]).await;
    let left: Vec<u64> = l["versions"].as_array().unwrap().iter().map(|v| v["created_at"].as_u64().unwrap()).collect();
    assert_eq!(left, vec![now - 60], "the newer stays");
}

/// An edit link can fill its note's quarter, never make room in the owner's private notes' history:
/// when the owner's account is full, the guest's edit is refused and the owner's versions stay.
#[tokio::test]
async fn a_guests_edit_never_deletes_the_owners_private_history_to_fit() {
    let app = test_app(1000, true);
    let (u, t) = owner(&app).await;
    let versions = format!("/api/docs/{DOC}/versions");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    for (i, at) in [now - 86400, now - 60].into_iter().enumerate() {
        let (st, v) = call(&app, "POST", &versions, Some(&t), Some(u.blob(DOC, "version", 1, at, &[i as u8; 400]))).await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
    }
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(&[1; 100]))).await;
    assert_eq!(used(&app, &t).await, 900);
    // 150 more fits the share's quarter (250), not the owner's quota (1000): refused, nothing deleted.
    // (The snapshot replaces the 100-byte update it covers, so it's 250 to grow by 150.)
    for (kind, covers, body) in [("update", 0, vec![2u8; 150]), ("snapshot", 1, vec![3u8; 250]), ("version", now, vec![4u8; 150])] {
        let (st, v) = call_with(&app, "POST", &format!("/api/shares/{SHARE}/{kind}s"), None, Some(s.blob(kind, covers, &body)), &[("x-share-token", s.token())]).await;
        assert_eq!((st, v["error"].as_str()), (StatusCode::INSUFFICIENT_STORAGE, Some("storage full")), "{kind}: {v}");
    }
    assert_eq!(used(&app, &t).await, 900);
    assert_eq!(call(&app, "GET", &versions, Some(&t), None).await.1["versions"].as_array().unwrap().len(), 2, "the owner's history is whole");
    // The owner's own edit still makes room, as before.
    let (st, _) = call(&app, "POST", &versions, Some(&t), Some(u.blob(DOC, "version", 1, now, &[5; 150]))).await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(call(&app, "GET", &versions, Some(&t), None).await.1["versions"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_shared_notes_history_is_forgotten_by_its_owner_not_by_its_link() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(&[1; 10]))).await;
    let versions = format!("/api/shares/{SHARE}/versions");
    for at in [now - 86400, now - 60] {
        assert_eq!(call_with(&app, "POST", &versions, None, Some(s.blob("version", at, &[4; 20])), &[("x-share-token", s.token())]).await.0, StatusCode::CREATED);
    }
    let before = now + 10;
    let forget = format!("{versions}?before={before}");
    // With the link alone: no.
    assert_eq!(call_with(&app, "DELETE", &forget, None, None, &[("x-share-token", s.token())]).await.0, StatusCode::UNAUTHORIZED);
    // Its owner, signed: all of it before then.
    check_needs_signature(&app, &u, &t, "DELETE", &forget, sig::action::FORGET_HISTORY, SHARE, before.to_string().as_bytes(), None, StatusCode::OK).await;
    let (_, l) = call_with(&app, "GET", &versions, None, None, &[("x-share-token", s.token())]).await;
    assert!(l["versions"].as_array().unwrap().is_empty());
    assert_eq!(used(&app, &t).await, 10);
}

#[tokio::test]
async fn reads_are_rate_limited_so_tokens_cant_be_guessed_quickly() {
    let app = test_app(1 << 20, false);
    let (_, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;
    let wrong = "00".repeat(32);
    for i in 0..600 {
        let path = if i % 2 == 0 { format!("/api/shares/{SHARE}") } else { format!("/api/shares/{SHARE}/doc?after=0") };
        let (st, _) = get_with_token(&app, &path, &wrong).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
    }
    // Then even the right token waits for the next minute.
    let (st, _) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
}

/// A shared note deleted for good is kept for 30 days (#253): its links stop working at once,
/// and restored (signed by its owner), they work again, with its text and History.
#[tokio::test]
async fn a_deleted_share_is_kept_and_comes_back() {
    let app = test_app(1 << 20, false);
    let (u, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 86400 * 2;
    call(&app, "POST", &format!("/api/shares/{SHARE}/versions"), None, Some(s.blob("version", at, b"as it was"))).await;
    let (_, before) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=0"), &s.token()).await;
    let size = used(&app, &t).await;

    share_action(&app, &u, &t, SHARE, "delete").await;
    let (st, _) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(used(&app, &t).await, 0);
    let (_, kept) = call(&app, "GET", "/api/trash", Some(&t), None).await;
    assert_eq!(kept["trash"][0]["kind"], "share");

    let path = format!("/api/trash/share/{SHARE}/restore");
    check_needs_signature(&app, &u, &t, "POST", &path, sig::action::RESTORE_SHARE, SHARE, &[], None, StatusCode::NO_CONTENT).await;
    let (_, after) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=0"), &s.token()).await;
    assert_eq!(after, before, "its links work again, its text as it was");
    let (_, versions) = get_with_token(&app, &format!("/api/shares/{SHARE}/versions"), &s.token()).await;
    assert_eq!(versions["versions"].as_array().unwrap().len(), 1);
    assert_eq!(used(&app, &t).await, size);
    // Only its owner's: someone else, signing for it, finds nothing.
    let stranger = User::new(3, "fedcba9876543210fedcba9876543210");
    signup(&app, &stranger).await;
    let ts = login(&app, &stranger.sk).await.unwrap();
    let (st, _) = signed(&app, &stranger.sk, &stranger.account_id, &ts, "POST", &path, sig::action::RESTORE_SHARE, SHARE, &[], None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

/// Turning a share's links off and deleting it need the owner key's signature, for that
/// action on that share, over a fresh challenge: a stolen session can't (#144).
#[tokio::test]
async fn revoking_and_deleting_a_share_need_the_owners_signature() {
    let app = test_app(1 << 20, false);
    let (u, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;
    let ok = StatusCode::NO_CONTENT;
    let (refused, _) = call(&app, "POST", &format!("/api/shares/{SHARE}/revoke"), Some(&t), None).await;
    assert_eq!(refused, StatusCode::FORBIDDEN);
    let (_, v) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_ne!(v["status"], "revoked", "a refused revoke leaves the links working");
    check_needs_signature(&app, &u, &t, "POST", &format!("/api/shares/{SHARE}/revoke"), sig::action::REVOKE_SHARE, SHARE, &[], None, ok).await;
    check_needs_signature(&app, &u, &t, "DELETE", &format!("/api/shares/{SHARE}"), sig::action::DELETE_SHARE, SHARE, &[], None, ok).await;
}

#[tokio::test]
async fn revoke_and_delete_are_the_owners() {
    let app = test_app(1 << 20, false);
    let (u, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;

    // Someone else, signing with their own key: not theirs.
    let stranger = User::new(3, "fedcba9876543210fedcba9876543210");
    signup(&app, &stranger).await;
    let ts = login(&app, &stranger.sk).await.unwrap();
    let (st, _) = share_action(&app, &stranger, &ts, SHARE, "revoke").await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = share_action(&app, &stranger, &ts, SHARE, "delete").await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = share_action(&app, &u, &t, SHARE, "revoke").await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, v) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_eq!(v["status"], "revoked", "the link can say why it stopped working");
    let (st, _) = get_with_token(&app, &format!("/api/shares/{SHARE}/doc?after=0"), &s.token()).await;
    assert_eq!(st, StatusCode::GONE);
    let (st, _) = call(&app, "POST", &format!("/api/shares/{SHARE}/updates"), None, Some(s.blob("update", 0, b"late"))).await;
    assert_eq!(st, StatusCode::GONE);

    let (st, _) = share_action(&app, &u, &t, SHARE, "delete").await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, _) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(used(&app, &t).await, 0);
}

#[tokio::test]
async fn the_link_page_has_its_own_style_nonce_and_says_nothing_about_the_note() {
    let app = test_app(1 << 20, false);
    let (st, headers, body) = get_with_host(&app, &format!("/s/{SHARE}"), Some("localhost")).await;
    assert_eq!(st, StatusCode::OK);
    let html = String::from_utf8(body).unwrap();
    let csp = headers.get("content-security-policy").unwrap().to_str().unwrap();
    let nonce = csp.split("'nonce-").nth(1).unwrap().split('\'').next().unwrap();
    assert!(html.contains(&format!(r#"<meta name="style-nonce" content="{nonce}" />"#)));
    assert!(html.contains("/v/") && html.contains("guest.js"), "versioned assets");
    assert!(!html.contains("og:"), "no link preview for a shared note");
    assert!(html.contains(r#"name="referrer" content="no-referrer""#));
    let (st, _, _) = get_with_host(&app, "/s/not-a-share-id", Some("localhost")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_shared_notes_versions_need_its_keys_count_for_the_owner_and_go_with_it() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"hello"))).await;
    let path = format!("/api/shares/{SHARE}/versions");
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 86400 * 2;

    // Saved with the edit link's key (no session), as a version with its time.
    let (st, v) = call(&app, "POST", &path, None, Some(s.blob("version", at, b"as it was"))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, _) = call(&app, "POST", &path, None, Some(Share::new(SHARE, 10).blob("version", at, b"x"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "another key");
    let (st, _) = call(&app, "POST", &path, None, Some(s.blob("update", at, b"x"))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "an update's signature");
    assert_eq!(used(&app, &t).await, 5 + 9, "the owner's storage");

    // Read with the read token only, each with its signature.
    let (st, _) = call(&app, "GET", &path, None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, list) = get_with_token(&app, &path, &s.token()).await;
    assert_eq!(st, StatusCode::OK);
    let id = list["versions"][0]["id"].as_i64().unwrap();
    let (_, one) = get_with_token(&app, &format!("{path}/{id}"), &s.token()).await;
    assert_eq!((one["created_at"].as_u64(), one["ciphertext"].as_str()), (Some(at), Some(b64(b"as it was").as_str())));
    assert_eq!(one["sig"], s.blob("version", at, b"as it was")["sig"]);
    let (_, v) = get_with_token(&app, &format!("/api/shares/{SHARE}"), &s.token()).await;
    assert_eq!(v["version_every_secs"], 3600);

    // Turned off: no more; deleted: gone, storage freed.
    share_action(&app, &u, &t, SHARE, "revoke").await;
    let (st, _) = call(&app, "POST", &path, None, Some(s.blob("version", at + 60, b"late"))).await;
    assert_eq!(st, StatusCode::GONE);
    let (st, _) = get_with_token(&app, &path, &s.token()).await;
    assert_eq!(st, StatusCode::GONE);
    share_action(&app, &u, &t, SHARE, "delete").await;
    assert_eq!(used(&app, &t).await, 0);
}

#[tokio::test]
async fn deleting_the_owners_account_turns_its_shared_notes_off() {
    let app = test_app(1 << 20, true);
    let (u, t) = owner(&app).await;
    let s = Share::new(SHARE, 9);
    let (st, _) = call(&app, "POST", "/api/shares", Some(&t), Some(s.create_body(b"shared text"))).await;
    assert!(st.is_success());
    let path = format!("/api/shares/{SHARE}");
    assert_eq!(get_with_token(&app, &path, &s.token()).await.0, StatusCode::OK);
    let hash = sig::pubkey_hash(&u.pubkey());
    let nonce = call(&app, "POST", "/api/auth/challenge", None, Some(json!({ "pubkey_hash": hash }))).await.1["nonce"].clone();
    let n = B64.decode(nonce.as_str().unwrap()).unwrap();
    let body = json!({ "nonce": nonce, "sig": b64(&u.sk.sign(&sig::delete_account_msg(ACCT, &n)).to_bytes()) });
    assert_eq!(call(&app, "POST", "/api/account/delete", Some(&t), Some(body)).await.0, StatusCode::NO_CONTENT);
    // The link no longer opens anything, and nobody can write to it.
    let (st, _) = get_with_token(&app, &path, &s.token()).await;
    assert!(st == StatusCode::NOT_FOUND || st == StatusCode::GONE, "{st}");
    let (st, _) = call(&app, "POST", &format!("{path}/updates"), None, Some(s.blob("update", 0, b"x"))).await;
    assert!(st.is_client_error(), "{st}");
}
