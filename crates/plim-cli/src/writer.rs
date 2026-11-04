//! Who's writing (#505): each version an AI saves says which app, through what, and which session,
//! so a note's history tells one session's change from another's ("Claude · amber fox", "Claude ·
//! quiet river"). A session is named with two words, easier to tell apart and to say than an id,
//! and also keeps a short id (not shown) for when two draw the same words.
//!
//! A `plim --as NAME` run is one session; the connector, one per MCP session (the Mcp-Session-Id
//! it hands out), named from that id so it needs nothing kept.

use plim_core::version::Writer;

/// An adjective, then a noun: 64 of each (4,096 names). Short, plain, and fine next to any other.
const WORDS: [[&str; 64]; 2] = [
    [
        "amber", "bold", "brave", "bright", "brisk", "calm", "clear", "cool", "crisp", "deep", "early", "fair", "fast", "fine", "fond", "free",
        "fresh", "glad", "gold", "good", "grand", "green", "keen", "kind", "late", "light", "lucky", "merry", "mild", "neat", "new", "nice",
        "odd", "open", "pale", "plain", "proud", "quick", "quiet", "rare", "ready", "rich", "ripe", "rosy", "round", "safe", "sharp", "shy",
        "slow", "small", "smart", "snug", "soft", "sound", "spare", "still", "sunny", "sweet", "swift", "tall", "tidy", "warm", "wild", "wise",
    ],
    [
        "ant", "bear", "bee", "bird", "boat", "book", "cat", "cliff", "cloud", "crab", "crow", "deer", "dog", "dove", "duck", "elm",
        "fern", "fig", "fish", "fox", "frog", "goat", "hare", "hawk", "hill", "kite", "lake", "lamb", "leaf", "lion", "lynx", "moon",
        "moss", "moth", "mouse", "newt", "oak", "otter", "owl", "path", "pear", "pine", "plum", "pond", "rain", "reed", "river", "robin",
        "rock", "rose", "seal", "seed", "snail", "snow", "star", "stone", "swan", "toad", "tree", "vale", "wave", "wolf", "wren", "yak",
    ],
];

/// A writing session: its two words and its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WriterSession {
    pub name: String,
    pub sid: String,
}

impl WriterSession {
    /// From 8 bytes: the first two pick the words, the next six are the id.
    fn from_bytes(b: &[u8; 8]) -> Self {
        WriterSession { name: format!("{} {}", WORDS[0][b[0] as usize % 64], WORDS[1][b[1] as usize % 64]), sid: hex::encode(&b[2..]) }
    }

    /// A new one, at random (`--as NAME`, once per run).
    pub fn random() -> Self {
        Self::from_bytes(&plim_core::crypto::random_bytes::<8>())
    }

    /// The one an MCP session's id names (the connector): the same id, the same session, without
    /// keeping anything. (Hashed: the id itself isn't written anywhere.)
    pub fn of(mcp_session: &str) -> Self {
        let h = plim_core::sig::sha256(mcp_session.as_bytes());
        Self::from_bytes(h[..8].try_into().unwrap())
    }

    /// What a version it saves says about who wrote it: `app` ("Claude"), through `connection`.
    pub fn writer(&self, app: &str, connection: &str) -> Writer {
        Writer { name: Some(app.into()), connection: Some(connection.into()), session: Some(self.name.clone()), sid: Some(self.sid.clone()) }
    }
}

/// The longest name `--as` takes: a few words ("Claude", "Backup script").
const AS_MAX: usize = 40;

/**
 * Who a write from the shell is by (#542): `--as NAME`, else `$PLIM_AS`; neither, you. Marked as an
 * app's edits are (the connector): the text it types carries its mark in the app ("by
 * Claude" in the list, its letter in the margin) and History names its versions ("Claude · amber
 * fox"). A label, not proof: whoever runs `plim` holds the whole key, and could write as anyone.
 */
pub(crate) struct WritingAs {
    pub name: String,
    pub session: WriterSession,
}

impl WritingAs {
    /// From the flag, else the environment; refused if it's not a plain short name.
    pub fn from(flag: Option<String>) -> anyhow::Result<Option<Self>> {
        Self::named(flag.or_else(|| crate::config::env("AS")))
    }

    fn named(name: Option<String>) -> anyhow::Result<Option<Self>> {
        let Some(name) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) else { return Ok(None) };
        if name.chars().count() > AS_MAX || name.chars().any(char::is_control) {
            anyhow::bail!("--as takes a short name, {AS_MAX} characters at most (\"Claude\", \"Backup script\")");
        }
        Ok(Some(WritingAs { name, session: WriterSession::random() }))
    }

    /// Before the change: the note as it was, kept as a version (as an app's edits keep it).
    pub async fn before(&self, note: &crate::sync::DocSync, before: &str) -> anyhow::Result<()> {
        crate::vault::keep_before(note, before).await
    }

    /// After the change, before it's saved: its text marked as this writer's, and (in your list,
    /// `index` and the note's id) "by NAME" (after notes::touch, which clears it).
    pub fn mark(&self, note: &crate::sync::DocSync, index: Option<(&yrs::Doc, &str)>) {
        crate::notes::mark_session(&note.doc, &self.name, "local", Some(&self.session.name));
        if let Some((index, id)) = index {
            crate::notes::set_last_by(index, id, &self.name);
        }
    }

    /// Once saved: the note as it is now, a version named for this writer; said if it couldn't be.
    pub async fn after(&self, note: &crate::sync::DocSync, after: &str) {
        if let Some(said) = crate::vault::keep_after(note, after, &self.session.writer(&self.name, "plim")).await {
            eprintln!("{said}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writing_as_a_short_plain_name() {
        let n = |s: &str| WritingAs::named(Some(s.into())).map(|w| w.map(|w| w.name));
        assert_eq!(n("  Claude ").unwrap().as_deref(), Some("Claude"));
        assert_eq!(n("   ").unwrap(), None, "blank: you");
        assert!(WritingAs::named(None).unwrap().is_none());
        assert!(n(&"x".repeat(41)).is_err(), "too long");
        assert!(n("a\nb").is_err(), "a line break");
    }

    #[test]
    fn a_session_is_two_words_and_an_id() {
        let s = WriterSession::from_bytes(&[0, 0, 1, 2, 3, 4, 5, 6]);
        assert_eq!(s, WriterSession { name: "amber ant".into(), sid: "010203040506".into() });
        assert_eq!(WriterSession::from_bytes(&[63 + 64, 255, 0, 0, 0, 0, 0, 0]).name, "wise yak", "every byte picks a word");
        let r = WriterSession::random();
        assert!(r.name.split(' ').count() == 2 && r.sid.len() == 12, "{r:?}");
        assert_eq!(WriterSession::of("abc"), WriterSession::of("abc"), "an MCP session keeps its name");
        assert_ne!(WriterSession::of("abc").sid, WriterSession::of("abd").sid);
        let w = WriterSession::of("abc").writer("Claude", "plim mcp");
        assert_eq!((w.name.as_deref(), w.connection.as_deref()), (Some("Claude"), Some("plim mcp")));
        // Every word one plain lowercase word, none twice.
        for list in WORDS {
            let mut seen = std::collections::HashSet::new();
            assert!(list.iter().all(|w| w.chars().all(|c| c.is_ascii_lowercase()) && seen.insert(*w)));
        }
    }
}
