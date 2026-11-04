// Key derivation, signing and encryption — all via WebCrypto.
import { keyringAad, keyringMsg } from './sig.js';

const subtle = crypto.subtle;
const te = new TextEncoder();
const HKDF_SALT = te.encode('tiro/v1/salt');
// PKCS#8 DER prefix for a raw 32-byte Ed25519 private key.
const ED25519_PKCS8_PREFIX = hexToBytes('302e020100300506032b657004220420');

// ---- encoding helpers ----

export function bytesToHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Native base64 where the browser has it (much faster for big blobs).
export function b64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Base64url without padding (links' keys, JWK fields), and back. */
export const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function unb64url(s) {
  return unb64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

export async function hkdf(ikm, info, length = 32) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: te.encode(info) }, base, length * 8),
  );
}

// ---- identity: seed → signing key + key-encryption key ----

export async function importSigningKey(seed32) {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed32, 16);
  const exportable = await subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const jwk = await subtle.exportKey('jwk', exportable);
  const signKey = await subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  pkcs8.fill(0);
  return { signKey, pubkey: unb64url(jwk.x) };
}

export async function aesKey(raw, usages = ['encrypt', 'decrypt']) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

/**
 * From a BIP-39 seed derive the Ed25519 signing key (identity) and the
 * key-encryption key that wraps vault keys. The public key hash is what the
 * server looks the account up by.
 */
export async function deriveIdentity(seed) {
  const signSeed = await hkdf(seed, 'tiro/v1/sign');
  const kekRaw = await hkdf(seed, 'tiro/v1/kek');
  const { signKey, pubkey } = await importSigningKey(signSeed);
  const kek = await aesKey(kekRaw);
  signSeed.fill(0);
  kekRaw.fill(0);
  return { signKey, pubkey, pubkeyHash: bytesToHex(await sha256(pubkey)), kek };
}

export async function sign(signKey, msg) {
  return new Uint8Array(await subtle.sign('Ed25519', signKey, msg));
}

export async function verify(pubkey, msg, sig) {
  const key = await subtle.importKey('raw', pubkey, 'Ed25519', false, ['verify']);
  return subtle.verify('Ed25519', key, sig, msg);
}

// ---- AEAD ----

export async function encrypt(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return { nonce, ciphertext: new Uint8Array(ct) };
}

export async function decrypt(key, nonce, ciphertext, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext));
}

// ---- key hierarchy ----

/** Wrap a raw vault key under the KEK and sign the entry; returns the API shape. */
export async function wrapVaultKey(identity, accountId, keyVersion, vaultKey) {
  const { nonce, ciphertext } = await encrypt(identity.kek, vaultKey, keyringAad(accountId, keyVersion));
  const sig = await sign(identity.signKey, keyringMsg(accountId, keyVersion, nonce, ciphertext));
  return { key_version: keyVersion, nonce: b64(nonce), wrapped: b64(ciphertext), sig: b64(sig) };
}

export async function unwrapVaultKey(identity, accountId, entry) {
  return decrypt(identity.kek, unb64(entry.nonce), unb64(entry.wrapped), keyringAad(accountId, entry.key_version));
}

/** Per-document AES key = HKDF(vault key, "doc:<id>"). */
export async function deriveDocKey(vaultKey, docId) {
  return aesKey(await hkdf(vaultKey, `tiro/v1/doc:${docId}`));
}
