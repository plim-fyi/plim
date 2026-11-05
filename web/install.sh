#!/bin/sh
# Installs plim, the terminal client, from its latest release (or updates it: run it again).
#
#   curl -fsSL https://plim.fyi/install.sh | sh
#
# What it does, so you can do it by hand instead (README, Terminal client): picks the binary for
# this machine (plim-linux-amd64, or plim-macos for any Mac), downloads it and SHA256SUMS from
# https://github.com/plim-fyi/plim/releases, checks the hash, and puts it at ~/.local/bin/plim.
#
#   PLIM_INSTALL_DIR=/usr/local/bin   where to put it (default ~/.local/bin)
#   PLIM_VERSION=0.20.2               a release other than the latest
#
# Served from plim.fyi as part of the web app, so it's in the signed record of every deploy
# (plim-signed-web-deploys). It needs curl or wget, and sha256sum, shasum or openssl.
set -eu

repo="https://github.com/plim-fyi/plim"
base="${PLIM_RELEASE_URL:-$repo/releases/${PLIM_VERSION:+download/v$PLIM_VERSION}${PLIM_VERSION:-latest/download}}"
dir="${PLIM_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "install.sh: $*"; exit 1; }

case "$(uname -s)" in
  Linux) case "$(uname -m)" in
    x86_64 | amd64) asset=plim-linux-amd64 ;;
    *) fail "no release for Linux on $(uname -m) yet: build it from source (README, Terminal client)" ;;
  esac ;;
  Darwin) asset=plim-macos ;;
  *) fail "no release for $(uname -s): on Windows, use WSL and the Linux binary" ;;
esac

# (https only, whatever a redirect says; PLIM_INSTALL_ALLOW_HTTP=1 is for tools/install-check.sh,
# against a release served on this machine.)
if [ "${PLIM_INSTALL_ALLOW_HTTP:-}" = 1 ]; then
  proto=""; https=""
else
  proto="--proto =https"; https="--https-only"
fi
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL $proto --tlsv1.2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q $https -O "$2" "$1"; }
else
  fail "needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v openssl >/dev/null 2>&1; then
  digest() { openssl dgst -sha256 -r "$1" | cut -d' ' -f1; }
else
  fail "needs sha256sum, shasum or openssl to check the download"
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/plim-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

say "Downloading $asset…"
fetch "$base/$asset" "$tmp/$asset" || fail "couldn't download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download $base/SHA256SUMS"
expected="$(grep " [*]\{0,1\}$asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "SHA256SUMS has no line for $asset"
actual="$(digest "$tmp/$asset")"
[ "$actual" = "$expected" ] || fail "$asset doesn't match SHA256SUMS (got $actual, expected $expected): not installed"

was=""
if [ -x "$dir/plim" ]; then
  was="$("$dir/plim" --version 2>/dev/null || true)"
fi
mkdir -p "$dir"
chmod 755 "$tmp/$asset"
# (Into place in one step: a plim running meanwhile keeps its old file.)
mv -f "$tmp/$asset" "$dir/plim.new" && mv -f "$dir/plim.new" "$dir/plim"
now="$("$dir/plim" --version 2>/dev/null || echo plim)"

if [ -n "$was" ] && [ "$was" != "$now" ]; then
  say "Updated: $was → $now, at $dir/plim"
elif [ -n "$was" ]; then
  say "Already the latest: $now, at $dir/plim"
else
  say "Installed: $now, at $dir/plim"
fi
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "Add it to your PATH: export PATH=\"$dir:\$PATH\" (in ~/.bashrc, ~/.zshrc or the like)" ;;
esac
say "Then: plim --server https://plim.fyi login   (your 12 words), or init for a new vault."
say "To update later, run this again."
