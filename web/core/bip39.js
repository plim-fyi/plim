// BIP-39 mnemonic generation, validation and seed derivation (WebCrypto only).
import { WORDLIST } from './bip39-english.js';
import { sha256 } from './crypto.js';

const INDEX = new Map(WORDLIST.map((w, i) => [w, i]));

function bits(bytes) {
  return [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
}

export async function entropyToMnemonic(entropy) {
  if (![16, 20, 24, 28, 32].includes(entropy.length)) throw new Error('bad entropy length');
  const checksum = bits(await sha256(entropy)).slice(0, entropy.length / 4);
  const all = bits(entropy) + checksum;
  const words = [];
  for (let i = 0; i < all.length; i += 11) words.push(WORDLIST[parseInt(all.slice(i, i + 11), 2)]);
  return words.join(' ');
}

/** 12 words = 128 bits of entropy. */
export async function generateMnemonic(strength = 128) {
  return entropyToMnemonic(crypto.getRandomValues(new Uint8Array(strength / 8)));
}

export function normalize(mnemonic) {
  return mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/** { entropy } for a valid phrase, otherwise { problem } (human-readable). */
async function decodeMnemonic(mnemonic) {
  const words = normalize(mnemonic).split(' ');
  if (![12, 15, 18, 21, 24].includes(words.length)) return { problem: 'Expected 12 or 24 words' };
  const unknown = words.find((w) => !INDEX.has(w));
  if (unknown) return { problem: `"${unknown}" is not a recovery word` };
  const all = words.map((w) => INDEX.get(w).toString(2).padStart(11, '0')).join('');
  const csLen = words.length / 3;
  const entBits = all.slice(0, all.length - csLen);
  const entropy = new Uint8Array(entBits.length / 8);
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
  const expected = bits(await sha256(entropy)).slice(0, csLen);
  return expected === all.slice(-csLen) ? { entropy } : { problem: 'Checksum mismatch — check the words and their order' };
}

/** Returns null if valid, otherwise a human-readable problem. */
export async function validateMnemonic(mnemonic) {
  return (await decodeMnemonic(mnemonic)).problem ?? null;
}

/** The entropy a valid phrase encodes (the inverse of entropyToMnemonic). */
export async function mnemonicToEntropy(mnemonic) {
  const { entropy, problem } = await decodeMnemonic(mnemonic);
  if (problem) throw new Error(problem);
  return entropy;
}

/** PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase → 64-byte seed. */
export async function mnemonicToSeed(mnemonic, passphrase = '') {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', te.encode(normalize(mnemonic)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const salt = te.encode(('mnemonic' + passphrase).normalize('NFKD'));
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 2048 }, key, 512),
  );
}
