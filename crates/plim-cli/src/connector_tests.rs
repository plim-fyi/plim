//! The connector (#369) against a real in-process Plim server: a connection made as the web app
//! makes one, the OAuth dance a client goes through, and the tools over the connection's holders.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use serde_json::{Value, json};
use plim_core::crypto::{HeldKeys, connection_holder_secret, connection_keys, holder_keys, random_bytes, seal_held_keys};
use plim_core::sig::sha256;
use yrs::{Any, Array, Map, Transact};

use crate::connector::{Connector, router};
use crate::notes;
use crate::session::Session;
use crate::sync::{DocSync, NoEvents, ShareHome};
use crate::sync_tests::{Server, device, server, vault};

const CONN: &str = "c0ffeec0ffeec0ffeec0ffeec0ffee01";

/// A connection of `owner`'s, as the web app's createConnection makes it: registered, its list
/// note a share held through the derived holder, `info` with its name.
async fn connect(owner: &Arc<Session>, secret: &[u8; 32]) -> (String, [u8; 32]) {
    let ck = connection_keys(secret);
    owner.api.post("/connections", &json!({ "connection_id": CONN, "name": "Claude", "pubkey": B64.encode(ck.pubkey) })).await.unwrap();
    let list_id = hex::encode(random_bytes::<16>());
    let list_seed = random_bytes::<32>();
    let list = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(&list_id, &list_seed)), Arc::new(NoEvents)).unwrap();
    {
        let info = list.doc.get_or_insert_map("info");
        list.doc.get_or_insert_map("notes");
        list.doc.get_or_insert_array("activity");
        let mut txn = list.doc.transact_mut();
        info.insert(&mut txn, "name", "Claude");
        info.insert(&mut txn, "notebook", true);
    }
    list.create_share(&list.state()).await.unwrap();
    let hk = holder_keys(&ck.list_holder_secret);
    let sealed = seal_held_keys(&hk.seal_key, &ck.list_holder_id, &list_id, &HeldKeys::Edit { seed: list_seed });
    owner
        .api
        .post(
            "/holders",
            &json!({ "holder_id": ck.list_holder_id, "share_id": list_id, "role": "edit", "token_hash": B64.encode(sha256(&hk.token)),
                "nonce": B64.encode(sealed.nonce), "ciphertext": B64.encode(&sealed.ciphertext), "connection_id": CONN }),
        )
        .await
        .unwrap();
    (list_id, list_seed)
}

/// A note of the owner's granted to the connection: shared, a holder of the connection's on it
/// (edit), listed as shared with agents (#514), as the app lists one.
async fn grant(owner: &Arc<Session>, secret: &[u8; 32], list: &DocSync, text: &str) -> String {
    grant_at(owner, secret, list, text, "edit", Some("ai")).await
}

/// The same, with its role and place ("ai": shared with agents; none: a note given before, through a tag).
async fn grant_at(owner: &Arc<Session>, secret: &[u8; 32], list: &DocSync, text: &str, role: &str, place: Option<&str>) -> String {
    grant_share(owner, secret, list, text, role, place).await.0
}

/// The same, with the share it's in: its id and seed (to open it as the owner).
/// A note written the old way ("Title\n#tag\n\nbody"), as the app keeps it: in its frontmatter (#584).
fn fm(text: &str) -> String {
    crate::frontmatter::to_frontmatter(text)
}

async fn grant_share(owner: &Arc<Session>, secret: &[u8; 32], list: &DocSync, text: &str, role: &str, place: Option<&str>) -> (String, String, [u8; 32]) {
    let text = &crate::frontmatter::to_frontmatter(text); // (as the app has notes: their title and tags in a block, #584)
    let note_id = uuid::Uuid::new_v4().to_string();
    let share_id = hex::encode(random_bytes::<16>());
    let seed = random_bytes::<32>();
    let share = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(&share_id, &seed)), Arc::new(NoEvents)).unwrap();
    notes::set_body(&share.doc, text);
    share.create_share(&share.state()).await.unwrap();
    let hid = hex::encode(random_bytes::<16>());
    let hk = holder_keys(&connection_holder_secret(secret, &hid));
    let keys = plim_core::crypto::share_keys(&seed);
    let held = if role == "edit" { HeldKeys::Edit { seed } } else { HeldKeys::Read { enc_key: keys.enc_key, pubkey: keys.pubkey } };
    let sealed = seal_held_keys(&hk.seal_key, &hid, &share_id, &held);
    owner
        .api
        .post(
            "/holders",
            &json!({ "holder_id": hid, "share_id": share_id, "role": role, "token_hash": B64.encode(sha256(&hk.token)),
                "nonce": B64.encode(sealed.nonce), "ciphertext": B64.encode(&sealed.ciphertext), "connection_id": CONN }),
        )
        .await
        .unwrap();
    let entries = list.doc.get_or_insert_map("notes");
    let tags: Vec<Any> = crate::frontmatter::note_tags(text).iter().map(|t| Any::from(t.as_str())).collect();
    let mut fields: HashMap<String, Any> = HashMap::from([
        ("noteId".into(), Any::from(note_id.as_str())),
        ("title".into(), Any::from(notes::title_from_body(text).as_str())),
        ("tags".into(), Any::Array(tags.into())),
        ("role".into(), Any::from(role)),
        ("updated".into(), Any::Number(yrs::Number::Float(notes::now_ms()))),
    ]);
    if let Some(place) = place {
        fields.insert("place".into(), Any::from(place));
    }
    entries.insert(&mut list.doc.transact_mut(), hid.as_str(), Any::Map(Arc::new(fields)));
    (note_id, share_id, seed)
}

struct Client {
    http: reqwest::Client,
    url: String,
}

impl Client {
    async fn start(srv: &Server) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let c = Arc::new(Connector::new(&url, &srv.url, random_bytes::<32>()));
        tokio::spawn(async move { axum::serve(listener, router(c).into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap() });
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        Client { http, url }
    }

    async fn rpc(&self, token: &str, method: &str, params: Value) -> Value {
        let r = self
            .http
            .post(format!("{}/mcp", self.url))
            .bearer_auth(token)
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "{method}");
        r.json().await.unwrap()
    }

    async fn tool(&self, token: &str, name: &str, args: Value) -> (bool, String) {
        let r = self.rpc(token, "tools/call", json!({ "name": name, "arguments": args })).await;
        (r["result"]["isError"].as_bool().unwrap(), r["result"]["content"][0]["text"].as_str().unwrap().to_string())
    }

    /// The whole dance: registration, /authorize (to the Plim app's consent page), consent given
    /// (as the app's /connect does, through /complete), the code redeemed with PKCE.
    async fn connect(&self, connection: &str, secret: &[u8; 32]) -> (String, String) {
        let reg: Value = self
            .http
            .post(format!("{}/register", self.url))
            .json(&json!({ "client_name": "Claude", "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"] }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let client_id = reg["client_id"].as_str().unwrap().to_string();
        let verifier = B64URL.encode(random_bytes::<32>());
        let challenge = B64URL.encode(sha256(verifier.as_bytes()));
        let r = self
            .http
            .get(format!("{}/authorize", self.url))
            .query(&[
                ("response_type", "code"),
                ("client_id", &client_id),
                ("redirect_uri", "https://claude.ai/api/mcp/auth_callback"),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("state", "xyz"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 303, "to the consent page");
        let to = r.headers()["location"].to_str().unwrap().to_string();
        let q: HashMap<String, String> = url_query(&to);
        assert!(to.contains("/connect?"), "{to}");
        assert_eq!(q["name"], "Claude");
        assert_eq!(q["to"], "claude.ai", "where the person goes back to, for the consent page");
        assert_eq!(q["return"], format!("{}/complete", self.url));
        // The consent page, said yes: the fragment the app hands to /complete.
        let done: Value = self
            .http
            .post(format!("{}/complete", self.url))
            .json(&json!({ "auth": q["auth"], "connection": connection, "secret": B64URL.encode(secret), "to": q["to"] }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let redirect = done["redirect"].as_str().unwrap();
        assert!(redirect.starts_with("https://claude.ai/api/mcp/auth_callback?code="), "{redirect}");
        let rq = url_query(redirect);
        assert_eq!(rq["state"], "xyz");
        // A wrong verifier gets nothing (and the code stays unused for the right one? no: used up, as RFC says: try the wrong one on a fresh code elsewhere).
        let tok: Value = self
            .http
            .post(format!("{}/token", self.url))
            .form(&[("grant_type", "authorization_code"), ("code", &rq["code"]), ("code_verifier", &verifier), ("client_id", &client_id), ("redirect_uri", "https://claude.ai/api/mcp/auth_callback")])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(tok["token_type"], "Bearer", "{tok}");
        (tok["access_token"].as_str().unwrap().to_string(), tok["refresh_token"].as_str().unwrap().to_string())
    }
}

fn url_query(url: &str) -> HashMap<String, String> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or_default();
    q.split('&')
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            Some((k.to_string(), percent_decode(v)))
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn claude_connects_reads_what_is_shared_with_agents_and_makes_notes() {
    let srv = server().await;
    let id = vault(&srv).await;
    let owner = device(&srv, &id).await;
    let secret = random_bytes::<32>();
    let (list_id, list_seed) = connect(&owner, &secret).await;
    let mut list = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(&list_id, &list_seed)), Arc::new(NoEvents)).unwrap();
    list.load().await.unwrap();
    let gym = grant(&owner, &secret, &list, "Gym log\n#gym\n\n- squats 5x5").await;
    let soup = grant(&owner, &secret, &list, "Soup\n#recipes\n\nOnions first.").await;
    // A note given before #514 through a tag, not shared with agents: it isn't there for it.
    grant_at(&owner, &secret, &list, "Diary\n#diary\n\nNot for agents.", "edit", None).await;
    list.flush().await.unwrap();

    let client = Client::start(&srv).await;
    // Nothing without a token: and where to get one.
    let r = client.http.post(format!("{}/mcp", client.url)).json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).send().await.unwrap();
    assert_eq!(r.status(), 401);
    assert!(r.headers()["www-authenticate"].to_str().unwrap().contains("/.well-known/oauth-protected-resource"));
    let meta: Value = client.http.get(format!("{}/.well-known/oauth-authorization-server", client.url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(meta["code_challenge_methods_supported"], json!(["S256"]));

    let (token, refresh) = client.connect(CONN, &secret).await;
    let init = client.rpc(&token, "initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    assert!(init["result"]["instructions"].as_str().unwrap().contains("Settings → Connections"), "{init}");
    let tools = client.rpc(&token, "tools/list", json!({})).await;
    assert!(tools["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "create_note"));

    // What's shared with agents, and only that (#514): the note given through a tag isn't there.
    let (err, out) = client.tool(&token, "list_notes", json!({})).await;
    assert!(!err, "{out}");
    assert!(out.contains("Gym log") && out.contains(&gym) && out.contains("Soup") && !out.contains("Diary") && !out.contains("only"), "{out}");
    let (err, out) = client.tool(&token, "read_note", json!({ "note": "gym" })).await;
    assert!(!err && out.contains("squats 5x5"), "{out}");
    for note in ["Diary", "secret diary"] {
        let (err, out) = client.tool(&token, "read_note", json!({ "note": note })).await;
        assert!(err && out.contains("no note matches"), "{note}: {out}");
    }
    let (err, out) = client.tool(&token, "list_tags", json!({})).await;
    assert!(!err && out == "#gym 1\n#recipes 1\n", "{out}");
    let (err, out) = client.tool(&token, "list_grants", json!({})).await;
    assert!(!err && out.contains("nothing else of theirs") && out.contains("Settings → Connections"), "{out}");
    assert!(init["result"]["instructions"].as_str().unwrap().contains("the notes the user shares with agents"), "at initialize: {init}");

    // Searching (#24): every word, whatever the case; only notes shared with agents; a tag narrows it.
    let (err, out) = client.tool(&token, "search_notes", json!({ "query": "SQUATS" })).await;
    assert!(!err && out.starts_with("1 note match \"SQUATS\":\n- Gym log · ") && out.contains("    - **squats** 5x5"), "{out}");
    let (err, out) = client.tool(&token, "search_notes", json!({ "query": "onions" })).await;
    assert!(!err && out.contains("Soup") && out.contains("**Onions** first."), "{out}");
    let (err, out) = client.tool(&token, "search_notes", json!({ "query": "agents" })).await;
    assert!(!err && !out.contains("Diary"), "{out}");
    let (err, out) = client.tool(&token, "search_notes", json!({ "query": "onions", "tag": "gym" })).await;
    assert!(!err && out == "No notes tagged #gym match \"onions\".", "{out}");
    let (err, out) = client.tool(&token, "search_notes", json!({ "query": "  " })).await;
    assert!(err && out.contains("query is missing"), "{out}");

    // Appending: the note changed on the server (the owner sees it), the list's entry and activity kept.
    let (err, out) = client.tool(&token, "append_to_note", json!({ "note": "Gym log", "text": "- bench 3x8" })).await;
    assert!(!err, "{out}");
    let (err, out) = client.tool(&token, "read_note", json!({ "note": &gym })).await;
    assert!(!err && out.ends_with("- squats 5x5\n- bench 3x8"), "{out}");
    // Editing (#74): a piece replaced, the lines around it said. Tags are only topics: any on, any off.
    let (err, out) = client.tool(&token, "edit_note", json!({ "note": "Gym log", "old_text": "- squats 5x5", "new_text": "- squats 5x5 (easy)" })).await;
    assert!(!err && out.starts_with("Edited \"Gym log\"") && out.contains("- squats 5x5 (easy)"), "{out}");
    let (err, out) = client.tool(&token, "edit_note", json!({ "note": "Soup", "old_text": "Onions", "new_text": "Leeks" })).await;
    assert!(!err, "{out}");
    let (err, out) = client.tool(&token, "tag_note", json!({ "note": "Gym log", "tags": ["gym/legs", "finance"] })).await;
    assert!(!err && out.contains("#gym/legs") && out.contains("#finance"), "{out}");
    let (err, out) = client.tool(&token, "untag_note", json!({ "note": "Gym log", "tags": ["gym", "finance"] })).await;
    assert!(!err, "{out}");
    let (_, out) = client.tool(&token, "read_note", json!({ "note": "Gym log" })).await;
    assert!(out.contains("tags: [gym/legs]") && !out.contains("finance"), "{out}");

    // A note made, shared with agents: a share of the owner's, signed by the connection; listed
    // with its seed for the owner's app to take in. Any tags: they're topics.
    let (err, out) = client.tool(&token, "create_note", json!({ "text": "Ideas\n#travel #finance\n\n- a connector" })).await;
    assert!(!err && out.starts_with("Created \"Ideas\", shared with agents: "), "{out}");
    let (err, out) = client.tool(&token, "read_note", json!({ "note": "Ideas" })).await;
    assert!(!err && out.contains("- a connector"), "{out}");
    list.pull().await.unwrap();
    let (made, activity) = {
        let entries = list.doc.get_or_insert_map("notes");
        let activity = list.doc.get_or_insert_array("activity");
        let txn = list.doc.transact();
        let made: Vec<Value> = entries
            .iter(&txn)
            .filter_map(|(_, v)| {
                let yrs::Out::Any(a) = v else { return None };
                let v: Value = serde_json::to_value(&a).ok()?;
                v.get("seed").is_some().then_some(v)
            })
            .collect();
        let acts: Vec<String> = activity.iter(&txn).filter_map(|v| if let yrs::Out::Any(Any::Map(m)) = v { Some(m["what"].to_string()) } else { None }).collect();
        (made, acts)
    };
    assert_eq!(made.len(), 1, "{made:?}");
    assert_eq!(made[0]["title"], "Ideas");
    assert_eq!(made[0]["tags"], json!(["finance", "travel"]));
    assert_eq!(made[0]["role"], "edit");
    assert_eq!(made[0]["place"], "ai", "shared with agents");
    let share_id = made[0]["shareId"].as_str().unwrap();
    let seed: [u8; 32] = B64.decode(made[0]["seed"].as_str().unwrap()).unwrap().try_into().unwrap();
    let keys = plim_core::crypto::share_keys(&seed);
    let status = owner.api.get_share(&format!("/shares/{share_id}"), &hex::encode(keys.read_token)).await.unwrap();
    assert_eq!(status["status"], "ok", "the owner's share, opened with the listed seed: {status}");
    let account = owner.api.get("/account").await.unwrap();
    assert!(account["used_bytes"].as_i64().unwrap() > 0, "counted for the owner");
    // The note records Claude's session (#389): its client id → the connection's name, for whom
    // the text it typed was.
    let mut made_note = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(share_id, &seed)), Arc::new(NoEvents)).unwrap();
    made_note.load().await.unwrap();
    let authors: Vec<(String, Value)> = {
        let map = made_note.doc.get_or_insert_map("authors");
        let txn = made_note.doc.transact();
        map.iter(&txn).filter_map(|(k, v)| if let yrs::Out::Any(a) = v { Some((k.to_string(), serde_json::to_value(&a).unwrap())) } else { None }).collect()
    };
    assert_eq!(authors.len(), 1, "{authors:?}");
    assert_eq!(authors[0].1["name"], "Claude");
    assert_eq!(authors[0].1["connection"], CONN);
    assert!(authors[0].0.parse::<u64>().is_ok(), "keyed by its Yjs client id");
    assert!(activity.iter().any(|a| a.contains("Read \"Gym log\"")) && activity.iter().any(|a| a.contains("Added to \"Gym log\"")) && activity.iter().any(|a| a.contains("Created \"Ideas\"")), "{activity:?}");
    assert!(activity.iter().any(|a| a.contains("Edited \"Gym log\"")), "{activity:?}");
    assert!(!client.tool(&token, "read_note", json!({ "note": &soup })).await.0);

    // The refresh token gives a new pair; the access token outlives nothing the owner turns off.
    let tok: Value = client.http.post(format!("{}/token", client.url)).form(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).send().await.unwrap().json().await.unwrap();
    let token2 = tok["access_token"].as_str().unwrap().to_string();
    assert_ne!(token2, token);
    let (err, _) = client.tool(&token2, "list_notes", json!({})).await;
    assert!(!err);
    owner.api.signed(&owner.identity, &owner.account_id, reqwest::Method::POST, &format!("/connections/{CONN}/revoke"), plim_core::sig::action::REVOKE_CONNECTION, CONN).await.unwrap();
    let (err, out) = client.tool(&token2, "list_notes", json!({})).await;
    assert!(err && out.contains("turned off"), "{out}");
    let (err, out) = client.tool(&token2, "create_note", json!({ "text": "Still here?" })).await;
    assert!(err, "{out}");
}

#[test]
fn redirect_hosts() {
    use crate::connector::redirect_host as h;
    assert_eq!(h("https://claude.ai/api/mcp/auth_callback").as_deref(), Some("claude.ai"));
    assert_eq!(h("https://Claude.AI:443/cb").as_deref(), Some("claude.ai"));
    assert_eq!(h("http://localhost:33418/callback").as_deref(), Some("localhost"));
    assert_eq!(h("http://127.0.0.1/cb").as_deref(), Some("127.0.0.1"));
    assert_eq!(h("http://[::1]:8080/cb").as_deref(), Some("::1"));
    for bad in ["http://localhost.evil.com/cb", "http://evil.com/cb", "https://claude.ai@evil.com/cb", "javascript:alert(1)", "https:///cb", "ftp://x/cb"] {
        assert_eq!(h(bad), None, "{bad}");
    }
}

/// Each MCP session through the connector is named in the history its changes leave (#505): it's
/// handed an Mcp-Session-Id at initialize, and every change sent with it is that session's.
#[tokio::test]
async fn the_connector_names_each_mcp_session_in_history() {
    use crate::writer::WriterSession;
    let srv = server().await;
    let id = vault(&srv).await;
    let owner = device(&srv, &id).await;
    let secret = random_bytes::<32>();
    let (list_id, list_seed) = connect(&owner, &secret).await;
    let mut list = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(&list_id, &list_seed)), Arc::new(NoEvents)).unwrap();
    list.load().await.unwrap();
    let (_, share_id, seed) = grant_share(&owner, &secret, &list, "Gym log\n#gym\n\n- squats", "edit", Some("ai")).await;
    list.flush().await.unwrap();
    let client = Client::start(&srv).await;
    let (token, _) = client.connect(CONN, &secret).await;
    let post = |sid: Option<&str>, body: Value| {
        let mut r = client.http.post(format!("{}/mcp", client.url)).bearer_auth(&token).json(&body);
        if let Some(s) = sid {
            r = r.header("mcp-session-id", s);
        }
        r.send()
    };
    // Two conversations: each handed its own session at initialize; one already in a session isn't handed another.
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } });
    let s1 = post(None, init.clone()).await.unwrap().headers()["mcp-session-id"].to_str().unwrap().to_string();
    let s2 = post(None, init.clone()).await.unwrap().headers()["mcp-session-id"].to_str().unwrap().to_string();
    assert!(s1.len() == 32 && s1 != s2, "{s1} {s2}");
    assert!(post(Some(&s1), init).await.unwrap().headers().get("mcp-session-id").is_none());
    let call = |name: &str, args: Value| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": name, "arguments": args } });
    let r: Value = post(Some(&s1), call("append_to_note", json!({ "note": "Gym log", "text": "- bench" }))).await.unwrap().json().await.unwrap();
    assert_eq!(r["result"]["isError"], false, "{r}");
    let r: Value = post(Some(&s2), call("edit_note", json!({ "note": "Gym log", "old_text": "- bench", "new_text": "- bench 3x8" }))).await.unwrap().json().await.unwrap();
    assert_eq!(r["result"]["isError"], false, "{r}");
    // Without one (a client that keeps none): its change is the connection's, no session named.
    let r: Value = post(None, call("append_to_note", json!({ "note": "Gym log", "text": "- rows" }))).await.unwrap().json().await.unwrap();
    assert_eq!(r["result"]["isError"], false, "{r}");
    // The owner reads the note's history: what it was, then each session's change, by whom.
    let note = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(&share_id, &seed)), Arc::new(NoEvents)).unwrap();
    let mut steps = vec![];
    for (v, _) in note.versions().await.unwrap().into_iter().rev() {
        let (_, packed) = note.read_version_packed(v).await.unwrap();
        let (text, w) = plim_core::version::unpack_version(&packed).unwrap();
        steps.push((text, w.map(|w| (w.name.unwrap(), w.connection.unwrap(), w.session))));
    }
    let by = |s: Option<&str>| Some(("Claude".to_string(), CONN.to_string(), s.map(|s| WriterSession::of(s).name)));
    assert_eq!(
        steps,
        // (Each as written the old way, in its block as the note has it, #584.)
        vec![
            (fm("Gym log\n#gym\n\n- squats"), None),
            (fm("Gym log\n#gym\n\n- squats\n- bench"), by(Some(&s1))),
            (fm("Gym log\n#gym\n\n- squats\n- bench 3x8"), by(Some(&s2))),
            (fm("Gym log\n#gym\n\n- squats\n- bench 3x8\n- rows"), by(None)),
        ]
    );

    // The AI reads the history (#505), but only from when it was given the note: a version the
    // owner kept from before (a day ago) isn't there; and the read is in its activity.
    let a_day_ago = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 86400;
    note.save_version(b"Gym log\n#gym\n\n- a private line, deleted before sharing", a_day_ago).await.unwrap();
    let tool = |name: &str, args: Value| post(Some(&s1), call(name, args));
    let r: Value = tool("note_history", json!({ "note": "Gym log" })).await.unwrap().json().await.unwrap();
    let h = r["result"]["content"][0]["text"].as_str().unwrap();
    assert!(h.starts_with("\"Gym log\": 4 versions") && h.contains("aren't shown") && h.contains(&format!("Claude · {}", WriterSession::of(&s2).name)), "{h}");
    let r: Value = tool("read_version", json!({ "note": "Gym log", "version": 4, "diff": true })).await.unwrap().json().await.unwrap();
    let v = r["result"]["content"][0]["text"].as_str().unwrap();
    assert!(v.contains("the oldest you can see") && !v.contains("private line"), "{v}");
    let r: Value = tool("read_version", json!({ "note": "Gym log", "version": 5 })).await.unwrap().json().await.unwrap();
    assert!(r["result"]["isError"] == true && !r.to_string().contains("private line"), "{r}");
    list.load().await.unwrap();
    let activity: Vec<String> = {
        use yrs::{Array, Transact};
        let a = list.doc.get_or_insert_array("activity");
        let txn = list.doc.transact();
        a.iter(&txn).map(|v| v.to_string(&txn)).collect()
    };
    assert!(activity.iter().any(|a| a.contains("Read the history of \\\"Gym log\\\"") || a.contains("Read the history of \"Gym log\"")), "{activity:?}");
}

#[tokio::test]
async fn the_dance_refuses_what_it_should() {
    let srv = server().await;
    let client = Client::start(&srv).await;
    // An unregistered client, a redirect it didn't register, no PKCE.
    let r = client.http.get(format!("{}/authorize?response_type=code&client_id=nope&redirect_uri=https%3A%2F%2Fx.test%2Fcb", client.url)).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let reg: Value = client.http.post(format!("{}/register", client.url)).json(&json!({ "client_name": "X", "redirect_uris": ["https://x.test/cb"] })).send().await.unwrap().json().await.unwrap();
    let cid = reg["client_id"].as_str().unwrap();
    let r = client.http.get(format!("{}/authorize?response_type=code&client_id={cid}&redirect_uri=https%3A%2F%2Fother.test%2Fcb&code_challenge=a&code_challenge_method=S256", client.url)).send().await.unwrap();
    assert_eq!(r.status(), 400, "another redirect");
    let r = client.http.get(format!("{}/authorize?response_type=code&client_id={cid}&redirect_uri=https%3A%2F%2Fx.test%2Fcb", client.url)).send().await.unwrap();
    assert_eq!(r.status(), 303);
    assert!(r.headers()["location"].to_str().unwrap().contains("error=invalid_request"), "no PKCE: back to the client with the error");
    // Consent for an attempt that isn't pending; a code with the wrong verifier; a made-up token.
    let r = client.http.post(format!("{}/complete", client.url)).json(&json!({ "auth": "0000", "connection": CONN, "secret": B64URL.encode([1u8; 32]) })).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let r = client.http.get(format!("{}/authorize?response_type=code&client_id={cid}&redirect_uri=https%3A%2F%2Fx.test%2Fcb&code_challenge=abc&code_challenge_method=S256", client.url)).send().await.unwrap();
    let auth = url_query(r.headers()["location"].to_str().unwrap())["auth"].clone();
    // The consent page's "you'll go back to claude.ai", forged in the link (#403): refused, and the attempt is over.
    let r = client.http.post(format!("{}/complete", client.url)).json(&json!({ "auth": auth, "connection": CONN, "secret": B64URL.encode([1u8; 32]), "to": "claude.ai" })).send().await.unwrap();
    assert_eq!(r.status(), 400, "shown claude.ai, going to x.test");
    let r = client.http.get(format!("{}/authorize?response_type=code&client_id={cid}&redirect_uri=https%3A%2F%2Fx.test%2Fcb&code_challenge=abc&code_challenge_method=S256", client.url)).send().await.unwrap();
    let auth = url_query(r.headers()["location"].to_str().unwrap())["auth"].clone();
    let done: Value = client.http.post(format!("{}/complete", client.url)).json(&json!({ "auth": auth, "connection": CONN, "secret": B64URL.encode([1u8; 32]), "to": "x.test" })).send().await.unwrap().json().await.unwrap();
    let code = url_query(done["redirect"].as_str().unwrap())["code"].clone();
    let r = client.http.post(format!("{}/token", client.url)).form(&[("grant_type", "authorization_code"), ("code", &code), ("code_verifier", "wrong")]).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let r = client.http.post(format!("{}/token", client.url)).form(&[("grant_type", "refresh_token"), ("refresh_token", "nonsense")]).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let r = client.http.post(format!("{}/mcp", client.url)).bearer_auth("nonsense").json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).send().await.unwrap();
    assert_eq!(r.status(), 401);
    // Its pages: a CSP that lets only /complete's own script run, no framing, no referrer (#407).
    let r = client.http.get(format!("{}/complete", client.url)).send().await.unwrap();
    let csp = r.headers()["content-security-policy"].to_str().unwrap().to_string();
    assert!(csp.contains("script-src 'sha256-") && csp.contains("frame-ancestors 'none'"), "{csp}");
    assert_eq!(r.headers()["referrer-policy"], "no-referrer");
    // A few consents under way from one address at a time, not all of them (#406).
    let start = || client.http.get(format!("{}/authorize?response_type=code&client_id={cid}&redirect_uri=https%3A%2F%2Fx.test%2Fcb&code_challenge=abc&code_challenge_method=S256", client.url)).send();
    let mut answers = vec![];
    for _ in 0..12 {
        answers.push(start().await.unwrap().status().as_u16());
    }
    assert!(answers.contains(&303) && answers.ends_with(&[503, 503]), "{answers:?}");
}

/// The connector's requests count against the connection's own allowance (#394): with this
/// address's share reads all used up, Claude still reads its notes.
#[tokio::test]
async fn claude_has_its_own_allowance_not_the_connectors_address() {
    let srv = server().await;
    let id = vault(&srv).await;
    let owner = device(&srv, &id).await;
    let secret = random_bytes::<32>();
    let (list_id, list_seed) = connect(&owner, &secret).await;
    let mut list = DocSync::new_share(owner.clone(), Arc::new(ShareHome::from_seed(&list_id, &list_seed)), Arc::new(NoEvents)).unwrap();
    list.load().await.unwrap();
    grant(&owner, &secret, &list, "Gym log\n#gym\n\n- squats").await;
    list.flush().await.unwrap();
    let client = Client::start(&srv).await;
    let (token, _) = client.connect(CONN, &secret).await;
    // This address's share reads, all of them (the connector and these share one address here).
    let keys = plim_core::crypto::share_keys(&list_seed);
    let http = reqwest::Client::new();
    let status = |n: u16| n == 429;
    let mut refused = false;
    for _ in 0..700 {
        let r = http.get(format!("{}/api/shares/{list_id}", srv.url)).header("x-share-token", hex::encode(keys.read_token)).send().await.unwrap();
        if status(r.status().as_u16()) {
            refused = true;
            break;
        }
    }
    assert!(refused, "the address's allowance should run out");
    let (err, out) = client.tool(&token, "read_note", json!({ "note": "Gym log" })).await;
    assert!(!err && out.contains("- squats"), "Claude reads on its own allowance: {out}");
}
