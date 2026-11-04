#!/usr/bin/env bash
# Build the web app's WebAssembly: crates/plim-wasm → web/wasm/plim.wasm.
#   tools/wasm/build.sh            write web/wasm/plim.wasm
#   tools/wasm/build.sh --check    rebuild and compare: web/wasm/plim.wasm must be exactly that
# Reproducible with the pinned Rust (mise.toml) and Cargo.lock: paths are remapped,
# so where the repo and the cargo registry are doesn't change the bytes.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$root/web/wasm/plim.wasm
cargo_home=${CARGO_HOME:-$HOME/.cargo}

rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown ||
  rustup target add wasm32-unknown-unknown

# simd128: every browser Plim runs in has it (WebCrypto's Ed25519 needs newer ones still).
RUSTFLAGS="-C target-feature=+simd128 --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$root=/plim" \
  cargo build --manifest-path "$root/Cargo.toml" -p plim-wasm --lib --profile wasm \
  --target wasm32-unknown-unknown --target-dir "$root/target/wasm" --locked
built=$root/target/wasm/wasm32-unknown-unknown/wasm/plim_wasm.wasm

if [[ ${1:-} == --check ]]; then
  if cmp -s "$built" "$out"; then
    echo "web/wasm/plim.wasm is up to date ($(wc -c <"$out") bytes)"
  else
    echo "web/wasm/plim.wasm differs from a fresh build: run tools/wasm/build.sh and commit it" >&2
    exit 1
  fi
else
  cp "$built" "$out"
  echo "wrote web/wasm/plim.wasm ($(wc -c <"$out") bytes, sha256 $(sha256sum "$out" | cut -c1-16)…)"
fi
