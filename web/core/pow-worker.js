// Signup proof-of-work solver. Runs off the main thread.
// Finds nonce such that SHA-256(salt || u64be(nonce)) has >= difficulty
// leading zero bits. In the app's WebAssembly (plim_core::pow, about twice as
// fast: #499) where it loads; else solve() below, a small synchronous SHA-256
// (awaiting WebCrypto per attempt is far too slow for ~1M hashes).
import { loadWasm } from './wasm.js';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** First 32-bit word of SHA-256 over a single 64-byte block given as 16 words. */
function sha256Block(block) {
  for (let i = 0; i < 16; i++) W[i] = block[i];
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    W[i] = (W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
  }
  let a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
  let e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  return [(a + 0x6a09e667) >>> 0, (b + 0xbb67ae85) >>> 0];
}

function leadingZeros([w0, w1]) {
  return w0 === 0 ? 32 + Math.clz32(w1) : Math.clz32(w0);
}

export function solve(salt, difficulty) {
  if (salt.length !== 16 || difficulty > 48) throw new Error('unsupported pow parameters');
  // Message = salt(16) || nonce(8) = 24 bytes → one padded block.
  const block = new Uint32Array(16);
  const dv = new DataView(salt.buffer, salt.byteOffset, 16);
  for (let i = 0; i < 4; i++) block[i] = dv.getUint32(i * 4);
  block[6] = 0x80000000;
  block[15] = 24 * 8;
  for (let hi = 0; hi < 0x10000; hi++) {
    block[4] = hi;
    for (let lo = 0; lo < 0x100000000; lo++) {
      block[5] = lo;
      if (leadingZeros(sha256Block(block)) >= difficulty) return hi * 0x100000000 + lo;
    }
  }
  throw new Error('no solution');
}

/**
 * Solve with the WebAssembly (`wasm`, from loadWasm) where it loaded, else with solve() here;
 * also if the WebAssembly fails partway, so signup never depends on it. `via`: which it was,
 * for the tests and the browser flows.
 */
export function solveWith(wasm, salt, difficulty) {
  if (wasm) {
    try {
      return { nonce: wasm.powSolve(salt, difficulty), via: 'wasm' };
    } catch (err) {
      console.warn('proof-of-work: the WebAssembly failed, solving in JS instead', err);
    }
  }
  return { nonce: solve(salt, difficulty), via: 'js' };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (e) => {
    try {
      const salt = new Uint8Array(e.data.salt), { difficulty } = e.data;
      if (salt.length !== 16 || difficulty > 48) throw new Error('unsupported pow parameters');
      self.postMessage(solveWith(await loadWasm(), salt, difficulty));
    } catch (err) {
      self.postMessage({ error: String(err?.message ?? err) });
    }
  };
}
