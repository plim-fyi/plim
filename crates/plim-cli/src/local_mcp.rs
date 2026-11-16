//! `plim mcp`: an MCP server on stdin/stdout for an AI on this machine (Claude Code, say), that
//! is a connection like any other in Settings → Connections, not this device's vault.
//!
//! `plim mcp setup` makes the connection with the vault (as the web app's consent page does,
//! web/ui/consent.js createConnection): registered with the key it signs with, its list note (a
//! share of its own, with a holder derived from the connection's secret), and its record in the
//! encrypted index, where your Plim apps keep its notes in step with what you share with agents
//! (web/ui/connections-keep.js). It's given the notes shared with agents now, as that keeper
//! would, so it works before an app next opens. Only the connection's id and secret are kept on
//! this machine (keychain.rs), never the device's key.
//!
//! `plim mcp` then runs the connector's tools (connector::Conn) with that secret: what it can
//! open is what the connection's holders open, the notes shared with agents and nothing else;
//! the cryptography, not this process, says so. Disconnect in Settings stops it at once.

use std::io::{BufRead, Write};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use plim_core::crypto::{HeldKeys, connection_keys, holder_keys, random_bytes, seal_held_keys};
use plim_core::sig::action;
use yrs::{Any, Map, ReadTxn, Transact};

use crate::config;
use crate::connector::Conn;
use crate::keychain::{self, Kind};
use crate::session::Session;
use crate::sync::{DocSync, NoEvents, ShareHome};
use crate::vault::{finish, load_index, open_session};
use crate::writer::WriterSession;
use crate::{mcp, notes, sharing};

/// What's kept: the connection's id (16 bytes) and secret (32).
fn pack(id: &str, secret: &[u8; 32]) -> Result<Vec<u8>> {
    let mut out = hex::decode(id)?;
    out.extend_from_slice(secret);
    Ok(out)
}

fn unpack(kept: &[u8]) -> Result<(String, [u8; 32])> {
    if kept.len() != 48 {
        bail!("what's kept for plim mcp isn't readable: `plim mcp remove`, then `plim mcp setup`");
    }
    Ok((hex::encode(&kept[..16]), kept[16..].try_into()?))
}

/// The connection set up here, if there is one: (its id, its secret).
fn kept(account_id: &str) -> Result<Option<(String, [u8; 32])>> {
    keychain::find(account_id, Kind::Mcp)?.map(|(_, k)| unpack(&k)).transpose()
}

pub(crate) async fn setup(server: Option<&str>, name: &str) -> Result<()> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = if name.is_empty() { "plim mcp".into() } else { name.chars().take(60).collect() };
    let device = config::require_device()?;
    if let Some((id, _)) = kept(&device.account_id)? {
        bail!("plim mcp is already set up here (connection {}): `plim mcp remove` first to make another", &id[..8]);
    }
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let (id, secret, given) = connect_here(&sess, &mut l.index, &name).await?;
    let store = keychain::put(&device.account_id, Kind::Mcp, &pack(&id, &secret)?)?;

    eprintln!("Connected \"{name}\": it sees the notes you share with agents ({given} now), and nothing else of yours.");
    eprintln!("Its secret is {}; your own key isn't used by it.", keychain::describe(store, &device.account_id, Kind::Mcp));
    eprintln!("Disconnect it in Plim (Settings → Connections) or with `plim mcp remove`.\n");
    eprintln!("Add it to Claude Code:");
    println!("claude mcp add plim -- plim mcp");
    eprintln!("\nOr to another MCP client's settings:");
    eprintln!("{{ \"mcpServers\": {{ \"plim\": {{ \"command\": \"plim\", \"args\": [\"mcp\"] }} }} }}");
    Ok(())
}

/// A connection made with the vault, as the web app's consent page makes one, and given the notes
/// shared with agents now; saved in the index. Its id, its secret, and how many notes it was given.
pub(crate) async fn connect_here(sess: &Arc<Session>, index: &mut DocSync, name: &str) -> Result<(String, [u8; 32], usize)> {
    // The connection: registered with the key it signs with.
    let secret = random_bytes::<32>();
    let keys = connection_keys(&secret);
    let id = hex::encode(random_bytes::<16>());
    sess.api.post("/connections", &json!({ "connection_id": id, "name": name, "pubkey": B64.encode(keys.pubkey) })).await?;

    // The notes shared with agents now, each given a holder for it (shared first if it was private,
    // for it: `via`), as the keeper does; their entries go in its list.
    let mut entries: Vec<(String, notes::NoteMeta)> = Vec::new();
    let mut made_shared = Vec::new();
    for meta in notes::all(&index.doc).into_iter().filter(|m| !m.deleted && m.place.reached()) {
        let given = async {
            let mut meta = meta.clone();
            if meta.share.is_none() {
                let mut r = sharing::share(sess, index, &meta, false).await?;
                r.extra.insert("via".into(), Any::from(id.as_str()));
                notes::set_share(&index.doc, &meta.id, Some(&r));
                made_shared.push(meta.id.clone());
                meta = notes::find(&index.doc, &meta.id)?;
            }
            sharing::add_holder_for(sess, index, &meta, name, true, Some((&id, &secret))).await.map(|h| (h.id, meta))
        }
        .await;
        match given {
            Ok(e) => entries.push(e),
            Err(e) => eprintln!("warning: couldn't give it \"{}\" ({e:#}); your Plim app will, when it next opens", mcp::title_or_untitled(&meta.title)),
        }
    }

    // Its list note: a share of its own, what it was given in it, and its holder, which it finds
    // with its own secret.
    let list_id = hex::encode(random_bytes::<16>());
    let list_seed = random_bytes::<32>();
    // (Its first state made apart, in a doc of its own: written through the share's DocSync it would
    // also wait in this device's outbox as an edit, and hold up `plim logout`.)
    let doc = yrs::Doc::new();
    {
        let notes_in = doc.get_or_insert_map("notes");
        doc.get_or_insert_array("activity");
        let info = doc.get_or_insert_map("info");
        let mut txn = doc.transact_mut();
        info.insert(&mut txn, "name", name);
        info.insert(&mut txn, "notebook", true); // (what connectors from before #514 read)
        for (hid, meta) in &entries {
            let tags: Vec<Any> = meta.tags.iter().map(|t| Any::from(t.as_str())).collect();
            notes_in.insert(
                &mut txn,
                hid.as_str(),
                Any::from(std::collections::HashMap::from([
                    ("noteId".to_string(), Any::from(meta.id.as_str())),
                    ("title".to_string(), Any::from(meta.title.as_str())),
                    ("tags".to_string(), Any::Array(tags.into())),
                    ("role".to_string(), Any::from("edit")),
                    ("place".to_string(), Any::from("ai")),
                ])),
            );
        }
    }
    let state = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let list = DocSync::new_share(sess.clone(), Arc::new(ShareHome::from_seed(&list_id, &list_seed)), Arc::new(NoEvents))?;
    list.create_share(&state).await?;
    let hk = holder_keys(&keys.list_holder_secret);
    let held = HeldKeys::Edit { seed: list_seed };
    let sealed = seal_held_keys(&hk.seal_key, &keys.list_holder_id, &list_id, &held);
    sess.api
        .post(
            "/holders",
            &json!({
                "holder_id": keys.list_holder_id, "share_id": list_id, "role": held.role(),
                "token_hash": B64.encode(plim_core::sig::sha256(&hk.token)), "connection_id": id,
                "nonce": B64.encode(sealed.nonce), "ciphertext": B64.encode(&sealed.ciphertext),
            }),
        )
        .await?;

    // Its record in the index, as the web app keeps one: your apps keep its notes in step from here.
    {
        let connections = index.doc.get_or_insert_map("connections");
        let mut txn = index.doc.transact_mut();
        // (A plain object, as the web app sets it: `connectionsMap().set(id, { name, secret, … })`.)
        connections.insert(
            &mut txn,
            id.as_str(),
            Any::from(std::collections::HashMap::from([
                ("name".to_string(), Any::from(name)),
                ("secret".to_string(), Any::from(B64.encode(secret))),
                ("listShareId".to_string(), Any::from(list_id.as_str())),
                ("listSeed".to_string(), Any::from(B64.encode(list_seed))),
                ("created".to_string(), Any::from(notes::now_ms())),
                ("from".to_string(), Any::from("localhost")),
                // (where it is, as the consent page keeps it: a local one shows as "This computer")
            ])),
        );
    }
    finish(&mut [index]).await?;
    for note in made_shared {
        sharing::remove_private(sess, &note).await;
    }
    Ok((id, secret, entries.len()))
}

/// Disconnect it, and forget it here.
pub(crate) async fn remove(server: Option<&str>) -> Result<()> {
    let device = config::require_device()?;
    let Some((id, _)) = kept(&device.account_id)? else {
        bail!("plim mcp isn't set up here");
    };
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    disconnect(&sess, &mut l.index, &id).await?;
    keychain::forget(&device.account_id, Kind::Mcp);
    eprintln!("Disconnected: plim mcp can't open your notes any more. Remove it from your MCP client's settings too.");
    Ok(())
}

/// What Disconnect in Settings → Connections does (web/ui/connections.js): turned off on the server
/// at once (its holders with it) and its record gone from the index; then each note it had gets new
/// keys (one shared only for it is private again), its list note goes, and the connection.
pub(crate) async fn disconnect(sess: &Arc<Session>, index: &mut DocSync, id: &str) -> Result<()> {
    let signed = |method: reqwest::Method, path: String, act: &'static str| {
        let sess = sess.clone();
        let id = id.to_string();
        async move { sess.api.signed(&sess.identity, &sess.account_id, method, &path, act, &id).await }
    };
    match signed(reqwest::Method::POST, format!("/connections/{id}/revoke"), action::REVOKE_CONNECTION).await {
        Ok(_) | Err(crate::api::ApiError::Http(404, _)) => {}
        Err(e) => return Err(e).context("couldn't disconnect it, so it's still set up; try again"),
    }
    let list_share = {
        let connections = index.doc.get_or_insert_map("connections");
        let mut txn = index.doc.transact_mut();
        let list = match connections.get(&txn, id) {
            Some(yrs::Out::Any(Any::Map(m))) => match m.get("listShareId") {
                Some(Any::String(s)) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        };
        connections.remove(&mut txn, id);
        list
    };
    finish(&mut [index]).await?;

    // Cut off already: the rest is tidying, and a step that fails is told, not fatal.
    let its = |h: &notes::Holder| h.extra.get("connection") == Some(&Any::from(id));
    for meta in notes::all(&index.doc).into_iter().filter(|m| m.share.as_ref().is_some_and(|s| s.holders.iter().any(its))) {
        let mut r = meta.share.clone().expect("filtered");
        r.holders.retain(|h| !its(h));
        notes::set_share(&index.doc, &meta.id, Some(&r));
        let meta = notes::find(&index.doc, &meta.id)?;
        let only_for_it = r.extra.get("via") == Some(&Any::from(id)) && r.holders.is_empty();
        let done = if only_for_it { sharing::unshare(sess, index, &meta).await } else { sharing::share(sess, index, &meta, true).await.map(|_| ()) };
        if let Err(e) = done {
            eprintln!("warning: \"{}\" kept its keys ({e:#}): the connection is off, so it can't use them", mcp::title_or_untitled(&meta.title));
        }
    }
    finish(&mut [index]).await?;
    if let Some(list) = list_share {
        let _ = sharing::delete_share(sess, &list).await;
    }
    let _ = signed(reqwest::Method::DELETE, format!("/connections/{id}"), action::DELETE_CONNECTION).await;
    Ok(())
}

/// The MCP server: one JSON-RPC message (or a batch) per line on stdin, its answer on stdout.
pub(crate) async fn serve(server: Option<&str>) -> Result<()> {
    let device = config::require_device()?;
    let Some((id, secret)) = kept(&device.account_id)? else {
        bail!("plim mcp isn't set up on this machine: run `plim mcp setup` first (it sees only the notes you share with agents)");
    };
    let plim = config::server_url(server, Some(&device));
    // One writing session for this run (#505): the versions its changes leave name it.
    let session = hex::encode(random_bytes::<16>());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut out = std::io::stdout().lock();
    while let Some(line) = rx.recv().await {
        if line.trim().is_empty() {
            continue;
        }
        // (A connection opened for each message, as the connector does for each request: what it
        // was given since, or taken back, counts at once.)
        let mut conn = Conn::new(&plim, &id, secret, Some(WriterSession::of(&session)));
        let answer = match serde_json::from_str::<Value>(&line) {
            Err(e) => Some(mcp::error(Value::Null, -32700, &format!("not JSON: {e}"))),
            Ok(Value::Array(msgs)) => {
                let mut all = Vec::new();
                for m in msgs {
                    all.extend(mcp::dispatch(&mut conn, m).await);
                }
                (!all.is_empty()).then_some(Value::Array(all))
            }
            Ok(m) => mcp::dispatch(&mut conn, m).await,
        };
        if let Some(a) = answer {
            writeln!(out, "{a}")?;
            out.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::Place;
    use crate::sync_tests::{device, server, vault};

    /// A private note of `index`'s with `text`, listed.
    async fn note(sess: &Arc<Session>, index: &DocSync, text: &str) -> String {
        let text = crate::frontmatter::to_frontmatter(text);
        let id = notes::create(&index.doc, "");
        let mut private = DocSync::new(sess.clone(), &id, Arc::new(NoEvents)).unwrap();
        notes::set_body(&private.doc, &text);
        private.flush().await.unwrap();
        notes::touch(&index.doc, &id, &text, true);
        id
    }

    async fn call(conn: &mut Conn, tool: &str, args: Value) -> (bool, String) {
        let r = mcp::dispatch(conn, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } })).await.unwrap();
        (r["result"]["isError"].as_bool().unwrap(), r["result"]["content"][0]["text"].as_str().unwrap().to_string())
    }

    /// `plim mcp setup`'s connection: made with the vault, given the notes shared with agents (a
    /// private one shared for it, as the web app's keeper does), recorded in the index as the web
    /// app keeps one; and through it, with only its secret, those notes and nothing else.
    #[tokio::test]
    async fn setup_connects_to_the_notes_shared_with_agents_only() {
        let srv = server().await;
        let id = vault(&srv).await;
        let owner = device(&srv, &id).await;
        let mut index = DocSync::new(owner.clone(), "index", Arc::new(NoEvents)).unwrap();
        index.load().await.unwrap();
        let gym = note(&owner, &index, "Gym log\n#gym\n\n- squats 5x5").await;
        notes::set_place(&index.doc, &gym, Place::Notebook);
        let diary = note(&owner, &index, "Diary\n\nNot for agents.").await;
        index.flush().await.unwrap();

        let (cid, secret, given) = connect_here(&owner, &mut index, "Claude Code").await.unwrap();
        assert_eq!(given, 1);
        assert_eq!(owner.store.outbox_docs().unwrap(), Vec::<String>::new(), "nothing left waiting to upload (plim logout would refuse)");

        // The index, as the web app reads it: the note shared for it (`via`), its holder marked
        // as the connection's, the diary untouched, and the connection's record.
        let mut fresh = DocSync::new(owner.clone(), "index", Arc::new(NoEvents)).unwrap();
        fresh.load().await.unwrap();
        let shared = notes::find(&fresh.doc, &gym).unwrap().share.expect("shared for it");
        assert_eq!(shared.extra.get("via"), Some(&Any::from(cid.as_str())));
        assert_eq!(shared.holders.len(), 1);
        assert_eq!(shared.holders[0].extra.get("connection"), Some(&Any::from(cid.as_str())));
        assert!(notes::find(&fresh.doc, &diary).unwrap().share.is_none());
        let record = fresh.doc.get_or_insert_map("connections");
        let txn = fresh.doc.transact();
        let Some(yrs::Out::Any(Any::Map(r))) = record.get(&txn, &cid) else { panic!("its record in the index, a plain object as the web app keeps it") };
        for k in ["name", "secret", "listShareId", "listSeed", "from"] {
            assert!(matches!(r.get(k), Some(Any::String(_))), "{k} in {r:?}");
        }
        assert!(matches!(r.get("created"), Some(Any::Number(_))));
        drop(txn);

        // Through the connection, with nothing but its secret.
        let mut conn = Conn::new(&srv.url, &cid, secret, None);
        let (err, out) = call(&mut conn, "list_notes", json!({})).await;
        assert!(!err && out.contains("Gym log") && !out.contains("Diary"), "{out}");
        let (err, out) = call(&mut conn, "read_note", json!({ "note": "gym" })).await;
        assert!(!err && out.contains("squats 5x5"), "{out}");
        let (err, out) = call(&mut conn, "read_note", json!({ "note": "Diary" })).await;
        assert!(err && out.contains("no note matches"), "{out}");

        // A note it makes is listed in its own list, shared with agents.
        let (err, out) = call(&mut conn, "create_note", json!({ "text": "Ideas\n#ideas\n\nA local MCP." })).await;
        assert!(!err, "{out}");
        let (err, out) = call(&mut conn, "list_notes", json!({})).await;
        assert!(!err && out.contains("Ideas"), "{out}");

        // `plim mcp remove`: as Disconnect in Settings. Cut off; its record gone; the note shared
        // only for it private again, its text still there.
        disconnect(&owner, &mut index, &cid).await.unwrap();
        let (err, out) = call(&mut Conn::new(&srv.url, &cid, secret, None), "list_notes", json!({})).await;
        assert!(err && out.contains("turned off"), "{out}");
        let mut fresh = DocSync::new(owner.clone(), "index", Arc::new(NoEvents)).unwrap();
        fresh.load().await.unwrap();
        assert!(notes::find(&fresh.doc, &gym).unwrap().share.is_none(), "private again");
        let record = fresh.doc.get_or_insert_map("connections");
        assert!(record.get(&fresh.doc.transact(), &cid).is_none(), "its record gone");
        let mut private = DocSync::new(owner.clone(), &gym, Arc::new(NoEvents)).unwrap();
        private.load().await.unwrap();
        assert!(notes::body(&private.doc).contains("squats 5x5"));
        assert_eq!(owner.store.outbox_docs().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn what_is_kept_packs_and_unpacks() {
        let id = "c0ffeec0ffeec0ffeec0ffeec0ffee01";
        let packed = pack(id, &[9; 32]).unwrap();
        assert_eq!(packed.len(), 48);
        assert_eq!(unpack(&packed).unwrap(), (id.to_string(), [9; 32]));
        assert!(unpack(&packed[..40]).is_err());
    }
}
