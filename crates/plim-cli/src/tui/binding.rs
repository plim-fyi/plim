//! Text ↔ Y.Text plumbing for the editor, ported from `web/textarea-binding.js`.
//! The note doc uses byte offsets (`OffsetKind::Bytes`); every edit is computed
//! on char boundaries so it is valid UTF-8 for both Rust and the web app.

use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update};

use crate::notes::{body, body_text};
use crate::sync::new_doc;

/// Smallest single edit turning `a` into `b`, in byte offsets on char boundaries.
#[derive(Debug, PartialEq, Eq)]
pub struct Edit {
    pub index: usize,
    pub remove: usize,
    pub insert: String,
}

pub fn diff(a: &str, b: &str) -> Edit {
    let prefix: usize = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).map(|(c, _)| c.len_utf8()).sum();
    let (ra, rb) = (&a[prefix..], &b[prefix..]);
    let suffix: usize =
        ra.chars().rev().zip(rb.chars().rev()).take_while(|(x, y)| x == y).map(|(c, _)| c.len_utf8()).sum();
    Edit { index: prefix, remove: ra.len() - suffix, insert: rb[..rb.len() - suffix].to_string() }
}

/// Apply `old → new` to the note's body (a local edit, so it autosaves): one
/// transaction, or several for a big insert (see `notes::insert_chunked`).
pub fn apply_text(note: &Doc, old: &str, new: &str) {
    let e = diff(old, new);
    if e.remove == 0 && e.insert.is_empty() {
        return;
    }
    let text = body_text(note);
    if e.insert.len() > crate::notes::INSERT_CHUNK {
        if e.remove > 0 {
            text.remove_range(&mut note.transact_mut(), e.index as u32, e.remove as u32);
        }
        crate::notes::insert_chunked(note, e.index as u32, &e.insert);
        return;
    }
    let mut txn = note.transact_mut();
    if e.remove > 0 {
        text.remove_range(&mut txn, e.index as u32, e.remove as u32);
    }
    if !e.insert.is_empty() {
        text.insert(&mut txn, e.index as u32, &e.insert);
    }
}

/// Move a byte position through an edit, as `transformIndex` does in the web app.
pub fn transform(pos: usize, e: &Edit) -> usize {
    if pos <= e.index {
        pos
    } else if pos >= e.index + e.remove {
        pos - e.remove + e.insert.len()
    } else {
        e.index + e.insert.len()
    }
}

/// (row, col in chars) → byte offset in `text`.
pub fn to_offset(text: &str, row: usize, col: usize) -> usize {
    let mut off = 0;
    for (i, line) in text.split('\n').enumerate() {
        if i == row {
            return off + line.char_indices().nth(col).map_or(line.len(), |(b, _)| b);
        }
        off += line.len() + 1;
    }
    text.len()
}

/// Byte offset → (row, col in chars).
pub fn to_row_col(text: &str, offset: usize) -> (usize, usize) {
    let before = &text[..offset.min(text.len())];
    let row = before.matches('\n').count();
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    (row, before[line_start..].chars().count())
}

/// Where the cursor at (row, col) in `old` should land in `new`.
pub fn move_cursor(old: &str, new: &str, row: usize, col: usize) -> (usize, usize) {
    let pos = transform(to_offset(old, row, col), &diff(old, new));
    to_row_col(new, pos)
}

/// Merge an external edit: replay `base → edited` on a fork of the note as it
/// was when the editor opened, and return that change as Yjs updates — one
/// per transaction, so a big insert stays split into pieces (see
/// `apply_text`) and each becomes its own upload. Applying them, in order and
/// each in its own transaction, to the live doc merges cleanly with edits
/// made in the meantime. Empty when nothing changed.
pub fn external_edit_updates(base_state: &[u8], edited: &str) -> Result<Vec<Vec<u8>>> {
    let fork = new_doc();
    fork.transact_mut().apply_update(Update::decode_v1(base_state)?)?;
    let base = body(&fork);
    if base == edited {
        return Ok(Vec::new());
    }
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink = updates.clone();
    fork.observe_update_v1("plim-external", move |_, e| sink.lock().unwrap().push(e.update.clone()))
        .map_err(|e| anyhow!("cannot observe document: {e:?}"))?;
    apply_text(&fork, &base, edited);
    let _ = fork.unobserve_update_v1("plim-external");
    Ok(std::mem::take(&mut *updates.lock().unwrap()))
}

pub fn state_of(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_on_char_boundaries() {
        assert_eq!(diff("hello world", "hello brave world"), Edit { index: 6, remove: 0, insert: "brave ".into() });
        assert_eq!(diff("abc", "ac"), Edit { index: 1, remove: 1, insert: "".into() });
        // "é" and "è" share their first UTF-8 byte; the diff must not split it.
        let e = diff("café", "cafè");
        assert_eq!(e, Edit { index: 3, remove: 2, insert: "è".into() });
        let e = diff("✓✓", "✓x✓");
        assert_eq!(e, Edit { index: 3, remove: 0, insert: "x".into() });
    }

    #[test]
    fn cursor_mapping() {
        let t = "ab\nçd\n";
        assert_eq!(to_offset(t, 1, 1), 5);
        assert_eq!(to_row_col(t, 5), (1, 1));
        assert_eq!(to_offset(t, 2, 0), t.len());
        assert_eq!(to_row_col(t, t.len()), (2, 0));
        // Remote insert before the cursor pushes it along; after it, leaves it.
        assert_eq!(move_cursor("hello\nworld", ">> hello\nworld", 1, 2), (1, 2));
        assert_eq!(move_cursor("hello", ">> hello", 0, 2), (0, 5));
        assert_eq!(move_cursor("hello", "hello!!", 0, 2), (0, 2));
    }

    #[test]
    fn apply_text_updates_doc() {
        let doc = new_doc();
        apply_text(&doc, "", "Grüße\nworld");
        apply_text(&doc, "Grüße\nworld", "Grüße, all\nworld!");
        assert_eq!(body(&doc), "Grüße, all\nworld!");
    }

    #[test]
    fn external_edit_merges_with_concurrent_changes() {
        let live = new_doc();
        apply_text(&live, "", "line one\nline two\n");
        let base = state_of(&live);
        // While the external editor is open, another device appends a line.
        apply_text(&live, "line one\nline two\n", "line one\nline two\nfrom elsewhere\n");
        // The external editor changed the first line only.
        let updates = external_edit_updates(&base, "LINE ONE edited\nline two\n").unwrap();
        assert_eq!(updates.len(), 1);
        for u in &updates {
            live.transact_mut().apply_update(Update::decode_v1(u).unwrap()).unwrap();
        }
        assert_eq!(body(&live), "LINE ONE edited\nline two\nfrom elsewhere\n");
        // No change → no update.
        assert!(external_edit_updates(&state_of(&live), &body(&live)).unwrap().is_empty());
    }

    #[test]
    fn a_big_external_edit_stays_in_pieces() {
        let live = new_doc();
        apply_text(&live, "", "notes\n");
        let base = state_of(&live);
        apply_text(&live, "notes\n", "notes\nfrom elsewhere\n");
        let pasted = format!("notes\n{}é end\n", "log line ✓\n".repeat(crate::notes::INSERT_CHUNK / 4));
        let updates = external_edit_updates(&base, &pasted).unwrap();
        assert!(updates.len() >= 3, "{} updates", updates.len());
        assert!(updates.iter().all(|u| u.len() <= crate::notes::INSERT_CHUNK + 1024));
        // Each applied in its own transaction: as many local updates (outbox records) on the live doc.
        let seen = Arc::new(Mutex::new(0));
        let count = seen.clone();
        live.observe_update_v1("count", move |_, _| *count.lock().unwrap() += 1).unwrap();
        for u in &updates {
            live.transact_mut().apply_update(Update::decode_v1(u).unwrap()).unwrap();
        }
        assert_eq!(*seen.lock().unwrap(), updates.len());
        // Both edits survive (concurrent inserts at one spot: Yjs picks the order, the same everywhere).
        let merged = body(&live);
        assert!(merged.starts_with("notes\n") && merged.contains("from elsewhere\n"));
        assert!(merged.contains(&pasted["notes\n".len()..]));
        assert_eq!(merged.len(), pasted.len() + "from elsewhere\n".len());
    }
}
