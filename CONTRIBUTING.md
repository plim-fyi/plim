# Contributing to Plim

Thanks for helping. Bug reports, fixes and improvements are all welcome.

## Before you start

This repository has no issue tracker: reports and questions come by email.

- **A bug:** write to **bugs@plim.fyi** with what you did, what you expected and what happened,
  and where (browser and device, or `plim --version`). Never send a recovery phrase, a passphrase,
  a share link's `#…` part or a session token: they're keys.
- **A security problem:** see [SECURITY.md](SECURITY.md).
- **A bigger change** (a new feature, a change to sync, crypto or the server's API): write to
  bugs@plim.fyi first, so we can agree on the approach before you spend time on it.

## Working on it

The [README](README.md) explains how everything fits together, [docs/SYNC.md](docs/SYNC.md) how
notes sync, and [AGENTS.md](AGENTS.md) the layout, the checks to run and the rules that aren't
obvious: read it first, whether or not you work with an AI agent. In short:

- Run the checks that cover your change (`cargo test --workspace`, `node web/tests/run.mjs`, and
  the browser or terminal checks for UI changes), and add a test for what you fixed or added.
- Keep the web app free of a build step, and the JS and Rust implementations byte-compatible.
- Never change a `tiro/v1/...` label, or anything else that existing accounts and devices depend on.
- A change to the terminal client gets a line in the next version's section of
  [CHANGELOG.md](CHANGELOG.md).

## Pull requests

Open one against `main`, small and focused, saying what it changes and why, and how you checked
it.

Development happens in a private tree, and this repository receives one commit per publish (a
release, or main between releases). So an accepted pull request is applied to that tree with your
authorship kept, merged here, and the next publish lands on top of it. Between your merge and that
publish, `main` here may be behind what's deployed; rebase on the newest `main` if asked.

## License

By contributing, you agree that your contribution is licensed under the license of the files it
changes: AGPL-3.0-or-later for the server, the web app, the admin dashboard and the tools; MIT or
Apache-2.0 for the crates in `crates/` (see the README's License).
