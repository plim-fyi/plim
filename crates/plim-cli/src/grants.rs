//! What an agent may do with the user's notes (#514): read and edit the notes the user shares with
//! agents, and nothing else. One rule for every connection through the connector. The web app gives a connection its notes by the same rule
//! (web/core/connections-sync.js roleFor), and both answer the cases in
//! web/tests/fixtures/grants.json.
//!
//! Tags are only topics: they share nothing. Whether a note is shared with agents is kept with it in
//! the note list (`place: "ai"`), not in its text, so no tag typed or put on shares a note: only the
//! user does, in Share.

/// What an agent is told about the notes it may see. (Short: what the tools enforce, they say when it matters.)
const WORDS: &str = "You can read and edit the notes the user shares with agents (every AI they connect: Claude, \
ChatGPT, Codex…), and nothing else of theirs. When the user asks you to save or remember something, or the \
conversation turns up something they'd want later (a finding, an answer, a decision, a plan), keep it there: first \
look for the note on that topic (search_notes; list_tags lists the topics) and add to it or update it (edit_note, \
append_to_note) in its own format; make a new note only for a new topic. A new note you make is shared with agents. \
Tag a note with one or two topics, broad to narrow (#health/knee, #travel/portugal), reusing the topics there: a topic \
is what the note is about, never what you were doing (not #learning, #research), and details are sections in the \
note. Tags only sort notes: they share nothing. You can't delete or rewrite notes. Keep what matters, in a few clear \
lines, not the conversation. Then say in a line where you kept it, with the note's address.";

/// Whether a note is shared with agents (#514; the place of #484): the index keeps it with the note
/// (`place: "ai"`; none: the user's alone).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Place {
    #[default]
    Mine,
    /// Shared with agents.
    Notebook,
}

impl Place {
    /// As the index has it (web/core/connections-sync.js NOTEBOOK): "ai", shared with agents; anything else, the user's alone.
    pub fn from_index(place: Option<&str>) -> Self {
        if place == Some("ai") { Place::Notebook } else { Place::Mine }
    }

    /// Whether an agent may read and edit a note here: only one shared with agents.
    pub fn reached(self) -> bool {
        self == Place::Notebook
    }
}

/// In words, for the client (at initialize, and list_grants).
pub fn describe() -> String {
    WORDS.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same answers as the web app, from the same cases (web/tests/fixtures/grants.json):
    /// shared with agents, edited; else nowhere, whatever its tags.
    #[test]
    fn the_shared_cases() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../../web/tests/fixtures/grants.json")).unwrap();
        for c in f["cases"].as_array().unwrap() {
            let reached = Place::from_index(c["place"].as_str()).reached();
            assert_eq!(reached, c["role"] == "edit", "{c}");
        }
        assert!(describe().contains("nothing else of theirs") && describe().contains("Tags only sort notes"));
    }
}
