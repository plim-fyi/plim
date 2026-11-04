# AGENTS.md

Notes for coding agents (and people) working on Plim: end-to-end encrypted Markdown notes, with
a Rust server, a web app with no build step, and a terminal client. The [README](README.md) is
the full picture; this is what to know before changing anything.

## Layout

| Path | What |
|---|---|
| `server/` | The server (axum + SQLite). Stores only ciphertext; never sees a note's text or keys. |
| `web/` | The web app: plain JavaScript modules, loaded by the browser as they are. `web/core/` (data, sync, crypto), `web/editor/`, `web/ui/` (screens), each importing only from those below it. |
| `crates/plim-core/` | Shared Rust: canonical encoding, signatures, proof-of-work, client crypto. Byte-compatible with `web/core/`. |
| `crates/plim-cli/` | The `plim` terminal client and its TUI. |
| `crates/plim-wasm/` | The Rust the web app runs, built to `web/wasm/plim.wasm` (committed). |
| `admin/` | The read-only admin dashboard. |
| `tools/` | Browser and terminal checks that also take the screenshots (`tools/screenshots/`), the vendored JS build (`tools/vendor/`), the wasm build (`tools/wasm/`), benchmarks (`tools/bench/`). |
| `docs/` | How sync works (`SYNC.md`), deploying a server (`DEPLOY.md`), the screenshots. |

## Checks

Run what covers your change before calling it done:

```sh
cargo test --workspace                      # server, shared crypto, CLI
node web/tests/run.mjs                      # the web app's tests, including Rust interop and the layering rule
tools/wasm/build.sh --check                 # if crates/plim-wasm or plim-core changed: web/wasm/plim.wasm must match a fresh build
npm --prefix tools/vendor run check         # if tools/vendor or web/vendor changed
cd tools/screenshots && npm ci && npm run web   # browser flows (Chromium, desktop and iPhone size); build the release server first:
                                            #   cargo build --release -p plim-server -p plim-cli
cd tools/screenshots && npm run tui         # the terminal client in tmux, when the CLI changes
```

A run of the browser or terminal checks rewrites screenshots under `docs/screenshots/`: keep them
only when the change is meant to change what they show.

## Rules that aren't obvious

- **Never change a `tiro/v1/...` string.** Keys are derived from the recovery phrase and these
  labels, and signatures cover them; a new label means no existing account can open its notes.
  The same goes for the other names that keep the project's old name (headers, browser storage,
  `tiro.db`): see "Names that still say tiro" in [docs/SYNC.md](docs/SYNC.md).
- **The JS and Rust implementations must stay byte-compatible.** Both read the fixtures in
  `web/tests/fixtures/`; a change to encoding, signing or encryption changes both sides and the
  fixtures (`node web/tests/run.mjs --write-fixture`, `cargo run -p plim-core --example interop_fixture`).
- **The web app has no build step.** Don't add a bundler or a framework. Its libraries are
  committed, built by `tools/vendor/` from pinned versions; its WebAssembly is committed, built
  reproducibly by `tools/wasm/build.sh`. Edit the sources, rebuild, commit both.
- **The server must not learn plaintext.** Anything new it stores or sees is ciphertext or
  metadata, and metadata it newly learns is worth a line in the README's Known limitations.
- **No inline scripts or styles in the web app:** its Content Security Policy refuses them.
- **Settings are `PLIM_*` environment variables**, each also read by its old name `TIRO_*`.
- **Changelog:** only the terminal client is versioned; a change to it adds a line to the next
  version's section of [CHANGELOG.md](CHANGELOG.md).

## Contributions

Pull requests are welcome. The public repository receives one commit per publish (a release, or
main between releases); an accepted pull request is applied to the development tree and appears in
the next one, on top of your merged one: [CONTRIBUTING.md](CONTRIBUTING.md) says how.
