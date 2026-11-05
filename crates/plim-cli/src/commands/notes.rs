//! The notes: `plim ls`, `cat`, `tags`, `tag`/`untag`, `append`, `add`, `rm`.

use crate::writer::WritingAs;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use anyhow::{Context, Result, bail};
use clap::ValueEnum;

use crate::prompt::STDIN_IS_DATA;
use crate::sync::DocSync;
use crate::vault::{CliEvents, append_text, apply_tags, base_url, finish, load_index, note_target, open_holder_link, open_link, open_note, open_session, relative, tag_query};
use crate::{link, notes};

/// `plim ls --sort` (#344): the list's order, as the app's (web/core/notesort.js), newest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub(crate) enum Sort {
    /// When each note was last edited
    Edited,
    /// When each note was made
    Created,
}

pub(crate) async fn ls(server: Option<&str>, urls: bool, tag: Option<&str>, sort: Sort) -> Result<()> {
    let tag = tag.map(tag_query).transpose()?;
    let sess = open_session(server).await?;
    let base = base_url(server)?;
    let mut l = load_index(&sess).await?;
    let all = notes::list(&l.index.doc);
    let mut list: Vec<_> = all.iter().filter(|n| tag.as_ref().is_none_or(|t| n.tags.iter().any(|x| crate::tags::matches(x, t)))).collect();
    if sort == Sort::Created {
        notes::sort_by_created(&mut list);
    }
    if all.is_empty() {
        eprintln!("No notes yet. Add one with `plim add` or open `plim`.");
    } else if let Some(t) = &tag
        && list.is_empty()
    {
        eprintln!("No notes tagged #{t}.");
    }
    for n in &list {
        // (A title is anyone's text, a shared note's too: no control characters to the terminal.)
        let title = if n.title.is_empty() { "Untitled".to_string() } else { n.title.chars().map(|c| if c.is_control() { ' ' } else { c }).collect() };
        let shared = if n.shared { "  (shared)" } else { "" };
        let tagged: String = n.tags.iter().map(|t| format!("  #{t}")).collect();
        let name = if urls { link::note_url(&base, &n.id) } else { n.id[..8].to_string() };
        let at = if sort == Sort::Created { notes::created_or_updated(n) } else { n.updated };
        println!("{name}  {:<10}  {title}{shared}{tagged}", relative(at));
    }
    if tag.is_some() {
        unread_hint(&all);
    }
    finish(&mut [&mut l.index]).await
}

/// Notes whose tags haven't been read yet (last written before tags were kept, or by an app
/// that doesn't keep them): said, as a search by tag can't find them.
fn unread_hint(list: &[notes::NoteMeta]) {
    let unread = list.iter().filter(|n| !n.tags_read).count();
    if unread > 0 {
        let notes = if unread == 1 { "1 note hasn't" } else { &format!("{unread} notes haven't") };
        eprintln!("({notes} had its tags read yet, so a search by tag misses it: `plim tags --rebuild` reads them.)");
    }
}

/// `plim cat --tag`: every note with the tag, newest first, each under its title and address
/// (as `head` heads files). Each note's stored tags are put right from its text on the way: one
/// that no longer has the tag isn't printed.
pub(crate) async fn cat_tagged(server: Option<&str>, tag: &str) -> Result<()> {
    let tag = tag_query(tag)?;
    let sess = open_session(server).await?;
    let base = base_url(server)?;
    let mut l = load_index(&sess).await?;
    let all = notes::list(&l.index.doc);
    let mut printed = 0;
    for n in all.iter().filter(|n| n.tags.iter().any(|x| crate::tags::matches(x, &tag))) {
        let note = match open_note(&sess, n).await {
            Ok(note) => note,
            Err(e) => {
                eprintln!("couldn't open \"{}\": {e:#}", n.title);
                continue;
            }
        };
        let body = notes::body(&note.doc);
        notes::set_tags(&l.index.doc, &n.id, &body);
        if !crate::frontmatter::note_tags(&body).iter().any(|x| crate::tags::matches(x, &tag)) {
            continue; // (its stored tags were behind its text)
        }
        if printed > 0 {
            println!();
        }
        let title = if n.title.is_empty() { "Untitled" } else { &n.title };
        println!("==> {title} · {} <==", link::note_url(&base, &n.id));
        print!("{body}");
        if !body.ends_with('\n') {
            println!();
        }
        printed += 1;
    }
    if printed == 0 {
        eprintln!("No notes tagged #{tag}.");
    }
    unread_hint(&all);
    finish(&mut [&mut l.index]).await
}

/// `plim export <dir>` (#47): every note (but those deleted for good) as a Markdown file in `dir`,
/// as the web app's Export all notes makes them (crate::export): Recently deleted's in
/// `dir/deleted/`, each file's time its note's last edit. `dir` is made; one with anything in it is
/// refused, so nothing there is written over.
pub(crate) async fn export(server: Option<&str>, dir: &std::path::Path) -> Result<()> {
    use crate::export::{FileMeta, Named, export_text, export_title, file_paths};
    if dir.exists() && std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))?.next().is_some() {
        bail!("{} isn't empty: export into a new or empty folder", dir.display());
    }
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let all: Vec<_> = notes::all(&l.index.doc).into_iter().filter(|n| !notes::purged(&l.index.doc, &n.id)).collect();
    eprintln!("Reading {} notes…", all.len());
    let mut read = Vec::new();
    let mut missed = Vec::new();
    for n in &all {
        match open_note(&sess, n).await {
            Ok(note) => read.push((n, notes::body(&note.doc))),
            Err(e) => {
                eprintln!("couldn't open \"{}\": {e:#}", n.title);
                missed.push(n.title.clone());
            }
        }
    }
    let titles: Vec<String> = read.iter().map(|(n, body)| export_title(body, &n.title)).collect();
    let named: Vec<Named> = read.iter().zip(&titles).map(|((n, _), t)| Named { id: &n.id, title: t, created: n.created, deleted: n.deleted }).collect();
    let paths = file_paths(&named);
    // The files aren't encrypted: private to you (0700, 0600), and never written over something
    // put there since the folder was looked at (create_new, which also refuses a symlink).
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let mkdir = |d: &std::path::Path| std::fs::DirBuilder::new().recursive(true).mode(0o700).create(d).with_context(|| format!("making {}", d.display()));
    mkdir(dir)?;
    for (n, body) in &read {
        let shared = n.share.as_ref().is_some_and(|s| s.role.as_deref() != Some("owner"));
        let text = export_text(body, &FileMeta { created: n.created, updated: n.updated, id: n.id.clone(), shared });
        let path = dir.join(&paths[&n.id]);
        if let Some(parent) = path.parent() {
            mkdir(parent)?;
        }
        let file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).with_context(|| format!("writing {}", path.display()))?;
        std::io::Write::write_all(&mut &file, text.as_bytes())?;
        if n.updated > 0.0 {
            // (Its time, its note's last edit, as the zip has it.)
            let _ = file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(n.updated as u64));
        }
    }
    let deleted = read.iter().filter(|(n, _)| n.deleted).count();
    let word = |k: usize| if k == 1 { "1 note".to_string() } else { format!("{k} notes") };
    eprintln!("Exported {} to {}{}.", word(read.len()), dir.display(), if deleted > 0 { format!(" ({deleted} from Recently deleted, in deleted/)") } else { String::new() });
    eprintln!("The files aren't encrypted: keep them somewhere safe.");
    if !missed.is_empty() {
        eprintln!("Not exported (couldn't be read): {}", missed.join(", "));
    }
    finish(&mut [&mut l.index]).await
}

/// `plim tags`: each tag and how many notes have it (a nested tag's notes count for its parent
/// too: #gym/legs is under #gym). With `rebuild`, every note is opened and its tags read first.
pub(crate) async fn tags(server: Option<&str>, rebuild: bool) -> Result<()> {
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    if rebuild {
        let list = notes::list(&l.index.doc);
        eprintln!("Reading the tags of {} notes…", list.len());
        let (mut changed, mut failed) = (0, 0);
        for n in &list {
            match open_note(&sess, n).await {
                Ok(note) => changed += usize::from(notes::set_tags(&l.index.doc, &n.id, &notes::body(&note.doc))),
                Err(e) => {
                    failed += 1;
                    eprintln!("couldn't open \"{}\": {e:#}", n.title);
                }
            }
        }
        let failed = if failed > 0 { format!(", {failed} couldn't be opened") } else { String::new() };
        eprintln!("Read {} notes: {changed} had tags to put right{failed}.", list.len());
    }
    let list = notes::list(&l.index.doc);
    let counts = crate::answers::tag_counts(list.iter().map(|n| n.tags.as_slice())); // (each tag once a note; #gym/legs not for #gym, #539)
    if counts.is_empty() {
        eprintln!("No tags yet. Write one in a note (#gym), or add one with `plim tag <note> gym`.");
    }
    for (t, n) in &counts {
        println!("#{t}  {n}");
    }
    if !rebuild {
        unread_hint(&list);
    }
    finish(&mut [&mut l.index]).await
}

/// `plim tag` (`add`) and `plim untag`: the tags put on, or taken off, the line of tags under the
/// note's title, as one edit to its text (others' edits meanwhile merge as with any edit).
pub(crate) async fn tag(server: Option<&str>, target: &str, wanted: &[String], add: bool, who: Option<WritingAs>) -> Result<()> {
    let wanted: Vec<String> = wanted.iter().map(|t| tag_query(t)).collect::<Result<_>>()?;
    let target = note_target(server, target)?;
    let sess = open_session(server).await?;
    let base = base_url(server)?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &target)?;
    let mut note = open_note(&sess, &meta).await?;
    if !note.writable() {
        bail!("\"{}\" is view only (you have its view link)", meta.title);
    }
    let old = notes::body(&note.doc);
    match &who {
        Some(w) => w.before(&note, &old).await?,
        None => note.keep_history().await,
    }
    let (done, left) = apply_tags(&note, &wanted, add);
    let body = notes::body(&note.doc);
    notes::touch(&l.index.doc, &meta.id, &body, body != old);
    let by = who.as_ref().filter(|_| body != old); // (written as someone: only if it changed anything)
    if let Some(w) = by {
        w.mark(&note, Some((&l.index.doc, &meta.id)));
    }
    finish(&mut [&mut note, &mut l.index]).await?;
    if let Some(w) = by {
        w.after(&note, &body).await;
    }
    let title = if meta.title.is_empty() { "Untitled" } else { &meta.title };
    let url = link::note_url(&base, &meta.id);
    if !done.is_empty() {
        eprintln!("{} \"{title}\": {} · {url}", if add { "Tagged" } else { "Untagged" }, done.join(" "));
    }
    for t in left.iter().map(String::as_str) {
        let msg = if add { format!("\"{title}\" has #{t} already.") } else { format!("\"{title}\" isn't tagged #{t}.") };
        eprintln!("{msg}");
    }
    Ok(())
}

/// Arguments, or stdin when there are none (or just "-").
fn text_arg(text: Vec<String>) -> Result<String> {
    if text.is_empty() || text == ["-"] {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).context("reading text from stdin")?;
        STDIN_IS_DATA.store(true, Ordering::Relaxed);
        Ok(s)
    } else {
        Ok(text.join(" "))
    }
}

pub(crate) async fn append(server: Option<&str>, target: &str, text: Vec<String>, who: Option<WritingAs>) -> Result<()> {
    let text = text_arg(text)?;
    let linked = match (link::parse(target), link::parse_holder(target)) {
        (Some(link), _) => Some(open_link(&link).await?),
        (None, Some(hl)) => Some(open_holder_link(&hl).await?.1),
        _ => None,
    };
    if let Some(mut note) = linked {
        if !note.writable() {
            bail!("that's a view link: it can only read the note");
        }
        note.keep_history().await; // (#505: as the app's edits keep versions)
        append_text(&note, &text);
        if let Some(w) = &who {
            w.mark(&note, None); // (#542: through a link, the text marked; no list of yours to say so)
        }
        note.flush().await?;
        if note.has_pending()? {
            bail!("couldn't save it: the server didn't take the change (offline?)");
        }
        eprintln!("Added to the shared note.");
        return Ok(());
    }
    let target = note_target(server, target)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &target)?;
    let mut note = open_note(&sess, &meta).await?;
    if !note.writable() {
        bail!("\"{}\" is view only (you have its view link)", meta.title);
    }
    let before = notes::body(&note.doc);
    match &who {
        Some(w) => w.before(&note, &before).await?,
        None => note.keep_history().await,
    }
    append_text(&note, &text);
    let after = notes::body(&note.doc);
    notes::touch(&l.index.doc, &meta.id, &after, true);
    if let Some(w) = &who {
        w.mark(&note, Some((&l.index.doc, &meta.id)));
    }
    finish(&mut [&mut note, &mut l.index]).await?;
    if let Some(w) = &who {
        w.after(&note, &after).await;
    }
    eprintln!("Added to \"{}\": {}", meta.title, link::note_url(&base_url(server)?, &meta.id));
    Ok(())
}

pub(crate) async fn cat(server: Option<&str>, query: &str) -> Result<()> {
    let linked = match (link::parse(query), link::parse_holder(query)) {
        (Some(link), _) => Some(open_link(&link).await?),
        (None, Some(hl)) => Some(open_holder_link(&hl).await?.1),
        _ => None,
    };
    if let Some(note) = linked {
        let body = notes::body(&note.doc);
        print!("{body}");
        if !body.ends_with('\n') {
            println!();
        }
        return Ok(());
    }
    let query = note_target(server, query)?;
    let sess = open_session(server).await?;
    let l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &query)?;
    let note = open_note(&sess, &meta).await?; // (a shared note: from its share, with its link's keys, #80)
    let body = notes::body(&note.doc);
    print!("{body}");
    if !body.ends_with('\n') {
        println!();
    }
    Ok(())
}

pub(crate) async fn add(server: Option<&str>, text: Vec<String>, who: Option<WritingAs>) -> Result<()> {
    let body = if text.is_empty() || text == ["-"] {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).context("reading note from stdin")?;
        STDIN_IS_DATA.store(true, Ordering::Relaxed);
        s
    } else {
        text.join(" ")
    };
    if body.trim().is_empty() {
        bail!("nothing to add");
    }
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let body = crate::frontmatter::to_frontmatter(&body); // (#584: its title and tags in a block)
    let id = notes::create(&l.index.doc, &notes::title_from_body(&body));
    let mut note = DocSync::new(sess.clone(), &id, Arc::new(CliEvents))?;
    notes::set_body(&note.doc, &body);
    notes::touch(&l.index.doc, &id, &body, true);
    if let Some(w) = &who {
        w.mark(&note, Some((&l.index.doc, &id)));
    }
    finish(&mut [&mut note, &mut l.index]).await?;
    if let Some(w) = &who {
        w.after(&note, &body).await;
    }
    eprintln!("Added \"{}\": {}", notes::title_from_body(&body), link::note_url(&base_url(server)?, &id));
    Ok(())
}

pub(crate) async fn rm(server: Option<&str>, query: &str) -> Result<()> {
    let query = note_target(server, query)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &query)?;
    notes::delete(&l.index.doc, &meta.id);
    finish(&mut [&mut l.index]).await?;
    eprintln!("Deleted \"{}\"", meta.title);
    Ok(())
}
