//! Sharing: `plim share`, `unshare` (with people, or with agents: `--agents`, #514), and `add-link` (a note shared with you, into your list).

use anyhow::{Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

use crate::config;
use crate::vault::{base_url, finish, load_index, note_target, open_holder_link, open_link, open_session};
use crate::grants::Place;
use crate::{link, notes, sharing};

pub(crate) async fn add_link(server: Option<&str>, link: &str) -> Result<()> {
    // A link of your own (#369): kept as the holder, whose row follows the note's share.
    let (note, server_of, share_id, note_id, share_ref) = match (link::parse(link), link::parse_holder(link)) {
        (Some(link), _) => (open_link(&link).await?, link.server.clone(), link.share_id.clone(), link.note_id.clone(), link.share_ref()),
        (None, Some(hl)) => {
            let (share_id, note) = open_holder_link(&hl).await?;
            let r = notes::ShareRef { id: share_id.clone(), holder: Some(notes::HolderRef { id: hl.holder_id.clone(), secret: B64.encode(hl.secret) }), ..Default::default() };
            (note, hl.server.clone(), share_id, hl.note_id.clone(), r)
        }
        _ => bail!("that isn't a Plim link (…/n/<id>#k=… or #h=…)"),
    };
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    if config::server_url(server, config::load_device()?.as_ref()).trim_end_matches('/') != server_of {
        bail!("that link is for {server_of}, but this device is signed in to another server");
    }
    if let Some(m) = notes::with_share(&l.index.doc, &share_id) {
        eprintln!("\"{}\" is already in your notes.", m.title);
        return Ok(());
    }
    let body = notes::body(&note.doc);
    let title = notes::title_from_body(&body);
    // Under the link's address, if it has one and no note of yours is there: the same address for everyone in it (#299).
    let id = note_id.as_deref().filter(|id| notes::get(&l.index.doc, id).is_none());
    let id = notes::create_shared(&l.index.doc, &title, &share_ref, id);
    notes::set_tags(&l.index.doc, &id, &body); // (its tags, for the list: #308)
    finish(&mut [&mut l.index]).await?;
    let mode = if note.writable() { "" } else { " (view only)" };
    eprintln!("Added \"{}\"{mode} to your notes.", if title.is_empty() { "Untitled" } else { &title });
    Ok(())
}

pub(crate) async fn share(server: Option<&str>, query: &str, new_links: bool, for_whom: Option<&str>, view: bool) -> Result<()> {
    let query = note_target(server, query)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &query)?;
    let was_private = meta.share.is_none();
    let r = sharing::share(&sess, &l.index, &meta, new_links).await?;
    finish(&mut [&mut l.index]).await?;
    if was_private {
        sharing::remove_private(&sess, &meta.id).await;
    }
    let base = base_url(server)?;
    // A link of their own for someone (#369): registered, kept in the list, printed on stdout.
    if let Some(name) = for_whom {
        let meta = notes::find(&l.index.doc, &meta.id)?;
        let h = sharing::add_holder(&sess, &l.index, &meta, name, !view).await?;
        finish(&mut [&mut l.index]).await?;
        let secret: [u8; 32] = B64.decode(&h.secret)?.try_into().map_err(|_| anyhow::anyhow!("a bad secret"))?;
        println!("{name}’s link ({}): {}", if view { "can view" } else { "can edit" }, link::holder_url(&base, &meta.id, &h.id, &secret));
        eprintln!("Anyone with the link can open \"{}\". Take it back in the app's Share dialog (Remove).", meta.title);
        return Ok(());
    }
    let links = sharing::links(&base, &meta.id, &r)?;
    // The links on stdout (to copy, or for a script); the rest on stderr.
    if let Some(e) = &links.edit {
        println!("Can edit: {e}");
    }
    if let Some(v) = &links.view {
        println!("Can view: {v}");
    }
    if let Some(o) = &links.own {
        println!("Your link: {o}");
    }
    eprintln!(
        "{} Anyone with a link can open this note: share them only with people you trust.",
        match (was_private, new_links) {
            (true, _) => format!("Shared \"{}\".", meta.title),
            (false, true) => format!("New links for \"{}\": the old ones don't work any more.", meta.title),
            (false, false) => format!("\"{}\" is shared.", meta.title),
        }
    );
    Ok(())
}

pub(crate) async fn unshare(server: Option<&str>, query: &str) -> Result<()> {
    let query = note_target(server, query)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &query)?;
    sharing::unshare(&sess, &l.index, &meta).await?;
    finish(&mut [&mut l.index]).await?;
    eprintln!("Stopped sharing \"{}\": its links don't work any more.", meta.title);
    Ok(())
}


/// `plim share --agents` and `plim unshare --agents` (#514): every agent you connect reads and edits
/// the notes shared with agents. Here only the index says so; your Plim app shares it with each
/// connection (or takes it back) when it next looks.
pub(crate) async fn share_with_agents(server: Option<&str>, query: &str, on: bool) -> Result<()> {
    let query = note_target(server, query)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &query)?;
    let title = if meta.title.is_empty() { "Untitled" } else { &meta.title };
    if meta.share.as_ref().is_some_and(|s| s.holder.is_some()) {
        bail!("\"{title}\" was shared with you: only whoever shared it can share it with agents");
    }
    if meta.place.reached() == on {
        eprintln!("\"{title}\" {} shared with agents.", if on { "is already" } else { "isn't" });
        return Ok(());
    }
    notes::set_place(&l.index.doc, &meta.id, if on { Place::Notebook } else { Place::Mine });
    finish(&mut [&mut l.index]).await?;
    eprintln!(
        "{}",
        if on {
            format!("Shared \"{title}\" with agents: every agent you connect reads and edits it.")
        } else {
            format!("\"{title}\" isn't shared with agents any more: they lose it when your Plim app next opens.")
        }
    );
    Ok(())
}
