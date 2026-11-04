//! MCP as the connector speaks it (#369, connector/): JSON-RPC 2.0 messages, `initialize`,
//! `tools/list`, `tools/call` and `ping` (notifications get no answer), the tools offered, and what
//! the client is told. The connector's `Conn` does each tool's work (connector/tools.rs).
//!
//! There's no MCP server on stdin/stdout any more: it held this device's whole vault key, so what
//! it showed was the process's rule, not cryptography. A client reaches the notes shared with
//! agents through the connector, as Claude's apps do; in a terminal, the `plim` commands.

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::search;

const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

pub(crate) const INSTRUCTIONS: &str = "Plim is the user's notes app: plain markdown notes, end-to-end encrypted, synced to their \
devices. Treat a note as the source of truth: when the user wants something kept, put it in Plim; when they ask about \
something Plim holds, read it. A note is named by its address (https://…/n/<id>), its id, or its title (exact first, \
then a part of it, ignoring case). A note's title and tags are in a YAML block at its top (frontmatter): `title: Leg day`, \
`tags: [gym, gym/legs]` (nested as `gym/legs`); a `#word` in the text is only text. Put tags on and off with tag_note and \
untag_note. When you mention a note you read or wrote, link it by its address. Append to a log in its own format \
(read it first). A new note's first line is its title, and a line of tags under it (#gym #training) its tags: both go \
in its frontmatter.";

pub(crate) fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// What answers an MCP client: the tools, and what to tell it about them.
pub(crate) trait Tools {
    /// The client's name, from initialize (`clientInfo.name`), for whom edits are marked as.
    fn met(&mut self, _client: &str) {}
    /// What the client may do here, after INSTRUCTIONS (the connector looks it up).
    async fn instructions(&mut self) -> String;
    /// Whether the writing tools are offered at all.
    fn can_write(&self) -> bool;
    async fn call(&mut self, name: &str, args: &Value) -> Result<String>;
}

/// One JSON-RPC message answered (None for a notification).
pub(crate) async fn dispatch(t: &mut impl Tools, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = id?; // (a notification: no answer)
    let result = match method {
        "initialize" => {
            if let Some(client) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                t.met(client);
            }
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "plim", "title": "Plim", "version": env!("CARGO_PKG_VERSION") },
                "instructions": format!("{INSTRUCTIONS} {}", t.instructions().await),
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools(t.can_write()) }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !tools(t.can_write()).iter().any(|t| t["name"] == name) {
                return Some(error(id, -32602, &format!("no tool called {name}")));
            }
            match t.call(&name, &args).await {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                Err(e) => json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true }),
            }
        }
        _ => return Some(error(id, -32601, &format!("no method {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// A mistake in what was asked (no such note, a bad tag, out of scope): not worth logging as a failure.
pub(crate) fn is_users(e: &anyhow::Error) -> bool {
    let m = format!("{e:#}");
    ["no note", "matches", "isn't a tag", "aren't a tag", "is missing", "view only", "nothing to", "that address is on", "only read", "can't", "needs a tag", "old_text", "an edit", "you can see", "history is open"]
        .iter()
        .any(|s| m.contains(s))
}

/// read_version's `version`: its number in note_history, 1 the newest (#505).
pub(crate) fn version_arg(args: &Value) -> Result<usize> {
    args.get("version")
        .and_then(Value::as_u64)
        .filter(|n| *n >= 1)
        .map(|n| n as usize)
        .context("version is missing: its number in note_history (1 is the newest)")
}

/// How many notes a search answers with, as asked (1–100), else search::LIMIT.
pub(crate) fn limit(args: &Value) -> usize {
    args.get("limit").and_then(Value::as_u64).map_or(search::LIMIT, |n| n.clamp(1, 100) as usize)
}

/// How many notes are opened at once to search them.
const OPEN_AT_ONCE: usize = 8;

/// `work` done OPEN_AT_ONCE at a time, the answers as they come.
pub(crate) async fn at_once<F: Future>(work: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    use futures::StreamExt;
    let mut work = work.into_iter();
    let mut running = futures::stream::FuturesUnordered::new();
    running.extend(work.by_ref().take(OPEN_AT_ONCE));
    let mut out = Vec::new();
    while let Some(r) = running.next().await {
        out.push(r);
        running.extend(work.next());
    }
    out
}

pub(crate) fn title_or_untitled(t: &str) -> &str {
    if t.is_empty() { "Untitled" } else { t }
}

pub(crate) fn tools(can_write: bool) -> Vec<Value> {
    let note = json!({ "type": "string", "description": "The note: its address (https://…/n/<id>), its id (4+ characters), or its title" });
    let read = json!({ "readOnlyHint": true, "openWorldHint": false });
    let write = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    let mut out = vec![
        json!({ "name": "list_notes", "title": "List notes",
            "description": "The user's notes you can see, newest first: title, address, when, tags. Optionally only those with a tag (that tag itself: \"gym\" doesn't find #gym/legs, its own tag).",
            "inputSchema": { "type": "object", "properties": {
                "tag": { "type": "string", "description": "Only notes with this tag, without the #" },
                "sort": { "type": "string", "enum": ["edited", "created"], "description": "Newest first by last edited (the default) or by when made" } } },
            "annotations": read }),
        json!({ "name": "search_notes", "title": "Search notes",
            "description": "Find the notes you can see with every word of a search in them (in the title or text, as part of a word or whole, whatever the case or accents: \"cafe\" finds \"Café\"). Answers with each note's title, address, when it was edited and tags, and up to two lines with the words in **bold**; notes with every word in their title first, then newest first. Read a note found to see all of it.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Words to find, all of them (not a phrase: their order doesn't matter)" },
                "tag": { "type": "string", "description": "Only notes with this tag, without the #" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "The most notes to answer with (20 if not given)" } }, "required": ["query"] },
            "annotations": read }),
        json!({ "name": "read_note", "title": "Read a note",
            "description": "A note's text (markdown), with its address.",
            "inputSchema": { "type": "object", "properties": { "note": note }, "required": ["note"] },
            "annotations": read }),
        json!({ "name": "read_notes_by_tag", "title": "Read notes by tag",
            "description": "Every note with a tag, each under its title and address: a log, a project, a topic, at once.",
            "inputSchema": { "type": "object", "properties": { "tag": { "type": "string", "description": "The tag, without the #" } }, "required": ["tag"] },
            "annotations": read }),
        json!({ "name": "list_tags", "title": "List tags",
            "description": "The tags in the notes you can see, and how many notes have each.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read }),
        json!({ "name": "list_grants", "title": "What you may read and write",
            "description": "The tags the user granted you, each read-only or read & write: your access, whether or not any note carries the tag yet. Check this when unsure what you can see or change (the user can change it any time).",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read }),
    ];
    if can_write {
        let tagging = |what: &str| what.to_string();
        out.extend([
            json!({ "name": "create_note", "title": "Create a note",
                "description": "A new note, in markdown, shared with agents. Its first line is its title, and a line of tags under it (#gym #training) its tags: both are put in its frontmatter (`title:`, `tags: [gym, training]`) for you. Returns its address.",
                "inputSchema": { "type": "object", "properties": { "text": { "type": "string", "description": "The note's text: its title on the first line" } }, "required": ["text"] },
                "annotations": write }),
            json!({ "name": "append_to_note", "title": "Add to a note",
                "description": "Text added at the end of a note, on a line of its own (a log entry, a list item). Read the note first to follow its format.",
                "inputSchema": { "type": "object", "properties": { "note": note, "text": { "type": "string", "description": "What to add" } }, "required": ["note", "text"] },
                "annotations": write }),
            json!({ "name": "edit_note", "title": "Edit a note",
                "description": "Replace a piece of a note's text with another (empty: take it out): fix a line, tick a task, reword, tidy. old_text must be in the note exactly once, as it is now: read the note first and copy it, with enough around it to be unique. The note as it was is kept in its History first, so the user can go back. An edit can't put on tags you can't write, nor leave the note none you can. Answers with the lines around the change.",
                "inputSchema": { "type": "object", "properties": {
                    "note": note,
                    "old_text": { "type": "string", "description": "The exact text to replace, there once" },
                    "new_text": { "type": "string", "description": "What goes in its place (empty: it's taken out)" } }, "required": ["note", "old_text", "new_text"] },
                "annotations": write }),
            json!({ "name": "tag_note", "title": "Tag a note",
                "description": "Put tags on a note: added to the tags in its frontmatter (the block made if there's none).",
                "inputSchema": { "type": "object", "properties": { "note": note, "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags, without the #" } }, "required": ["note", "tags"] },
                "annotations": write }),
            json!({ "name": "untag_note", "title": "Untag a note",
                "description": tagging("Take tags off a note: out of the tags in its frontmatter."),
                "inputSchema": { "type": "object", "properties": { "note": note, "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags, without the #" } }, "required": ["note", "tags"] },
                "annotations": write }),
            // (#505: a note's history, only of notes you may edit, and only from when you were given it.)
            json!({ "name": "note_history", "title": "A note's history",
                "description": "A note's earlier versions, newest first and numbered (1 is the newest): when, who made each if an AI did (an app and its session, \"Claude · amber fox\"), and the lines it added and removed. Only for notes you can edit, from when you were given them. Use it to see what changed, and by whom, before changing a note; read_version shows one.",
                "inputSchema": { "type": "object", "properties": { "note": note }, "required": ["note"] },
                "annotations": read }),
            json!({ "name": "read_version", "title": "Read a version of a note",
                "description": "One of a note's earlier versions, by its number in note_history (1 is the newest): its whole text, or with diff, what it changed since the one before (a unified diff).",
                "inputSchema": { "type": "object", "properties": {
                    "note": note,
                    "version": { "type": "integer", "minimum": 1, "description": "Its number in note_history: 1 is the newest" },
                    "diff": { "type": "boolean", "description": "What it changed since the version before, not its whole text" } }, "required": ["note", "version"] },
                "annotations": read }),
        ]);
    }
    out
}

/// The same answer as for a note that isn't there: out of scope, a note is nobody's business.
pub(crate) fn nowhere(query: &str) -> anyhow::Error {
    anyhow::anyhow!("no note matches \"{query}\"")
}

/// A tool's answer, and what it adds if anything (#505: a change it couldn't keep in History).
pub(crate) fn with_note(answer: String, note: Option<String>) -> String {
    match note {
        Some(n) => format!("{answer}\n{n}"),
        None => answer,
    }
}
