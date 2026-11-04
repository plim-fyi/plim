// node tools/bench/pow.mjs [difficulty] [salts] — signup's proof-of-work (#499): the app's
// WebAssembly (web/wasm/plim.wasm) against the JS solver, on the same salts (so the same work).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { solve } from '../../web/core/pow-worker.js';
import { wasmFromBytes } from '../../web/core/wasm.js';

const DIFF = Number(process.argv[2] ?? 20), SALTS = Number(process.argv[3] ?? 12);
const salts = [...Array(SALTS)].map((_, i) => new Uint8Array(createHash('sha256').update(`salt${i}`).digest().subarray(0, 16)));
const wasm = await wasmFromBytes(readFileSync(new URL('../../web/wasm/plim.wasm', import.meta.url)));

function run(name, f) {
  const t = performance.now();
  const nonces = salts.map(f);
  const ms = performance.now() - t, hashes = nonces.reduce((a, n) => a + n + 1, 0);
  console.log(`${name.padEnd(5)} ${(hashes / ms / 1000).toFixed(2).padStart(6)} MH/s  ${(ms / SALTS).toFixed(0).padStart(5)} ms a signup`);
  return nonces;
}
solve(salts[0], 12); // (warm up)
const js = run('js', (s) => solve(s, DIFF));
const w = run('wasm', (s) => wasm.powSolve(s, DIFF));
if (w.join() !== js.join()) throw new Error('the two found different nonces');
console.log(`difficulty ${DIFF}, ${SALTS} salts`);
