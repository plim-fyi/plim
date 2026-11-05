# Deploying Plim

How to configure and run the server for real use: settings, the container image, starting at boot, and a Cloudflare Tunnel in front. For a quick local run, see [Quick start](../README.md#quick-start).

## Configuration

| Env var | Default | |
|---|---|---|
| `PLIM_ADDR` | `127.0.0.1:3000` | listen address |
| `PLIM_DB` | `tiro.db` | SQLite path |
| `PLIM_WEB` | the repo's `web/` | static frontend directory (`/app/web` in the container) |
| `PLIM_POW_BITS` | `20` | signup proof-of-work difficulty |
| `PLIM_QUOTA_BYTES` | `52428800` | per-account storage cap |
| `PLIM_MAX_BLOB_BYTES` | `8388608` (8 MiB) | largest single encrypted update or snapshot; the request size limit follows it. Clients split uploads to fit, so this caps the size of one note |
| `PLIM_PRUNE_ON_SNAPSHOT` | on | deletes updates once a snapshot covers them (at startup too, for data stored earlier); `0` keeps the full encrypted history |
| `PLIM_ADMIN_ADDR` | off | e.g. `127.0.0.1:3001`: serve the read-only admin dashboard (loopback only) |
| `PLIM_ADMIN_WEB` | the repo's `admin/` | admin dashboard files (`/app/admin` in the container) |
| `PLIM_ADMIN_ALLOW_NONLOOPBACK` | off | `1` allows a non-loopback admin bind (for containers; publish it on the host's loopback) |
| `PLIM_TRUSTED_PROXIES` | none | comma-separated proxy addresses or CIDR ranges whose client IP header is used for rate limiting |
| `PLIM_CLIENT_IP_HEADER` | `x-forwarded-for` | `cf-connecting-ip` behind Cloudflare; otherwise the rightmost `X-Forwarded-For` entry is used |
| `PLIM_MAX_ACCOUNTS` | none | at most this many accounts: then the welcome screen says Plim isn't taking new vaults, and signing up is refused. Existing accounts keep working. The admin dashboard shows how many are left |
| `PLIM_VERSION_EVERY_SECS` | `3600` | how often clients keep a version of a note while it's edited (its History); every version is kept, the oldest going only when an account (or a shared note) needs the room |
| `PLIM_CONNECTOR_URL` | none | the connector's address (#369), e.g. `https://mcp.example.com`: the only app the consent page at `/connect` hands a connection's secret to. Unset: connecting an app is off |
| `PLIM_PUBLIC_URL` | none | the site's public address, e.g. `https://notes.example.com`: makes the link preview's image and URL absolute, so iMessage, Slack and others show the preview card |

Each setting is also read by its name from before the rename, `TIRO_*` (`TIRO_DB` and so on), when the `PLIM_*` one isn't set.

**HTTPS:** deploy behind HTTPS. WebCrypto, passkeys and the service worker only work in a secure context outside `localhost`.

**Rate limits behind a proxy:** rate limiting uses the address of the connection. Behind a reverse proxy, list the proxy in `PLIM_TRUSTED_PROXIES`, or every user shares the proxy's limit.
- The client IP header is only believed from those addresses.
- With `x-forwarded-for`, only the rightmost entry counts: the one your proxy added.
- If a proxy header arrives from an untrusted address, the server logs that address once, so you can see what your proxy connects from.

`GET /healthz` reports whether the server and its database are up. `plim-server --healthcheck` checks it from inside a container, which has no curl. The server shuts down cleanly on SIGTERM.

## Container

The `Containerfile` builds a ~30 MB image: a distroless runtime, a non-root user, and the database in the `/data` volume. Podman and Docker both work.

```sh
podman build --format docker -t plim .     # or: docker build -f Containerfile -t plim .
podman run -d --name plim -v plim-data:/data \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
  -e PLIM_ADMIN_ADDR=0.0.0.0:3001 -e PLIM_ADMIN_ALLOW_NONLOOPBACK=1 plim
```

`--format docker` keeps the image's built-in health check; Podman's default OCI format drops it.

**At boot with systemd:** start the container once the way you want it, then let systemd own it:
```sh
podman generate systemd --new --name plim --files
mkdir -p ~/.config/systemd/user && mv container-plim.service ~/.config/systemd/user/
podman rm -f plim && systemctl --user daemon-reload && systemctl --user enable --now container-plim.service
loginctl enable-linger $USER          # keep running after you log out
```
`podman generate systemd` is deprecated in Podman 5 but still works.

**Ports:**
- Both ports are published on the host's **loopback** by default. Put your HTTPS reverse proxy in front of `127.0.0.1:3000`, and set `PLIM_TRUSTED_PROXIES` to the proxy's address as the container sees it.
- To expose the server directly to your network, publish `3000:3000` instead. Only do this for testing, because the web app needs HTTPS outside `localhost`.
- Keep the admin port on `127.0.0.1` and reach it from another machine with `ssh -L 3001:127.0.0.1:3001 <host>`, or put it behind a reverse proxy with a sign-in of its own (one that sets a cookie): the dashboard's API calls send the proxy's cookie along (`credentials: same-origin`). The dashboard accepts only `Host: localhost` or `127.0.0.1` (a DNS-rebinding guard), so the proxy must send that, e.g. nginx `proxy_set_header Host 127.0.0.1:3001`.

**Upgrades:**
- systemd unit: build or load the new `plim` image, then `systemctl --user restart container-plim`. The unit was generated with `--new`, so it recreates the container from the new image.
- Without systemd: build or load the new image, `podman rm -f plim`, then the same `podman run` as before.
- Data lives in the volume and survives.
- Pages already open notice the new version (each API answer names it, as `X-Tiro-Version`) and offer **Plim was updated · Reload**.

**Backups:** the volume holds `tiro.db` (the database's name from before the rename). The server copies it while it runs, consistently (SQLite's `VACUUM INTO`, checked before it replaces the previous copy):

```sh
podman exec plim /app/plim-server --backup /data/backup.db   # plim: backed up … integrity ok
podman cp plim:/data/backup.db ./plim-backup.db              # out of the volume, owned by you
```

Run it on a timer and send the copy somewhere else (restic, rsync, object storage): it's ciphertext, but account ids, sizes and timing are in it, so keep it encrypted there too. To restore, stop the container and put the copy in its volume as `tiro.db`, owned by the image's user (uid 65532), with no `tiro.db-wal` or `tiro.db-shm` left beside it; then start it:

```sh
podman stop plim
mp=$(podman volume inspect plim-data --format '{{.Mountpoint}}')
podman unshare sh -c "rm -f $mp/tiro.db-wal $mp/tiro.db-shm && cp plim-backup.db $mp/tiro.db && chown 65532:65532 $mp $mp/tiro.db"
podman start plim
```

(Into a new volume, that `chown` of the folder matters: podman gives a volume the image's `/data`, owned by 65532, only when it starts out empty.) Devices that saw newer data then show the rollback warning: that's the restore, not an attack.

Backups hold everyone's data as it was: an account deleted since (Settings → Account → Delete account) is still in them until they're replaced. Keep them only as long as you need them, and remember a restore brings deleted accounts back.

The volume must be on a local filesystem: SQLite's write-ahead log doesn't work over NFS.

## Live sync (WebSockets)

The web app keeps one WebSocket open at `/api/live` for live sync. Anything in front of Plim must pass WebSocket upgrades through:
- **Cloudflare Tunnel:** works as is. Cloudflare closes idle WebSockets after about 100 s, so the server sends a ping every 30 s.
- **nginx:** add `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` to the location, and keep `proxy_read_timeout` above 30 s.
- **Caddy:** works as is.

If the upgrade fails, the app falls back to polling every few seconds; nothing breaks, edits just take longer to show up on other devices. The admin dashboard shows the number of live connections under "Signed in now".

## Behind a Cloudflare Tunnel

`cloudflared` gives you HTTPS at Cloudflare's edge without opening any inbound ports. There are two ways to run it. Both give each visitor their own rate limit, using Cloudflare's `CF-Connecting-IP` header.

**Why the address to trust matters:** with rootless Podman, traffic through a *published* port arrives from the plim container's own IP inside the network. So never trust the whole subnet: anyone who could reach a published port could then fake their address.

### Option 1: `cloudflared` already runs on the host

Keep your existing tunnel and service. In Zero Trust → **Networks → Tunnels** → your tunnel → **Public hostname**, add e.g. `notes.example.com` → service **HTTP** → `localhost:3000`. Then run plim with a **pinned** address and trust that address:

```sh
podman network create --subnet 10.89.42.0/24 plim
podman run -d --name plim --network plim --ip 10.89.42.5 -v plim-data:/data \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
  -e PLIM_ADMIN_ADDR=0.0.0.0:3001 -e PLIM_ADMIN_ALLOW_NONLOOPBACK=1 \
  -e PLIM_TRUSTED_PROXIES=10.89.42.5 -e PLIM_CLIENT_IP_HEADER=cf-connecting-ip plim
```

The host `cloudflared` reaches plim through the published port, so plim sees its own address, `10.89.42.5`. Trusting that address means trusting everything that comes through port 3000, which is safe only because **port 3000 is published on `127.0.0.1`**:
- Visitors from the internet can only arrive through Cloudflare, which rejects a client-supplied `CF-Connecting-IP` (error 1000).
- Only programs running on the server itself could set the header.

Rules for this setup:
- Never publish it as `3000:3000`.
- Keep `--ip` and `PLIM_TRUSTED_PROXIES` identical. Without `--ip`, a recreated container gets a new address, and plim falls back to one shared rate limit and logs a warning.

**Without the custom network** (Podman's default rootless network, called pasta): `--ip` isn't available, and the host `cloudflared` reaches plim from **your server's own LAN address**. If that address is static, skip `podman network create`, `--network` and `--ip`, and trust it instead:

```sh
podman run -d --name plim -v plim-data:/data \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
  -e PLIM_ADMIN_ADDR=0.0.0.0:3001 -e PLIM_ADMIN_ALLOW_NONLOOPBACK=1 \
  -e PLIM_TRUSTED_PROXIES=<server LAN IP> -e PLIM_CLIENT_IP_HEADER=cf-connecting-ip plim
```

The same loopback-only rule applies. To find the address, start plim once without the two `PLIM_*` proxy variables, visit the site through Cloudflare, and read it from the `podman logs plim` warning. If the address later changes (DHCP), plim falls back to one shared rate limit and logs the new address.

**Older Podman (before 5.0, e.g. 4.3 on Debian 12):** rootless containers use slirp4netns instead of pasta. Every container gets the fixed address `10.0.2.100`, and all published-port traffic arrives from it. That address doesn't change when the container is recreated. With port 3000 on loopback, trust it: `-e PLIM_TRUSTED_PROXIES=10.0.2.100 -e PLIM_CLIENT_IP_HEADER=cf-connecting-ip`. Check with `podman port plim` that 3000 maps to `127.0.0.1`.

Rather not trust anything? Leave out the two `PLIM_*` proxy variables, and `--network`/`--ip` if you like. Everything still works, and all visitors share one rate limit.

### Option 2: `cloudflared` as a container

This is stricter: only the tunnel's own fixed address is trusted, so even programs on the server can't fake an address.

1. In Cloudflare Zero Trust → **Networks → Tunnels**, create a tunnel (or open an existing one) and copy its token.
2. Under **Public hostname**, add e.g. `notes.example.com` → service **HTTP** → `plim:3000`.
3. Run both containers on one network, `cloudflared` at a fixed address that `plim` trusts:
```sh
podman network create --subnet 10.89.42.0/24 plim
podman run -d --name plim --network plim -v plim-data:/data -p 127.0.0.1:3001:3001 \
  -e PLIM_ADMIN_ADDR=0.0.0.0:3001 -e PLIM_ADMIN_ALLOW_NONLOOPBACK=1 \
  -e PLIM_TRUSTED_PROXIES=10.89.42.10 -e PLIM_CLIENT_IP_HEADER=cf-connecting-ip plim
echo 'TUNNEL_TOKEN=<token>' > cloudflared.env && chmod 600 cloudflared.env
podman run -d --name cloudflared --network plim --ip 10.89.42.10 --env-file cloudflared.env \
  docker.io/cloudflare/cloudflared:latest tunnel --no-autoupdate run
```
Port 3000 doesn't need publishing: `cloudflared` reaches `plim:3000` over the network. If you switch from Option 1 and stop publishing it, also move the tunnel's service from `localhost:3000` to `plim:3000`, then stop the host `cloudflared`. Otherwise Cloudflare returns 502.

**Check it (either option):**
- `podman logs plim` should show `trusted proxies: <address>/32 via cf-connecting-ip`.
- After you visit the site through Cloudflare, there should be no "isn't in PLIM_TRUSTED_PROXIES" warnings.

**Cloudflare settings for this hostname:**
- **Always Use HTTPS** (SSL/TLS → Edge Certificates): on. Otherwise plain `http://` serves the page too. Plim won't run there (no WebCrypto), but a shared link opened as `http://` could be served a page that reads its key. The server also sends HSTS, so browsers that have visited stay on HTTPS. (If other subdomains must stay on HTTP, use a redirect rule for this hostname instead.)
- **Turn off:** Rocket Loader, Email Obfuscation and automatic Web Analytics injection. Plim's CSP blocks injected scripts anyway.
- **Bot Fight Mode:** don't enable it, because it challenges non-browser clients such as the `plim` CLI.
- **Admin dashboard:** keep it off the tunnel and reach it with `ssh -L 3001:127.0.0.1:3001 <server>`. If it were routed by mistake, the Host check would still reject it.
- **Browser Cache TTL:** "Respect Existing Headers" is best, but any value works. The page links its scripts and styles under `/v/<hash of the web files>/`, so each deploy uses new URLs and browsers never keep running old code.
- **What Cloudflare can see:** it terminates TLS, so it can see request metadata and login tokens but not note contents. It also serves the JavaScript to your browser, so it joins the server in what you trust for that.

## The connector

`plim mcp --http` (#369) lets Claude, and any other MCP client, connect to vaults on this server over the web ([README](../README.md#connecting-claude-over-the-web)): the only way an agent reaches notes, as there's no MCP server on stdin/stdout. It's the `plim` CLI binary, run as a service, with no account of its own; it holds no notes and no keys, only the key that seals Claude's tokens (`--secret-file`, made on first run: keep it, or every connection has to be made again).

1. Install `plim` on the server: a release's `plim-linux-amd64` ([Terminal client](../README.md#terminal-client) says how), or built from source.
2. Run it as a user service: [`docs/plim-mcp.service`](plim-mcp.service) (edit `--server` and `--public-url`): copy it to `~/.config/systemd/user/`, then `systemctl --user daemon-reload`, `systemctl --user enable --now plim-mcp` and `loginctl enable-linger $USER`. It listens on `127.0.0.1:3010`.
3. Publish it: in the tunnel's **Public hostname**, add e.g. `mcp-notes.example.com` → **HTTP** → `localhost:3010` (Option 1) or the host's address as the `cloudflared` container reaches it (Option 2). Same Cloudflare settings as the site; Bot Fight Mode would block Claude. Keep the name one level under your zone (`mcp-notes.example.com`, not `mcp.notes.example.com`): Cloudflare's Universal SSL certificate covers `*.example.com` only, so a deeper name fails the TLS handshake unless you buy an advanced certificate.
4. Tell the Plim server: `PLIM_CONNECTOR_URL=https://mcp-notes.example.com`. The consent page at `/connect` hands a connection's secret to that address only; unset, connecting an app is off.
5. Check: `https://mcp-notes.example.com/` says what it is, and `/.well-known/oauth-authorization-server` lists its endpoints. In Claude, add a connector with `https://mcp-notes.example.com/mcp`.

After installing a new `plim`: `systemctl --user restart plim-mcp`. Tokens are sealed to the process's key, not to the binary, so connections survive it.
