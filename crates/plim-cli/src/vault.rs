//! The vault as the commands and the connector open it: a session, the note index,
//! a note (from the list, a link, or a link of someone's own), and the edits they share.

use std::sync::Arc;

use anyhow::{Context, Result, bail};

use crate::api::{Api, ApiError};
use crate::config;
use crate::prompt::unlock_device;
use crate::session::{Session, identity_from_seed};
use crate::sync::{self, DocSync, NoEvents};
use crate::{link, notes, sharing, tags};

pub(crate) async fn open_session(server: Option<&str>) -> Result<Arc<Session>> {
    let device = config::require_device()?;
    let seed = unlock_device(&device).await?;
    let api = Api::new(&config::server_url(server, Some(&device)));
    let sess = Session::open(api, identity_from_seed(&seed)).await.map_err(|e| match e.downcast_ref::<ApiError>() {
        Some(ApiError::Http(401, _)) => {
            anyhow::anyhow!("this device's key no longer works (was the recovery phrase changed?) — run `plim login`")
        }
        _ => e,
    })?;
    if let Some((seen, got)) = sess.keyring_rollback {
        eprintln!("warning: the server returned older encryption keys (v{got}) than this device has seen (v{seen}).");
    }
    flush_stray_outboxes(&sess).await;
    Ok(sess)
}

/// Upload edits left over from a previous run that ended before they were sent.
async fn flush_stray_outboxes(sess: &Arc<Session>) {
    let docs = sess.store.outbox_docs().unwrap_or_default();
    if docs.is_empty() {
        return;
    }
    // Which notes are shared, and how (from the note list).
    let shares: Vec<(String, notes::ShareRef)> = match load_index(sess).await {
        Ok(l) => notes::all(&l.index.doc).into_iter().filter_map(|m| Some((m.id, m.share?))).collect(),
        Err(_) => Vec::new(),
    };
    for doc_id in docs {
        let share = shares.iter().find(|(note, r)| *note == doc_id || doc_id == format!("share:{}", r.id)).map(|(_, r)| r);
        let _ = match share {
            // A shared note's own edits, or ones left for its private doc from before
            // it was shared elsewhere (that doc takes no more: #119): to its share.
            Some(r) => flush_into_share(sess, &doc_id, r).await,
            None => match DocSync::new(sess.clone(), &doc_id, Arc::new(NoEvents)) {
                Ok(mut s) => s.flush().await,
                Err(e) => Err(e),
            },
        };
    }
}

pub(crate) async fn flush_into_share(sess: &Arc<Session>, doc_id: &str, r: &notes::ShareRef) -> Result<()> {
    let mut share = DocSync::new_share(sess.clone(), Arc::new(r.home()?), Arc::new(NoEvents))?;
    if doc_id != share.doc_id {
        let private = DocSync::new(sess.clone(), doc_id, Arc::new(NoEvents))?;
        let (ids, updates) = private.pending_updates()?;
        if share.writable() && !updates.is_empty() {
            share.load().await?;
            for u in &updates {
                share.apply_local(u)?;
            }
        }
        if share.writable() {
            sess.store.outbox_remove(&ids)?;
        }
    }
    share.flush().await
}

pub(crate) struct Loaded {
    pub(crate) index: DocSync,
}

pub(crate) async fn load_index(sess: &Arc<Session>) -> Result<Loaded> {
    let mut index = DocSync::new(sess.clone(), "index", Arc::new(CliEvents))?;
    index.load().await?;
    Ok(Loaded { index })
}

/// Prints rollback warnings for one-shot commands.
pub(crate) struct CliEvents;
impl sync::Events for CliEvents {
    fn forged(&self, _doc_id: &str) {
        eprintln!("warning: skipped a change to this shared note that wasn't made with its edit link.");
    }
    fn status(&self, _doc_id: &str, status: sync::Status) {
        if status == sync::Status::LinkOff {
            eprintln!("This shared note's links were turned off: it can't be read any more.");
        }
    }
    fn rollback(&self, r: sync::Rollback) {
        eprintln!(
            "warning: the server sent older data for {} than this device has seen before — recent changes may be missing.",
            if r.doc_id == "index" { "the note list".to_string() } else { format!("note {}", &r.doc_id[..8.min(r.doc_id.len())]) }
        );
    }
}

/// Flush and report whether everything reached the server.
pub(crate) async fn finish(syncs: &mut [&mut DocSync]) -> Result<()> {
    let mut pending = false;
    for s in syncs.iter_mut() {
        if let Err(e) = s.flush().await
            && !sync::is_offline(&e) {
                return Err(e);
            }
        pending |= s.has_pending()?;
    }
    if pending {
        eprintln!("Saved on this device; it will upload the next time plim can reach the server.");
    }
    Ok(())
}

pub(crate) fn relative(ms: f64) -> String {
    if ms == 0.0 {
        return String::new();
    }
    let s = (notes::now_ms() - ms) / 1000.0;
    match s {
        s if s < 60.0 => "just now".into(),
        s if s < 3600.0 => format!("{}m ago", (s / 60.0) as u64),
        s if s < 86400.0 => format!("{}h ago", (s / 3600.0) as u64),
        s => format!("{}d ago", (s / 86400.0) as u64),
    }
}

/// The server this device uses (`--server`, `PLIM_SERVER`, the signed-in one): what a note's address starts with.
pub(crate) fn base_url(server: Option<&str>) -> Result<String> {
    Ok(config::server_url(server, config::load_device()?.as_ref()))
}

/// What names a note (#299): its address (`https://…/n/<id>`, on this server) stands for its
/// id; anything else (a title, an id or its prefix) is looked up as it is.
pub(crate) fn note_target(server: Option<&str>, query: &str) -> Result<String> {
    let Some(url) = link::parse_note_url(query) else { return Ok(query.to_string()) };
    let base = base_url(server)?;
    if url.server != base {
        bail!("that address is on {}, but this device is signed in to {base}", url.server);
    }
    Ok(url.id)
}

/// A tag asked for, as it's kept ("#Gym" is "gym").
pub(crate) fn tag_query(s: &str) -> Result<String> {
    tags::tag_name(s).with_context(|| format!("\"{s}\" isn't a tag: letters, digits, _ and -, nested with / (#gym, #gym/legs)"))
}


/// A note of the list, opened: its text from its home (a shared note's: its share, with its link's keys, #80).
pub(crate) async fn open_note(sess: &Arc<Session>, meta: &notes::NoteMeta) -> Result<DocSync> {
    let mut note = match &meta.share {
        Some(r) => DocSync::new_share(sess.clone(), Arc::new(sharing::home_of(sess, r).await?), Arc::new(CliEvents))?,
        None => DocSync::new(sess.clone(), &meta.id, Arc::new(CliEvents))?,
    };
    note.load().await?;
    Ok(note)
}

/// A shared note from only a link of someone's own (#369): the holder's row says which share
/// it's in and holds the keys; no account, no passphrase, nothing kept here.
pub(crate) async fn open_holder_link(hl: &link::HolderLink) -> Result<(String, DocSync)> {
    let api = Api::new(&hl.server);
    let (share_id, home) = sharing::resolve_holder(&api, &hl.holder_id, &hl.secret).await?;
    let home = Arc::new(home);
    let sess = Session::for_link(api, &home).await?;
    let mut note = DocSync::new_share(sess, home, Arc::new(CliEvents))?;
    note.load().await?;
    Ok((share_id, note))
}

/// Tags put on (`add`), or taken off, the note's frontmatter (#584), as one edit to its text
/// (others' edits meanwhile merge as with any edit): those done ("#gym"), and those there was
/// nothing to do for.
pub(crate) fn apply_tags(note: &DocSync, wanted: &[String], add: bool) -> (Vec<String>, Vec<String>) {
    let old = notes::body(&note.doc);
    let mut body = old.clone();
    let (mut done, mut left) = (Vec::new(), Vec::new());
    for t in wanted {
        match if add { crate::frontmatter::add_tag(&body, t) } else { crate::frontmatter::remove_tag(&body, t) } {
            Some(next) => {
                body = next;
                done.push(format!("#{t}"));
            }
            None => left.push(t.clone()),
        }
    }
    if body != old {
        use yrs::{Text, Transact};
        let (at, del, ins) = tags::change(&old, &body);
        let text = notes::body_text(&note.doc);
        let mut txn = note.doc.transact_mut();
        if del > 0 {
            text.remove_range(&mut txn, at as u32, del as u32);
        }
        if !ins.is_empty() {
            text.insert(&mut txn, at as u32, &ins);
        }
    }
    (done, left)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/**
 * Before an agent changes a note (#505): the note as it is kept as a version, unless the newest
 * version already is it. Whatever changed since the last version (the user's typing, say) is then
 * a step of its own in History, not folded into the agent's. Not kept: not changed.
 */
pub(crate) async fn keep_before(note: &DocSync, before: &str) -> Result<()> {
    let versions = note.versions().await?;
    let newest = match versions.first() {
        Some((id, _)) => note.read_version(*id).await.ok().map(|(_, text)| text),
        None => None,
    };
    if newest.as_deref() == Some(before.as_bytes()) {
        return Ok(());
    }
    // (Never before the newest: keep_after rounds its time up, and this comes after it.)
    let at = now_secs().max(versions.first().map_or(0, |(_, t)| *t));
    note.save_version(before.as_bytes(), at)
        .await
        .context("couldn't keep the note as it was in its history first, so it wasn't changed")
}

/**
 * After an agent's change has been saved (#505): the note as it is now, kept as a version by
 * `writer` (the app, through what, its session), so History shows the change as theirs. None if
 * kept; else why not (the change itself stands: it's said, not failed).
 */
pub(crate) async fn keep_after(note: &DocSync, after: &str, writer: &plim_core::version::Writer) -> Option<String> {
    // (Its time rounded up, the one before down: versions are timed to the second, and the note's
    // record of who typed (notes::mark_session) to the millisecond, so the change falls between the
    // two, and History doesn't take it for one after this. The server allows a little ahead.)
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    match note.save_version_packed(&plim_core::version::pack_by(after, writer), ms.div_ceil(1000)).await {
        Ok(()) => None,
        Err(e) => Some(format!("(It isn't in the note's History as yours: {e:#}.)")),
    }
}

/**
 * An agent's edit (#74), the note going from `before` to `after` (edits::replace_once): the note
 * as it was kept as a version first (keep_before: History has it one step back; not kept, not
 * changed), then the smallest change to its text, as one edit that merges with anyone else's.
 */
pub(crate) async fn keep_then_edit(note: &DocSync, before: &str, after: &str) -> Result<()> {
    keep_before(note, before).await?;
    use yrs::{Text, Transact};
    let (at, del, ins) = tags::change(before, after);
    let text = notes::body_text(&note.doc);
    let mut txn = note.doc.transact_mut();
    if del > 0 {
        text.remove_range(&mut txn, at as u32, del as u32);
    }
    if !ins.is_empty() {
        text.insert(&mut txn, at as u32, &ins);
    }
    Ok(())
}

/// A shared note from only its link (#130): no account, no passphrase, nothing kept here.
pub(crate) async fn open_link(link: &link::Link) -> Result<DocSync> {
    let home = Arc::new(link.home());
    let sess = Session::for_link(Api::new(&link.server), &home).await?;
    let mut note = DocSync::new_share(sess, home, Arc::new(CliEvents))?;
    note.load().await?;
    Ok(note)
}

/// Text at the end of a note: on a line of its own (a log, a list, an agent's notes).
pub(crate) fn append_text(note: &DocSync, text: &str) {
    use yrs::{Text, Transact};
    let body = notes::body(&note.doc);
    let sep = if body.is_empty() || body.ends_with('\n') { "" } else { "\n" };
    let t = notes::body_text(&note.doc);
    let len = t.len(&note.doc.transact());
    t.insert(&mut note.doc.transact_mut(), len, &format!("{sep}{}", text.trim_end_matches('\n')));
}

