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
