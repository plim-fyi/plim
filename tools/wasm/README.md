# The web app's WebAssembly

Some of Plim's Rust runs in the browser too, compiled to WebAssembly: `crates/plim-wasm` builds into `web/wasm/plim.wasm`, which is committed, ready to load, like `web/vendor/`. So the app still has no build step, and the browser runs the same code as the server and the terminal client.

| Export | What | Used by |
|---|---|---|
| `pow_solve` | signup's proof-of-work (`plim_core::pow`, #499): about twice as fast as JavaScript | `web/core/pow-worker.js` |
| `alloc_bytes`, `free_bytes` | memory for passing bytes in | `web/core/wasm.js` |

`web/core/wasm.js` loads it, once, on first use, and wraps each export for JavaScript. Where it can't load it gives `null`, and every caller keeps a JavaScript way, so the app works without it, only slower.

It's a plain C ABI, with no bindings generator: arguments go in as numbers, or as bytes written into memory from `alloc_bytes`. `plim-core` is used without its `crypto` feature: keys and encryption stay in WebCrypto, where the browser keeps keys out of reach of the page's JavaScript.

The page's CSP allows it with `'wasm-unsafe-eval'` in `script-src` (`server/src/lib.rs`): it lets the page compile WebAssembly it loaded from its own origin, and allows no JavaScript `eval`.

## Commands

From the repo root:

```
tools/wasm/build.sh            # write web/wasm/plim.wasm
tools/wasm/build.sh --check    # rebuild it: web/wasm/plim.wasm must be exactly that
```

The build is reproducible: with the Rust pinned in `mise.toml` and `Cargo.lock`, any machine makes the same bytes (paths are remapped). GitHub runs `--check` on every pull request that touches it (`.github/workflows/wasm.yml`).

## Changing it

1. Change `crates/plim-wasm` (or what it uses in `plim-core`); give a new export its wrapper in `web/core/wasm.js`.
2. `tools/wasm/build.sh`, then the tests: `cargo test --workspace` and `node web/tests/run.mjs`.
3. Commit the code and `web/wasm/plim.wasm` together. Updating Rust in `mise.toml` changes the bytes too: rebuild and commit.

`node tools/bench/pow.mjs` compares the proof-of-work in WebAssembly and in JavaScript.
