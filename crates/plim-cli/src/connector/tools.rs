//! One connection at work, for one request: the notes its list note holds that are shared with
//! agents (#514, grants.rs), and the tools (`mcp`'s) on them.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::Signer;
use serde_json::{Value, json};
use plim_core::crypto::{ConnectionKeys, connection_holder_secret, connection_keys, random_bytes};
use plim_core::sig::{action, action_msg};
use yrs::{Any, Array, ArrayRef, Map, MapRef, Out, Transact};

use super::ACTIVITY_KEPT;
use crate::api::Api;
use crate::commands::notes::Sort;
use crate::grants::Place;
use crate::mcp::{Tools, at_once, is_users, limit, nowhere, title_or_untitled, with_note};
use crate::session::{DEFAULT_MAX_BLOB, Session};
use crate::sync::{DocSync, NoEvents, ShareHome};
use crate::writer::WriterSession;
use crate::{answers, link, notes, search, sharing, tags};

/// One connection at work, for one request.
pub(crate) struct Conn {
    plim: String,
    id: String,
    secret: [u8; 32],
    keys: ConnectionKeys,
    /// Which MCP session this request is in (#505): named in the versions its changes leave.
    session: Option<WriterSession>,
    /// The list, once opened in this request.
    list: Option<(DocSync, ListInfo)>,
}

/// What the owner's app wrote in the list's 'info': the connection's name. (What it sees is the
/// rule's, the same for every agent: the notes shared with agents, #514.)
#[derive(Default)]
struct ListInfo {
    /// The connection's name, as the owner calls it ("Claude"): what its edits are marked with.
    name: String,
}

impl ListInfo {
    fn describe(&self) -> String {
        format!(
            "{} The user connected you in Plim, under Settings → Connections, and shares a note with agents with the Agents switch in its Share.",
            crate::grants::describe()
        )
    }
}

/// A note in the list: a holder of the connection's on it, or one the connection made (with its
/// seed, until the owner's app adopts it).
#[derive(Clone)]
struct Entry {
    key: String,
    note_id: String,
    title: String,
    tags: Vec<String>,
    role: String,
    created: f64,
    updated: f64,
    seed: Option<[u8; 32]>,
    share_id: Option<String>,
    /// Where the note lives (#484), as the owner's app listed it.
    place: Place,
}

impl Entry {
    fn meta(&self) -> notes::NoteMeta {
        notes::NoteMeta {
            id: self.note_id.clone(),
            title: self.title.clone(),
            tags: self.tags.clone(),
            tags_read: true,
            created: self.created,
            updated: self.updated,
            deleted: false,
            shared: true,
            share: None,
            place: self.place,
        }
    }
}

impl Conn {
    /// `session`: this MCP session's writing session (#505), if the client keeps one.
    pub(super) fn new(plim: &str, id: &str, secret: [u8; 32], session: Option<WriterSession>) -> Self {
        Conn { plim: plim.into(), id: id.into(), keys: connection_keys(&secret), secret, list: None, session }
    }

    fn api(&self) -> Api {
        Api::new(&self.plim).for_connection(&self.id, self.keys.signing.clone())
    }

    async fn session(&self) -> Result<Arc<Session>> {
        Session::guest(self.api(), DEFAULT_MAX_BLOB)
    }

    async fn open_home(&self, home: ShareHome) -> Result<DocSync> {
        let mut doc = DocSync::new_share(self.session().await?, Arc::new(home), Arc::new(NoEvents))?;
        doc.load().await?;
        Ok(doc)
    }

    /// The list note, through the connection's own holder (GET /holders marks the connection used).
    async fn list(&mut self) -> Result<&mut (DocSync, ListInfo)> {
        if self.list.is_none() {
            let (_, home) = sharing::resolve_holder(&self.api(), &self.keys.list_holder_id, &self.keys.list_holder_secret)
                .await
                .map_err(|e| anyhow!("this connection was turned off in Plim, or doesn't exist any more ({e:#})"))?;
            let doc = self.open_home(home).await?;
            let info = read_info(&doc);
            self.list = Some((doc, info));
        }
        Ok(self.list.as_mut().unwrap())
    }

    /// The notes it may see: those its list holds that are shared with agents (#514; one it made is,
    /// from the start). An entry from a tag granted before isn't.
    async fn entries(&mut self) -> Result<Vec<Entry>> {
        let (doc, _) = self.list().await?;
        Ok(read_entries(doc).into_iter().filter(|e| e.place.reached()).collect())
    }

    /// A note opened through its holder (or its seed, one the connection made).
    async fn open(&self, e: &Entry) -> Result<DocSync> {
        let home = match (&e.seed, &e.share_id) {
            (Some(seed), Some(id)) => ShareHome::from_seed(id, seed),
            _ => sharing::resolve_holder(&self.api(), &e.key, &connection_holder_secret(&self.secret, &e.key)).await.map_err(|err| anyhow!("{}: {err:#}", nowhere(&e.note_id)))?.1,
        };
        self.open_home(home).await
    }

    fn find(&self, entries: &[Entry], query: &str) -> Result<Entry> {
        let q = match link::parse_note_url(query) {
            Some(url) if url.server != self.plim => bail!("that address is on {}, but this connection is to {}", url.server, self.plim),
            Some(url) => url.id,
            None => query.to_string(),
        };
        let metas: Vec<notes::NoteMeta> = entries.iter().map(Entry::meta).collect();
        let found = notes::find_in(&metas, &q).map_err(|e| if e.to_string().starts_with("no note") { nowhere(query) } else { e })?;
        Ok(entries.iter().find(|e| e.note_id == found.id).cloned().unwrap())
    }

    async fn open_to_write(&mut self, query: &str) -> Result<(Entry, DocSync)> {
        let entries = self.entries().await?;
        let e = self.find(&entries, query)?;
        if e.role != "edit" {
            bail!("\"{}\" is view only", title_or_untitled(&e.title));
        }
        let note = self.open(&e).await?;
        if !note.writable() {
            bail!("\"{}\" is view only", title_or_untitled(&e.title));
        }
        Ok((e, note))
    }

    /// The list's entry for a note put right after a change (its title and tags, as the owner's
    /// app keeps them), and the change noted in 'activity'; the list saved.
    async fn note_changed(&mut self, e: &Entry, body: &str, what: &str) -> Result<()> {
        let title = notes::title_from_body(body);
        let tags = crate::frontmatter::note_tags(body);
        let (doc, _) = self.list().await?;
        {
            let entries = doc.doc.get_or_insert_map("notes");
            let activity = doc.doc.get_or_insert_array("activity");
            let mut txn = doc.doc.transact_mut();
            if let Some(Out::Any(Any::Map(m))) = entries.get(&txn, &e.key) {
                let mut m = (*m).clone();
                m.insert("title".into(), Any::from(title.as_str()));
                m.insert("tags".into(), Any::Array(tags.iter().map(|t| Any::from(t.as_str())).collect::<Vec<_>>().into()));
                entries.insert(&mut txn, e.key.as_str(), Any::Map(Arc::new(m)));
            }
            push_activity(&activity, &mut txn, what, &e.note_id);
        }
        doc.flush().await
    }

    /// This request's editing session, recorded in the note (#389): its Yjs client id, for whom
    /// (the connection's name) and when, in the note's 'authors' map. The text it typed keeps that
    /// client id, so the owner's apps can tell Claude's text from theirs, on any device.
    async fn mark_session(&mut self, doc: &yrs::Doc) -> Result<()> {
        let name = self.list().await?.1.name.clone();
        notes::mark_session(doc, &name, &self.id, self.session.as_ref().map(|s| s.name.as_str()));
        Ok(())
    }

    /// Who this request's changes are by, in the versions they leave (#505): the connection's
    /// name, its id (the owner's app names it as it's called now), and the MCP session if any.
    async fn writer(&mut self) -> Result<plim_core::version::Writer> {
        let name = self.list().await?.1.name.clone();
        Ok(match &self.session {
            Some(s) => s.writer(&name, &self.id),
            None => plim_core::version::Writer { name: Some(name), connection: Some(self.id.clone()), ..Default::default() },
        })
    }

    async fn list_notes(&mut self, tag: Option<&str>, sort: Sort) -> Result<String> {
        let mut entries = self.entries().await?;
        if let Some(t) = tag {
            entries.retain(|e| e.tags.iter().any(|x| tags::matches(x, t)));
        }
        let mut metas: Vec<notes::NoteMeta> = entries.iter().map(Entry::meta).collect();
        let now = notes::now_ms();
        metas.sort_by(|a, b| b.updated.min(now).total_cmp(&a.updated.min(now)).then_with(|| a.id.cmp(&b.id)));
        let mut list: Vec<&notes::NoteMeta> = metas.iter().collect();
        if sort == Sort::Created {
            notes::sort_by_created(&mut list);
        }
        if list.is_empty() {
            return Ok(answers::nothing_listed(tag));
        }
        let mut out = String::new();
        for n in list {
            let at = if sort == Sort::Created { notes::created_or_updated(n) } else { n.updated };
            let view_only = entries.iter().any(|e| e.note_id == n.id && e.role != "edit");
            out += &answers::list_line(title_or_untitled(&n.title), &link::note_url(&self.plim, &n.id), &crate::vault::relative(at), view_only, &n.tags);
        }
        Ok(out)
    }

    async fn read_note(&mut self, query: &str) -> Result<String> {
        let entries = self.entries().await?;
        let e = self.find(&entries, query)?;
        let note = self.open(&e).await?;
        let body = notes::body(&note.doc);
        self.note_changed(&e, &body, &format!("Read \"{}\"", title_or_untitled(&e.title))).await.ok();
        Ok(format!("{} · {}\n\n{body}", title_or_untitled(&e.title), link::note_url(&self.plim, &e.note_id)))
    }

    /// A note to read the history of (#505): only one it may edit, and its versions only from when
    /// it was given the note (its holder made; one it made itself, all of them). The read noted in
    /// its activity, as reading a note is.
    async fn open_history(&mut self, query: &str) -> Result<(Entry, DocSync, Option<u64>)> {
        let entries = self.entries().await?;
        let e = self.find(&entries, query)?;
        if e.role != "edit" {
            bail!("you can only read \"{}\": a note's history is open only for notes you can edit", title_or_untitled(&e.title));
        }
        let (note, since) = match (&e.seed, &e.share_id) {
            (Some(seed), Some(id)) => (self.open_home(ShareHome::from_seed(id, seed)).await?, None),
            _ => {
                let (_, home, at) = sharing::resolve_holder_at(&self.api(), &e.key, &connection_holder_secret(&self.secret, &e.key))
                    .await
                    .map_err(|err| anyhow!("{}: {err:#}", nowhere(&e.note_id)))?;
                // (A server that doesn't say: from now, so nothing from before it was given.)
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                (self.open_home(home).await?, Some(at.unwrap_or(now)))
            }
        };
        let body = notes::body(&note.doc);
        self.note_changed(&e, &body, &format!("Read the history of \"{}\"", title_or_untitled(&e.title))).await.ok();
        Ok((e, note, since))
    }

    async fn note_history(&mut self, query: &str) -> Result<String> {
        let (e, note, since) = self.open_history(query).await?;
        crate::commands::history::history_answer(&note, title_or_untitled(&e.title), &link::note_url(&self.plim, &e.note_id), since).await
    }

    async fn read_version(&mut self, query: &str, n: usize, diff: bool) -> Result<String> {
        let (e, note, since) = self.open_history(query).await?;
        crate::commands::history::version_answer(&note, title_or_untitled(&e.title), n, diff, since).await
    }

    async fn read_tagged(&mut self, tag: &str) -> Result<String> {
        let mut out = String::new();
        let mut n = 0;
        for e in self.entries().await?.iter().filter(|e| e.tags.iter().any(|x| tags::matches(x, tag))) {
            let Ok(note) = self.open(e).await else { continue };
            let body = notes::body(&note.doc);
            if !crate::frontmatter::note_tags(&body).iter().any(|x| tags::matches(x, tag)) {
                continue;
            }
            n += 1;
            out += &format!("==> {} · {} <==\n{}\n\n", title_or_untitled(&e.title), link::note_url(&self.plim, &e.note_id), body.trim_end());
        }
        if n > 0 {
            let (doc, _) = self.list().await?;
            let activity = doc.doc.get_or_insert_array("activity");
            push_activity(&activity, &mut doc.doc.transact_mut(), &format!("Read {n} notes tagged #{tag}"), "");
            doc.flush().await.ok();
        }
        Ok(if out.is_empty() { answers::nothing_listed(Some(tag)) } else { out.trim_end().to_string() })
    }

    async fn search(&mut self, query: &str, tag: Option<&str>, limit: usize) -> Result<String> {
        let words = search::query_words(query);
        let mut entries = self.entries().await?;
        if let Some(t) = tag {
            entries.retain(|e| e.tags.iter().any(|x| tags::matches(x, t)));
        }
        let now = notes::now_ms();
        entries.sort_by(|a, b| b.updated.min(now).total_cmp(&a.updated.min(now)).then_with(|| a.note_id.cmp(&b.note_id)));
        let this = &*self;
        // (Boxed as Send: the connector's handlers must be, and the compiler can't see it through the closure.)
        type Opening<'a> = std::pin::Pin<Box<dyn Future<Output = (usize, Result<DocSync>)> + Send + 'a>>;
        let work: Vec<Opening> = entries.iter().enumerate().map(|(i, e)| -> Opening { Box::pin(async move { (i, this.open(e).await) }) }).collect();
        let opened = at_once(work).await;
        let mut found: Vec<(usize, search::Found)> = Vec::new();
        for (i, r) in opened {
            let Ok(note) = r else { continue };
            let e = &entries[i];
            let body = notes::body(&note.doc);
            let tags = crate::frontmatter::note_tags(&body);
            if tag.is_some_and(|t| !tags.iter().any(|x| tags::matches(x, t))) {
                continue;
            }
            let title = title_or_untitled(&e.title);
            let Some(m) = search::match_note(title, &body, &words, 2) else { continue };
            let tagged: String = tags.iter().map(|t| format!(" #{t}")).collect();
            let role = if e.role != "edit" { " (view only)" } else { "" };
            found.push((i, search::Found { title: title.into(), url: link::note_url(&self.plim, &e.note_id), when: format!("{}{role}", crate::vault::relative(e.updated)), tags: tagged, m }));
        }
        found.sort_by_key(|(i, _)| *i);
        let n = found.len();
        let (doc, _) = self.list().await?;
        let activity = doc.doc.get_or_insert_array("activity");
        push_activity(&activity, &mut doc.doc.transact_mut(), &format!("Searched for \"{}\" ({n} found)", query.trim()), "");
        doc.flush().await.ok();
        let scope = tag.map(|t| format!(" tagged #{t}")).unwrap_or_default();
        Ok(search::answer(query.trim(), found.into_iter().map(|(_, f)| f).collect(), limit, &scope))
    }

    /// The tags (topics) in the notes it can see, with how many notes have each.
    async fn list_tags(&mut self) -> Result<String> {
        let entries = self.entries().await?;
        Ok(answers::tags_answer(&answers::tag_counts(entries.iter().map(|e| e.tags.as_slice()))))
    }

    /// A new note, shared with agents (#514), with any tags (they're only topics): a share made on
    /// the owner's behalf, signed with the connection's key, listed with its seed (the owner's app
    /// takes it into their notes, and gives this connection a holder).
    async fn create_note(&mut self, text: &str) -> Result<String> {
        // (Its title and tags in a block, #584: the app reads blocks before and after it moves your notes.)
        let text = crate::frontmatter::to_frontmatter(text);
        self.list().await?;
        let api = self.api();
        let note_id = uuid::Uuid::new_v4().to_string();
        let share_id = hex::encode(random_bytes::<16>());
        let seed = random_bytes::<32>();
        let share = DocSync::new_share(self.session().await?, Arc::new(ShareHome::from_seed(&share_id, &seed)), Arc::new(NoEvents))?;
        notes::set_body(&share.doc, &text);
        self.mark_session(&share.doc).await?;
        let body = share.share_create_body(&share.state())?;
        let ch = api.post("/auth/challenge", &json!({ "pubkey_hash": self.keys.pubkey_hash })).await?;
        let nonce_b64 = ch["nonce"].as_str().unwrap_or_default().to_string();
        let nonce = B64.decode(&nonce_b64).context("a bad challenge")?;
        let sig = B64.encode(self.keys.signing.sign(&action_msg(&self.id, action::CONNECTION_CREATE_SHARE, &share_id, &nonce, &[])).to_bytes());
        api.post_with(&format!("/connections/{}/shares", self.id), &body, &[("x-tiro-nonce", &nonce_b64), ("x-tiro-sig", &sig)])
            .await
            .map_err(|e| match e.status() {
                Some(410) => anyhow!("this connection was turned off in Plim"),
                _ => anyhow!("couldn't make the note: {e}"),
            })?;
        let title = notes::title_from_body(&text);
        let note_tags = crate::frontmatter::note_tags(&text);
        let key = hex::encode(random_bytes::<16>());
        let now = notes::now_ms();
        let (doc, _) = self.list().await?;
        {
            let entries = doc.doc.get_or_insert_map("notes");
            let activity = doc.doc.get_or_insert_array("activity");
            let mut txn = doc.doc.transact_mut();
            let fields: HashMap<String, Any> = HashMap::from([
                ("noteId".into(), Any::from(note_id.as_str())),
                ("shareId".into(), Any::from(share_id.as_str())),
                ("seed".into(), Any::from(B64.encode(seed).as_str())),
                ("title".into(), Any::from(title.as_str())),
                ("tags".into(), Any::Array(note_tags.iter().map(|t| Any::from(t.as_str())).collect::<Vec<_>>().into())),
                ("role".into(), Any::from("edit")),
                ("created".into(), Any::Number(yrs::Number::Float(now))),
                ("updated".into(), Any::Number(yrs::Number::Float(now))),
                ("place".into(), Any::from("ai")), // (shared with agents, #514: the owner's app takes it in so)
            ]);
            entries.insert(&mut txn, key.as_str(), Any::Map(Arc::new(fields)));
            push_activity(&activity, &mut txn, &format!("Created \"{}\"", title_or_untitled(&title)), &note_id);
        }
        doc.flush().await?;
        let kept = crate::vault::keep_after(&share, &text, &self.writer().await?).await;
        Ok(with_note(format!("Created \"{}\", shared with agents: {}", title_or_untitled(&title), link::note_url(&self.plim, &note_id)), kept))
    }

    async fn append(&mut self, query: &str, text: &str) -> Result<String> {
        let (e, mut note) = self.open_to_write(query).await?;
        crate::vault::keep_before(&note, &notes::body(&note.doc)).await?;
        crate::vault::append_text(&note, text);
        self.mark_session(&note.doc).await?;
        note.flush().await?;
        let body = notes::body(&note.doc);
        self.note_changed(&e, &body, &format!("Added to \"{}\"", title_or_untitled(&e.title))).await?;
        let kept = crate::vault::keep_after(&note, &body, &self.writer().await?).await;
        Ok(with_note(format!("Added to \"{}\": {}", title_or_untitled(&e.title), link::note_url(&self.plim, &e.note_id)), kept))
    }

    /// `old` (there once) replaced by `new` (#74): within what it may write, the
    /// note kept as a version first, marked as the connection's, noted in its activity.
    async fn edit(&mut self, query: &str, old: &str, new: &str) -> Result<String> {
        let (e, mut note) = self.open_to_write(query).await?;
        let before = notes::body(&note.doc);
        let after = crate::edits::replace_once(&before, old, new).map_err(|e| anyhow!(e))?;
        crate::vault::keep_then_edit(&note, &before, &after).await?;
        self.mark_session(&note.doc).await?;
        note.flush().await?;
        self.note_changed(&e, &after, &format!("Edited \"{}\"", title_or_untitled(&e.title))).await?;
        let kept = crate::vault::keep_after(&note, &notes::body(&note.doc), &self.writer().await?).await;
        Ok(with_note(format!("Edited \"{}\": {}\n\n{}", title_or_untitled(&e.title), link::note_url(&self.plim, &e.note_id), crate::edits::context(&after, &before)), kept))
    }

    async fn retag(&mut self, query: &str, wanted: &[String], add: bool) -> Result<String> {
        let wanted: Vec<String> = wanted.iter().map(|t| crate::vault::tag_query(t)).collect::<Result<_>>()?;
        let (e, mut note) = self.open_to_write(query).await?;
        let old = notes::body(&note.doc);
        let (done, left) = crate::vault::apply_tags(&note, &wanted, add);
        let body = notes::body(&note.doc);
        let mut kept = None;
        if body != old {
            // (Marked as the connection's only when the text changed.)
            self.mark_session(&note.doc).await?;
            crate::vault::keep_before(&note, &old).await?;
            note.flush().await?;
            self.note_changed(&e, &body, &format!("{} \"{}\": {}", if add { "Tagged" } else { "Untagged" }, title_or_untitled(&e.title), done.join(" "))).await?;
            kept = crate::vault::keep_after(&note, &body, &self.writer().await?).await;
        }
        Ok(with_note(answers::retag_answer(add, title_or_untitled(&e.title), &done, &left, &link::note_url(&self.plim, &e.note_id)), kept))
    }
}

impl Tools for Conn {
    /// What it may see, in words (the list opened for it: the connection still on).
    async fn instructions(&mut self) -> String {
        match self.list().await {
            Ok((_, info)) => info.describe(),
            Err(_) => "What you can read and write is what the user granted this connection in Plim, under Settings → Connections.".into(),
        }
    }

    fn can_write(&self) -> bool {
        true
    }

    async fn call(&mut self, name: &str, args: &Value) -> Result<String> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
        let need = |k: &str| s(k).filter(|v| !v.trim().is_empty()).with_context(|| format!("{k} is missing"));
        let list_of = |k: &str| -> Result<Vec<String>> {
            let v = args.get(k).and_then(Value::as_array).with_context(|| format!("{k} is missing: a list of tags"))?;
            v.iter().map(|t| t.as_str().map(str::to_string).context("a tag isn't text")).collect()
        };
        let r = match name {
            "list_notes" => {
                let tag = s("tag").filter(|t| !t.is_empty()).map(|t| crate::vault::tag_query(&t)).transpose()?;
                let sort = if s("sort").as_deref() == Some("created") { Sort::Created } else { Sort::Edited };
                self.list_notes(tag.as_deref(), sort).await
            }
            "read_note" => self.read_note(&need("note")?).await,
            "note_history" => self.note_history(&need("note")?).await,
            "read_version" => self.read_version(&need("note")?, crate::mcp::version_arg(args)?, args.get("diff").and_then(Value::as_bool).unwrap_or(false)).await,
            "read_notes_by_tag" => self.read_tagged(&crate::vault::tag_query(&need("tag")?)?).await,
            "search_notes" => {
                let tag = s("tag").filter(|t| !t.is_empty()).map(|t| crate::vault::tag_query(&t)).transpose()?;
                self.search(&need("query")?, tag.as_deref(), limit(args)).await
            }
            "list_tags" => self.list_tags().await,
            "list_grants" => self.list().await.map(|(_, info)| info.describe()),
            "create_note" => self.create_note(&need("text")?).await,
            "append_to_note" => self.append(&need("note")?, &need("text")?).await,
            "edit_note" => self.edit(&need("note")?, &s("old_text").unwrap_or_default(), &s("new_text").unwrap_or_default()).await,
            "tag_note" => self.retag(&need("note")?, &list_of("tags")?, true).await,
            "untag_note" => self.retag(&need("note")?, &list_of("tags")?, false).await,
            _ => bail!("no tool called {name}"),
        };
        if let Err(e) = &r
            && !is_users(e)
        {
            eprintln!("plim mcp: {name} for connection {}… failed: {e:#}", &self.id[..8]);
        }
        r
    }
}

fn any_str(m: &HashMap<String, Any>, k: &str) -> String {
    match m.get(k) {
        Some(Any::String(s)) => s.to_string(),
        _ => String::new(),
    }
}

fn any_f64(m: &HashMap<String, Any>, k: &str) -> f64 {
    match m.get(k) {
        Some(Any::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn read_info(doc: &DocSync) -> ListInfo {
    let info: MapRef = doc.doc.get_or_insert_map("info");
    let txn = doc.doc.transact();
    let name = match info.get(&txn, "name") {
        Some(Out::Any(Any::String(s))) if !s.trim().is_empty() => s.to_string(),
        _ => "Claude".into(),
    };
    ListInfo { name }
}

fn read_entries(doc: &DocSync) -> Vec<Entry> {
    let entries: MapRef = doc.doc.get_or_insert_map("notes");
    let txn = doc.doc.transact();
    let mut out: Vec<Entry> = entries
        .iter(&txn)
        .filter_map(|(key, v)| {
            let Out::Any(Any::Map(m)) = v else { return None };
            let seed: Option<[u8; 32]> = B64.decode(any_str(&m, "seed")).ok().and_then(|b| b.try_into().ok());
            let share_id = Some(any_str(&m, "shareId")).filter(|s| !s.is_empty());
            Some(Entry {
                key: key.to_string(),
                note_id: Some(any_str(&m, "noteId")).filter(|s| !s.is_empty())?,
                title: any_str(&m, "title"),
                tags: match m.get("tags") {
                    Some(Any::Array(a)) => a.iter().filter_map(|t| if let Any::String(s) = t { Some(s.to_string()) } else { None }).collect(),
                    _ => Vec::new(),
                },
                role: Some(any_str(&m, "role")).filter(|s| !s.is_empty()).unwrap_or_else(|| "read".into()),
                created: any_f64(&m, "created"),
                updated: any_f64(&m, "updated"),
                seed,
                share_id,
                place: Place::from_index(Some(any_str(&m, "place").as_str())),
            })
        })
        .collect();
    // (A note both made here and since adopted: the holder's entry counts, the seeded one not.)
    let held: std::collections::HashSet<String> = out.iter().filter(|e| e.seed.is_none()).map(|e| e.note_id.clone()).collect();
    out.retain(|e| e.seed.is_none() || !held.contains(&e.note_id));
    out
}

fn push_activity(activity: &ArrayRef, txn: &mut yrs::TransactionMut, what: &str, note_id: &str) {
    let item = Any::Map(Arc::new(HashMap::from([
        ("at".to_string(), Any::Number(yrs::Number::Float(notes::now_ms()))),
        ("what".to_string(), Any::from(what)),
        ("noteId".to_string(), Any::from(note_id)),
    ])));
    activity.push_back(txn, item);
    let len = activity.len(txn);
    if len > ACTIVITY_KEPT {
        activity.remove_range(txn, 0, len - ACTIVITY_KEPT);
    }
}
