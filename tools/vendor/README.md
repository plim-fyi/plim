# Vendored JavaScript

The web app has no build step: browsers load `web/` as it is. Its two libraries are committed, ready to load, in `web/vendor/`:

| File | What | Used by |
|---|---|---|
| `yjs.mjs` | [Yjs](https://github.com/yjs/yjs), the format notes are stored in | syncing, history, the guest page, the tests |
| `codemirror.mjs` | [CodeMirror 6](https://codemirror.net), its markdown language (`@codemirror/lang-markdown` and `@lezer/markdown`, GitHub-flavoured; not the HTML, CSS and JavaScript parsers `markdown()` would bring) and [y-codemirror.next](https://github.com/yjs/y-codemirror.next) (with y-protocols' awareness, for cursors in shared notes) | the note editor and its markdown (`web/editor/editor.js`, `editor-ios.js`, `markdown.js`), and others' cursors (`web/core/presence.js`) |

This folder builds both from the versions pinned in `package.json` (and `package-lock.json`), with esbuild, which runs only here, when updating them. They're not minified, so they read like the packages' own code, and each starts with a line naming the packages and versions in it. `codemirror.mjs` imports Yjs from `./yjs.mjs` rather than bundling its own: two copies of Yjs in one page break it.

The build also changes one thing in y-codemirror.next: it colours other people's cursors with inline `style` attributes, which the app's CSP refuses, so they're replaced with `data-ycolor` attributes that `web/style.css` colours (`CSP_SAFE_COLOURS` in `build.mjs`). If an update changes that code, the build fails rather than shipping uncoloured cursors.

## Commands

From this folder (or from the repo root with `npm --prefix tools/vendor run …`):

```
npm ci            # the pinned versions, exactly
npm run build     # write web/vendor/yjs.mjs and codemirror.mjs
npm run check     # rebuild into a temporary folder: web/vendor must be exactly that
```

GitHub runs `npm run check` on every pull request that touches `tools/vendor/` or `web/vendor/` (`.github/workflows/vendor.yml`).

## Updating a library

1. Change its version in `package.json`, then `npm install` (updates `package-lock.json`).
   - Yjs: `y-codemirror.next` and `y-protocols` depend on it too; check they accept the new version.
2. `npm run build`, then `npm run check`.
3. Test:
   - `node web/tests/run.mjs` (from the repo root). For **Yjs** this matters most: its interop fixtures check that the web app and the terminal client (Rust, `yrs` in `crates/`) still read each other's updates. If they fail, the update needs a matching `yrs` version in `Cargo.toml` first.
   - `cargo test --workspace`: the Rust side of those fixtures.
   - The browser flows: `cd tools/screenshots && npm run web && npm run tui` (the editor, cursors in shared notes, sync between devices).
4. Commit `package.json`, `package-lock.json` and `web/vendor/` together.
