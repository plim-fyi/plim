//! An agent's edit to a note (#74): a piece of its text replaced by another, as an editor's
//! find-and-replace does. The piece must be there exactly once (else the agent is told how often,
//! and to say more of what's around it), so the edit lands where it was meant to, whatever else
//! changed in the note meanwhile; and it's applied as the smallest change (tags::change), merging
//! with anyone else's edits like any other.

/// The most text one edit may take out or put in: an edit, not a whole note rewritten by mistake.
pub const MAX_EDIT: usize = 20_000;

/// The note's text with `old` (there exactly once) replaced by `new`. Err: why not, for the agent.
pub fn replace_once(body: &str, old: &str, new: &str) -> Result<String, String> {
    if old.is_empty() {
        return Err("old_text is empty: give the exact text to replace (to add at the end, use append_to_note)".into());
    }
    if old.len() > MAX_EDIT || new.len() > MAX_EDIT {
        return Err(format!("an edit takes out or puts in at most {MAX_EDIT} characters: make it in smaller pieces"));
    }
    if old == new {
        return Err("old_text and new_text are the same: nothing to change".into());
    }
    match body.matches(old).count() {
        0 => Err("old_text isn't in the note (exactly, as it is now): read it again and copy the text to replace".into()),
        1 => Ok(body.replacen(old, new, 1)),
        n => Err(format!("old_text is in the note {n} times: include more of the text around it, so it's there once")),
    }
}

/// The lines around what changed (`new` in the note's new text), to show the agent its edit: the
/// changed lines and one either side, at most 8.
pub fn context(after: &str, before: &str) -> String {
    let (at, _, ins) = crate::tags::change(before, after);
    let start_line = after[..at].matches('\n').count();
    let end_line = start_line + ins.matches('\n').count();
    let lines: Vec<&str> = after.split('\n').collect();
    let from = start_line.saturating_sub(1);
    let to = (end_line + 1).min(lines.len().saturating_sub(1));
    let shown: Vec<&str> = lines[from..=to.max(from)].iter().take(8).copied().collect();
    shown.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "Groceries\n#shopping\n\n- oat milk\n- lemons\n- sourdough\n- lemons, unwaxed";

    #[test]
    fn a_piece_there_once_is_replaced_and_its_lines_shown() {
        let after = replace_once(NOTE, "- oat milk", "- [x] oat milk").unwrap();
        assert_eq!(after, NOTE.replace("- oat milk", "- [x] oat milk"));
        assert_eq!(context(&after, NOTE), "\n- [x] oat milk\n- lemons");
        // Taken out: an empty new_text.
        let gone = replace_once(NOTE, "\n- sourdough", "").unwrap();
        assert!(!gone.contains("sourdough"));
    }

    #[test]
    fn a_piece_not_there_there_twice_empty_or_unchanged_is_refused_saying_why() {
        assert!(replace_once(NOTE, "- bread", "- rye").unwrap_err().contains("isn't in the note"));
        assert!(replace_once(NOTE, "- lemons", "- limes").unwrap_err().contains("2 times"), "\"- lemons\" is in \"- lemons, unwaxed\" too");
        assert_eq!(replace_once(NOTE, "- lemons\n", "- limes\n").unwrap(), NOTE.replace("- lemons\n", "- limes\n"), "more of it: once");
        assert!(replace_once(NOTE, "", "x").unwrap_err().contains("empty"));
        assert!(replace_once(NOTE, "- oat milk", "- oat milk").unwrap_err().contains("same"));
        assert!(replace_once(NOTE, "- oat milk", &"x".repeat(MAX_EDIT + 1)).unwrap_err().contains("at most"));
    }
}
