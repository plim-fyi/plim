# Terminal client screenshots

The `plim` terminal client (see [Terminal client](../README.md#terminal-client)), in a dark terminal. For the web app, see the [map of the screens](../tools/screens-map/README.md).

Regenerate them after a change:

```sh
cargo build --release -p plim-server -p plim-cli
cd tools/screenshots && npm ci && npm run tui
```

The script runs `plim` in a hidden tmux session against its own throwaway server, types into it, and draws each captured screen as a terminal window (see `tools/screenshots/tui.mjs`). It needs `tmux`, `nvim`, and Chromium (`CHROME` if it isn't found), which draws the windows and runs the web app for the shared notes and tags.

## Contents

1. [Create a vault: plim init](#create-a-vault-plim-init)
2. [Scripting](#scripting)
3. [The TUI](#the-tui)
4. [Your own editor](#your-own-editor)
5. [Offline](#offline)
6. [Rollback warning](#rollback-warning)
7. [Sign in on another machine: plim login](#sign-in-on-another-machine-plim-login)
8. [Shared notes](#shared-notes)
9. [Tags](#tags)

## Create a vault: `plim init`

`init` shows the 12 words once, clears them, asks for three of them back, then sets this machine’s device passphrase, and offers to remember it on this machine (in its keychain, or the kernel's keyring on a server).

**The 12 words**

<img src="screenshots/tui/01-init-1-phrase.png" width="760" alt="The 12 words">

**Three of them back (the screen was cleared)**

<img src="screenshots/tui/01-init-2-confirm.png" width="760" alt="Three of them back (the screen was cleared)">

**The device passphrase, and the vault is created**

<img src="screenshots/tui/01-init-3-done.png" width="760" alt="The device passphrase, and the vault is created">

## Scripting

Every note is also a shell command away: add, list and print (`plim cat` prints the note as it is, its frontmatter block first).

**`plim add`, `plim ls` and `plim cat`**

<img src="screenshots/tui/02-scripting-1-commands.png" width="760" alt="plim add, plim ls and plim cat">

## The TUI

`plim` opens the list next to the selected note. Changes save as you type; edits from other devices appear live.

**The list and the selected note**

<img src="screenshots/tui/03-tui-1-list.png" width="760" alt="The list and the selected note">

**Editing (Tab moves into the note)**

<img src="screenshots/tui/03-tui-2-editing.png" width="760" alt="Editing (Tab moves into the note)">

**A new note (n)**

<img src="screenshots/tui/03-tui-3-new-note.png" width="760" alt="A new note (n)">

**Search (/)**

<img src="screenshots/tui/03-tui-4-search.png" width="760" alt="Search (/)">

**Delete, with a confirmation (d)**

<img src="screenshots/tui/03-tui-5-delete.png" width="760" alt="Delete, with a confirmation (d)">

## Your own editor

`e` (or Ctrl-E while editing) opens the note in `$PLIM_EDITOR`, `$VISUAL` or `$EDITOR`. What you save merges with anything edited elsewhere meanwhile.

**The note in nvim**

<img src="screenshots/tui/04-editor-1-nvim.png" width="760" alt="The note in nvim">

**Back in plim: merged**

<img src="screenshots/tui/04-editor-2-merged.png" width="760" alt="Back in plim: merged">

## Offline

If the connection drops while `plim` is open, edits stay in its encrypted outbox and upload when the server is back.

**Editing with the server down**

<img src="screenshots/tui/05-offline-1-editing.png" width="760" alt="Editing with the server down">

**Back online: uploaded**

<img src="screenshots/tui/05-offline-2-back-online.png" width="760" alt="Back online: uploaded">

## Rollback warning

The server returned less than this machine had already seen (here, an update was deleted from the database). Press A in the list to acknowledge.

**The warning**

<img src="screenshots/tui/06-rollback-1-warning.png" width="760" alt="The warning">

## Sign in on another machine: `plim login`

The 12 words (hidden as you type), then a device passphrase for this machine, remembered here if you say so: then commands ask for nothing.

**Signed in**

<img src="screenshots/tui/07-login-1-signed-in.png" width="760" alt="Signed in">

## Shared notes

Notes shared in the web app are marked **Shared** in the list (and `(shared)` in `plim ls`), and open and save here like any note: their text lives in the share, sealed with the link's keys, and what's typed here reaches everyone in it. Every change from the server is checked against the share's key; one not made with its edit link is skipped, and the status line says so. A note added from a view link opens **view only**. If its links are turned off, the status line says that too. A note shared (or unshared) on another device while it's open here reopens in its new home.

<img src="screenshots/tui/08-shared-1-open.png" width="760" alt="A shared note open in the terminal, with a line typed there">

With only its link, no account or passphrase: `plim append <link> "…"` and `plim cat <link>` (here with an empty home folder). A script or an AI tool can be given one note this way, not the whole vault.

<img src="screenshots/tui/08-shared-2-link.png" width="760" alt="plim cat and plim append with only a note's link">

`plim share <note>` shares a note from here, with its history, and prints its links (they open in the web app too); `--new-links` replaces them, and `plim unshare` stops sharing.

<img src="screenshots/tui/08-shared-3-share.png" width="760" alt="plim share printing a note's edit and view links">

## Tags

A note's tags are in its frontmatter, `tags: [gym, gym/legs]`, as the web app keeps them; a `#word` in the text is only text. `plim tag <note> gym` puts one in the block (making the block if there's none), `plim untag` takes it off. `plim ls --tag gym` lists the notes tagged `gym` (not `gym/legs`: a tag is a word of its own), `plim cat --tag gym` prints them all, each under its title and address, and `plim tags` counts them. In the list here, typing `#gym` as the search shows the same notes. A note last written before tags were kept is found once `plim tags --rebuild` has read it.

<img src="screenshots/tui/09-tags-1-commands.png" width="760" alt="plim tag, plim ls --tag gym and plim tags">
