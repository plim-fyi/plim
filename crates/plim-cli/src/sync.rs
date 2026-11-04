//! Per-document sync, ported from `web/core/sync.js`: an encrypted local outbox
//! for autosave, debounced uploads, polling, compaction, and rollback
//! detection via a shadow doc holding only server-confirmed state.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use ed25519_dalek::{Signer, SigningKey};
use plim_core::crypto::{self, open_blob, seal_blob};
use plim_core::sig::{self, blob_aad, share_aad, share_blob_msg};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::Instant;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, OffsetKind, Options, Origin, ReadTxn, StateVector, Transact, Update};

use crate::api::ApiError;
use crate::session::Session;

/// Transaction origin for changes that came from the server or the outbox,
/// so they are not queued for upload again.
pub const REMOTE: &str = "plim-remote";
const DEBOUNCE: Duration = Duration::from_millis(400);
const MAX_WAIT: Duration = Duration::from_secs(2);
pub const POLL: Duration = Duration::from_secs(5);
const COMPACT_AFTER: u64 = 100; // updates since the last snapshot…
const COMPACT_BYTES: usize = 512 * 1024; // …or bytes of them (a few big pastes are enough)

/// Save state, in increasing priority (the UI shows the highest across docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Saved,
    Saving,
    Offline,
    Error,
    /// The note is too big for one upload, or to compact: split it.
    TooLarge,
    Full,
    /// A shared note whose links were turned off (#80): nothing more syncs.
    LinkOff,
}

#[derive(Clone, Debug)]
#[allow(dead_code)] // details are for tests and diagnostics; the UI only names the doc
pub struct Rollback {
    pub doc_id: String,
    /// Number of clients whose confirmed history the server no longer has.
    pub missing: usize,
    /// The server sent updates whose predecessors are missing.
    pub incomplete: bool,
}

/// Callbacks from sync to whoever is displaying it.
pub trait Events: Send + Sync + 'static {
    fn status(&self, _doc_id: &str, _status: Status) {}
    fn rollback(&self, _r: Rollback) {}
    fn remote_change(&self, _doc_id: &str) {}
    /// A shared note's update or snapshot that wasn't signed with its key (#77): skipped.
    fn forged(&self, _doc_id: &str) {}
}

pub struct NoEvents;
impl Events for NoEvents {}

/// Receives decrypted remote updates instead of them being applied directly,
/// so a UI can apply them on its own thread in step with the editor.
pub type RemoteSink = Arc<dyn Fn(&str, Vec<u8>) + Send + Sync>;

pub fn new_doc() -> Doc {
    Doc::with_options(Options { offset_kind: OffsetKind::Bytes, ..Options::default() })
}

pub fn is_offline(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ApiError>().is_some_and(ApiError::is_offline)
}

fn api_status(e: &anyhow::Error) -> Option<u16> {
    e.downcast_ref::<ApiError>().and_then(ApiError::status)
}

fn sealed_json(b: &crypto::SealedBlob, key_version: u64, covers_seq: Option<u64>) -> Value {
    let mut v = json!({
        "key_version": key_version,
        "nonce": B64.encode(b.nonce),
        "ciphertext": B64.encode(&b.ciphertext),
        "sig": B64.encode(b.sig),
    });
    if let Some(c) = covers_seq {
        v["covers_seq"] = json!(c);
    }
    v
}

/// A shared note's keys (#80; as web/core/share.js): from an edit link's seed, or a
/// view link's encryption key (and public key). Its text lives at
/// `/api/shares/{id}`, sealed with these instead of the vault's keys.
pub struct ShareHome {
    pub id: String,
    enc_key: [u8; 32],
    /// Only with an edit link: writing needs it.
    signing: Option<SigningKey>,
    /// To check that what the server sends was written with an edit link (#77).
    /// None only for a view link from before #77: nothing to check with.
    pubkey: Option<[u8; 32]>,
    read_token: [u8; 32],
}

impl ShareHome {
    pub fn from_seed(id: &str, seed: &[u8; 32]) -> Self {
        let k = crypto::share_keys(seed);
        ShareHome { id: id.into(), enc_key: k.enc_key, signing: Some(k.signing), pubkey: Some(k.pubkey), read_token: k.read_token }
    }

    pub fn read_only(id: &str, enc_key: [u8; 32], pubkey: Option<[u8; 32]>) -> Self {
        ShareHome { id: id.into(), read_token: crypto::share_read_token(&enc_key), enc_key, signing: None, pubkey }
    }

    pub fn writable(&self) -> bool {
        self.signing.is_some()
    }

    pub fn token_hex(&self) -> String {
        hex::encode(self.read_token)
    }

    fn encrypt(&self, kind: &str, bytes: &[u8]) -> crypto::Sealed {
        crypto::encrypt(&self.enc_key, bytes, &share_aad(&self.id, kind))
    }

    /// Written with an edit link: signed with the share's key (true when there's no key to check with).
    fn signed(&self, kind: &str, blob: &Value) -> bool {
        let Some(pubkey) = self.pubkey else { return true };
        let covers = match kind {
            "snapshot" => blob["covers_seq"].as_u64().unwrap_or(0),
            "version" => blob["created_at"].as_u64().unwrap_or(0), // (a version's time is in its signature)
            _ => 0,
        };
        let field = |k: &str| B64.decode(blob[k].as_str().unwrap_or_default()).ok();
        match (field("nonce"), field("ciphertext"), field("sig")) {
            (Some(n), Some(c), Some(s)) => sig::verify(&pubkey, &share_blob_msg(&self.id, kind, covers, &n, &c), &s),
            _ => false,
        }
    }
}

/// Encrypt a local edit into the outbox (runs inside the yrs update callback).
fn enqueue(sess: &Session, doc_id: &str, share: Option<&ShareHome>, update: &[u8]) -> Result<()> {
    if let Some(share) = share {
        if !share.writable() {
            return Ok(()); // a view link: nothing to save (the editor doesn't take typing)
        }
        let s = share.encrypt("outbox", update);
        return sess.store.outbox_add(doc_id, 0, &s.nonce, &s.ciphertext);
    }
    let kr = sess.keyring.read().unwrap();
    let kv = kr.current();
    let key = kr.doc_key(kv, doc_id)?;
    let s = crypto::encrypt(&key, update, &blob_aad(&sess.account_id, doc_id, "outbox", kv));
    sess.store.outbox_add(doc_id, kv, &s.nonce, &s.ciphertext)
}

pub struct DocSync {
    pub doc_id: String,
    pub doc: Doc,
    shadow: Doc,
    sess: Arc<Session>,
    events: Arc<dyn Events>,
    /// Signalled whenever a local edit lands in the outbox.
    pub dirty: Arc<Notify>,
    pub last_seq: u64,
    pub snapshot_seq: u64,
    remembered: Option<StateVector>,
    rollback_reported: bool,
    remote_sink: Option<RemoteSink>,
    /// Ciphertext bytes of updates newer than the last snapshot, and that snapshot's size.
    bytes_since_snapshot: usize,
    snapshot_bytes: usize,
    /// The server refused an upload as too large: don't retry until the next edit.
    too_large: Arc<AtomicBool>,
    /// The whole note is too big to snapshot (it still saves, in batches).
    oversize: bool,
    /// The server takes no more writes for this doc (410, #119): the note was
    /// shared (its unsent edits then move to the share: `pending_updates`) or
    /// deleted for good. No more retries here.
    gone: bool,
    /// Where its text lives: a share (#80), or (None) its own private doc.
    share: Option<Arc<ShareHome>>,
    /// Your own edits here keep versions as the web app's do (#505: `keep_history`); None: not
    /// (the note list, and the AI tools, which keep theirs themselves).
    history: Option<History>,
}

/// The web app's rule for your edits (web/core/sync.js firstEdit, versionAfterSave): before the
/// first edit of a session, the note as it was, if the last version is an interval old; then, while
/// edits keep coming, at most one an interval.
struct History {
    every: u64,
    /// When the last version was taken (None: not looked yet, before this session's first edit).
    last_at: Option<u64>,
    last_text: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl DocSync {
    pub fn new(sess: Arc<Session>, doc_id: &str, events: Arc<dyn Events>) -> Result<Self> {
        Self::with_home(sess, doc_id, None, events)
    }

    /// A shared note (#80): its doc ID here is "share:<id>", as in the web app.
    pub fn new_share(sess: Arc<Session>, share: Arc<ShareHome>, events: Arc<dyn Events>) -> Result<Self> {
        let doc_id = format!("share:{}", share.id);
        Self::with_home(sess, &doc_id, Some(share), events)
    }

    /// Whether edits here can be saved (not a view link).
    pub fn writable(&self) -> bool {
        self.share.as_ref().is_none_or(|s| s.writable())
    }

    fn with_home(sess: Arc<Session>, doc_id: &str, share: Option<Arc<ShareHome>>, events: Arc<dyn Events>) -> Result<Self> {
        let doc = new_doc();
        let dirty = Arc::new(Notify::new());
        let too_large = Arc::new(AtomicBool::new(false));
        {
            let (sess, id, events, dirty, too_large, home) =
                (sess.clone(), doc_id.to_string(), events.clone(), dirty.clone(), too_large.clone(), share.clone());
            doc.observe_update_v1("plim-outbox", move |txn, e| {
                if txn.origin() == Some(&Origin::from(REMOTE)) {
                    return;
                }
                too_large.store(false, Ordering::Relaxed); // a new edit: worth trying again
                events.status(&id, Status::Saving);
                match enqueue(&sess, &id, home.as_deref(), &e.update) {
                    Ok(()) => dirty.notify_one(),
                    Err(_) => events.status(&id, Status::Error),
                }
            })
            .map_err(|e| anyhow!("cannot observe document: {e:?}"))?;
        }
        Ok(DocSync {
            doc_id: doc_id.into(),
            doc,
            shadow: new_doc(),
            sess,
            events,
            dirty,
            last_seq: 0,
            snapshot_seq: 0,
            remembered: None,
            rollback_reported: false,
            remote_sink: None,
            bytes_since_snapshot: 0,
            snapshot_bytes: 0,
            too_large,
            oversize: false,
            gone: false,
            share,
            history: None,
        })
    }

    /// Keep versions of your edits here as the web app does (#505): the terminal editor, `plim
    /// append`, `plim tag`. The interval is the server's (GET /account), an hour if it doesn't say.
    pub async fn keep_history(&mut self) {
        if self.doc_id == "index" || !self.writable() {
            return;
        }
        let every = match self.sess.api.get("/account").await {
            Ok(a) => a["version_every_secs"].as_u64().unwrap_or(3600),
            Err(_) => 3600,
        };
        self.history = Some(History { every, last_at: None, last_text: None });
    }

    /// Before the first upload of this session's edits: the note as the server had it, kept if the
    /// last version is an interval old (a new, empty note: nothing yet). A failure: no version this time.
    async fn version_before_first_edit(&mut self) {
        let Some(h) = &self.history else { return };
        if h.last_at.is_some() {
            return;
        }
        let (every, now, before) = (h.every, now_secs(), crate::notes::body(&self.shadow));
        let last = self.versions().await.ok().and_then(|v| v.first().map(|(_, t)| *t));
        let due = last.is_none_or(|t| now.saturating_sub(t) >= every);
        let (at, text) = if due && !before.is_empty() && self.save_version(before.as_bytes(), now).await.is_ok() {
            (now, Some(before))
        } else {
            (if due { now } else { last.unwrap_or(now) }, None)
        };
        if let Some(h) = &mut self.history {
            h.last_at = Some(at);
            h.last_text = text;
        }
    }

    /// After an upload: while edits keep coming, a version at most once an interval.
    async fn version_after_save(&mut self) {
        let Some(h) = &self.history else { return };
        let (Some(last_at), now, text) = (h.last_at, now_secs(), crate::notes::body(&self.shadow)) else { return };
        if text.is_empty() || h.last_text.as_deref() == Some(text.as_str()) || now.saturating_sub(last_at) < h.every {
            return;
        }
        if self.save_version(text.as_bytes(), now).await.is_ok()
            && let Some(h) = &mut self.history
        {
            h.last_at = Some(now);
            h.last_text = Some(text);
        }
    }

    /// From now on, hand remote updates to `sink` rather than applying them.
    pub fn set_remote_sink(&mut self, sink: RemoteSink) {
        self.remote_sink = Some(sink);
    }

    fn status(&self, s: Status) {
        // A note too big to compact still saves; keep saying so instead of "saved".
        self.events.status(&self.doc_id, if s == Status::Saved && self.oversize { Status::TooLarge } else { s });
    }

    fn max_blob(&self) -> usize {
        self.sess.max_blob()
    }

    fn seal(&self, kind: &str, bytes: &[u8], covers_seq: Option<u64>) -> Result<Value> {
        if let Some(share) = &self.share {
            let signing = share.signing.as_ref().context("a view link: this note can't be changed")?;
            let s = share.encrypt(kind, bytes);
            let covers = covers_seq.unwrap_or(0);
            let sig = signing.sign(&share_blob_msg(&share.id, kind, covers, &s.nonce, &s.ciphertext));
            let mut v = json!({ "nonce": B64.encode(s.nonce), "ciphertext": B64.encode(&s.ciphertext), "sig": B64.encode(sig.to_bytes()) });
            if let Some(c) = covers_seq {
                v["covers_seq"] = json!(c);
            }
            return Ok(v);
        }
        let kr = self.sess.keyring.read().unwrap();
        let kv = kr.current();
        let key = kr.doc_key(kv, &self.doc_id)?;
        let b = seal_blob(&self.sess.identity, &key, &self.sess.account_id, &self.doc_id, kind, kv, covers_seq.unwrap_or(0), bytes);
        Ok(sealed_json(&b, kv, covers_seq))
    }

    fn open(&self, kind: &str, key_version: u64, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        if let Some(share) = &self.share {
            return crypto::decrypt(&share.enc_key, nonce, ciphertext, &share_aad(&share.id, kind))
                .map_err(|_| anyhow!("cannot decrypt {kind} of {}", self.doc_id));
        }
        let key = self.sess.keyring.read().unwrap().doc_key(key_version, &self.doc_id)?;
        open_blob(&key, &self.sess.account_id, &self.doc_id, kind, key_version, nonce, ciphertext)
            .with_context(|| format!("cannot decrypt {kind} of {}", self.doc_id))
    }

    fn open_json(&self, kind: &str, blob: &Value) -> Result<Vec<u8>> {
        // (A shared note's blobs have no key version: one key, from its link.)
        let kv = if self.share.is_some() { 0 } else { blob["key_version"].as_u64().context("missing key_version")? };
        let nonce = B64.decode(blob["nonce"].as_str().unwrap_or_default())?;
        let ct = B64.decode(blob["ciphertext"].as_str().unwrap_or_default())?;
        self.open(kind, kv, &nonce, &ct)
    }

    fn apply_remote(&self, bytes: &[u8]) -> Result<()> {
        self.shadow.transact_mut().apply_update(Update::decode_v1(bytes)?)?;
        match &self.remote_sink {
            Some(sink) => sink(&self.doc_id, bytes.to_vec()),
            None => self.doc.transact_mut_with(REMOTE).apply_update(Update::decode_v1(bytes)?)?,
        }
        Ok(())
    }

    /// Where to upload a kind of blob: the note's doc, or its share.
    fn upload_path(&self, kind: &str) -> String {
        match &self.share {
            Some(s) => format!("/shares/{}/{kind}", s.id),
            None => format!("/docs/{}/{kind}", self.doc_id),
        }
    }

    /// GET something of this doc's (a shared note's needs its read token).
    async fn get_json(&self, path: &str) -> Result<Value> {
        Ok(match &self.share {
            Some(s) => self.sess.api.get_share(path, &s.token_hex()).await?,
            None => self.sess.api.get(path).await?,
        })
    }

    // ---- history (#60): versions, to carry them along when a note moves (#130) ----

    /// Its versions' ids and times, newest first.
    pub async fn versions(&self) -> Result<Vec<(i64, u64)>> {
        let r = self.get_json(&self.upload_path("versions")).await?;
        Ok(r["versions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v["id"].as_i64()?, v["created_at"].as_u64()?)))
            .collect())
    }

    /// Make this share on the server (POST /shares), its text `state`: its public key and
    /// a hash of its read token (what the server checks writes and reads against), and
    /// its first update, signed with its key. Needs the session of the account that owns it.
    pub async fn create_share(&self, state: &[u8]) -> Result<()> {
        self.sess.api.post("/shares", &self.share_create_body(state)?).await?;
        Ok(())
    }

    /// What makes this share on the server (POST /shares; a connection's POST /connections/{id}/shares,
    /// #369): its public key, read hash, and `state` sealed as its first update.
    pub fn share_create_body(&self, state: &[u8]) -> Result<Value> {
        let share = self.share.as_ref().context("not a shared note")?;
        let pubkey = share.pubkey.context("an edit link is needed to share")?;
        let mut update = self.seal("update", state, None)?;
        update["covers_seq"] = json!(0);
        Ok(json!({
            "share_id": share.id,
            "pubkey": B64.encode(pubkey),
            "read_hash": B64.encode(sig::sha256(&share.read_token)),
            "update": update,
        }))
    }

    /// One version's time and text (a shared note's only if signed with its key, #77).
    pub async fn read_version(&self, id: i64) -> Result<(u64, Vec<u8>)> {
        let (at, packed) = self.read_version_packed(id).await?;
        let text = plim_core::version::unpack(&packed).map_err(|e| anyhow::anyhow!("version {id}: {e}"))?;
        Ok((at, text.into_bytes()))
    }

    /// One version's time and bytes as they were packed (its writer too, #505), checked to read.
    pub(crate) async fn read_version_packed(&self, id: i64) -> Result<(u64, Vec<u8>)> {
        let blob = self.get_json(&format!("{}/{id}", self.upload_path("versions"))).await?;
        if self.share.as_ref().is_some_and(|s| !s.signed("version", &blob)) {
            bail!("version {id} isn't signed with the note's key");
        }
        let at = blob["created_at"].as_u64().context("a version without a time")?;
        let packed = self.open_json("version", &blob)?;
        plim_core::version::unpack(&packed).map_err(|e| anyhow::anyhow!("version {id}: {e}"))?;
        Ok((at, packed))
    }

    /// Keep `text` as a version taken at `at` (seconds), packed (plim-core version.rs).
    pub async fn save_version(&self, text: &[u8], at: u64) -> Result<()> {
        self.save_version_packed(&plim_core::version::pack(&String::from_utf8_lossy(text)), at).await
    }

    pub(crate) async fn save_version_packed(&self, packed: &[u8], at: u64) -> Result<()> {
        let body = self.seal("version", packed, Some(at))?;
        self.sess.api.post(&self.upload_path("versions"), &body).await?;
        Ok(())
    }

    /// Copy every version to `to` (oldest first, as they were made), keeping their times and, as
    /// packed, who wrote each (#505). Returns how many; one that can't be read is skipped.
    pub async fn copy_versions_to(&self, to: &DocSync) -> Result<usize> {
        let mut copied = 0;
        for (id, _) in self.versions().await?.into_iter().rev() {
            let Ok((at, packed)) = self.read_version_packed(id).await else { continue };
            to.save_version_packed(&packed, at).await?;
            copied += 1;
        }
        Ok(copied)
    }

    /// The whole text as one update (what the server confirmed, and what's typed here).
    pub fn state(&self) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(&StateVector::default())
    }

    /// A shared note's links were turned off: say so, and stop (no more pulls or uploads).
    fn link_off(&mut self) {
        self.gone = true;
        self.events.status(&self.doc_id, Status::LinkOff);
    }

    // ---- inbound ----

    /// Fetch and apply everything after `last_seq`. Returns whether anything changed.
    pub async fn pull(&mut self) -> Result<bool> {
        if self.gone && self.share.is_some() {
            return Ok(false);
        }
        let r = match &self.share {
            Some(s) => self.sess.api.get_share(&format!("/shares/{}/doc?after={}", s.id, self.last_seq), &s.token_hex()).await,
            None => self.sess.api.get(&format!("/docs/{}?after={}", self.doc_id, self.last_seq)).await,
        };
        let r = match r {
            Err(e) if self.share.is_some() && matches!(e.status(), Some(404 | 410)) => {
                self.link_off();
                return Ok(false);
            }
            r => r?,
        };
        let mut changed = false;
        // A shared note: only what was written with an edit link counts (#77); the rest is skipped.
        let forged = |kind: &str, blob: &Value| self.share.as_ref().is_some_and(|s| !s.signed(kind, blob));
        if !r["snapshot"].is_null() && forged("snapshot", &r["snapshot"]) {
            self.events.forged(&self.doc_id);
        } else if !r["snapshot"].is_null() {
            let bytes = self.open_json("snapshot", &r["snapshot"])?;
            self.apply_remote(&bytes)?;
            let covers = r["snapshot"]["covers_seq"].as_u64().unwrap_or(0);
            self.last_seq = self.last_seq.max(covers);
            self.snapshot_seq = covers;
            self.snapshot_bytes = blob_bytes(&r["snapshot"]);
            self.bytes_since_snapshot = 0;
            changed = true;
        }
        for u in r["updates"].as_array().into_iter().flatten() {
            if forged("update", u) {
                self.last_seq = self.last_seq.max(u["seq"].as_u64().unwrap_or(0)); // (not asked for again)
                self.events.forged(&self.doc_id);
                continue;
            }
            let bytes = self.open_json("update", u)?;
            self.apply_remote(&bytes)?;
            self.last_seq = self.last_seq.max(u["seq"].as_u64().unwrap_or(0));
            self.bytes_since_snapshot += blob_bytes(u);
            changed = true;
        }
        self.check_rollback()?;
        if changed {
            self.events.remote_change(&self.doc_id);
        }
        Ok(changed)
    }

    /// Initial load: server state (tolerating offline), then pending local edits.
    pub async fn load(&mut self) -> Result<()> {
        if let Err(e) = self.pull().await {
            if !is_offline(&e) {
                return Err(e);
            }
            self.status(Status::Offline);
        }
        let pending = self.sess.store.outbox_list(&self.doc_id)?;
        for rec in &pending {
            let bytes = self.open("outbox", rec.key_version, &rec.nonce, &rec.ciphertext)?;
            self.doc.transact_mut_with(REMOTE).apply_update(Update::decode_v1(&bytes)?)?;
        }
        if !pending.is_empty() {
            self.dirty.notify_one();
        }
        Ok(())
    }

    // ---- outbound ----

    /// This doc's unsent edits, decrypted, and their outbox ids: to move them
    /// to where the note lives now (it was shared elsewhere: #119, #80).
    pub fn pending_updates(&self) -> Result<(Vec<i64>, Vec<Vec<u8>>)> {
        let pending = self.sess.store.outbox_list(&self.doc_id)?;
        let updates = pending.iter().map(|r| self.open("outbox", r.key_version, &r.nonce, &r.ciphertext)).collect::<Result<_>>()?;
        Ok((pending.iter().map(|r| r.id).collect(), updates))
    }

    /// Apply edits as if made here (queued in this doc's outbox, then uploaded).
    /// Load it first: edits built on text it doesn't have yet would wait for that
    /// text and arrive with it, as the server's, and never upload.
    pub fn apply_local(&self, update: &[u8]) -> Result<()> {
        self.doc.transact_mut().apply_update(Update::decode_v1(update)?)?;
        Ok(())
    }

    /// Whether the server takes no more writes for it (#119, #80): for the sync cases (#441).
    #[cfg(test)]
    pub(crate) fn is_gone(&self) -> bool {
        self.gone
    }

    pub fn has_pending(&self) -> Result<bool> {
        Ok(!self.sess.store.outbox_list(&self.doc_id)?.is_empty())
    }

    /// Upload pending outbox records, merged into as few encrypted updates as
    /// fit the server's blob limit (several after a big paste or a long offline
    /// stretch). An edit too big even on its own is kept and reported, not retried.
    pub async fn flush(&mut self) -> Result<()> {
        let pending = self.sess.store.outbox_list(&self.doc_id)?;
        if pending.is_empty() {
            self.status(Status::Saved);
            return Ok(());
        }
        if self.too_large.load(Ordering::Relaxed) {
            return Ok(()); // refused as too large; retrying can't help until the note changes
        }
        if self.gone {
            return Ok(());
        }
        self.version_before_first_edit().await;
        let limit = self.max_blob();
        let result = async {
            let updates = pending
                .iter()
                .map(|r| self.open("outbox", r.key_version, &r.nonce, &r.ciphertext))
                .collect::<Result<Vec<_>>>()?;
            for batch in batches(&updates, limit / 2) {
                let ids: Vec<i64> = batch.clone().map(|i| pending[i].id).collect();
                let parts: Vec<Vec<u8>> = batch.map(|i| updates[i].clone()).collect();
                let merged = if parts.len() == 1 { parts[0].clone() } else { yrs::merge_updates_v1(&parts)? };
                if merged.len() > limit - 1024 {
                    return Err(ApiError::Http(413, "blob too large".into()).into());
                }
                let body = self.seal("update", &merged, None)?;
                let r = self.sess.api.post(&self.upload_path("updates"), &body).await?;
                self.sess.store.outbox_remove(&ids)?;
                self.confirmed(&merged)?;
                self.bytes_since_snapshot += blob_bytes(&body);
                // Directly after what we've pulled: count it as seen, so this device compacts too.
                if r["seq"].as_u64() == Some(self.last_seq + 1) {
                    self.last_seq += 1;
                }
            }
            anyhow::Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                if self.has_pending()? {
                    self.dirty.notify_one();
                } else {
                    self.status(Status::Saved);
                }
                self.version_after_save().await;
                self.maybe_compact().await;
                Ok(())
            }
            Err(e) if api_status(&e) == Some(410) => {
                // A shared note: its links were turned off. A private doc: the note was
                // shared or deleted for good elsewhere (#119). Kept in the outbox, not retried.
                if self.share.is_some() {
                    self.link_off();
                } else {
                    self.gone = true;
                    self.status(Status::Error);
                }
                Ok(())
            }
            Err(e) if api_status(&e) == Some(413) => {
                // Kept in the outbox; stop retrying until the next edit.
                self.too_large.store(true, Ordering::Relaxed);
                self.events.status(&self.doc_id, Status::TooLarge);
                Ok(())
            }
            Err(e) => {
                self.status(match () {
                    _ if api_status(&e) == Some(507) => Status::Full,
                    _ if is_offline(&e) => Status::Offline,
                    _ => Status::Error,
                });
                Err(e)
            }
        }
    }

    // ---- compaction ----

    /// Snapshot once the updates since the last snapshot are many (over
    /// `COMPACT_AFTER`) or big (more bytes than both `COMPACT_BYTES`, or half
    /// the blob limit if smaller, and the last snapshot), so loading fetches
    /// one blob instead of the whole history.
    pub async fn maybe_compact(&mut self) {
        if self.last_seq <= self.snapshot_seq {
            return;
        }
        let many = self.last_seq - self.snapshot_seq > COMPACT_AFTER;
        let big = self.bytes_since_snapshot > COMPACT_BYTES.min(self.max_blob() / 2).max(self.snapshot_bytes);
        if many || big {
            // A 409 means another device already compacted further; anything else retries later.
            let _ = self.snapshot().await;
        }
    }

    /// Upload the server-confirmed state as a snapshot covering everything up
    /// to `last_seq`. (Local edits not yet confirmed are still in the outbox and
    /// get uploaded as later updates.)
    pub async fn snapshot(&mut self) -> Result<()> {
        let covers = self.last_seq;
        let state = self.shadow.transact().encode_state_as_update_v1(&StateVector::default());
        let limit = self.max_blob();
        if state.len() > limit - 1024 {
            self.mark_oversize(true);
            return Err(anyhow!("note {} is too large to compact", self.doc_id));
        }
        self.mark_oversize(state.len() * 10 > limit * 9);
        let body = self.seal("snapshot", &state, Some(covers))?;
        self.sess.api.post(&self.upload_path("snapshots"), &body).await.inspect_err(|e| {
            if e.status() == Some(413) {
                self.mark_oversize(true);
            }
        })?;
        self.snapshot_seq = covers;
        self.snapshot_bytes = blob_bytes(&body);
        self.bytes_since_snapshot = 0;
        self.confirmed(&state)
    }

    fn mark_oversize(&mut self, on: bool) {
        if self.oversize != on {
            self.oversize = on;
            if on {
                self.events.status(&self.doc_id, Status::TooLarge);
            }
        }
    }

    // ---- rollback detection ----

    fn load_remembered(&mut self) -> Result<()> {
        if self.remembered.is_none() {
            self.remembered = Some(match self.sess.store.seen_get(&self.doc_id)? {
                Some(b) => StateVector::decode_v1(&b)?,
                None => StateVector::default(),
            });
        }
        Ok(())
    }

    fn shadow_sv(&self) -> StateVector {
        self.shadow.transact().state_vector()
    }

    /// The server stored `bytes`: count them as confirmed server state.
    fn confirmed(&mut self, bytes: &[u8]) -> Result<()> {
        self.shadow.transact_mut().apply_update(Update::decode_v1(bytes)?)?;
        self.load_remembered()?;
        self.remember(&self.shadow_sv())
    }

    /// Raise the remembered state vector (never lowers it) and persist if changed.
    fn remember(&mut self, sv: &StateVector) -> Result<()> {
        let remembered = self.remembered.as_mut().expect("loaded");
        let mut changed = false;
        for (client, clock) in sv.iter() {
            if remembered.get(client) < *clock {
                remembered.set_max(*client, *clock);
                changed = true;
            }
        }
        if changed {
            self.sess.store.seen_set(&self.doc_id, &remembered.encode_v1())?;
        }
        Ok(())
    }

    /// Compare what the server delivered against what this device saw it confirm before.
    fn check_rollback(&mut self) -> Result<()> {
        self.load_remembered()?;
        let have = self.shadow_sv();
        let remembered = self.remembered.as_ref().expect("loaded");
        let missing = remembered.iter().filter(|(c, k)| have.get(c) < **k).count();
        let incomplete = self.shadow.transact().has_missing_updates();
        if (missing > 0 || incomplete) && !self.rollback_reported {
            self.rollback_reported = true;
            self.events.rollback(Rollback { doc_id: self.doc_id.clone(), missing, incomplete });
        }
        self.remember(&have)
    }

    /// The user acknowledged a rollback: what the server has now is the new baseline.
    pub fn accept_server_state(&mut self) -> Result<()> {
        let sv = self.shadow_sv();
        self.sess.store.seen_set(&self.doc_id, &sv.encode_v1())?;
        self.remembered = Some(sv);
        self.rollback_reported = false;
        Ok(())
    }

    // ---- background driver (TUI) ----

    /// Run autosave and polling until stopped: flush 400 ms after the last
    /// edit (at most 2 s while typing), poll every 5 s, retry with backoff.
    pub async fn drive(mut self, mut cmds: mpsc::UnboundedReceiver<Cmd>) {
        let mut poll = tokio::time::interval_at(Instant::now() + POLL, POLL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let (mut debounce, mut max_wait, mut retry): (Option<Instant>, Option<Instant>, Option<Instant>) = (None, None, None);
        let mut backoff = Duration::from_secs(1);
        let dirty = self.dirty.clone();
        loop {
            let deadline = [debounce, max_wait, retry].into_iter().flatten().min();
            tokio::select! {
                _ = dirty.notified() => {
                    let now = Instant::now();
                    debounce = Some(now + DEBOUNCE);
                    max_wait.get_or_insert(now + MAX_WAIT);
                }
                _ = sleep_opt(deadline) => {
                    (debounce, max_wait, retry) = (None, None, None);
                    match self.flush().await {
                        Ok(()) => backoff = Duration::from_secs(1),
                        Err(_) => {
                            retry = Some(Instant::now() + backoff);
                            backoff = (backoff * 2).min(Duration::from_secs(30));
                        }
                    }
                }
                _ = poll.tick() => {
                    if let Err(e) = self.pull().await
                        && !is_offline(&e)
                    {
                        self.status(Status::Error);
                    }
                    self.maybe_compact().await;
                }
                cmd = cmds.recv() => match cmd {
                    Some(Cmd::AcceptServerState) => {
                        let _ = self.accept_server_state();
                    }
                    Some(Cmd::Stop(ack)) => {
                        let _ = self.flush().await;
                        let _ = ack.send(());
                        break;
                    }
                    None => {
                        let _ = self.flush().await;
                        break;
                    }
                },
            }
        }
        let _ = self.doc.unobserve_update_v1("plim-outbox");
    }
}

pub enum Cmd {
    AcceptServerState,
    Stop(oneshot::Sender<()>),
}

async fn sleep_opt(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// Size of a blob's ciphertext, from its base64.
fn blob_bytes(blob: &Value) -> usize {
    blob["ciphertext"].as_str().map_or(0, |c| c.len() * 3 / 4)
}

/// Group updates, in order, into index ranges whose sizes add up to at most
/// `limit` bytes (at least one update per range).
fn batches(updates: &[Vec<u8>], limit: usize) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let (mut start, mut size) = (0, 0);
    for (i, u) in updates.iter().enumerate() {
        if i > start && size + u.len() > limit {
            out.push(start..i);
            (start, size) = (i, 0);
        }
        size += u.len();
    }
    if start < updates.len() {
        out.push(start..updates.len());
    }
    out
}
