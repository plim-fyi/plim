//! What the AI tools answer (#520), through the connector (connector/tools.rs, over a connection's
//! list note): what they say, and the rules behind it.

use std::collections::{BTreeMap, BTreeSet};

/// How many notes have each tag (`plim tags`, list_tags), each counted once a note. A tag is a
/// word (#539): `gym/legs` doesn't count for `gym`, as in the app.
pub fn tag_counts<'a>(notes: impl IntoIterator<Item = &'a [String]>) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for tags in notes {
        for t in tags.iter().collect::<BTreeSet<_>>() {
            *counts.entry(t.clone()).or_default() += 1;
        }
    }
    counts
}

/// list_tags: each tag and its count, a line each.
pub fn tags_answer(counts: &BTreeMap<String, usize>) -> String {
    if counts.is_empty() {
        return "No tags in the notes you can see.".into();
    }
    counts.iter().map(|(t, n)| format!("#{t} {n}\n")).collect()
}

/// list_notes (and read_notes_by_tag) with nothing to show.
pub fn nothing_listed(tag: Option<&str>) -> String {
    match tag {
        Some(t) => format!("No notes tagged #{t} that you can see."),
        None => "No notes that you can see: the user hasn't shared any with agents yet (or you make one).".into(),
    }
}

/// A note's line in list_notes: its title, address, when, whether it's view only, its tags.
pub fn list_line(title: &str, url: &str, when: &str, view_only: bool, tags: &[String]) -> String {
    let tagged: String = tags.iter().map(|t| format!(" #{t}")).collect();
    let role = if view_only { " (view only)" } else { "" };
    format!("- {title} · {url} · {when}{role}{tagged}\n")
}

/// tag_note / untag_note: what was done, what was left as it was, and the note's address.
pub fn retag_answer(add: bool, title: &str, done: &[String], left: &[String], url: &str) -> String {
    let mut out = vec![];
    if !done.is_empty() {
        out.push(format!("{} \"{title}\": {}", if add { "Tagged" } else { "Untagged" }, done.join(" ")));
    }
    if !left.is_empty() {
        let tags: Vec<String> = left.iter().map(|t| format!("#{t}")).collect();
        let why = match (add, tags.len() == 1) {
            (true, true) => "was there already",
            (true, false) => "were there already",
            (false, true) => "wasn't one of its tags",
            (false, false) => "weren't among its tags",
        };
        out.push(format!("{} {why}.", tags.join(" ")));
    }
    out.push(url.to_string());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tag_counts_once_a_note_and_a_nested_one_only_for_itself() {
        let notes = [vec!["gym/legs".to_string(), "gym".to_string(), "gym".to_string()], vec!["gym/arms/biceps".to_string()]];
        let counts = tag_counts(notes.iter().map(Vec::as_slice));
        assert_eq!(tags_answer(&counts), "#gym 1\n#gym/arms/biceps 1\n#gym/legs 1\n");
        assert_eq!(tags_answer(&BTreeMap::new()), "No tags in the notes you can see.");
    }

    #[test]
    fn retagging_says_what_was_done_and_what_was_left() {
        let s = |v: &[&str]| v.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert_eq!(retag_answer(true, "Plan", &s(&["gym"]), &s(&["work"]), "u"), "Tagged \"Plan\": gym\n#work was there already.\nu");
        assert_eq!(retag_answer(false, "Plan", &[], &s(&["a", "b"]), "u"), "#a #b weren't among its tags.\nu");
    }
}
