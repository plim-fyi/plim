# Security

Plim is end-to-end encrypted: the server should never be able to read a note, a title or a key.
A way around that, a way to read or change someone else's notes, or to sign in as them, is exactly
what we want to hear about.

## Reporting a vulnerability

Please report it privately, not in a pull request or anywhere public:

- through GitHub: **Security → Report a vulnerability** on this repository, or
- by email to **security@plim.fyi**.

Say what you found, how to reproduce it, and what it lets someone do. You'll get an answer within a
few days. We'll work on a fix with you, and credit you when it's released unless you'd rather not
be named.

## What's in scope

- the server (`server/`), the web app (`web/`), the terminal client and shared crates (`crates/`),
  and the connector (`plim mcp --http`);
- the hosted service at plim.fyi, tested only with accounts of your own: no access to other
  people's data, no denial of service, no social engineering.

The README's [Known limitations](README.md#known-limitations) are known trade-offs (such as the
server delivering the web app's code, and the metadata it sees). A way to make one of them worse
than it says is in scope.

## Checking what plim.fyi serves

[![Check plim.fyi](https://github.com/plim-fyi/plim-signed-web-deploys/actions/workflows/check.yml/badge.svg)](https://github.com/plim-fyi/plim-signed-web-deploys/actions/workflows/check.yml)

Every deploy of plim.fyi's web app is recorded in public, signed:
[plim-fyi/plim-signed-web-deploys](https://github.com/plim-fyi/plim-signed-web-deploys) holds the
files as deployed, a manifest of their hashes, and a signature, by a key used for nothing else and
kept off the server:

```
SHA256:1wTlYiGJry6gR+6RFU2RvE8HehErrLGK9+pXu96Tzds  (ED25519, deploys@plim.fyi)
```

Its `./verify` checks that plim.fyi serves exactly the newest signed deploy, byte for byte, and
GitHub runs it every hour. A difference it reports, a deploy there not signed by that key, or
plim.fyi serving something not in the record, is a security problem: report it as above.
