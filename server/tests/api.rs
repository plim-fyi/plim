mod common;
use common::*;

#[tokio::test]
async fn signup_requires_valid_single_use_pow() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    let (_, pow) = call(&app, "POST", "/api/pow", None, Some(json!({}))).await;
    let salt = B64.decode(pow["salt"].as_str().unwrap()).unwrap();
    let good = solve(&salt, 8);
    let bad = (0..).find(|&n| !pow::check(&salt, n, 8)).unwrap();
    let body = |n: u64| json!({ "account_id": ACCT, "pubkey": b64(&u.pubkey()), "keyring_entry": u.keyring_entry(1),
                                "pow_salt": pow["salt"], "pow_nonce": n });

    let (s, _) = call(&app, "POST", "/api/accounts", None, Some(body(bad))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // The failed attempt consumed the challenge, so even a correct answer is refused now.
    let (s, _) = call(&app, "POST", "/api/accounts", None, Some(body(good))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    assert_eq!(signup(&app, &u).await, StatusCode::CREATED);
    assert_eq!(signup(&app, &u).await, StatusCode::CONFLICT);
}

#[tokio::test]
async fn auth_signature_is_domain_separated() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let hash = sig::pubkey_hash(&u.pubkey());
    let (_, ch) = call(&app, "POST", "/api/auth/challenge", None, Some(json!({ "pubkey_hash": hash }))).await;
    let nonce = B64.decode(ch["nonce"].as_str().unwrap()).unwrap();
    // Sign the same fields under the blob tag: must be rejected.
    let wrong = u.sk.sign(&sig::encode(sig::TAG_BLOB, &[sig::Field::Bytes(&nonce), sig::Field::Str(&hash)]));
    let (s, _) = call(&app, "POST", "/api/auth/verify", None, Some(json!({
        "pubkey_hash": hash, "nonce": ch["nonce"], "sig": b64(&wrong.to_bytes()) }))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(login(&app, &u.sk).await.is_ok());
    // Unauthenticated access is refused.
    let (s, _) = call(&app, "GET", "/api/docs", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn updates_snapshots_and_tamper_rejection() {
    let app = test_app(1 << 20, true);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();

    for i in 1..=3u8 {
        let (s, v) = call(&app, "POST", "/api/docs/index/updates", Some(&t), Some(u.blob("index", "update", 1, 0, &[i; 20]))).await;
        assert_eq!((s, v["seq"].as_i64()), (StatusCode::OK, Some(i as i64)));
    }
    let mut tampered = u.blob("index", "update", 1, 0, b"abc");
    tampered["ciphertext"] = json!(b64(b"abd"));
    let (s, _) = call(&app, "POST", "/api/docs/index/updates", Some(&t), Some(tampered)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // A blob signed for one doc cannot be posted to another.
    let (s, _) = call(&app, "POST", "/api/docs/other/updates", Some(&t), Some(u.blob("index", "update", 1, 0, b"x"))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // Unknown key version.
    let (s, _) = call(&app, "POST", "/api/docs/index/updates", Some(&t), Some(u.blob("index", "update", 7, 0, b"x"))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Snapshot can't claim to cover more than exists.
    let (s, _) = call(&app, "POST", "/api/docs/index/snapshots", Some(&t), Some(u.blob("index", "snapshot", 1, 9, b"s"))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = call(&app, "POST", "/api/docs/index/snapshots", Some(&t), Some(u.blob("index", "snapshot", 1, 2, b"snap"))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = call(&app, "POST", "/api/docs/index/snapshots", Some(&t), Some(u.blob("index", "snapshot", 1, 1, b"old"))).await;
    assert_eq!(s, StatusCode::CONFLICT);

    let (_, v) = call(&app, "GET", "/api/docs/index?after=0", Some(&t), None).await;
    assert_eq!(v["snapshot"]["covers_seq"], 2);
    assert_eq!(v["updates"].as_array().unwrap().len(), 1);
    assert_eq!(v["head"], 3);
    // Client already past the snapshot only gets newer updates.
    let (_, v) = call(&app, "GET", "/api/docs/index?after=2", Some(&t), None).await;
    assert!(v["snapshot"].is_null());
    assert_eq!(v["updates"][0]["seq"], 3);
    // Seq continues after pruning.
    let (_, v) = call(&app, "POST", "/api/docs/index/updates", Some(&t), Some(u.blob("index", "update", 1, 0, b"4"))).await;
    assert_eq!(v["seq"], 4);
    // Pruned 2 updates (40 bytes) and kept a 4-byte snapshot + 2 updates (20 + 1 bytes).
    let (_, v) = call(&app, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["used_bytes"], 25);
}

#[tokio::test]
async fn quota_returns_507() {
    let app = test_app(100, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let (s, _) = call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &[0; 80]))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, v) = call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &[0; 30]))).await;
    assert_eq!(s, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(v["error"], "storage full");
    // Compacting into a smaller snapshot is allowed even when full.
    let (s, v) = call(&app, "POST", "/api/docs/aa/snapshots", Some(&t), Some(u.blob("aa", "snapshot", 1, 1, &[0; 10]))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
}

#[tokio::test]
async fn rotate_swaps_key_and_revokes_sessions() {
    let app = test_app(1 << 20, false);
    let old = User::new(1, ACCT);
    signup(&app, &old).await;
    let t = login(&app, &old.sk).await.unwrap();
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(old.blob("aa", "update", 1, 0, b"v1"))).await;
    let (s, _) = call(&app, "POST", "/api/keyring", Some(&t), Some(old.keyring_entry(2))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = call(&app, "POST", "/api/keyring", Some(&t), Some(old.keyring_entry(5))).await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, v) = call(&app, "POST", "/api/docs/aa/snapshots", Some(&t), Some(old.blob("aa", "snapshot", 2, 1, b"v2snap"))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    // History: one version re-encrypted under the new key (stays), one left under the old (goes).
    let day = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 2 * 86400;
    for (key, at, ct) in [(2, day, &b"kept"[..]), (1, day - 86400, &b"old key"[..])] {
        let (s, _) = call(&app, "POST", "/api/docs/aa/versions", Some(&t), Some(old.blob("aa", "version", key, at, ct))).await;
        assert_eq!(s, StatusCode::CREATED);
    }

    let new = User::new(2, ACCT);
    let np = new.pubkey();
    let old_sig = old.sk.sign(&sig::rotate_msg(TAG_ROTATE_OLD, ACCT, &np));
    let new_sig = new.sk.sign(&sig::rotate_msg(TAG_ROTATE_NEW, ACCT, &np));
    let body = |keyring: Value, old_sig: &[u8]| json!({ "new_pubkey": b64(&np), "keyring": keyring,
        "old_sig": b64(old_sig), "new_sig": b64(&new_sig.to_bytes()), "prune": true });

    // Missing a key version → rejected.
    let (s, _) = call(&app, "POST", "/api/account/rotate", Some(&t), Some(body(json!([new.keyring_entry(2)]), &old_sig.to_bytes()))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    // New key signing its own authorization instead of the old key → rejected.
    let forged = new.sk.sign(&sig::rotate_msg(TAG_ROTATE_OLD, ACCT, &np));
    let full = json!([new.keyring_entry(1), new.keyring_entry(2)]);
    let (s, _) = call(&app, "POST", "/api/account/rotate", Some(&t), Some(body(full.clone(), &forged.to_bytes()))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _) = call(&app, "POST", "/api/account/rotate", Some(&t), Some(body(full, &old_sig.to_bytes()))).await;
    assert_eq!(s, StatusCode::OK);

    // Old session revoked, old key can't log in, new key can and sees pruned data.
    let (s, _) = call(&app, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&app, &old.sk).await, Err(StatusCode::UNAUTHORIZED));
    let t2 = login(&app, &new.sk).await.unwrap();
    let (_, v) = call(&app, "GET", "/api/docs/aa?after=0", Some(&t2), None).await;
    assert_eq!(v["snapshot"]["key_version"], 2);
    assert_eq!(v["updates"].as_array().unwrap().len(), 0);
    let (_, v) = call(&app, "GET", "/api/docs/aa/versions", Some(&t2), None).await;
    assert_eq!(v["versions"].as_array().unwrap().len(), 1, "versions under the old key are pruned too");
    let (_, v) = call(&app, "GET", "/api/account", Some(&t2), None).await;
    assert_eq!(v["used_bytes"], 6 + 4);
}

#[tokio::test]
async fn deleting_a_doc_removes_its_data_and_frees_quota() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &[1; 100]))).await;
    call(&app, "POST", "/api/docs/aa/snapshots", Some(&t), Some(u.blob("aa", "snapshot", 1, 1, &[2; 50]))).await;
    call(&app, "POST", "/api/docs/bb/updates", Some(&t), Some(u.blob("bb", "update", 1, 0, &[3; 30]))).await;
    let (_, v) = call(&app, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["used_bytes"], 180);

    let (s, _) = call(&app, "DELETE", "/api/docs/aa", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = delete_doc(&app, &u, &t, "index").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = delete_doc(&app, &u, &t, "aa").await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    let (_, v) = call(&app, "GET", "/api/docs/aa?after=0", Some(&t), None).await;
    assert!(v["snapshot"].is_null());
    assert_eq!(v["updates"].as_array().unwrap().len(), 0);
    let (_, v) = call(&app, "GET", "/api/docs", Some(&t), None).await;
    assert_eq!(v["docs"], json!(["bb"]));
    let (_, v) = call(&app, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["used_bytes"], 30);
    // Deleting again (another device emptying the same trash) is fine.
    let (s, _) = delete_doc(&app, &u, &t, "aa").await;
    assert_eq!(s, StatusCode::NO_CONTENT);
}

/// DELETE /api/docs/{doc}, signed as the clients sign it (#144).
async fn delete_doc(app: &Router, u: &User, t: &str, doc: &str) -> (StatusCode, Value) {
    signed(app, &u.sk, &u.account_id, t, "DELETE", &format!("/api/docs/{doc}"), sig::action::DELETE_DOC, doc, &[], None).await
}

/// POST /api/docs/{doc}/close or /reopen (`what`), signed (#144).
async fn doc_action(app: &Router, u: &User, t: &str, doc: &str, what: &str) -> (StatusCode, Value) {
    let action = if what == "close" { sig::action::CLOSE_DOC } else { sig::action::REOPEN_DOC };
    signed(app, &u.sk, &u.account_id, t, "POST", &format!("/api/docs/{doc}/{what}"), action, doc, &[], None).await
}

fn passkey_entry(hash: &str) -> Value {
    json!({ "cred_hash": hash, "nonce": b64(&[1u8; 12]), "ciphertext": b64(&[2u8; 32]) })
}

/// POST /api/passkeys, signed over the copy as the web client signs it (#144).
async fn put_passkey(app: &Router, u: &User, t: &str, entry: Value) -> (StatusCode, Value) {
    let hash = entry["cred_hash"].as_str().unwrap().to_string();
    signed(app, &u.sk, &u.account_id, t, "POST", "/api/passkeys", sig::action::PUT_PASSKEY, &hash, &passkey_copy(&entry), Some(entry)).await
}

/// DELETE /api/passkeys/{hash}, signed (#144).
async fn delete_passkey(app: &Router, u: &User, t: &str, hash: &str) -> (StatusCode, Value) {
    signed(app, &u.sk, &u.account_id, t, "DELETE", &format!("/api/passkeys/{hash}"), sig::action::DELETE_PASSKEY, hash, &[], None).await
}

#[tokio::test]
async fn passkey_entries_sign_in_without_a_session() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let hash = "ab".repeat(32);

    let (s, _) = call(&app, "POST", "/api/passkeys", None, Some(passkey_entry(&hash))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = put_passkey(&app, &u, &t, passkey_entry("AB")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, v) = put_passkey(&app, &u, &t, passkey_entry(&hash)).await;
    assert_eq!(s, StatusCode::OK, "{v}");

    // A new device fetches it with no session; unknown ids are 404.
    let (s, v) = call(&app, "GET", &format!("/api/passkey-signin/{hash}"), None, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["ciphertext"], b64(&[2u8; 32]));
    let (s, _) = call(&app, "GET", &format!("/api/passkey-signin/{}", "cd".repeat(32)), None, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let (_, v) = call(&app, "GET", "/api/passkeys", Some(&t), None).await;
    let list = v["passkeys"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0]["last_used_at"].is_i64());

    // Another account can't take over the same credential.
    let other = User::new(3, "fedcba9876543210fedcba9876543210");
    signup(&app, &other).await;
    let t3 = login(&app, &other.sk).await.unwrap();
    let (s, _) = put_passkey(&app, &other, &t3, passkey_entry(&hash)).await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = delete_passkey(&app, &other, &t3, &hash).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(&app, "GET", &format!("/api/passkey-signin/{hash}"), None, None).await;
    assert_eq!(s, StatusCode::OK, "only the owner can delete it");

    let (s, _) = delete_passkey(&app, &u, &t, &hash).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(&app, "GET", &format!("/api/passkey-signin/{hash}"), None, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn passkeys_are_capped_per_account() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    for i in 0..20 {
        let (s, _) = put_passkey(&app, &u, &t, passkey_entry(&format!("{i:064x}"))).await;
        assert_eq!(s, StatusCode::OK);
    }
    let (s, _) = put_passkey(&app, &u, &t, passkey_entry(&"f".repeat(64))).await;
    assert_eq!(s, StatusCode::CONFLICT);
    // Replacing an existing one is still allowed.
    let (s, _) = put_passkey(&app, &u, &t, passkey_entry(&format!("{:064x}", 0))).await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn rotate_removes_passkey_entries() {
    let app = test_app(1 << 20, false);
    let old = User::new(1, ACCT);
    signup(&app, &old).await;
    let t = login(&app, &old.sk).await.unwrap();
    let hash = "ab".repeat(32);
    put_passkey(&app, &old, &t, passkey_entry(&hash)).await;

    let new = User::new(2, ACCT);
    let np = new.pubkey();
    let (s, _) = call(&app, "POST", "/api/account/rotate", Some(&t), Some(json!({
        "new_pubkey": b64(&np), "keyring": [new.keyring_entry(1)],
        "old_sig": b64(&old.sk.sign(&sig::rotate_msg(TAG_ROTATE_OLD, ACCT, &np)).to_bytes()),
        "new_sig": b64(&new.sk.sign(&sig::rotate_msg(TAG_ROTATE_NEW, ACCT, &np)).to_bytes()),
    }))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = call(&app, "GET", &format!("/api/passkey-signin/{hash}"), None, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn security_headers_on_static_and_api() {
    let app = test_app(1 << 20, false);
    // The page itself gets the same policy plus a style nonce (see page_csp_has_a_fresh_style_nonce).
    for (method, path) in [("GET", "/app.js"), ("GET", "/api/docs"), ("GET", "/nope")] {
        let res = app.clone()
            .oneshot(Request::builder().method(method).uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let h = res.headers();
        assert_eq!(h["content-security-policy"], plim_server::CSP, "{path}");
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["referrer-policy"], "no-referrer");
        assert_eq!(h["x-frame-options"], "DENY");
        assert_eq!(h["strict-transport-security"], "max-age=31536000");
    }
}

/// Static files must be revalidated on every load (no stale scripts after an
/// upgrade behind a CDN); API responses must never be stored.
#[tokio::test]
async fn cache_headers_static_vs_api() {
    let app = test_app(1 << 20, false);
    for path in ["/", "/app.js", "/style.css", "/vendor/yjs.mjs", "/icon.svg"] {
        let (status, headers, _) = get_with_host(&app, path, Some("localhost:3000")).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers["cache-control"], "no-cache", "{path}");
    }
    for path in ["/api/docs", "/healthz"] {
        let (_, headers, _) = get_with_host(&app, path, Some("localhost:3000")).await;
        assert_eq!(headers["cache-control"], "no-store", "{path}");
    }
    // Revalidation is cheap: an unchanged file answers 304 with no body.
    let (_, headers, _) = get_with_host(&app, "/app.js", Some("localhost:3000")).await;
    let last_modified = headers["last-modified"].to_str().unwrap().to_string();
    let req = Request::builder()
        .uri("/app.js")
        .header("host", "localhost:3000")
        .header("if-modified-since", last_modified)
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(res.headers()["cache-control"], "no-cache");
}

/// The page links its scripts and styles under /v/<hash>/, so a deploy can't
/// leave browsers on old cached files, whatever a CDN does to Cache-Control.
#[tokio::test]
async fn versioned_asset_urls() {
    let app = test_app(1 << 20, false);
    let (status, headers, body) = get_with_host(&app, "/", Some("localhost:3000")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-cache");
    assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"));
    let html = String::from_utf8(body).unwrap();
    let at = html.find(r#"src="/v/"#).expect("versioned script") + r#"src="/v/"#.len();
    let version = &html[at..at + 12];
    assert!(html.contains(&format!(r#"src="/v/{version}/app.js""#)));
    assert!(html.contains(&format!(r#"href="/v/{version}/style.css""#)));
    assert_eq!(version, plim_server::assets::version(&config(":memory:", 0, false).web_dir).unwrap());

    let (_, _, plain) = get_with_host(&app, "/app.js", Some("localhost:3000")).await;
    for path in [format!("/v/{version}/app.js"), "/v/0123ab/app.js".into()] {
        let (status, headers, body) = get_with_host(&app, &path, Some("localhost:3000")).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(body, plain);
        assert_eq!(headers["cache-control"], "no-cache");
        assert_eq!(headers["content-security-policy"], plim_server::CSP);
        assert!(headers["content-type"].to_str().unwrap().contains("javascript"));
    }
    let (status, _, _) = get_with_host(&app, &format!("/v/{version}/vendor/yjs.mjs"), Some("localhost:3000")).await;
    assert_eq!(status, StatusCode::OK);
    for bad in ["/v/not-hex/app.js", "/v/abc/nope.js", "/v/abc/..%2fserver%2fCargo.toml", "/v/abc/../../Cargo.toml"] {
        let (status, _, _) = get_with_host(&app, bad, Some("localhost:3000")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
}

/// API responses say which version of the web files the server has, the one
/// the page links: a page running older files can tell (#134).
#[tokio::test]
async fn api_responses_carry_the_web_version() {
    let app = test_app(1 << 20, false);
    let (_, _, body) = get_with_host(&app, "/", Some("localhost:3000")).await;
    let html = String::from_utf8(body).unwrap();
    let at = html.find(r#"src="/v/"#).expect("versioned script") + r#"src="/v/"#.len();
    let version = &html[at..at + 12];
    for path in ["/api/signups", "/api/account", "/api/docs/nope"] {
        let (_, headers, _) = get_with_host(&app, path, Some("localhost:3000")).await;
        assert_eq!(headers["x-tiro-version"], version, "{path}"); // (errors too: 401, 404)
    }
    let (_, headers, _) = get_with_host(&app, "/s/0123456789abcdef0123456789abcdef", Some("localhost:3000")).await;
    assert!(!headers.contains_key("x-tiro-version"), "only the API");
}

/// A note's address (#299) serves the app's page, for any id: the server never says which
/// notes exist, and a bookmarked note opens from it (then the app decides).
#[tokio::test]
async fn a_notes_address_serves_the_app_whatever_the_id() {
    let app = test_app(1 << 20, false);
    let (_, _, home) = get_with_host(&app, "/", Some("localhost:3000")).await;
    let home = String::from_utf8(home).unwrap();
    for path in ["/n/0d4c6f2e-1b7a-4c3d-9e8f-123456789abc", "/n/not-an-id", "/n/0d4c6f2e-1b7a-4c3d-9e8f-123456789abc/"] {
        let (status, headers, body) = get_with_host(&app, path, Some("localhost:3000")).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains("app.js"), "{path}: the app's page");
        let csp = headers.get("content-security-policy").unwrap().to_str().unwrap();
        let nonce = csp.split("'nonce-").nth(1).unwrap().split('\'').next().unwrap();
        assert!(html.contains(&format!(r#"<meta name="style-nonce" content="{nonce}" />"#)), "{path}");
        // The same page as /, but for its nonce: nothing about the note in it.
        let strip = |h: &str| h.replace(|c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_', "");
        assert_eq!(strip(&html), strip(&home), "{path}");
    }
}

/// The service worker must stay at /sw.js (its scope is the folder it's
/// served from), unversioned, and revalidated so updates reach browsers.
#[tokio::test]
async fn service_worker_is_served_unversioned() {
    let app = test_app(1 << 20, false);
    let (status, headers, body) = get_with_host(&app, "/sw.js", Some("localhost:3000")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers["content-type"].to_str().unwrap().contains("javascript"));
    assert_eq!(headers["cache-control"], "no-cache");
    assert!(String::from_utf8(body).unwrap().contains("caches.open"));
    let (_, _, page) = get_with_host(&app, "/", Some("localhost:3000")).await;
    let page = String::from_utf8(page).unwrap();
    assert!(page.contains(r#"<link rel="manifest" href="/v/"#));
}

/// The blob limit is configurable, the request limit follows it, and clients
/// can read it from /account to size their uploads.
#[tokio::test]
async fn blob_and_body_limits_follow_config() {
    let mut cfg = config(":memory:", 50 << 20, false);
    cfg.max_blob_bytes = 256 * 1024;
    let srv = plim_server::app(AppState::new(cfg).unwrap());
    let u = User::new(31, &"31".repeat(16));
    assert_eq!(signup(&srv, &u).await, StatusCode::CREATED);
    let t = login(&srv, &u.sk).await.unwrap();
    let (_, v) = call(&srv, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["max_blob_bytes"], 256 * 1024);
    let (s, _) = call(&srv, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &vec![1; 250 * 1024]))).await;
    assert_eq!(s, StatusCode::OK, "a blob just under the limit, inside a body over the old fixed 2 MiB/4 ratio");
    let (s, _) = call(&srv, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &vec![1; 260 * 1024]))).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);

    // The default allows several MiB in one blob.
    let mut cfg = config(":memory:", 50 << 20, false);
    cfg.max_blob_bytes = plim_server::DEFAULT_MAX_BLOB_BYTES;
    let srv = plim_server::app(AppState::new(cfg).unwrap());
    let u = User::new(32, &"32".repeat(16));
    assert_eq!(signup(&srv, &u).await, StatusCode::CREATED);
    let t = login(&srv, &u.sk).await.unwrap();
    let (s, _) = call(&srv, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &vec![7; 6 << 20]))).await;
    assert_eq!(s, StatusCode::OK, "6 MiB fits under the 8 MiB default");
}

#[test]
fn pruning_is_on_unless_disabled() {
    use plim_server::on_unless_disabled as on;
    assert!(on(None) && on(Some("1")) && on(Some("yes")));
    assert!(!on(Some("0")) && !on(Some("false")) && !on(Some(" OFF ")));
}

/// Turning pruning on deletes what existing snapshots already cover, once at
/// startup, and recounts the account's usage.
#[tokio::test]
async fn startup_prunes_updates_already_covered() {
    let dir = std::env::temp_dir().join(format!("plim-prune-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("t.db");
    let db = db.to_str().unwrap();
    let u = User::new(33, &"33".repeat(16));
    {
        let srv = plim_server::app(AppState::new(config(db, 50 << 20, false)).unwrap());
        assert_eq!(signup(&srv, &u).await, StatusCode::CREATED);
        let t = login(&srv, &u.sk).await.unwrap();
        for i in 0..3u8 {
            call(&srv, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, &[i; 1000]))).await;
        }
        let (s, _) = call(&srv, "POST", "/api/docs/aa/snapshots", Some(&t), Some(u.blob("aa", "snapshot", 1, 2, &[9; 100]))).await;
        assert_eq!(s, StatusCode::OK);
        let (_, v) = call(&srv, "GET", "/api/account", Some(&t), None).await;
        assert_eq!(v["used_bytes"], 3100, "history kept while pruning is off");
    }
    let srv = plim_server::app(AppState::new(config(db, 50 << 20, true)).unwrap());
    let t = login(&srv, &u.sk).await.unwrap();
    let (_, v) = call(&srv, "GET", "/api/account", Some(&t), None).await;
    assert_eq!(v["used_bytes"], 1100, "updates 1–2 pruned; update 3 and the snapshot remain");
    let (_, v) = call(&srv, "GET", "/api/docs/aa?after=0", Some(&t), None).await;
    assert_eq!(v["snapshot"]["covers_seq"], 2);
    assert_eq!(v["updates"].as_array().unwrap().len(), 1);
    assert_eq!(v["head"], 3);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The page's CSP adds a one-off nonce for `<style>` elements (CodeMirror's
/// styles), handed to the page in a meta tag. Fresh on every load, nothing
/// else loosened, and every other response keeps the strict policy.
#[tokio::test]
async fn page_csp_has_a_fresh_style_nonce() {
    let app = test_app(1 << 20, false);
    let mut nonces = Vec::new();
    for _ in 0..2 {
        let (status, headers, body) = get_with_host(&app, "/", Some("localhost:3000")).await;
        assert_eq!(status, StatusCode::OK);
        let csp = headers["content-security-policy"].to_str().unwrap().to_string();
        let html = String::from_utf8(body).unwrap();
        let at = html.find(r#"<meta name="style-nonce" content=""#).expect("meta tag") + r#"<meta name="style-nonce" content=""#.len();
        let nonce = &html[at..at + 32];
        assert!(nonce.bytes().all(|b| b.is_ascii_hexdigit()), "{nonce}");
        assert_eq!(csp, plim_server::CSP.replace("style-src 'self'", &format!("style-src 'self' 'nonce-{nonce}'")));
        // (Its own WebAssembly may compile; no JavaScript eval, nothing from elsewhere.)
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval';"), "scripts stay strict");
        nonces.push(nonce.to_string());
    }
    assert_ne!(nonces[0], nonces[1], "a new nonce on every load");
    let (_, headers, _) = get_with_host(&app, "/app.js", Some("localhost:3000")).await;
    assert_eq!(headers["content-security-policy"], plim_server::CSP);
}

/// The link preview tags: absolute with PLIM_PUBLIC_URL (preview fetchers
/// need that), left relative without it; the image itself is served.
#[tokio::test]
async fn link_preview_urls_follow_public_url() {
    let og = |html: &str, prop: &str| {
        let tag = format!(r#"<meta property="{prop}" content=""#);
        let at = html.find(&tag).unwrap_or_else(|| panic!("{prop}")) + tag.len();
        html[at..at + html[at..].find('"').unwrap()].to_string()
    };
    let (_, _, body) = get_with_host(&test_app(1 << 20, false), "/", Some("localhost:3000")).await;
    let html = String::from_utf8(body).unwrap();
    assert_eq!(og(&html, "og:image"), "/og-image.png");

    let mut cfg = config(":memory:", 1 << 20, false);
    cfg.public_url = Some("https://notes.example.com".into());
    let app = plim_server::app(AppState::new(cfg).unwrap());
    let (_, _, body) = get_with_host(&app, "/", Some("localhost:3000")).await;
    let html = String::from_utf8(body).unwrap();
    assert_eq!(og(&html, "og:url"), "https://notes.example.com/");
    assert_eq!(og(&html, "og:image"), "https://notes.example.com/og-image.png");

    let (status, headers, _) = get_with_host(&app, "/og-image.png", Some("localhost:3000")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/png");
}

/// Deleting a note, closing or reopening it, and saving or removing a passkey's copy need the
/// account key's signature, for that action on that note or passkey, over a fresh challenge:
/// a stolen session can't do them (#144).
#[tokio::test]
async fn destructive_actions_need_the_accounts_signature() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"text"))).await;
    let ok = StatusCode::NO_CONTENT;
    check_needs_signature(&app, &u, &t, "POST", "/api/docs/aa/close", sig::action::CLOSE_DOC, "aa", &[], None, ok).await;
    check_needs_signature(&app, &u, &t, "POST", "/api/docs/aa/reopen", sig::action::REOPEN_DOC, "aa", &[], None, ok).await;
    check_needs_signature(&app, &u, &t, "DELETE", "/api/docs/aa", sig::action::DELETE_DOC, "aa", &[], None, ok).await;
    let hash = "ab".repeat(32);
    let entry = passkey_entry(&hash);
    let copy = passkey_copy(&entry);
    check_needs_signature(&app, &u, &t, "POST", "/api/passkeys", sig::action::PUT_PASSKEY, &hash, &copy, Some(entry), StatusCode::OK).await;
    check_needs_signature(&app, &u, &t, "DELETE", &format!("/api/passkeys/{hash}"), sig::action::DELETE_PASSKEY, &hash, &[], None, ok).await;
    // Nothing the refused tries asked for happened: only the signed ones.
    let (s, _) = call(&app, "GET", &format!("/api/passkey-signin/{hash}"), None, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

/// A deleted doc (a note shared, or deleted for good) takes no more writes, so a
/// device's late upload can't bring it back (#119), until it's reopened (sharing stopped).
#[tokio::test]
async fn a_deleted_doc_refuses_writes_until_reopened() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let (s, _) = call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"first"))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = delete_doc(&app, &u, &t, "aa").await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    // A device that hadn't heard: its update, snapshot and version are refused, and nothing is stored.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    for (path, body) in [
        ("updates", u.blob("aa", "update", 1, 0, b"late")),
        ("snapshots", u.blob("aa", "snapshot", 1, 0, b"late")),
        ("versions", u.blob("aa", "version", 1, now, b"late")),
    ] {
        let (s, v) = call(&app, "POST", &format!("/api/docs/aa/{path}"), Some(&t), Some(body)).await;
        assert_eq!(s, StatusCode::GONE, "{path}: {v}");
    }
    let (_, doc) = call(&app, "GET", "/api/docs/aa", Some(&t), None).await;
    assert_eq!(doc["updates"].as_array().map(Vec::len), Some(0));
    assert_eq!(call(&app, "GET", "/api/account", Some(&t), None).await.1["used_bytes"], 0);
    // Other docs are unaffected; another account's doc of the same name too.
    let (s, _) = call(&app, "POST", "/api/docs/bb/updates", Some(&t), Some(u.blob("bb", "update", 1, 0, b"x"))).await;
    assert_eq!(s, StatusCode::OK);
    // Reopened (sharing stopped: the note's text comes back here): writes work again.
    let (s, _) = doc_action(&app, &u, &t, "aa", "reopen").await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"back"))).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = doc_action(&app, &u, &t, "index", "reopen").await;
    assert_eq!(s, StatusCode::NO_CONTENT, "reopening one that isn't gone is fine");

    // Closed (about to be shared): no more writes, but what's there can still be read, to copy.
    let (s, _) = doc_action(&app, &u, &t, "bb", "close").await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = call(&app, "POST", "/api/docs/bb/updates", Some(&t), Some(u.blob("bb", "update", 1, 0, b"late"))).await;
    assert_eq!(s, StatusCode::GONE);
    let (_, doc) = call(&app, "GET", "/api/docs/bb", Some(&t), None).await;
    assert_eq!(doc["updates"].as_array().map(Vec::len), Some(1));
    let (s, _) = doc_action(&app, &u, &t, "index", "close").await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "the note list is never closed");
}

/// PLIM_MAX_ACCOUNTS: at the limit, no new accounts (nor the proof of work for one);
/// existing ones still sign in. /api/signups says whether it's open, nothing more.
#[tokio::test]
async fn signups_close_at_the_account_limit() {
    let app = app(AppState::new(Config { max_accounts: Some(1), ..config(":memory:", 1 << 20, false) }).unwrap());
    let (_, v) = call(&app, "GET", "/api/signups", None, None).await;
    assert_eq!(v, json!({ "open": true }));
    let a = User::new(1, ACCT);
    assert_eq!(signup(&app, &a).await, StatusCode::CREATED);
    let (_, v) = call(&app, "GET", "/api/signups", None, None).await;
    assert_eq!(v, json!({ "open": false }));
    let (s, v) = call(&app, "POST", "/api/pow", None, Some(json!({}))).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "{v}");
    assert_eq!(v["error"], "signups are closed");
    let b = User::new(2, "fedcba9876543210fedcba9876543210");
    let (s, _) = call(&app, "POST", "/api/accounts", None, Some(json!({
        "account_id": b.account_id, "pubkey": b64(&b.pubkey()), "keyring_entry": b.keyring_entry(1),
        "pow_salt": b64(&[0; 16]), "pow_nonce": 0,
    }))).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "refused before anything else is checked");
    assert!(login(&app, &a.sk).await.is_ok(), "an existing account still signs in");
    // No limit set: always open.
    let open = test_app(1 << 20, false);
    assert_eq!(call(&open, "GET", "/api/signups", None, None).await.1, json!({ "open": true }));
}

/// Deleting an account takes its key's signature over a fresh challenge, not
/// just a session; then nothing of it is left, its shared notes' links stop
/// working, and its sessions end (#51).
#[tokio::test]
async fn deleting_an_account_needs_its_key_and_leaves_nothing() {
    let app = test_app(1 << 20, false);
    let u = User::new(1, ACCT);
    signup(&app, &u).await;
    let t = login(&app, &u.sk).await.unwrap();
    let (s, _) = call(&app, "POST", "/api/docs/aa/updates", Some(&t), Some(u.blob("aa", "update", 1, 0, b"a note"))).await;
    assert_eq!(s, StatusCode::OK);
    let other = User::new(2, "fedcba9876543210fedcba9876543210");
    signup(&app, &other).await;
    let t2 = login(&app, &other.sk).await.unwrap();

    let hash = sig::pubkey_hash(&u.pubkey());
    let challenge = || async { call(&app, "POST", "/api/auth/challenge", None, Some(json!({ "pubkey_hash": hash }))).await.1["nonce"].clone() };
    let signed = |nonce: &Value, sk: &SigningKey| {
        let n = B64.decode(nonce.as_str().unwrap()).unwrap();
        json!({ "nonce": nonce, "sig": b64(&sk.sign(&sig::delete_account_msg(ACCT, &n)).to_bytes()) })
    };
    // A session alone, a signature by another key, or one over a stale nonce: refused.
    let (s, _) = call(&app, "POST", "/api/account/delete", Some(&t), Some(json!({}))).await;
    assert!(s.is_client_error(), "no signature: {s}");
    let n = challenge().await;
    let (s, _) = call(&app, "POST", "/api/account/delete", Some(&t), Some(signed(&n, &other.sk))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "another key");
    let (s, _) = call(&app, "POST", "/api/account/delete", Some(&t), Some(signed(&n, &u.sk))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "the challenge was used up by the failed try");
    let (s, _) = call(&app, "POST", "/api/account/delete", Some(&t2), Some(signed(&challenge().await, &u.sk))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "another account's session");
    assert_eq!(call(&app, "GET", "/api/account", Some(&t), None).await.0, StatusCode::OK, "still there");

    // Signed by its key, over a fresh challenge: gone.
    let (s, v) = call(&app, "POST", "/api/account/delete", Some(&t), Some(signed(&challenge().await, &u.sk))).await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    assert_eq!(call(&app, "GET", "/api/account", Some(&t), None).await.0, StatusCode::UNAUTHORIZED, "its sessions end");
    assert!(login(&app, &u.sk).await.is_err(), "can't sign in again");
    assert_eq!(signup(&app, &u).await, StatusCode::CREATED, "the same phrase could make a new, empty account");
    let t = login(&app, &u.sk).await.unwrap();
    let (_, doc) = call(&app, "GET", "/api/docs/aa", Some(&t), None).await;
    assert_eq!(doc["updates"].as_array().map(Vec::len), Some(0), "nothing of the old one");
    // The other account is untouched.
    assert_eq!(call(&app, "GET", "/api/account", Some(&t2), None).await.0, StatusCode::OK);
}
