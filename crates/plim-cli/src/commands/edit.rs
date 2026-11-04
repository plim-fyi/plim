//! `plim edit`: change a note's text from the shell, three ways. In your editor
//! (`$PLIM_EDITOR`/`$VISUAL`/`$EDITOR`, as the terminal editor's `e`); a piece replaced
//! (`--replace OLD NEW`, there exactly once, as the AI tools' edit_note); or the whole text from
//! stdin (`-`). Each is the smallest change to the text, merged with anyone else's edits, and
//! keeps versions as your other edits here do (#505).

use std::io::Read;

use anyhow::{Context, Result, bail};
use yrs::{Transact, Update};
use yrs::updates::decoder::Decode;

use crate::commands::history::changed_lines;
use crate::sync::DocSync;
use crate::tui::{binding, external};
use crate::vault::{base_url, finish, load_index, note_target, open_holder_link, open_link, open_note, open_session};
use crate::writer::WritingAs;
use crate::{link, notes};

/// How the new text comes.
pub(crate) enum How {
    /// In your editor.
    Editor,
    /// `old` (there once) replaced by `new`.
    Replace(String, String),
    /// The whole text, from stdin.
    Stdin,
}

pub(crate) async fn edit(server: Option<&str>, target: &str, how: How, who: Option<WritingAs>) -> Result<()> {
    // (Read first: a pipe's text, before anything is opened.)
    let piped = match &how {
        How::Stdin => Some(read_stdin()?),
        _ => None,
    };
    let linked = match (link::parse(target), link::parse_holder(target)) {
        (Some(l), _) => Some(open_link(&l).await?),
        (None, Some(hl)) => Some(open_holder_link(&hl).await?.1),
        _ => None,
    };
    if let Some(mut note) = linked {
        if !note.writable() {
            bail!("that's a view link: it can only read the note");
        }
        let Some((before, after)) = change(&mut note, &how, piped, None).await? else {
            eprintln!("No changes.");
            return Ok(());
        };
        if let Some(w) = &who {
            w.mark(&note, None); // (#542: through a link, the text marked; no list of yours to say so)
        }
        note.flush().await?;
        if note.has_pending()? {
            bail!("couldn't save it: the server didn't take the change (offline?)");
        }
        let (add, del) = changed_lines(&before, &after);
        eprintln!("Edited the shared note: +{add} −{del}");
        return Ok(());
    }
    let target = note_target(server, target)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &target)?;
    let mut note = open_note(&sess, &meta).await?;
    let title = if meta.title.is_empty() { "Untitled".to_string() } else { meta.title.clone() };
    if !note.writable() {
        bail!("\"{title}\" is view only (you have its view link)");
    }
    let Some((before, after)) = change(&mut note, &how, piped, who.as_ref()).await? else {
        eprintln!("No changes to \"{title}\".");
        return finish(&mut [&mut note, &mut l.index]).await;
    };
    notes::touch(&l.index.doc, &meta.id, &after, true);
    if let Some(w) = &who {
        w.mark(&note, Some((&l.index.doc, &meta.id)));
    }
    finish(&mut [&mut note, &mut l.index]).await?;
    if let Some(w) = &who {
        w.after(&note, &after).await;
    }
    let (add, del) = changed_lines(&before, &after);
    eprintln!("Edited \"{title}\": +{add} −{del} · {}", link::note_url(&base_url(server)?, &meta.id));
    Ok(())
}

/// The change made to the note (not yet saved): the text before and after, or None if there's none.
/// Written as someone (#542): the note as it was kept as their version's start, as an app's edits.
async fn change(note: &mut DocSync, how: &How, piped: Option<String>, who: Option<&WritingAs>) -> Result<Option<(String, String)>> {
    let before = notes::body(&note.doc);
    match who {
        Some(w) => w.before(note, &before).await?,
        None => note.keep_history().await,
    }
    match how {
        How::Replace(old, new) => {
            let after = crate::edits::replace_once(&before, old, new).map_err(|e| anyhow::anyhow!(e))?;
            binding::apply_text(&note.doc, &before, &after);
        }
        How::Stdin => {
            let mut after = piped.unwrap_or_default();
            // (`plim cat` ends a note without a final line break with one: not a change.)
            if !before.ends_with('\n') && after.ends_with('\n') {
                after.pop();
            }
            binding::apply_text(&note.doc, &before, &after);
        }
        How::Editor => {
            let base = binding::state_of(&note.doc);
            let plan = external::current_plan();
            if let Some(w) = &plan.warning {
                eprintln!("{w}");
            }
            let text = before.clone();
            let edited = tokio::task::spawn_blocking(move || external::edit(&text, &plan)).await.context("the editor didn't finish")??;
            if edited == before {
                return Ok(None);
            }
            // Edits made elsewhere while it was open: fetched, then yours merged in.
            note.pull().await?;
            for update in binding::external_edit_updates(&base, &edited)? {
                note.doc.transact_mut().apply_update(Update::decode_v1(&update)?)?;
            }
        }
    }
    let after = notes::body(&note.doc);
    Ok((after != before).then_some((before, after)))
}

/// The note's new text from stdin: refused if empty, so a broken pipe can't wipe a note.
fn read_stdin() -> Result<String> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).context("couldn't read the new text from stdin")?;
    crate::prompt::STDIN_IS_DATA.store(true, std::sync::atomic::Ordering::Relaxed); // (a passphrase is asked on the terminal)
    if text.trim().is_empty() {
        bail!("nothing on stdin: a note's whole new text is needed (to empty a note, delete it, or edit it in your editor)");
    }
    Ok(text)
}
