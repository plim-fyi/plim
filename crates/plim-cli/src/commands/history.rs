//! `plim history` and `plim restore` (#505): a note's earlier versions, as the web app's History
//! lists them (newest first, who made each when an AI did, what it changed), and one put back.

use anyhow::{Result, bail};
use similar::{ChangeTag, TextDiff};
use plim_core::version::Writer;

use crate::sync::DocSync;
use crate::vault::{base_url, finish, load_index, note_target, open_note, open_session};
use crate::{link, notes};

/// How many versions `plim history` lists unless asked for all.
const SHOWN: usize = 20;

/// One version: its time (seconds), text and who made it, if it says.
pub(crate) struct Version {
    pub at: u64,
    pub text: String,
    pub writer: Option<Writer>,
}

/// A version of a note, read and unpacked.
pub(crate) async fn read(note: &DocSync, id: i64) -> Result<Version> {
    let (at, packed) = note.read_version_packed(id).await?;
    let (text, writer) = plim_core::version::unpack_version(&packed).map_err(|e| anyhow::anyhow!("version {id}: {e}"))?;
    Ok(Version { at, text, writer })
}

/// Who made a version, in words ("Claude · amber fox", as web/core/authorship.js whoOf); "" when
/// it doesn't say (yours, or kept before versions said).
pub(crate) fn who(w: Option<&Writer>) -> String {
    match w {
        Some(Writer { name: Some(n), session: Some(s), .. }) if !n.is_empty() && !s.is_empty() => format!("{n} · {s}"),
        Some(Writer { name: Some(n), .. }) => n.clone(),
        _ => String::new(),
    }
}

/// Lines added and removed going from `a` to `b`.
pub(crate) fn changed_lines(a: &str, b: &str) -> (usize, usize) {
    let diff = TextDiff::from_lines(a, b);
    diff.iter_all_changes().fold((0, 0), |(add, del), c| match c.tag() {
        ChangeTag::Insert => (add + 1, del),
        ChangeTag::Delete => (add, del + 1),
        ChangeTag::Equal => (add, del),
    })
}

/// What changed from `a` to `b`, as a unified diff (two lines around each change).
pub(crate) fn unified(a: &str, b: &str, from: &str, to: &str) -> String {
    TextDiff::from_lines(a, b).unified_diff().context_radius(2).header(from, to).to_string()
}

/// How long ago, in a few characters: "42s ago", "5m ago", "3h ago", "2d ago".
pub(crate) fn ago(at: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match now.saturating_sub(at) {
        s if s < 60 => format!("{s}s ago"),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86400),
    }
}

/// `plim history <note>`: its versions, newest first, numbered (1 the newest), each with when, who
/// made it if an AI did, and the lines it added and removed since the one before; a first line for
/// what's changed since the newest (not kept yet). With `n`: that version's text, or (`diff`) what
/// it changed since the one before.
pub(crate) async fn history(server: Option<&str>, query: &str, n: Option<usize>, diff: bool, all: bool) -> Result<()> {
    let target = note_target(server, query)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &target)?;
    let mut note = open_note(&sess, &meta).await?;
    let title = if meta.title.is_empty() { "Untitled" } else { &meta.title };
    let ids: Vec<i64> = note.versions().await?.into_iter().map(|(id, _)| id).collect();
    if ids.is_empty() {
        eprintln!("\"{title}\" has no earlier versions yet.");
        return finish(&mut [&mut note, &mut l.index]).await;
    }
    if let Some(n) = n {
        let Some(&id) = ids.get(n.wrapping_sub(1)) else { bail!("\"{title}\" has {} versions: 1 (the newest) to {}", ids.len(), ids.len()) };
        let v = read(&note, id).await?;
        if diff {
            let before = match ids.get(n) {
                Some(&older) => read(&note, older).await?.text,
                None => String::new(),
            };
            print!("{}", unified(&before, &v.text, &format!("version {}", n + 1), &format!("version {n}")));
        } else {
            print!("{}", v.text);
            if !v.text.ends_with('\n') {
                println!();
            }
        }
        return finish(&mut [&mut note, &mut l.index]).await;
    }
    let shown = if all { ids.len() } else { ids.len().min(SHOWN) };
    // (Each listed, and the one before the oldest listed: what it changed is counted from it.)
    let mut versions = Vec::new();
    for &id in &ids[..(shown + 1).min(ids.len())] {
        versions.push(read(&note, id).await?);
    }
    println!("\"{title}\": {} version{}, newest first · {}", ids.len(), if ids.len() == 1 { "" } else { "s" }, link::note_url(&base_url(server)?, &meta.id));
    let now = notes::body(&note.doc);
    if now != versions[0].text {
        let (add, del) = changed_lines(&versions[0].text, &now);
        println!("{:>4}  {:<8}  {:<26}  +{add} −{del}", "now", "", "(not kept yet)");
    }
    for (i, v) in versions.iter().take(shown).enumerate() {
        let before = versions.get(i + 1).map(|o| o.text.as_str()).unwrap_or_default();
        let sum = if i + 1 < versions.len() || shown == ids.len() {
            let (add, del) = changed_lines(before, &v.text);
            format!("+{add} −{del}")
        } else {
            String::new()
        };
        println!("{:>4}  {:<8}  {:<26}  {sum}", i + 1, ago(v.at), who(v.writer.as_ref()));
    }
    if shown < ids.len() {
        eprintln!("({} older: `plim history --all`.)", ids.len() - shown);
    }
    eprintln!("A version's text: `plim history <note> <n>`; what it changed: add --diff. Put one back: `plim restore <note> <n>`.");
    finish(&mut [&mut note, &mut l.index]).await
}

/// `plim restore <note> <n>`: the note made as it was in version `n` (1 the newest), as one edit
/// that merges with anyone else's; what it is now kept as a version first, so it can be undone.
pub(crate) async fn restore(server: Option<&str>, query: &str, n: usize) -> Result<()> {
    let target = note_target(server, query)?;
    let sess = open_session(server).await?;
    let mut l = load_index(&sess).await?;
    let meta = notes::find(&l.index.doc, &target)?;
    let mut note = open_note(&sess, &meta).await?;
    let title = if meta.title.is_empty() { "Untitled".to_string() } else { meta.title.clone() };
    if !note.writable() {
        bail!("\"{title}\" is view only (you have its view link)");
    }
    let ids: Vec<i64> = note.versions().await?.into_iter().map(|(id, _)| id).collect();
    let Some(&id) = ids.get(n.wrapping_sub(1)) else {
        bail!("\"{title}\" has {} version{}{}", ids.len(), if ids.len() == 1 { "" } else { "s" }, if ids.is_empty() { "" } else { ": 1 is the newest" })
    };
    let v = read(&note, id).await?;
    let now = notes::body(&note.doc);
    if now == v.text {
        eprintln!("\"{title}\" is already as it was in version {n}.");
        return finish(&mut [&mut note, &mut l.index]).await;
    }
    crate::vault::keep_then_edit(&note, &now, &v.text).await?;
    notes::touch(&l.index.doc, &meta.id, &v.text, true);
    finish(&mut [&mut note, &mut l.index]).await?;
    eprintln!("Restored \"{title}\" as it was {} (version {n}); what it was is kept in its history: `plim history`.", ago(v.at));
    Ok(())
}

// ---- the AI tools: note_history and read_version (#505) ----

/// A note's versions an AI may see: from `since` (seconds: when it was given the note; None: all),
/// newest first.
async fn visible(note: &DocSync, since: Option<u64>) -> Result<(Vec<i64>, bool)> {
    let all = note.versions().await?;
    let total = all.len();
    let ids: Vec<i64> = all.into_iter().filter(|(_, at)| since.is_none_or(|s| *at >= s)).map(|(id, _)| id).collect();
    let hidden = ids.len() < total;
    Ok((ids, hidden))
}

/// note_history's answer: the versions it may see, newest first and numbered.
pub(crate) async fn history_answer(note: &DocSync, title: &str, url: &str, since: Option<u64>) -> Result<String> {
    let (ids, hidden) = visible(note, since).await?;
    let earlier = if hidden { " (Versions from before you were given it aren't shown.)" } else { "" };
    if ids.is_empty() {
        return Ok(format!("\"{title}\" has no versions{} yet: {url}{earlier}", if hidden { " you can see" } else { "" }));
    }
    let shown = ids.len().min(SHOWN);
    let mut versions = Vec::new();
    for &id in &ids[..(shown + 1).min(ids.len())] {
        versions.push(read(note, id).await?);
    }
    let mut out = vec![format!("\"{title}\": {} version{}, newest first: {url}", ids.len(), if ids.len() == 1 { "" } else { "s" })];
    let now = notes::body(&note.doc);
    if now != versions[0].text {
        let (add, del) = changed_lines(&versions[0].text, &now);
        out.push(format!("now (not kept yet): +{add} −{del} since 1"));
    }
    for (i, v) in versions.iter().take(shown).enumerate() {
        let who = match who(v.writer.as_ref()) {
            w if w.is_empty() => "the user, or before versions said who".to_string(),
            w => w,
        };
        let sum = match versions.get(i + 1) {
            Some(o) => {
                let (add, del) = changed_lines(&o.text, &v.text);
                format!(" · +{add} −{del}")
            }
            None => String::new(),
        };
        out.push(format!("{} · {} · {who}{sum}", i + 1, ago(v.at)));
    }
    if shown < ids.len() {
        out.push(format!("({} older not listed.)", ids.len() - shown));
    }
    out.push(format!("read_version shows one (its text, or with diff what it changed).{earlier}"));
    Ok(out.join("\n"))
}

/// read_version's answer: version `n` (1 the newest) of those it may see: its text, or (`diff`) what
/// it changed since the one before it may see.
pub(crate) async fn version_answer(note: &DocSync, title: &str, n: usize, diff: bool, since: Option<u64>) -> Result<String> {
    let (ids, hidden) = visible(note, since).await?;
    let Some(&id) = ids.get(n.wrapping_sub(1)) else {
        bail!("\"{title}\" has {} version{} you can see{}", ids.len(), if ids.len() == 1 { "" } else { "s" }, if ids.is_empty() { "" } else { ": 1 is the newest" })
    };
    let v = read(note, id).await?;
    let by = match who(v.writer.as_ref()) {
        w if w.is_empty() => String::new(),
        w => format!(", by {w}"),
    };
    let head = format!("Version {n} of \"{title}\", {}{by}", ago(v.at));
    if !diff {
        return Ok(format!("{head}:\n\n{}", v.text));
    }
    Ok(match ids.get(n) {
        Some(&older) => format!("{head}, what it changed since version {}:\n\n{}", n + 1, unified(&read(note, older).await?.text, &v.text, &format!("version {}", n + 1), &format!("version {n}"))),
        None if hidden => format!("{head}: the oldest you can see, so nothing to compare it with. Its text:\n\n{}", v.text),
        None => format!("{head}: the first version kept. Its text:\n\n{}", v.text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn who_changed_and_how_much() {
        let w = |n: Option<&str>, s: Option<&str>| Writer { name: n.map(Into::into), session: s.map(Into::into), ..Default::default() };
        assert_eq!(who(Some(&w(Some("Claude"), Some("amber fox")))), "Claude · amber fox");
        assert_eq!(who(Some(&w(Some("Codex"), None))), "Codex");
        assert_eq!(who(Some(&w(None, Some("amber fox")))), "");
        assert_eq!(who(None), "");
        assert_eq!(changed_lines("a\nb\nc\n", "a\nB\nc\nd\n"), (2, 1));
        assert_eq!(changed_lines("", "one"), (1, 0));
        let d = unified("a\nb\n", "a\nc\n", "version 2", "version 1");
        assert!(d.starts_with("--- version 2\n+++ version 1\n") && d.contains("-b\n") && d.contains("+c\n"), "{d}");
        assert!(ago(0).ends_with("d ago"));
    }
}
