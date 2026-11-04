// The web app's WebAssembly: web/wasm/plim.wasm, Plim's Rust (crates/plim-wasm),
// built by tools/wasm/build.sh. Loaded once, on first use. Where it can't load
// (no WebAssembly, a fetch that failed) it's null, so each caller keeps a JS way.

const WASM_URL = new URL('../wasm/plim.wasm', import.meta.url);
const U64_MAX = 0xffffffffffffffffn; // (a u64 comes back as a signed BigInt: BigInt.asUintN below)

let loading;

/** The module's functions, or null where it can't load. */
export function loadWasm() {
  return (loading ??= fetchWasm().catch(() => null));
}

async function fetchWasm() {
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error(`plim.wasm: ${res.status}`);
  return wasmFromBytes(await res.arrayBuffer());
}

/** The same, from the module's bytes (the tests, in Node). */
export async function wasmFromBytes(bytes) {
  return wrap((await WebAssembly.instantiate(bytes)).instance.exports);
}

function wrap(x) {
  /** Run f(ptr, len) with `bytes` copied into the module's memory. */
  const withBytes = (bytes, f) => {
    const ptr = x.alloc_bytes(bytes.length);
    try {
      new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
      return f(ptr, bytes.length);
    } finally {
      x.free_bytes(ptr, bytes.length);
    }
  };
  return {
    /** Signup's proof-of-work, as pow-worker.js's solve(). */
    powSolve(salt, difficulty) {
      const n = BigInt.asUintN(64, withBytes(salt, (ptr, len) => x.pow_solve(ptr, len, difficulty)));
      if (n === U64_MAX) throw new Error('unsupported pow parameters');
      return Number(n);
    },
  };
}
