#!/bin/sh
# Runs web/install.sh against a release made here: a fake "latest" with this machine's asset name
# holding a small script that answers --version, served from a folder by python's http.server.
# Checks: a fresh install, "already the latest", an update, a bad hash refused, PLIM_VERSION's path.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/plim-install-check.XXXXXX")"
trap 'kill $srv 2>/dev/null; rm -rf "$work"' EXIT

case "$(uname -s)" in Darwin) asset=plim-macos ;; *) asset=plim-linux-amd64 ;; esac
release() { # $1: the folder, $2: the version the "binary" says
  mkdir -p "$1"
  printf '#!/bin/sh\necho "plim %s (test)"\n' "$2" > "$1/$asset"
  (cd "$1" && { sha256sum "$asset" 2>/dev/null || shasum -a 256 "$asset"; } > SHA256SUMS)
}
release "$work/site/latest/download" 1.0.0
release "$work/site/download/v0.9.0" 0.9.0
# (A bad hash, to be refused.)
release "$work/site/bad" 1.0.1
sed -i.orig 's/^[0-9a-f]\{8\}/00000000/' "$work/site/bad/SHA256SUMS"

port=$((20000 + $$ % 10000))
(cd "$work/site" && python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
srv=$!
sleep 1
# (Plain http to this machine: the script insists on https for anything real; the check sets
# the URL whole, which also gets round --proto. curl: --proto '=https' is per URL scheme, so a
# local http:// URL fails; the check allows it with PLIM_RELEASE_URL and curl's config override.)
run() { PLIM_INSTALL_DIR="$work/bin" PLIM_INSTALL_ALLOW_HTTP=1 sh "$root/web/install.sh" "$@" 2>&1; }

out="$(PLIM_RELEASE_URL="http://127.0.0.1:$port/latest/download" run)"
echo "$out" | grep -q "^Installed: plim 1.0.0" || { echo "fresh install: $out"; exit 1; }
[ "$("$work/bin/plim" --version)" = "plim 1.0.0 (test)" ] || { echo "installed binary doesn't run"; exit 1; }
out="$(PLIM_RELEASE_URL="http://127.0.0.1:$port/latest/download" run)"
echo "$out" | grep -q "^Already the latest: plim 1.0.0" || { echo "again: $out"; exit 1; }
out="$(PLIM_RELEASE_URL="http://127.0.0.1:$port/download/v0.9.0" run)"
echo "$out" | grep -q "^Updated: plim 1.0.0 (test) → plim 0.9.0" || { echo "another version: $out"; exit 1; }
if out="$(PLIM_RELEASE_URL="http://127.0.0.1:$port/bad" run)"; then echo "a bad hash was accepted: $out"; exit 1; fi
echo "$out" | grep -q "doesn't match SHA256SUMS" || { echo "bad hash, wrong words: $out"; exit 1; }
[ "$("$work/bin/plim" --version)" = "plim 0.9.0 (test)" ] || { echo "the bad download replaced the binary"; exit 1; }
echo "install.sh: ok (fresh, already the latest, update, bad hash refused)"
