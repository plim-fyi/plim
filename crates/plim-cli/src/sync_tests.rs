//! Sync engine tests against a real in-process server.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use plim_server::{AppState, Config, app};
use yrs::{GetString, Text, Transact};

use crate::api::Api;
use crate::notes;
use crate::session::{Keyring, Session, create_account};
use crate::sync::{Cmd, DocSync, Events, NoEvents, Rollback, ShareHome, Status};
use plim_core::crypto::{Identity, random_bytes};
use plim_core::sig::action;

pub(crate) struct Server {
    pub(crate) url: String,
    pub(crate) state: AppState,
    /// Requests it refused (4xx), counted outside every layer (a body over the limit too).
    pub(crate) refused: Arc<AtomicU64>,
}

pub(crate) async fn server() -> Server {
    server_with(1 << 20).await
}

pub(crate) async fn server_with(max_blob_bytes: usize) -> Server {
    let cfg = Config {
        db_path: ":memory:".into(),
        web_dir: ".".into(),
        pow_bits: 4,
        quota_bytes: 50 << 20,
        max_blob_bytes,
        prune_on_snapshot: false,
        admin_web_dir: ".".into(),
        proxy: Default::default(),
        public_url: None,
        version_every_secs: 3600,
        max_accounts: None,
        connector_url: None,
    };
    let state = AppState::new(cfg).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let refused = Arc::new(AtomicU64::new(0));
    let count = refused.clone();
    let router = app(state.clone()).layer(axum::middleware::map_response(move |res: axum::response::Response| {
        let count = count.clone();
        async move {
            if res.status().is_client_error() {
                count.fetch_add(1, Ordering::Relaxed);
            }
            res
        }
    }));
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    Server { url, state, refused }
}

/// A new vault, returning a factory for independent "devices" on it.
pub(crate) async fn vault(srv: &Server) -> Arc<Identity> {
    let id = Arc::new(Identity::from_seed(&random_bytes::<64>()));
    create_account(&Api::new(&srv.url), &id).await.unwrap();
    id
}

pub(crate) async fn device(srv: &Server, id: &Arc<Identity>) -> Arc<Session> {
    let api = Api::new(&srv.url);
    let login = api.login(id).await.unwrap();
    let keyring = Keyring::from_entries(id, &login.account_id, &login.keyring).unwrap();
    Session::for_test(api, id.clone(), &login.account_id, keyring)
}

#[derive(Default)]
struct Recorder {
    rollbacks: Mutex<Vec<Rollback>>,
    statuses: Mutex<Vec<Status>>,
    forged: Mutex<usize>,
}
impl Events for Recorder {
    fn forged(&self, _: &str) {
        *self.forged.lock().unwrap() += 1;
    }
    fn rollback(&self, r: Rollback) {
        self.rollbacks.lock().unwrap().push(r);
    }
    fn status(&self, _: &str, s: Status) {
        self.statuses.lock().unwrap().push(s);
    }
}

fn type_at(s: &DocSync, idx: u32, text: &str) {
    let t = notes::body_text(&s.doc);
    t.insert(&mut s.doc.transact_mut(), idx, text);
}

fn body(s: &DocSync) -> String {
    notes::body(&s.doc)
}

#[tokio::test]
async fn driver_autosaves_and_polls() {
    let srv = server().await;
    let id = vault(&srv).await;
    let (a, b) = (device(&srv, &id).await, device(&srv, &id).await);

    let mut sa = DocSync::new(a.clone(), "aa", Arc::new(NoEvents)).unwrap();
    sa.load().await.unwrap();
    let doc_a = sa.doc.clone();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(sa.drive(rx));

    // Typing on A uploads by itself within the debounce window.
    notes::body_text(&doc_a).insert(&mut doc_a.transact_mut(), 0, "autosaved");
    tokio::time::sleep(Duration::from_millis(900)).await;
    let mut sb = DocSync::new(b.clone(), "aa", Arc::new(NoEvents)).unwrap();
    sb.load().await.unwrap();
    assert_eq!(body(&sb), "autosaved");

    // B's edit reaches A through polling (5 s interval).
    type_at(&sb, 0, ">> ");
    sb.flush().await.unwrap();
    tokio::time::sleep(Duration::from_millis(5600)).await;
    assert_eq!(notes::body_text(&doc_a).get_string(&doc_a.transact()), ">> autosaved");

    let (ack, done) = tokio::sync::oneshot::channel();
    tx.send(Cmd::Stop(ack)).unwrap();
    done.await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn index_notes_round_trip_between_devices() {
    let srv = server().await;
    let id = vault(&srv).await;
    let (a, b) = (device(&srv, &id).await, device(&srv, &id).await);
    let mut ia = DocSync::new(a.clone(), "index", Arc::new(NoEvents)).unwrap();
    ia.load().await.unwrap();
    let nid = notes::create(&ia.doc, "");
    notes::touch(&ia.doc, &nid, "My title\nbody", true);
    ia.flush().await.unwrap();
    let mut ib = DocSync::new(b.clone(), "index", Arc::new(NoEvents)).unwrap();
    ib.load().await.unwrap();
    let list = notes::list(&ib.doc);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title, "My title");
    assert!(list[0].updated > 0.0);
}

// ---------- large notes ----------

fn filler(n: usize, tag: &str) -> String {
    format!("{tag} ").repeat(n / (tag.len() + 1) + 1)[..n].to_string()
}

#[tokio::test]
async fn big_inserts_become_several_updates() {
    let srv = server().await;
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    let na = DocSync::new(a.clone(), "b300", Arc::new(NoEvents)).unwrap();
    // Multi-byte characters straddle the chunk boundaries.
    let text = format!("{}é😀 end", "ü".repeat(notes::INSERT_CHUNK));
    notes::set_body(&na.doc, &text);
    assert_eq!(body(&na), text);
    assert!(a.store.outbox_list("b300").unwrap().len() >= 3);
}

#[tokio::test]
async fn a_big_editor_edit_uploads_in_pieces() {
    use crate::tui::binding;
    use yrs::Update;
    use yrs::updates::decoder::Decode;
    let srv = server_with(1 << 20).await; // the old 1 MiB limit
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    a.set_max_blob(1 << 20);
    let rec = Arc::new(Recorder::default());
    let mut na = DocSync::new(a.clone(), "b500", rec.clone()).unwrap();
    type_at(&na, 0, "notes\n");
    na.flush().await.unwrap();
    let base = binding::state_of(&na.doc);
    let edited = format!("notes\n{}", filler(1536 * 1024, "line")); // 1.5 MB: one upload would be refused
    let updates = binding::external_edit_updates(&base, &edited).unwrap();
    // As one combined update (the old behaviour) it would be refused as too large.
    assert!(yrs::merge_updates_v1(&updates).unwrap().len() > 1 << 20);
    for u in &updates {
        na.doc.transact_mut().apply_update(Update::decode_v1(u).unwrap()).unwrap();
    }
    na.flush().await.unwrap();
    // Every piece uploaded, though together they're over the limit. (The note
    // itself is now too big to compact into one snapshot, and says so.)
    assert!(!na.has_pending().unwrap(), "everything uploaded");
    assert_eq!(rec.statuses.lock().unwrap().last(), Some(&Status::TooLarge));
    let mut nb = DocSync::new(device(&srv, &id).await, "b500", Arc::new(NoEvents)).unwrap();
    nb.load().await.unwrap();
    assert_eq!(body(&nb), edited);
}

#[tokio::test]
async fn a_note_moved_elsewhere_keeps_its_unsent_edits_and_stops_retrying() {
    let srv = server().await;
    let id = vault(&srv).await;
    let (a, b) = (device(&srv, &id).await, device(&srv, &id).await);
    let mut na = DocSync::new(a.clone(), "c119", Arc::new(NoEvents)).unwrap();
    type_at(&na, 0, "before");
    na.flush().await.unwrap();
    // Another device shares the note (#119): its private doc is closed, then deleted.
    b.api.signed(&b.identity, &b.account_id, reqwest::Method::POST, "/docs/c119/close", action::CLOSE_DOC, "c119").await.unwrap();
    b.api.signed(&b.identity, &b.account_id, reqwest::Method::DELETE, "/docs/c119", action::DELETE_DOC, "c119").await.unwrap();
    // This one, not knowing, edits on: refused, kept here, not retried, nothing stored.
    let rec = Arc::new(Recorder::default());
    let mut late = DocSync::new(a.clone(), "c119", rec.clone()).unwrap();
    type_at(&late, 0, "late ");
    late.flush().await.unwrap();
    assert_eq!(rec.statuses.lock().unwrap().last(), Some(&Status::Error));
    assert!(late.has_pending().unwrap(), "kept in the outbox");
    late.flush().await.unwrap(); // no new attempt
    let doc = b.api.get("/docs/c119").await.unwrap();
    assert_eq!(doc["updates"].as_array().map(Vec::len), Some(0), "the server took nothing");
    drop(na);
}

#[tokio::test]
async fn deleting_the_account_signs_it_and_leaves_nothing() {
    let srv = server().await;
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    let mut n = DocSync::new(a.clone(), "d051", Arc::new(NoEvents)).unwrap();
    type_at(&n, 0, "a note");
    n.flush().await.unwrap();
    let other = device(&srv, &id).await; // another device's session, signed in before
    a.api.delete_account(&a.identity, &a.account_id).await.unwrap();
    // Gone: that session ends (it can't sign in again either: no such account).
    assert!(other.api.get("/docs/d051").await.is_err());
    assert!(a.api.login(&id).await.is_err());
    drop(n);
}

// ---------- shared notes (#80) ----------

/// A share made by `owner` with `text`, as the web app makes one: its first update
/// sealed with the share's key and signed with its signing key.
pub(crate) async fn make_share(owner: &Arc<Session>, seed: &[u8; 32], state: &[u8]) -> String {
    use base64::Engine;
    use ed25519_dalek::Signer;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let id = hex::encode(random_bytes::<16>());
    let k = plim_core::crypto::share_keys(seed);
    let s = plim_core::crypto::encrypt(&k.enc_key, state, &plim_core::sig::share_aad(&id, "update"));
    let sig = k.signing.sign(&plim_core::sig::share_blob_msg(&id, "update", 0, &s.nonce, &s.ciphertext));
    owner
        .api
        .post("/shares", &serde_json::json!({
            "share_id": id, "pubkey": b64(&k.pubkey), "read_hash": b64(&plim_core::sig::sha256(&k.read_token)),
            "update": { "nonce": b64(&s.nonce), "ciphertext": b64(&s.ciphertext), "sig": b64(&sig.to_bytes()) },
        }))
        .await
        .unwrap();
    id
}

pub(crate) fn text_state(text: &str) -> Vec<u8> {
    use yrs::{ReadTxn, StateVector};
    let doc = crate::sync::new_doc();
    notes::body_text(&doc).insert(&mut doc.transact_mut(), 0, text);
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test]
async fn a_shared_note_whose_links_were_turned_off_stops() {
    let srv = server().await;
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    let seed = random_bytes::<32>();
    let share = make_share(&a, &seed, &text_state("Soon gone")).await;
    a.api.signed(&a.identity, &a.account_id, reqwest::Method::POST, &format!("/shares/{share}/revoke"), action::REVOKE_SHARE, &share).await.unwrap();
    let rec = Arc::new(Recorder::default());
    let mut note = DocSync::new_share(a.clone(), Arc::new(ShareHome::from_seed(&share, &seed)), rec.clone()).unwrap();
    note.load().await.unwrap();
    assert_eq!(rec.statuses.lock().unwrap().last(), Some(&Status::LinkOff));
    assert!(!note.pull().await.unwrap(), "nothing more");
}

#[tokio::test]
async fn edits_left_for_a_note_since_shared_move_into_its_share() {
    use base64::Engine;
    let srv = server().await;
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    // A private note, uploaded; then an edit typed here that never left (offline).
    let mut private = DocSync::new(a.clone(), "e080", Arc::new(NoEvents)).unwrap();
    type_at(&private, 0, "base");
    private.flush().await.unwrap();
    let state = {
        use yrs::{ReadTxn, StateVector};
        private.doc.transact().encode_state_as_update_v1(&StateVector::default())
    };
    type_at(&private, 4, " and more");
    drop(private);
    // Meanwhile another device shared it: its text, as it was, is in a share now.
    let seed = random_bytes::<32>();
    let share = make_share(&a, &seed, &state).await;
    let link = notes::ShareRef { id: share.clone(), seed: Some(base64::engine::general_purpose::STANDARD.encode(seed)), enc_key: None, pubkey: None, role: None, ..Default::default() };
    crate::vault::flush_into_share(&a, "e080", &link).await.unwrap();
    assert!(a.store.outbox_list("e080").unwrap().is_empty(), "moved, not left behind");
    let mut read = DocSync::new_share(a.clone(), Arc::new(ShareHome::from_seed(&share, &seed)), Arc::new(NoEvents)).unwrap();
    read.load().await.unwrap();
    assert_eq!(body(&read), "base and more");
}

#[tokio::test]
async fn a_link_alone_reads_and_appends_with_no_account() {
    use base64::Engine;
    let b64url = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let srv = server().await;
    let id = vault(&srv).await;
    let owner = device(&srv, &id).await;
    let seed = random_bytes::<32>();
    let share = make_share(&owner, &seed, &text_state("Agent log")).await;
    let edit = crate::link::parse(&format!("{}/s/{share}#e.{}", srv.url, b64url(&seed))).unwrap();
    // An edit link: append a line, as a script or an agent would (no session, nothing kept).
    let mut note = crate::vault::open_link(&edit).await.unwrap();
    assert_eq!(body(&note), "Agent log");
    crate::vault::append_text(&note, "step 1 done\n");
    note.flush().await.unwrap();
    assert!(!note.has_pending().unwrap());
    let again = crate::vault::open_link(&edit).await.unwrap();
    assert_eq!(body(&again), "Agent log\nstep 1 done", "on a line of its own");
    // A view link: reads, can't write.
    let k = plim_core::crypto::share_keys(&seed);
    let view = crate::link::parse(&format!("{}/s/{share}#r.{}.{}", srv.url, b64url(&k.enc_key), b64url(&k.pubkey))).unwrap();
    let read = crate::vault::open_link(&view).await.unwrap();
    assert_eq!(body(&read), "Agent log\nstep 1 done");
    assert!(!read.writable());
    // Turned off: the link stops working.
    owner.api.signed(&owner.identity, &owner.account_id, reqwest::Method::POST, &format!("/shares/{share}/revoke"), action::REVOKE_SHARE, &share).await.unwrap();
    assert!(crate::vault::open_link(&edit).await.is_err());
}

#[tokio::test]
async fn sharing_from_the_terminal_moves_the_text_and_history_and_back() {
    let srv = server().await;
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    let mut index = DocSync::new(a.clone(), "index", Arc::new(NoEvents)).unwrap();
    index.load().await.unwrap();
    let note_id = notes::create(&index.doc, "Plan");
    let mut private = DocSync::new(a.clone(), &note_id, Arc::new(NoEvents)).unwrap();
    type_at(&private, 0, "Plan\nstep one");
    private.flush().await.unwrap();
    let three_days_ago = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 3 * 86400;
    private.save_version(b"Plan (older)", three_days_ago).await.unwrap();
    // One that says who wrote it (#505): the writer goes along with it, byte for byte.
    let writer = plim_core::version::Writer { name: Some("Claude".into()), connection: Some("plim mcp".into()), session: Some("amber fox".into()), sid: Some("9f2c41d07a3b".into()) };
    private.save_version_packed(&plim_core::version::pack_by("Plan (by Claude)", &writer), three_days_ago + 60).await.unwrap();
    index.flush().await.unwrap();
    let meta = || notes::get(&index.doc, &note_id).unwrap();
    let opened = |r: &notes::ShareRef| {
        let home = Arc::new(r.home().unwrap());
        DocSync::new_share(a.clone(), home, Arc::new(NoEvents)).unwrap()
    };

    // Share it: the text and its history in the share, the private copy gone (and closed).
    let r = crate::sharing::share(&a, &index, &meta(), false).await.unwrap();
    crate::sharing::remove_private(&a, &note_id).await;
    assert_eq!(meta().share.as_ref().map(|s| s.id.clone()), Some(r.id.clone()));
    assert_eq!(r.role.as_deref(), Some("owner"));
    let mut shared = opened(&r);
    shared.load().await.unwrap();
    assert_eq!(body(&shared), "Plan\nstep one");
    let versions = shared.versions().await.unwrap();
    assert_eq!(versions.len(), 2, "its history came along");
    assert_eq!(shared.read_version(versions[1].0).await.unwrap(), (three_days_ago, b"Plan (older)".to_vec()));
    let (at, packed) = shared.read_version_packed(versions[0].0).await.unwrap();
    assert_eq!((at, plim_core::version::unpack_version(&packed).unwrap()), (three_days_ago + 60, ("Plan (by Claude)".to_string(), Some(writer.clone()))), "and who wrote it");
    let doc = a.api.get(&format!("/docs/{note_id}")).await.unwrap();
    assert_eq!(doc["updates"].as_array().map(Vec::len), Some(0), "the private copy is gone");
    let links = crate::sharing::links(&srv.url, &note_id, &r).unwrap();
    assert!(links.edit.unwrap().contains(&format!("/n/{note_id}#k={}.e.", r.id)) && links.view.unwrap().contains(&format!("#k={}.r.", r.id)));

    // New links: the text and history in a new share; the old link stops working.
    let r2 = crate::sharing::share(&a, &index, &meta(), true).await.unwrap();
    assert_ne!(r2.id, r.id);
    let mut moved = opened(&r2);
    moved.load().await.unwrap();
    assert_eq!(body(&moved), "Plan\nstep one");
    assert_eq!(moved.versions().await.unwrap().len(), 2);
    let rec = Arc::new(Recorder::default());
    let mut old = DocSync::new_share(a.clone(), Arc::new(r.home().unwrap()), rec.clone()).unwrap();
    old.load().await.unwrap();
    assert_eq!(rec.statuses.lock().unwrap().last(), Some(&Status::LinkOff), "the old link is off");

    // Stop sharing: back in its own doc, with its history; the share's links off.
    crate::sharing::unshare(&a, &index, &meta()).await.unwrap();
    assert!(meta().share.is_none());
    let mut back = DocSync::new(a.clone(), &note_id, Arc::new(NoEvents)).unwrap();
    back.load().await.unwrap();
    assert_eq!(body(&back), "Plan\nstep one");
    let back_versions = back.versions().await.unwrap();
    assert_eq!(back_versions.len(), 2, "its history came back too");
    let (_, packed) = back.read_version_packed(back_versions[0].0).await.unwrap();
    assert_eq!(plim_core::version::unpack_version(&packed).unwrap().1, Some(writer), "with who wrote it, through two moves");
    let rec = Arc::new(Recorder::default());
    let mut gone = DocSync::new_share(a.clone(), Arc::new(r2.home().unwrap()), rec.clone()).unwrap();
    gone.load().await.unwrap();
    assert_eq!(rec.statuses.lock().unwrap().last(), Some(&Status::LinkOff));

    // Someone else's shared note in my list (a member): I can't stop sharing it.
    let member = notes::create_shared(&index.doc, "Theirs", &notes::ShareRef { role: None, ..r2.clone() }, None);
    assert!(crate::sharing::unshare(&a, &index, &notes::get(&index.doc, &member).unwrap()).await.is_err());
}

/// Your edits in the terminal keep versions as the web app's do (#505): the note as it was before a
/// session's first edit, when the last version is an interval old; not again within the interval.
#[tokio::test]
async fn your_edits_keep_versions_as_the_apps_do() {
    let srv = server().await;
    let id = vault(&srv).await;
    let a = device(&srv, &id).await;
    let note_id = uuid::Uuid::new_v4().to_string();
    let mut first = DocSync::new(a.clone(), &note_id, Arc::new(NoEvents)).unwrap();
    first.keep_history().await;
    type_at(&first, 0, "Plan");
    first.flush().await.unwrap();
    assert!(first.versions().await.unwrap().is_empty(), "a new note: nothing to keep yet");
    // Another session (the terminal opened again): its first edit keeps the note as it was.
    let mut s = DocSync::new(a.clone(), &note_id, Arc::new(NoEvents)).unwrap();
    s.load().await.unwrap();
    s.keep_history().await;
    type_at(&s, 4, "\n- one");
    s.flush().await.unwrap();
    let versions = s.versions().await.unwrap();
    assert_eq!(versions.len(), 1);
    let v = crate::commands::history::read(&s, versions[0].0).await.unwrap();
    assert_eq!((v.text.as_str(), v.writer), ("Plan", None), "yours: no writer, as the app's");
    // More edits within the interval, and another session soon after: no more.
    type_at(&s, 10, "\n- two");
    s.flush().await.unwrap();
    let mut again = DocSync::new(a.clone(), &note_id, Arc::new(NoEvents)).unwrap();
    again.load().await.unwrap();
    again.keep_history().await;
    type_at(&again, 0, "# ");
    again.flush().await.unwrap();
    assert_eq!(again.versions().await.unwrap().len(), 1, "one an interval");
    // Not kept for the note list, nor without asking.
    let mut index = DocSync::new(a.clone(), "index", Arc::new(NoEvents)).unwrap();
    index.keep_history().await;
    notes::create(&index.doc, "x");
    index.flush().await.unwrap();
    assert!(index.versions().await.is_err() || index.versions().await.unwrap().is_empty());
}
