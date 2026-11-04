# Changelog: the terminal client, `plim` (`tiro` before 0.15.0)

Each release of `plim`, newest first. The web app and server aren't numbered: they deploy from
main as each change merges. Each release's binary: [the releases](https://github.com/plim-fyi/plim/releases)
(from 0.20.0).

## 0.20.2

- **No plain `http://` to other machines:** `plim` sends nothing to a server whose address is `http://` unless it's on this machine (`localhost`, `127.0.0.1`, `[::1]`), since your session and share keys would cross the network unencrypted (your notes stay encrypted either way). It says so and how to go on: its `https://` address, or `--insecure-http` (`PLIM_INSECURE_HTTP=1`) if you mean it. This holds for `--server`, `PLIM_SERVER`, the signed-in server and links to shared notes.
- **The connector's `list_grants`** describes what it answers: the notes shared with agents, whatever their tags (it still described tags granted read-only or read & write, as before 0.14.0).

## 0.20.1

- **Security:** rustls 0.23.46, the TLS library `plim` talks to its server with. It fixes GHSA-c8m5-c952-6cm4 (a TLS session's debug output could show its secrets; `plim` never prints it) and three low-severity advisories (GHSA-h2v8-394m-p7vv, GHSA-w44r-93j7-qv28, GHSA-vp88-798v-h67f).
- **On a Mac:** each release now has `plim-macos`, one binary for Apple silicon and Intel ([Terminal client](README.md#terminal-client) says how to install it).

## 0.20.0

- **Open source.** The server, the web app and the admin dashboard are AGPL-3.0-or-later; the Rust crates (`plim-core`, `plim-cli`, `plim-wasm`) are MIT or Apache-2.0, at your option. The JavaScript libraries the web app bundles keep their MIT licenses (`web/vendor/LICENSES.txt`).
- **Plim's names throughout:** the crates are `plim-core`, `plim-cli` and `plim-wasm`, the server is `plim-server`, and every setting is `PLIM_*`. The older `TIRO_*` names still work when the new one isn't set, and nothing a device or server has saved changes.
- **`plim mcp --http` reads `PLIM_CONNECTOR_URL` and `PLIM_CONNECTOR_SECRET_FILE`** (or their `TIRO_` names) when `--public-url` and `--secret-file` aren't given; before, only the `TIRO_` names.

## 0.19.1

- **User agent `plim/<version>`** on every request (it said `tiro-cli/`), including the logout at the end of a session, which sent none.

## 0.19.0

- **`plim export <dir>`** (#47): every note as a Markdown file in a new or empty folder, the same files as the web app's Export all notes (Settings → Account): each note's text as written, with `created`, `updated` and `id` in its frontmatter (and `shared: true` for a note someone shared with you), named for its title, dated its last edit; Recently deleted's in `<dir>/deleted/`. The files aren't encrypted.

## 0.18.0

- **No MCP server on stdin/stdout**: `plim mcp` only runs the connector (`plim mcp --http`), and alone it refuses, saying so. It held the device's whole key, so what it showed an agent was the process's rule, not cryptography. Connect Claude Code as claude.ai is, through your Plim server's connector (`claude mcp add --transport http plim https://<connector>/mcp`), and remove `plim mcp` from a client's settings. In a terminal, use the `plim` commands.

## 0.17.0

- **Its files are plim's** (no more `tiro` on your machine): the device key and outbox are in `~/.config/plim` and `~/.local/share/plim` (on a Mac, `~/Library/Application Support/plim`), and `plim remember` keeps the passphrase under `plim` in the keychain. A machine signed in with an older `plim` isn't signed in after updating: move `~/.config/tiro` to `~/.config/plim` and `~/.local/share/tiro` to `~/.local/share/plim` (or `plim login` again), then `plim remember` again. `PLIM_HOME` (or `TIRO_HOME`) still overrides both.
- `plim` is published under its own name only: no more `tiro` copy of the binary.

## 0.16.2

- **Only frontmatter** (#584): a note's tags are its block's, always. The old ways are gone: a `#word` in the text is never a tag, `plim tag`/`untag` never edit a line of tags under the title, and `plim add`, `plim mcp` and the connector always put a new note's title and tags in a block.

## 0.16.1

- **The connector's new notes have a block** (#584): `create_note` through the connector puts the note's title (its first line) and tags (a line of `#tags` under it) in its frontmatter, as `plim add` and `plim mcp` do once your notes are moved.
- **What agents are told**: a note's title and tags are in its frontmatter, a `#word` in the text is only text, and `tag_note`/`untag_note` put tags on and off the block. `plim untag` says "wasn't one of its tags".

## 0.16.0

- **Frontmatter** (#584): a note's title and tags can be in a YAML block at its top (`title: Leg day`, `tags: [gym, gym/legs]`). `plim` reads them from there: a note's title is its `title:` (else its first line), its tags those in `tags:`. `plim tag`/`untag` and the AI tools' `tag_note`/`untag_note` edit the block.
- Once the app has moved your notes to frontmatter (a mark in your note list), a `#word` in the text is no longer a tag, and `plim add` and `create_note` put a new note's title and tags in a block. Before that, notes without a block work as they did.

## 0.15.1

- **When each writer last wrote, kept in your note list** (#564): `--as NAME`, `plim mcp` and the other app writes record the time beside NAME, for the app's table of who writes at the top of Connected (notes, notes in the last 7 days, last write).

## 0.15.0

- **Tiro is now Plim** (#568, #570). The command is `plim`; the same binary is published as `tiro` too, so scripts, services and MCP clients that run `tiro` keep working, and `artifact-install tiro` keeps updating it. Messages, help and the AI tools say Plim, and `plim mcp` names itself plim.
- **`PLIM_*` settings**: `PLIM_SERVER`, `PLIM_PASSPHRASE`, `PLIM_AS`, `PLIM_EDITOR`, `PLIM_HOME`. Each is read by its old name, `TIRO_*`, when the new one isn't set. (The connector's `TIRO_CONNECTOR_URL` and `TIRO_CONNECTOR_SECRET_FILE` keep their names, as the server's settings do.)
- **Unchanged**: where it keeps your device key and outbox (`~/.config/tiro`, `~/.local/share/tiro`), the remembered passphrase, and everything on the wire, so a machine signed in before stays signed in.
- The app's address is now https://plim.fyi: a device signed in to the old one can use `PLIM_SERVER=https://plim.fyi` (or `--server`) until it signs in again.

## 0.14.5

- **Who wrote in a note, kept in your note list** (#552): `--as NAME`, `tiro mcp` and `tiro tag`/`append`/`edit` as an app add NAME to the note's writers, beside "by NAME". The app's Connected view holds the notes shared with agents and those an agent or a script wrote in, each writer's letter on its row.

## 0.14.4

- **`--as NAME`, or `TIRO_AS`: written as an app or a script** (#542). `add`, `append`, `edit`, `tag` and `untag` mark what they write as NAME's, as `tiro mcp`'s edits are: its letter in the app's margin, "by NAME" in the list, and History keeping the note before and after, the version named "NAME · two words". The flag wins over the environment; neither, you, as before. Through a link (no account), the text is marked.

## 0.14.3

- **A tag is a word, as in the app** (#539): `tiro ls --tag gym` and `tiro cat --tag gym` list the notes tagged `#gym`, not `#gym/legs` (that's `--tag gym/legs`); `tiro tags` counts each tag on its own; the terminal client's `#gym` search the same. The AI tools follow: `list_notes` and `read_notes_by_tag` with a tag, and `list_tags`.

## 0.14.2

- **Where to share a note with agents, said as the app has it now** (#514): the **Agents** switch, first in a note's Share (the app's note menu no longer has a Share with agents item). The connector's description of itself, and `tiro mcp`'s message for its old flags, say so.

## 0.14.1

- **`tiro mcp` and the connector answer alike** (#520): one set of answers for both (and `tiro tags`), so they can't drift. With nothing shared, `list_notes` says so and how ("the user hasn't shared any with agents yet"); a note's line marks it "(view only)" in both, where it was "(shared)" in `tiro mcp`; tagging marks a note as the agent's only when its text changed.

## 0.14.0

- **Agents see the notes you share with agents, and nothing else** (#514). `tiro mcp` and the connector follow one rule: an agent reads and edits the notes shared with agents (in the app, then a note's menu: Share with agents), whatever their tags, and nothing else. Tags are only topics now: they share nothing, and an agent may put any on a note. A note an agent makes is shared with agents.
- **`tiro share <note> --agents`** and **`tiro unshare <note> --agents`**: share a note with agents, or stop.
- **`tiro mcp` takes no scope**: `--read`, `--write`, `--write-all` and `--notebook` are refused, saying so. Use `tiro mcp` alone in the client's settings.

## 0.13.0

- **`tiro edit`: change a note from the shell**, three ways:
  - `tiro edit <note>` opens it in your editor (`$TIRO_EDITOR`, `$VISUAL` or `$EDITOR`, as `e` does in the terminal editor). Your changes merge with edits made elsewhere while it was open; closing it unchanged changes nothing.
  - `tiro edit <note> --replace OLD NEW` replaces a piece of the text that's there exactly once (else it says, and changes nothing), as the AI tools' `edit_note` does. An empty NEW takes it out.
  - `tiro edit <note> -` reads the note's whole new text from stdin and changes only what differs: `tiro cat Plan | sed 's/a/b/' | tiro edit Plan -`. An empty pipe is refused, so it can't wipe a note.

  Each works by title, id, address, or an edit link (no account needed then). Each keeps versions as your other edits here do (#505), and says what changed (`+1 −1`).

## 0.12.0

- **`tiro history` and `tiro restore`** (#505, step 4). `tiro history <note>` lists a note's versions, newest first and numbered:
  - each with how long ago, who made it if an AI did ("Claude · amber fox"), and the lines it added and removed;
  - a `now` line for what's changed since the newest version;
  - the newest 20 (`--all` for every one).

  `tiro history <note> <n>` prints a version; `--diff` shows what it changed since the one before. `tiro restore <note> <n>` puts the note back as it was then, as one edit that merges with anyone else's. What it is now is kept as a version first, so a restore can be undone too.
- **Your edits in the terminal keep versions as the web app's do** (#505, step 4). Before a session's first edit, the note as it was is kept if the last version is an hour old (the server's interval). Then at most one version an hour while you keep editing. This covers the editor, `tiro append` and `tiro tag`/`untag`. Before, edits made here kept none.
- **AIs can read a note's history** (#505, step 5): `note_history` and `read_version`, through `tiro mcp` and the connector.
  - Only for notes the AI may edit.
  - Through the connector, only versions from when it was given the note, so text deleted before you shared a note stays out of its reach. This needs the server from the same change, which tells a connection's holder when it was made.
  - Through `tiro mcp`, whose grants have no time, every version of a note it may edit.
  - The connector notes each read in the connection's activity, as reading a note is.

## 0.11.1

- **An AI's change is timed so History doesn't take it for a later one** (#505, step 3). Versions are timed to the second and the note's record of who typed to the millisecond. A change kept as a version now takes its time rounded up, so the app's History no longer shows "Now" as the AI's when nothing changed since. The text from before keeps its time, but never earlier than the newest version.

## 0.11.0

- **Each AI change is its own step in a note's history, saying who made it** (#505, step 2). Every tool that changes a note's text keeps the result as a version, labelled with the app, what it came through, and its session: `create_note`, `append_to_note`, `edit_note`, `tag_note` and `untag_note`, through `tiro mcp` and the connector. Before, only `edit_note` kept anything, and only the text from before.
  - The text from before is kept too, unless it's the newest version already. Whatever changed since the last version (your typing, say) is then a step of its own, not folded into the AI's.
  - Two AI sessions writing in one note minutes apart are two steps, each with its session's name: two words, like "amber fox". `tiro mcp` is one session for as long as it runs. The connector hands each MCP session an id at initialize (`Mcp-Session-Id`) and names it from that, keeping nothing. The note's record of who typed what names the session too.
  - Who wrote a version goes inside its encryption: the server doesn't learn it. Versions saying who wrote them need 0.10.3 or later to read.
  - If a change can't be kept in History, it still stands, and the answer says so.

## 0.10.3

- **Reads versions that say who wrote them** (#505, step 1). A note's history is about to record who made each version: an app, through what, and in which session, inside the version's encryption. This release reads such versions, and moves them unchanged when a note is shared or made private again, so who wrote each stays with it. Nothing writes them yet. Install it before the release that does: an older `tiro` can't read them.

## 0.10.2

- **Connector: an AI that can't make notes says so** (#496). Connections no longer get a tag of their own; they get the AI notebook. One with neither the notebook nor a tag it may write is told it can't make notes, instead of making one with no tag, as `tiro mcp` already did.

## 0.10.1

- **The prototype's `ai` tag is retired** (#493). The AI notebook is a place (0.10.0), so a client that may write `#ai` is no longer told it's the notebook, nor do its new notes go there: `#ai` is a tag like any other. Use `tiro mcp --notebook`, or "Keep the AI notebook" on a connection, instead.

## 0.10.0

- **The AI notebook is a place, not a tag** (#489, #490, #484). A note lives in your notes or in the AI notebook, and where it lives is kept in your note list, not its text. Only you move a note in or out, in the app. An AI given the notebook (`tiro mcp --notebook`, or "Keep the AI notebook" on its connection in Settings → Connections) reads and edits every note in it, whatever its tags; one not given it doesn't get them, even with a tag it may write.
  - In the notebook, tags are topics (`#health/knee`): any may go on or come off, and they share nothing. `list_tags` lists them apart from your tags.
  - A new note goes in the notebook unless it carries a tag of yours the AI may write; then it's yours, as before.
  - The AI is told how to keep it in shorter words, with plain topics.
  - The prototype's `ai` tag (0.9.0) works as before, until the move off it.

## 0.9.0

- **An AI notebook, as a prototype** (#485, #484). A client that may write the tag `ai` (`tiro mcp --write ai`, or `ai` granted to a connection) is told that it's the user's AI notebook, shared by every AI they connect. It's told to keep what's worth keeping there, under topics nested in `ai` (`#ai/health/knee`), updating the topic's note rather than making another. A new note goes there unless it's given another tag. An AI puts an `ai` tag only on a new note or one in the notebook already, never on one of yours, which every AI would then read.
- **Apps named as themselves** (#487, #483). `tiro mcp` names Codex, Cursor, Gemini and ChatGPT by their product, as it did Claude. The app gives each its own mark: Codex a green X, Gemini and ChatGPT violet, Cursor ochre. Before, Codex's edits were named after its MCP client and marked with the same C as Claude's. Another client is still named as it calls itself.

## 0.8.0

- **Claude can search your notes** (#474). `search_notes`, through the connector and with `tiro mcp`, finds the notes Claude may read that have every word of a search, as the app's search does: case and accents aside, part of a word or whole. Each note found comes with up to two lines, the words in bold. A tag narrows it. The app and `tiro` check the same cases (`web/tests/fixtures/search.json`).
- **Claude can edit a note** (#472). `edit_note` replaces a piece of a note's text that's there exactly once, keeping the note as it was as a version first, so History can take it back. An edit can't put on a tag Claude can't write, nor take off the last one it can.
- **Versions are packed** (#468). Versions `tiro` saves are compressed before they're encrypted, as the app's are; older ones still read as they are.

## 0.7.2

- **Each command's session ends when it's done** (#146). `tiro` signs in for a command and now ends that session on the server as it finishes, so its token stops working at once instead of staying valid for 15 minutes. Needs the server from the same change (older servers ignore it).

## 0.7.1

- **A new note carries only tags Claude may write** (#404). `create_note`, through the connector and with `tiro mcp`, refuses a note whose text has a tag Claude may only read or was never given, wherever the tag is in the text. Tagging a note already worked this way. A tag decides who else gets a note: before, Claude could file what it read under a tag another connection has. The reply names the tags and says to write such words without the `#`; a note with no tags still gets the connection's own, or the only one it may write.

## 0.7.0

- **One set of rules for what Claude may do** (#409). `tiro mcp` on your computer and the connector now share one grant type (`grants.rs`) for reading, writing, tagging, untagging and where a new note goes. The web app gives a connection its notes by the same rules, and both check the same cases (`web/tests/fixtures/grants.json`).
- **Connector: only the tags Claude was given** in `list_notes` and `list_tags`, as `tiro mcp` already listed them. A granted note's other tags are no longer named.
- The words for the grants are the same everywhere: "You can read and write notes tagged …, and only read notes tagged …".

## 0.6.9

- **Connector: its pages look like Tiro** (#418). Its address page and the "Connecting…" page follow the device's light or dark setting, in Tiro's colours.

## 0.6.8

Fixes from the October code audit, all in the connector:

- **The consent page's destination can't be forged** (#403). The Tiro app now tells `/complete` which host it showed as "you'll go back to". The connector refuses when that isn't where the code really goes, so a link edited to say "claude.ai" no longer works. Needs the web app from the same change.
- **`tag_note` puts on only tags Claude may write** (#404), as `tiro mcp` on your own computer already did.
- **At most 10 consents under way from one address** (#406), so nobody can take all 1000 and block connecting.
- **Security headers on every response** (#407): a CSP that runs only the `/complete` page's own script, no framing, no referrer, `nosniff`, HSTS.

## 0.6.7

- **Connector: refresh tokens last 90 days** (#390), up from 30, so a Claude you use now and then stays connected. Access tokens still last a day; Disconnect still cuts it off at once.

## 0.6.6

- **`tiro mcp` marks its edits too** (#389). Notes it creates, adds to, tags or untags record its editing session (as "Claude" for Claude's apps, by its own name for other clients), so the apps mark that text as the connector's is; and the note list says "by Claude" until you edit the note yourself (any `tiro` command or the app takes it back).

## 0.6.5

- **Connector: Claude's edits are attributed** (#389). When it writes in a note (creates, adds to, tags or untags it), it records its editing session in the note, encrypted like the rest: its Yjs client id, the connection's name, and when. The owner's apps mark the text it wrote and show who wrote it.

## 0.6.4

- **Connector: each connection has its own rate allowance** (#394). Its requests carry the connection's id, signed with its key for the minute; the server counts them against that connection, not against the connector's one address that every user's Claude shares. Needs the server from the same change.

## 0.6.3

- **Connector: the consent page knows where you're going back to** (#383). `/authorize` passes the client's checked return host to Tiro's consent page, which shows it ("You'll go back to claude.ai") and warns when it isn't Claude's website or this machine.
- **Connector: stricter return addresses, bounded consents** (#384). Plain http only to localhost / 127.0.0.1 / ::1 by host (not by prefix), no `user@` in the address; at most 1000 consents under way at once.

## 0.6.2

- **`list_grants`:** a tool that says which tags Claude may read and which it may read & write (the user's grants through the connector; the flags with `tiro mcp`), whether or not any note carries them yet.

## 0.6.1

- **Connector: the grants, said.** `initialize` tells Claude which tags the user granted (read, or read & write), and `list_tags` starts with them, whether or not any note carries them yet. Before, a granted tag with no notes looked like nothing granted.

## 0.6.0

- **`tiro mcp --http`: the connector** (#369). Tiro as a remote MCP server, so claude.ai, the Claude apps and Claude Code connect to a vault over the web with no `tiro` on the user's machine: OAuth (dynamic registration, PKCE) sends them to the Tiro app's consent page, where the owner picks the tags Claude may use (Settings → Connections, any time after). The connector holds no notes and no keys: a token is the connection's secret sealed to the process, and every note comes through holders the owner can turn off at once. Same tools as `tiro mcp`; what Claude reads and changes shows under the connection's activity. `--public-url` (or `TIRO_CONNECTOR_URL`) and `--secret-file` go with it.

## 0.5.0

- **Links for people** (#369): `tiro share <note> --for Sam` (`--view` for read only) prints a link of Sam's own. `--new-links` keeps people's own links working; `unshare` removes them. `cat`, `append` and `add-link` take such a link (`…/n/<id>#h=…`), and a note shared with you through one follows its owner's new links.

## 0.4.0

- **`tiro mcp`:** your notes for Claude Code, Claude Desktop and other MCP clients on the machine (#366), only those with the tags you name: `--read <tag>` to list and read them, `--write <tag>` to create, add to, tag and untag them too, `--write-all` for every note; nothing unless said. A note outside the scope isn't there for the client. Tools to list, read (one note, or every note with a tag), list tags, create, append to, tag and untag; no delete, no rewriting. It uses the passphrase `tiro remember` kept.

## 0.3.0

- **`tiro remember`:** the device passphrase, kept on the machine so `tiro` stops asking for it (#360). In its keychain where there's one (Secret Service on Linux, the Keychain on a Mac); on a headless machine, in the kernel's keyring until it restarts. `init` and `login` offer it; `tiro remember --off` and `tiro logout` forget it.

## 0.2.0

The first release, installed with `curl -fsSL https://<artifacts host>/install.sh | sh -s -- tiro`.

- **The TUI:** your notes listed, searched and edited, saved as you type, others' edits live; `$EDITOR` edits merge.
- **Scripting:** `ls` (`--tag`, `--sort edited|created`, `--urls`), `cat`, `add`, `append`, `rm`, `tags`, `tag`, `untag`.
- **Sharing:** `share`, `unshare`, `add-link`; `cat` and `append` with only a note's link.
- **Note addresses:** a note's `https://…/n/<id>` works wherever a title or id does.
- `tiro --version` names the commit it was built from too.
