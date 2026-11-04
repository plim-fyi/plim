//! The note model shared with the web app (see `web/app.js`):
//! doc `index` holds `Map("notes")`: id → Map{title, tags, created, updated, deleted, place};
//! each note is its own doc with `Text("body")`. A note's title and tags (#308) are its
//! text's, kept beside it for the list (which doesn't open every note): written whenever a
//! client writes the note. Its place (#484) isn't its text's: only the user moves a note.

use anyhow::{Result, bail};
use crate::grants::Place;
use yrs::any::Number;
use yrs::{Any, Doc, GetString, Map, MapPrelim, MapRef, Out, Text, TextRef, Transact};

pub const TITLE_MAX: usize = 80;
/// While typing, `updated` is bumped at most this often (ms).
const UPDATED_THROTTLE_MS: f64 = 30_000.0;

#[derive(Clone, Debug, PartialEq)]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    /// Its tags (#308), as last written with its text: in lower case, sorted (crate::tags).
    pub tags: Vec<String>,
    /// Whether its tags have been read at all (a note last written before tags were kept: not yet).
    pub tags_read: bool,
    pub created: f64,
    pub updated: f64,
    pub deleted: bool,
    /// A shared note (#70): its text is in its share (`/api/shares/{id}`), not a private doc.
    pub shared: bool,
    /// Its link, when shared (#80).
    pub share: Option<ShareRef>,
    /// Where it lives (#484): your notes or the AI notebook, as the index keeps it.
    pub place: Place,
}

/// A shared note's link, as the note list keeps it (web/app.js: `{ id, seed | encKey
/// (+ pubkey), role }`): an edit link's seed, or a view link's key (and public key).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ShareRef {
    pub id: String,
    pub seed: Option<String>,
    pub enc_key: Option<String>,
    pub pubkey: Option<String>,
    /// "owner" (shared it: may replace the links or stop sharing) or "member".
    pub role: Option<String>,
    /// Shared with you through a link of your own (#369): the holder, whose row on the server
    /// says which share the note is in now and holds its keys (`home` can't: sharing::home_of).
    pub holder: Option<HolderRef>,
    /// A note of yours: the people with a link of their own (#369), as the web app keeps them.
    pub holders: Vec<Holder>,
}

/// A link of your own to someone's note: its holder's id and secret (base64).
#[derive(Clone, Debug, PartialEq)]
pub struct HolderRef {
    pub id: String,
    pub secret: String,
}

/// Someone with a link of their own to a note of yours: `{ id, secret, role, label, created }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Holder {
    pub id: String,
    pub secret: String,
    pub role: String,
    pub label: String,
    pub created: f64,
}

fn any_str(m: &std::collections::HashMap<String, Any>, k: &str) -> Option<String> {
    match m.get(k) {
        Some(Any::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

impl ShareRef {
    fn from_any(v: &Any) -> Option<Self> {
        let Any::Map(m) = v else { return None };
        let s = |k: &str| any_str(m, k);
        let holder = match m.get("holder") {
            Some(Any::Map(h)) => Some(HolderRef { id: any_str(h, "id")?, secret: any_str(h, "secret")? }),
            _ => None,
        };
        let holders = match m.get("holders") {
            Some(Any::Array(items)) => items
                .iter()
                .filter_map(|h| {
                    let Any::Map(h) = h else { return None };
                    let created = match h.get("created") {
                        Some(Any::Number(n)) => n.as_f64().unwrap_or(0.0),
                        _ => 0.0,
                    };
                    Some(Holder { id: any_str(h, "id")?, secret: any_str(h, "secret")?, role: any_str(h, "role").unwrap_or_else(|| "read".into()), label: any_str(h, "label").unwrap_or_default(), created })
                })
                .collect(),
            _ => Vec::new(),
        };
        Some(ShareRef { id: s("id")?, seed: s("seed"), enc_key: s("encKey"), pubkey: s("pubkey"), role: s("role"), holder, holders })
    }

    /// Its keys (an edit link's, or a view link's: then it can't be written).
    pub fn home(&self) -> Result<crate::sync::ShareHome> {
        use base64::Engine;
        use base64::engine::general_purpose::STANDARD as B64;
        let key = |b64: &str| -> Result<[u8; 32]> {
            B64.decode(b64)?.try_into().map_err(|_| anyhow::anyhow!("a shared note's key isn't 32 bytes"))
        };
        match (&self.seed, &self.enc_key) {
            (Some(seed), _) => Ok(crate::sync::ShareHome::from_seed(&self.id, &key(seed)?)),
            (None, Some(enc)) => Ok(crate::sync::ShareHome::read_only(&self.id, key(enc)?, self.pubkey.as_deref().map(key).transpose()?)),
            (None, None) if self.holder.is_some() => bail!("this note is shared with you through a link of your own: its keys come from the server (sharing::home_of)"),
            (None, None) => bail!("this shared note's link has no key"),
        }
    }
}

// The time, as the server's clock has it (#58; as web/core/clock.js). Times written
// into notes come from it, so a device with a wrong clock doesn't sort its
// notes wrongly for everyone. Each API answer's Date header (api.rs) says how
// far this clock is off; under SKEW_MS counts as right (Date has whole seconds).
const SKEW_MS: f64 = 10_000.0;
const MAX_ROUND_TRIP_MS: f64 = 10_000.0;
static OFFSET_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn device_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// Now, in ms, by the server's clock (as far as we know it).
pub fn now_ms() -> f64 {
    device_ms() + OFFSET_MS.load(std::sync::atomic::Ordering::Relaxed) as f64
}

/// This device's clock now, for timing a request (api.rs).
pub fn device_now_ms() -> f64 {
    device_ms()
}

/// The offset an answer implies: its Date (whole seconds, so +500 ms) against
/// the middle of the round trip; `current` if it can't tell.
pub fn offset_from(date: Option<&str>, sent_ms: f64, received_ms: f64, current: i64) -> i64 {
    let Some(server) = date.and_then(|d| httpdate::parse_http_date(d).ok()) else { return current };
    if received_ms - sent_ms > MAX_ROUND_TRIP_MS {
        return current;
    }
    let server_ms = server.duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
    let off = server_ms + 500.0 - (sent_ms + received_ms) / 2.0;
    if off.abs() < SKEW_MS { 0 } else { off.round() as i64 }
}

/// api.rs: after each answer.
pub fn saw_server_date(date: Option<&str>, sent_ms: f64, received_ms: f64) {
    let current = OFFSET_MS.load(std::sync::atomic::Ordering::Relaxed);
    OFFSET_MS.store(offset_from(date, sent_ms, received_ms, current), std::sync::atomic::Ordering::Relaxed);
}

pub fn notes_map(index: &Doc) -> MapRef {
    index.get_or_insert_map("notes")
}

pub fn body_text(note: &Doc) -> TextRef {
    note.get_or_insert_text("body")
}

pub fn body(note: &Doc) -> String {
    let text = body_text(note);
    text.get_string(&note.transact())
}

fn as_f64(v: Option<Out>) -> f64 {
    opt_f64(v).unwrap_or(0.0)
}

fn opt_f64(v: Option<Out>) -> Option<f64> {
    match v {
        Some(Out::Any(Any::Number(n))) => n.as_f64(),
        _ => None,
    }
}

fn as_string(v: Option<Out>) -> String {
    match v {
        Some(Out::Any(Any::String(s))) => s.to_string(),
        _ => String::new(),
    }
}

/// A list of strings (a note's tags); anything else in it left out.
fn as_strings(v: Option<Out>) -> Vec<String> {
    match v {
        Some(Out::Any(Any::Array(a))) => a.iter().filter_map(|x| if let Any::String(s) = x { Some(s.to_string()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

fn strings_any(v: &[String]) -> Any {
    Any::Array(v.iter().map(|s| Any::from(s.as_str())).collect::<Vec<_>>().into())
}

fn meta<T: yrs::ReadTxn>(txn: &T, id: &str, v: Out) -> Option<NoteMeta> {
    let Out::YMap(m) = v else { return None };
    Some(NoteMeta {
        id: id.to_string(),
        title: as_string(m.get(txn, "title")),
        tags: as_strings(m.get(txn, "tags")),
        tags_read: m.get(txn, "tags").is_some(),
        created: as_f64(m.get(txn, "created")),
        updated: as_f64(m.get(txn, "updated")),
        deleted: matches!(m.get(txn, "deleted"), Some(Out::Any(Any::Bool(true)))),
        shared: !matches!(m.get(txn, "share"), None | Some(Out::Any(Any::Null | Any::Undefined))),
        share: match m.get(txn, "share") {
            Some(Out::Any(a)) => ShareRef::from_any(&a),
            _ => None,
        },
        place: Place::from_index(Some(as_string(m.get(txn, "place")).as_str())),
    })
}

/// One note (deleted ones too).
pub fn get(index: &Doc, id: &str) -> Option<NoteMeta> {
    let notes = notes_map(index); // before the read transaction: it may need to write
    let txn = index.transact();
    notes.get(&txn, id).and_then(|v| meta(&txn, id, v))
}

/// Whether a deleted note is gone for good (Recently deleted emptied, #190): its entry kept only
/// so devices agree it's gone.
pub fn purged(index: &Doc, id: &str) -> bool {
    let notes = notes_map(index);
    let txn = index.transact();
    match notes.get(&txn, id) {
        Some(Out::YMap(m)) => matches!(m.get(&txn, "purged"), Some(Out::Any(Any::Bool(true)))),
        _ => false,
    }
}

/// All notes including deleted ones, newest first.
pub fn all(index: &Doc) -> Vec<NoteMeta> {
    let notes = notes_map(index);
    let txn = index.transact();
    let mut out: Vec<NoteMeta> = notes.iter(&txn).filter_map(|(id, v)| meta(&txn, id, v)).collect();
    // A time from the future (a device with its clock ahead wrote it) sorts as now, not first forever.
    let now = now_ms();
    out.sort_by(|a, b| b.updated.min(now).total_cmp(&a.updated.min(now)).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Visible (non-deleted) notes, newest first.
pub fn list(index: &Doc) -> Vec<NoteMeta> {
    all(index).into_iter().filter(|n| !n.deleted).collect()
}

/// When a note was made; one without a created time (none should be) counts by its last edit.
pub fn created_or_updated(n: &NoteMeta) -> f64 {
    if n.created > 0.0 { n.created } else { n.updated }
}

/// Notes by when each was made, newest first (#344, as web/core/notesort.js): a time from the future
/// counts as now, ties go by id.
pub fn sort_by_created(list: &mut [&NoteMeta]) {
    let now = now_ms();
    list.sort_by(|a, b| created_or_updated(b).min(now).total_cmp(&created_or_updated(a).min(now)).then_with(|| a.id.cmp(&b.id)));
}

/// Its frontmatter's title (#584), else its first non-empty line, without its markdown marks
/// (`title_from_line`), capped.
pub fn title_from_body(body: &str) -> String {
    crate::frontmatter::note_title(body).chars().take(TITLE_MAX).collect()
}

/// A line, as a title, the way the web app lists it (web/core/title.js; the cases
/// both pass are in web/tests/fixtures/titles.json): heading, quote, list and
/// task marks at its start go, as do links' brackets and bold, strike and code
/// marks. "# Trip to Lisbon" is "Trip to Lisbon".
pub fn title_from_line(line: &str) -> String {
    let trimmed = line.trim();
    let mut t = trimmed;
    // (Repeated: "> - [ ] Call Ana" is a task in a list in a quote.)
    loop {
        let next = strip_block_mark(t);
        if next.len() == t.len() {
            break;
        }
        t = next;
    }
    let t = strip_inline_marks(t);
    let t = t.trim();
    // (A line that's only marks, like "---", stays as it is.)
    if t.is_empty() { trimmed.to_string() } else { t.to_string() }
}

/// `s` after its leading whitespace, if it starts with whitespace or is empty (a mark must end there).
fn after_space(s: &str) -> Option<&str> {
    (s.is_empty() || s.starts_with(char::is_whitespace)).then(|| s.trim_start())
}

fn strip_block_mark(t: &str) -> &str {
    let hashes = t.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes)
        && let Some(rest) = after_space(&t[hashes..])
    {
        return rest;
    }
    if let Some(rest) = t.strip_prefix('>') {
        return rest.trim_start();
    }
    if let Some(rest) = t.strip_prefix(['-', '*', '+'])
        && let Some(rest) = after_space(rest)
    {
        return rest;
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if (1..=9).contains(&digits)
        && let Some(rest) = t[digits..].strip_prefix(['.', ')'])
        && let Some(rest) = after_space(rest)
    {
        return rest;
    }
    for task in ["[ ]", "[x]", "[X]"] {
        if let Some(rest) = t.strip_prefix(task)
            && let Some(rest) = after_space(rest)
        {
            return rest;
        }
    }
    t
}

/// Links keep their text ("[text](url)" → "text"); "**", "__", "~~" and "`" go.
fn strip_inline_marks(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut rest = t;
    while let Some(c) = rest.chars().next() {
        if c == '['
            && let Some(close) = rest[1..].find(']').map(|i| i + 1)
            && rest[close + 1..].starts_with('(')
            && let Some(end) = rest[close + 2..].find(')').map(|i| i + close + 2)
        {
            out.push_str(&rest[1..close]);
            rest = &rest[end + 1..];
        } else if ["**", "__", "~~"].iter().any(|m| rest.starts_with(m)) {
            rest = &rest[2..];
        } else if c == '`' {
            rest = &rest[1..];
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

pub fn create(index: &Doc, title: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let notes = notes_map(index);
    let mut txn = index.transact_mut();
    notes.insert(
        &mut txn,
        id.as_str(),
        MapPrelim::from([
            ("title", Any::from(title)),
            ("created", Any::Number(Number::Float(now))),
            ("updated", Any::Number(Number::Float(now))),
            ("deleted", Any::Bool(false)),
        ]),
    );
    id
}

impl ShareRef {
    /// As the note list keeps it: a plain object, as the web app writes it.
    fn to_any(&self) -> Any {
        let mut fields = std::collections::HashMap::from([("id".to_string(), Any::from(self.id.as_str()))]);
        for (k, v) in [("seed", &self.seed), ("encKey", &self.enc_key), ("pubkey", &self.pubkey), ("role", &self.role)] {
            if let Some(v) = v {
                fields.insert(k.to_string(), Any::from(v.as_str()));
            }
        }
        if let Some(h) = &self.holder {
            fields.insert("holder".into(), Any::from(std::collections::HashMap::from([("id".to_string(), Any::from(h.id.as_str())), ("secret".to_string(), Any::from(h.secret.as_str()))])));
        }
        if !self.holders.is_empty() {
            let items: Vec<Any> = self
                .holders
                .iter()
                .map(|h| {
                    Any::from(std::collections::HashMap::from([
                        ("id".to_string(), Any::from(h.id.as_str())),
                        ("secret".to_string(), Any::from(h.secret.as_str())),
                        ("role".to_string(), Any::from(h.role.as_str())),
                        ("label".to_string(), Any::from(h.label.as_str())),
                        ("created".to_string(), Any::Number(Number::Float(h.created))),
                    ]))
                })
                .collect();
            fields.insert("holders".into(), Any::Array(items.into()));
        }
        Any::from(fields)
    }
}

/// Where a note lives (#130): `Some` its share (it was shared, or its links replaced),
/// `None` its own doc again (sharing stopped).
pub fn set_share(index: &Doc, id: &str, share: Option<&ShareRef>) {
    let Some(m) = note_map(index, id) else { return };
    let mut txn = index.transact_mut();
    match share {
        Some(s) => {
            m.insert(&mut txn, "share", s.to_any());
        }
        None => {
            m.remove(&mut txn, "share");
        }
    }
}

/// Add a shared note to the list from its link (#130; the web app's "Add to my notes"):
/// its text stays in the share; the list keeps the link's keys, as a member's. `id`: the
/// note's id from the link's address (#299), else a new one.
pub fn create_shared(index: &Doc, title: &str, share: &ShareRef, id: Option<&str>) -> String {
    let id = id.map_or_else(|| uuid::Uuid::new_v4().to_string(), String::from);
    let now = now_ms();
    let share = ShareRef { role: Some("member".into()), ..share.clone() };
    let notes = notes_map(index);
    let mut txn = index.transact_mut();
    notes.insert(
        &mut txn,
        id.as_str(),
        MapPrelim::from([
            ("title", Any::from(title)),
            ("created", Any::Number(Number::Float(now))),
            ("updated", Any::Number(Number::Float(now))),
            ("deleted", Any::Bool(false)),
            ("share", share.to_any()),
        ]),
    );
    id
}

/// The note (in a list) whose share this is, if any.
pub fn with_share(index: &Doc, share_id: &str) -> Option<NoteMeta> {
    all(index).into_iter().find(|n| !n.deleted && n.share.as_ref().is_some_and(|s| s.id == share_id))
}

fn note_map(index: &Doc, id: &str) -> Option<MapRef> {
    let notes = notes_map(index);
    let txn = index.transact();
    match notes.get(&txn, id) {
        Some(Out::YMap(m)) => Some(m),
        _ => None,
    }
}

/// Keep the index entry in step with the body: title from the first line,
/// A note's stored tags put right, from its text as it is (read, not written: `updated` stays).
/// Whether they changed.
pub fn set_tags(index: &Doc, id: &str, body: &str) -> bool {
    let Some(m) = note_map(index, id) else { return false };
    let tags = crate::frontmatter::note_tags(body);
    let stored = m.get(&index.transact(), "tags");
    if stored.is_some() && as_strings(stored) == tags {
        return false;
    }
    m.insert(&mut index.transact_mut(), "tags", strings_any(&tags));
    true
}

/// Its title and tags, from its text, and `updated` bumped (throttled unless `force`).
pub fn touch(index: &Doc, id: &str, body: &str, force: bool) {
    let Some(m) = note_map(index, id) else { return };
    if matches!(m.get(&index.transact(), "deleted"), Some(Out::Any(Any::Bool(true)))) {
        return; // (a deleted note's edits here are kept by keep_edit, not by its time here)
    }
    let title = title_from_body(body);
    let tags = crate::frontmatter::note_tags(body);
    let now = now_ms();
    let (old_title, old_tags, old_updated) = {
        let txn = index.transact();
        let tags = m.get(&txn, "tags");
        (as_string(m.get(&txn, "title")), tags.is_some().then(|| as_strings(tags)), as_f64(m.get(&txn, "updated")))
    };
    // (Also when it's from the future: a device with its clock ahead wrote it.)
    let bump = force || now - old_updated > UPDATED_THROTTLE_MS || old_updated - now > UPDATED_THROTTLE_MS;
    let new_tags = old_tags.as_ref() != Some(&tags);
    if old_title == title && !new_tags && !bump {
        return;
    }
    let mut txn = index.transact_mut();
    if old_title != title {
        m.insert(&mut txn, "title", title);
    }
    if new_tags {
        m.insert(&mut txn, "tags", strings_any(&tags));
    }
    if bump {
        m.insert(&mut txn, "updated", Any::Number(Number::Float(now)));
        // (Edited here: by you, unless an app says so after, set_last_by.)
        if m.get(&txn, "lastBy").is_some() {
            m.remove(&mut txn, "lastBy");
        }
    }
}

/// The app that edited the note last (#389), for the note list's "by Claude"; as web/ui/note.js. And
/// among the note's writers (#552: the Connected view, its letter on the row), once each, a name
/// told apart without its case, as web/core/connections-sync.js addWriter. And when it wrote, in
/// `wroteAt` (name → ms, #564: Connected's table of who writes), under its name as first written.
pub fn set_last_by(index: &Doc, id: &str, app: &str) {
    set_last_by_at(index, id, app, now_ms());
}

fn set_last_by_at(index: &Doc, id: &str, app: &str, at: f64) {
    let Some(m) = note_map(index, id) else { return };
    let (mut writers, mut times) = {
        let txn = index.transact();
        let times: std::collections::HashMap<String, Any> = match m.get(&txn, "wroteAt") {
            Some(Out::Any(Any::Map(t))) => t.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            _ => Default::default(),
        };
        (as_strings(m.get(&txn, "writers")), times)
    };
    let mut txn = index.transact_mut();
    m.insert(&mut txn, "lastBy", app);
    if app.trim().is_empty() {
        return;
    }
    if !writers.iter().any(|w| w.to_lowercase() == app.to_lowercase()) {
        writers.push(app.to_string());
        m.insert(&mut txn, "writers", strings_any(&writers));
    }
    let key = times.keys().find(|k| k.to_lowercase() == app.to_lowercase()).cloned().unwrap_or_else(|| app.to_string());
    let was = match times.get(&key) {
        Some(Any::Number(n)) => n.as_f64(),
        _ => None,
    };
    if was.is_none_or(|w| w < at) {
        times.insert(key, Any::Number(Number::Float(at)));
        m.insert(&mut txn, "wroteAt", Any::Map(std::sync::Arc::new(times)));
    }
}

/// Where the note lives (#484): the AI notebook ("ai") or your notes (none).
pub fn set_place(index: &Doc, id: &str, place: Place) {
    let Some(m) = note_map(index, id) else { return };
    let mut txn = index.transact_mut();
    match place {
        Place::Notebook => {
            m.insert(&mut txn, "place", "ai");
        }
        Place::Mine => {
            m.remove(&mut txn, "place");
        }
    }
}

/**
 * An app's editing session, recorded in the note it writes in (#389; web/core/authorship.js reads it):
 * its Yjs client id → whose (`name`), through what (`connection`), which session if it says
 * (`session`, its two words, #505) and when. The text it types keeps that client id, so the
 * owner's apps can tell it from theirs.
 */
pub fn mark_session(doc: &Doc, name: &str, connection: &str, session: Option<&str>) {
    let authors = doc.get_or_insert_map("authors");
    let mut fields = std::collections::HashMap::from([
        ("name".to_string(), Any::from(name)),
        ("connection".to_string(), Any::from(connection)),
        ("at".to_string(), Any::Number(Number::Float(now_ms()))),
    ]);
    if let Some(s) = session {
        fields.insert("session".to_string(), Any::from(s));
    }
    let record = Any::Map(std::sync::Arc::new(fields));
    authors.insert(&mut doc.transact_mut(), doc.client_id().to_string(), record);
}

/// Into Recently deleted (as web/core/trash.js deleteNote): when, and the `updated`
/// it saw, so edits it hadn't seen bring the note back (#54, revive_edited).
pub fn delete(index: &Doc, id: &str) {
    let Some(m) = note_map(index, id) else { return };
    let seen = as_f64(m.get(&index.transact(), "updated"));
    let mut txn = index.transact_mut();
    m.insert(&mut txn, "deleted", true);
    m.insert(&mut txn, "deletedAt", Any::Number(Number::Float(now_ms())));
    m.insert(&mut txn, "deletedSeen", Any::Number(Number::Float(seen)));
}

/// Deleted, and edited here at `edited_at` after what the deletion saw: the
/// note's `updated` becomes that time (edits here only move it every 30 s), so
/// revive_edited brings it back.
pub fn keep_edit(index: &Doc, id: &str, edited_at: f64) {
    let Some(m) = note_map(index, id) else { return };
    let (deleted, purged, seen, updated) = {
        let txn = index.transact();
        let flag = |k| matches!(m.get(&txn, k), Some(Out::Any(Any::Bool(true))));
        (flag("deleted"), flag("purged"), opt_f64(m.get(&txn, "deletedSeen")), as_f64(m.get(&txn, "updated")))
    };
    if deleted && !purged && seen.is_some_and(|s| edited_at > s) && edited_at > updated {
        m.insert(&mut index.transact_mut(), "updated", Any::Number(Number::Float(edited_at)));
    }
}

/// Deleted notes edited since, where the deletion wasn't seen (another device,
/// offline): back in the list (as web/core/trash.js reviveEdited). Deletions without
/// `deletedSeen` (older ones) are left be. Returns the titles brought back.
pub fn revive_edited(index: &Doc) -> Vec<String> {
    let notes = notes_map(index);
    let back: Vec<(String, MapRef, String)> = {
        let txn = index.transact();
        notes
            .iter(&txn)
            .filter_map(|(id, v)| match v {
                Out::YMap(m) => Some((id.to_string(), m)),
                _ => None,
            })
            .filter(|(_, m)| {
                let flag = |k| matches!(m.get(&txn, k), Some(Out::Any(Any::Bool(true))));
                let seen = opt_f64(m.get(&txn, "deletedSeen"));
                flag("deleted") && !flag("purged") && seen.is_some_and(|s| as_f64(m.get(&txn, "updated")) > s)
            })
            .map(|(id, m)| {
                let title = as_string(m.get(&txn, "title"));
                (id, m, title)
            })
            .collect()
    };
    if back.is_empty() {
        return Vec::new();
    }
    let mut txn = index.transact_mut();
    for (_, m, _) in &back {
        m.insert(&mut txn, "deleted", false);
        m.remove(&mut txn, "deletedAt");
        m.remove(&mut txn, "deletedSeen");
    }
    back.into_iter().map(|(_, _, title)| title).collect()
}

pub fn set_body(note: &Doc, body: &str) {
    let text = body_text(note);
    {
        let mut txn = note.transact_mut();
        let len = text.len(&txn);
        if len > 0 {
            text.remove_range(&mut txn, 0, len);
        }
    }
    insert_chunked(note, 0, body);
}

/// Largest insert done in one transaction: bigger text (a big paste) goes in
/// as several, so each becomes its own update instead of one too large to upload.
pub const INSERT_CHUNK: usize = 128 * 1024;

/// Insert `s` at byte offset `index` of the body, in pieces of at most
/// `INSERT_CHUNK` bytes (split on character boundaries), one transaction each.
pub fn insert_chunked(note: &Doc, index: u32, s: &str) {
    let text = body_text(note);
    let mut at = index;
    let mut rest = s;
    while !rest.is_empty() {
        let mut end = rest.len().min(INSERT_CHUNK);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (piece, tail) = rest.split_at(end);
        text.insert(&mut note.transact_mut(), at, piece);
        at += piece.len() as u32;
        rest = tail;
    }
}

/// Find a visible note by id (or id prefix) or title (exact, then substring; case-insensitive).
pub fn find(index: &Doc, query: &str) -> Result<NoteMeta> {
    find_in(&list(index), query)
}

/// The note `query` names among `notes` (the connector's: only those in its scope, #366), as `find`.
pub fn find_in(notes: &[NoteMeta], query: &str) -> Result<NoteMeta> {
    let q = query.to_lowercase();
    let tiers: [&dyn Fn(&NoteMeta) -> bool; 3] = [
        &|n| n.id == query || (query.len() >= 4 && n.id.starts_with(query)),
        &|n| n.title.to_lowercase() == q,
        &|n| n.title.to_lowercase().contains(&q),
    ];
    for matches in tiers {
        let hits: Vec<_> = notes.iter().filter(|n| matches(n)).collect();
        match hits.len() {
            0 => continue,
            1 => return Ok(hits[0].clone()),
            _ => bail!(
                "\"{query}\" matches {} notes: {} — use the id",
                hits.len(),
                hits.iter().map(|n| format!("{} ({})", n.title, &n.id[..8])).collect::<Vec<_>>().join(", ")
            ),
        }
    }
    bail!("no note matches \"{query}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "By Claude" (#389) and among the note's writers, once each (#552), as the app's addWriter.
    #[test]
    fn last_by_and_writers() {
        let index = Doc::new();
        let id = create(&index, "Log");
        set_last_by(&index, &id, "Claude");
        set_last_by(&index, &id, "Backup script");
        set_last_by(&index, &id, "claude");
        let m = note_map(&index, &id).unwrap();
        let txn = index.transact();
        assert_eq!(as_strings(m.get(&txn, "writers")), ["Claude", "Backup script"]);
        assert!(matches!(m.get(&txn, "lastBy"), Some(Out::Any(Any::String(s))) if &*s == "claude"));
    }

    /// When each wrote (#564), its latest, under its name as first written, as the app's addWriter.
    #[test]
    fn wrote_at() {
        let index = Doc::new();
        let id = create(&index, "Log");
        set_last_by_at(&index, &id, "Gym review", 9.0);
        set_last_by_at(&index, &id, "gym review", 5.0);
        set_last_by_at(&index, &id, "Claude", 7.0);
        let m = note_map(&index, &id).unwrap();
        let txn = index.transact();
        let Some(Out::Any(Any::Map(t))) = m.get(&txn, "wroteAt") else { panic!("no wroteAt") };
        let mut got: Vec<_> = t.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got, [("Claude".to_string(), Any::Number(Number::Float(7.0))), ("Gym review".to_string(), Any::Number(Number::Float(9.0)))]);
    }

    /// Two devices' note lists, synced by exchanging their whole state.
    fn sync(a: &Doc, b: &Doc) {
        use yrs::updates::decoder::Decode;
        use yrs::{ReadTxn, StateVector, Update};
        let ua = a.transact().encode_state_as_update_v1(&StateVector::default());
        let ub = b.transact().encode_state_as_update_v1(&StateVector::default());
        b.transact_mut().apply_update(Update::decode_v1(&ua).unwrap()).unwrap();
        a.transact_mut().apply_update(Update::decode_v1(&ub).unwrap()).unwrap();
    }

    #[test]
    fn notes_by_date_created_newest_first() {
        let now = now_ms();
        let note = |id: &str, created: f64, updated: f64| NoteMeta {
            id: id.into(), title: String::new(), tags: vec![], tags_read: true, created, updated,
            deleted: false, shared: false, share: None, place: Place::Mine,
        };
        let h = 3_600_000.0;
        let notes = [
            note("a", now - 100.0 * h, now - h),
            note("b", now - 2.0 * h, now - 50.0 * h),
            note("c", now + 10.0 * h, now), // (a clock ahead: counts as now)
            note("d", 0.0, now - 5.0 * h), // (no created time: by its last edit)
            note("e", now - 2.0 * h, now), // (the same as b: by id)
        ];
        let mut list: Vec<&NoteMeta> = notes.iter().collect();
        sort_by_created(&mut list);
        let ids: Vec<&str> = list.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["c", "b", "e", "d", "a"]);
        assert_eq!(created_or_updated(&notes[3]), now - 5.0 * h);
    }

    #[test]
    fn a_note_deleted_on_one_device_and_edited_on_another_comes_back() {
        let (a, b) = (Doc::new(), Doc::new());
        let plans = create(&a, "Plans");
        let old = create(&a, "Old");
        sync(&a, &b);
        // A deletes both; B (offline) edits Plans: its "updated" moves on.
        delete(&a, &plans);
        delete(&a, &old);
        {
            let m = note_map(&b, &plans).unwrap();
            m.insert(&mut b.transact_mut(), "updated", Any::Number(Number::Float(now_ms() + 1000.0)));
        }
        sync(&a, &b);
        assert!(get(&a, &plans).unwrap().deleted, "merged: deleted, with B's edit");
        assert_eq!(revive_edited(&a), vec!["Plans".to_string()], "either device can tell");
        sync(&a, &b);
        for d in [&a, &b] {
            assert!(!get(d, &plans).unwrap().deleted);
            assert!(get(d, &old).unwrap().deleted, "not edited since: stays deleted");
        }
        assert!(revive_edited(&b).is_empty());
        // Edited here after what a deletion saw, within the 30 s "updated" throttle: kept too.
        let c = Doc::new();
        let n = create(&c, "Typing");
        delete(&c, &n);
        keep_edit(&c, &n, now_ms() + 5_000.0);
        assert_eq!(revive_edited(&c), vec!["Typing".to_string()]);
        // A deletion from before deletedSeen existed is left be; touch doesn't bump a deleted note.
        let d = Doc::new();
        let legacy = create(&d, "Legacy");
        {
            let m = note_map(&d, &legacy).unwrap();
            let mut txn = d.transact_mut();
            m.insert(&mut txn, "deleted", true);
            m.insert(&mut txn, "updated", Any::Number(Number::Float(now_ms() + 9_000.0)));
        }
        touch(&d, &legacy, "Legacy edited", true);
        assert!(revive_edited(&d).is_empty());
        assert_eq!(get(&d, &legacy).unwrap().title, "Legacy");
    }

    #[test]
    fn the_servers_clock_corrects_this_ones() {
        let at = 1_791_187_200_000.0; // Sun, 05 Oct 2026 08:00:00 GMT
        let date = |ms: f64| httpdate::fmt_http_date(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64));
        assert_eq!(offset_from(Some(&date(at)), at - 100.0, at + 300.0, 0), 0);
        assert_eq!(offset_from(Some(&date(at + 5_000.0)), at, at + 200.0, 0), 0, "a few seconds off counts as right");
        assert!((offset_from(Some(&date(at + 300_000.0)), at - 100.0, at + 100.0, 0) - 300_500).abs() <= 1000);
        assert!((offset_from(Some(&date(at - 7_200_000.0)), at - 100.0, at + 100.0, 0) + 7_199_500).abs() <= 1000);
        assert_eq!(offset_from(Some(&date(at + 300_000.0)), at, at + 15_000.0, 42), 42, "too slow to tell");
        assert_eq!(offset_from(None, at, at + 100.0, 42), 42);
        assert_eq!(offset_from(Some("not a date"), at, at + 100.0, 42), 42);
    }

    #[test]
    fn a_time_from_the_future_sorts_as_now_and_the_next_edit_fixes_it() {
        let index = Doc::new();
        let (a, b) = (create(&index, "One"), create(&index, "Two"));
        // The one later by id gets a time 2 hours ahead (a wrong clock), the other now.
        let (ahead, now_id) = if a > b { (a, b) } else { (b, a) };
        let set = |id: &str, t: f64| {
            let m = note_map(&index, id).unwrap();
            let mut txn = index.transact_mut();
            m.insert(&mut txn, "updated", Any::Number(Number::Float(t)));
        };
        set(&ahead, now_ms() + 7_200_000.0);
        set(&now_id, now_ms() + 50.0);
        // Both count as now (ties go by id), not "the future one first".
        let order: Vec<String> = list(&index).into_iter().map(|n| n.id).collect();
        assert_eq!(order, vec![now_id.clone(), ahead.clone()]);
        touch(&index, &ahead, "One", false);
        assert!(get(&index, &ahead).unwrap().updated <= now_ms(), "an edit here sets it to now");
    }

    /// The same titles as the web app, from the same cases (web/tests/fixtures/titles.json).
    #[test]
    fn titles_without_markdown_marks() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../web/tests/fixtures/titles.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let (line, title) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
            assert_eq!(title_from_line(line), title, "{line:?}");
        }
        assert_eq!(title_from_body("\n## Trip to Lisbon\n- [ ] Book"), "Trip to Lisbon");
    }

    #[test]
    fn titles_and_find() {
        assert_eq!(title_from_body("\n  \n  Hello world  \nmore"), "Hello world");
        assert_eq!(title_from_body(&"x".repeat(200)).len(), TITLE_MAX);
        let index = Doc::new();
        let a = create(&index, "Shopping list");
        let b = create(&index, "Shopping ideas");
        create(&index, "Diary");
        assert_eq!(list(&index).len(), 3);
        assert_eq!(find(&index, "diary").unwrap().title, "Diary");
        assert!(find(&index, "shopping").unwrap_err().to_string().contains("matches 2"));
        assert_eq!(find(&index, "shopping list").unwrap().id, a);
        assert_eq!(find(&index, &b[..8]).unwrap().id, b);
        delete(&index, &a);
        assert_eq!(list(&index).len(), 2);
        assert_eq!(all(&index).len(), 3);
        touch(&index, &b, "New title\nbody", true);
        assert_eq!(list(&index).iter().find(|n| n.id == b).unwrap().title, "New title");
    }

    #[test]
    fn shared_notes_are_marked() {
        let index = Doc::new();
        let a = create(&index, "Mine");
        let b = create(&index, "Shared");
        // As the web app stores it: a plain object under "share".
        let share = Any::from(std::collections::HashMap::from([
            ("id".to_string(), Any::from("00112233445566778899aabbccddeeff")),
            ("seed".to_string(), Any::from("c2VlZA==")),
            ("role".to_string(), Any::from("owner")),
        ]));
        let entry = notes_map(&index).get(&index.transact(), &b).and_then(|v| v.cast::<MapRef>().ok()).unwrap();
        entry.insert(&mut index.transact_mut(), "share", share);
        let shared = |id: &str| list(&index).into_iter().find(|n| n.id == id).unwrap().shared;
        assert!(!shared(&a));
        assert!(shared(&b));
        assert!(get(&index, &b).unwrap().shared);
        assert!(get(&index, "nope").is_none());
        // Its link: an edit link's seed (here not 32 bytes, so no keys from it).
        let s = get(&index, &b).unwrap().share.unwrap();
        assert_eq!((s.id.as_str(), s.seed.as_deref(), s.enc_key.as_deref()), ("00112233445566778899aabbccddeeff", Some("c2VlZA=="), None));
        assert!(s.home().is_err());
        assert!(get(&index, &a).unwrap().share.is_none());
    }

    #[test]
    fn a_note_added_from_a_link_keeps_its_keys() {
        let index = Doc::new();
        let r = ShareRef { id: "s9".into(), seed: None, enc_key: Some("a2V5".into()), pubkey: Some("cGs=".into()), role: Some("member".into()), ..Default::default() };
        let id = create_shared(&index, "From a link", &r, None);
        let m = get(&index, &id).unwrap();
        assert!(m.shared);
        assert_eq!(m.share, Some(r.clone()));
        assert_eq!(with_share(&index, "s9").unwrap().id, id);
        let given = create_shared(&index, "Another", &ShareRef { id: "s10".into(), ..r }, Some("0d4c6f2e-1b7a-4c3d-9e8f-123456789abc"));
        assert_eq!(given, "0d4c6f2e-1b7a-4c3d-9e8f-123456789abc", "under the link's address");
    }

    #[test]
    fn a_shared_notes_link_gives_its_keys() {
        use base64::Engine;
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let edit = ShareRef { id: "s1".into(), seed: Some(b64(&[7; 32])), enc_key: None, pubkey: None, role: None, ..Default::default() };
        assert!(edit.home().unwrap().writable(), "an edit link writes");
        let keys = plim_core::crypto::share_keys(&[7; 32]);
        let view = ShareRef { id: "s1".into(), seed: None, enc_key: Some(b64(&keys.enc_key)), pubkey: Some(b64(&keys.pubkey)), role: None, ..Default::default() };
        assert!(!view.home().unwrap().writable(), "a view link only reads");
    }
}
