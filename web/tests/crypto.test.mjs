// BIP-39, keys, signatures and proof of work (bip39.js, crypto.js, sig.js, pow-worker.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entropyToMnemonic, generateMnemonic, mnemonicToSeed, validateMnemonic } from '../core/bip39.js';
import { b64, bytesToHex, deriveIdentity, hexToBytes, importSigningKey, randomBytes, sha256, sign, unb64, unwrapVaultKey, verify, wrapVaultKey } from '../core/crypto.js';
import { DocSync } from '../core/sync.js';
import { ACTION, actionMsg, authMsg, blobMsg, deleteAccountMsg, encode, TAG } from '../core/sig.js';
import { solve, solveWith } from '../core/pow-worker.js';
import { wasmFromBytes } from '../core/wasm.js';
import { here, test, fakeSession, text } from './lib.mjs';

test('BIP-39 Trezor vectors', async () => {
  const { english } = JSON.parse(readFileSync(new URL('bip39-vectors.json', here)));
  for (const [entropy, mnemonic, seed] of english) {
    assert.equal(await entropyToMnemonic(hexToBytes(entropy)), mnemonic);
    assert.equal(await validateMnemonic(mnemonic), null);
    assert.equal(bytesToHex(await mnemonicToSeed(mnemonic, 'TREZOR')), seed);
  }
});

test('BIP-39 rejects bad checksum and unknown words', async () => {
  const good = await generateMnemonic();
  assert.equal(good.split(' ').length, 12);
  assert.equal(await validateMnemonic(good), null);
  assert.match(await validateMnemonic('abandon '.repeat(11) + 'abandon'), /Checksum/);
  assert.equal(await validateMnemonic('  Abandon '.repeat(11) + 'about '), null);
  assert.match(await validateMnemonic('abandon '.repeat(11) + 'notaword'), /not a recovery word/);
  assert.match(await validateMnemonic('abandon abandon'), /12 or 24/);
});

test('identity is deterministic per phrase and distinct across phrases', async () => {
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const a = await deriveIdentity(await mnemonicToSeed(phrase));
  const b = await deriveIdentity(await mnemonicToSeed(phrase));
  const c = await deriveIdentity(await mnemonicToSeed(await generateMnemonic()));
  assert.equal(a.pubkeyHash, b.pubkeyHash);
  assert.notEqual(a.pubkeyHash, c.pubkeyHash);
  assert.equal(a.pubkeyHash, bytesToHex(await sha256(a.pubkey)));
  const msg = encode(TAG.auth, 'hello');
  assert.ok(await verify(a.pubkey, msg, await sign(b.signKey, msg)));
});

test('vault key wrap/unwrap round trip, bound to account and version', async () => {
  const id = await deriveIdentity(randomBytes(64));
  const vk = randomBytes(32);
  const entry = await wrapVaultKey(id, 'acct', 1, vk);
  assert.deepEqual(await unwrapVaultKey(id, 'acct', entry), vk);
  await assert.rejects(unwrapVaultKey(id, 'other', entry));
  await assert.rejects(unwrapVaultKey(id, 'acct', { ...entry, key_version: 2 }));
  const stranger = await deriveIdentity(randomBytes(64));
  await assert.rejects(unwrapVaultKey(stranger, 'acct', entry));
});

test('signature fixture shared with Rust matches', async () => {
  const fx = await makeFixture();
  const stored = JSON.parse(readFileSync(new URL('fixtures/sig.json', here)));
  assert.deepEqual(fx, stored);
});

test('PoW solver output satisfies the difficulty', async () => {
  const salt = randomBytes(16);
  const n = solve(salt, 14);
  const input = new Uint8Array(24);
  input.set(salt);
  new DataView(input.buffer).setBigUint64(16, BigInt(n));
  const h = await sha256(input);
  let zeros = 0;
  for (const byte of h) {
    zeros += byte === 0 ? 8 : Math.clz32(byte) - 24;
    if (byte !== 0) break;
  }
  assert.ok(zeros >= 14, `only ${zeros} zero bits`);
});

test('PoW in the WebAssembly finds the same nonces as the JS solver', async () => {
  const wasm = await wasmFromBytes(readFileSync(new URL('../wasm/plim.wasm', here)));
  for (let i = 0; i < 8; i++) {
    const salt = randomBytes(16);
    assert.equal(wasm.powSolve(salt, 14), solve(salt, 14));
  }
  assert.throws(() => wasm.powSolve(randomBytes(16), 49), /unsupported pow parameters/);
});

test('PoW falls back to JS where the WebAssembly is missing or fails', async () => {
  const wasm = await wasmFromBytes(readFileSync(new URL('../wasm/plim.wasm', here)));
  const salt = randomBytes(16), nonce = solve(salt, 12);
  assert.deepEqual(solveWith(wasm, salt, 12), { nonce, via: 'wasm' });
  assert.deepEqual(solveWith(null, salt, 12), { nonce, via: 'js' }); // (didn't load)
  const warn = console.warn;
  console.warn = () => {};
  try {
    const broken = { powSolve: () => { throw new WebAssembly.RuntimeError('unreachable'); } };
    assert.deepEqual(solveWith(broken, salt, 12), { nonce, via: 'js' }); // (loaded, then failed)
  } finally {
    console.warn = warn;
  }
});

test('base64: native and fallback agree', () => {
  const bytes = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 7919) & 255);
  const native = b64(bytes);
  const saved = [Uint8Array.prototype.toBase64, Uint8Array.fromBase64];
  try {
    delete Uint8Array.prototype.toBase64;
    delete Uint8Array.fromBase64;
    assert.equal(b64(bytes), native);
    assert.deepEqual(unb64(native), bytes);
  } finally {
    if (saved[0]) Uint8Array.prototype.toBase64 = saved[0];
    if (saved[1]) Uint8Array.fromBase64 = saved[1];
  }
  assert.deepEqual(unb64(native), bytes);
});

test('mixed key versions decrypt after rotation', async () => {
  const { keyring, mk } = await fakeSession();
  const a = new DocSync(mk(), 'n');
  a.ydoc.getText('body').insert(0, 'v1 text ');
  await a.flush();
  keyring.add(2, randomBytes(32));
  a.ydoc.getText('body').insert(8, 'v2 text');
  await a.flush();
  const b = new DocSync(mk(), 'n');
  await b.load();
  assert.equal(text(b.ydoc), 'v1 text v2 text');
  [a, b].forEach((s) => s.close());
});

test('tampered ciphertext is rejected by the client', async () => {
  const { api, mk } = await fakeSession();
  const a = new DocSync(mk(), 'n');
  a.ydoc.getText('body').insert(0, 'secret');
  await a.flush();
  const u = api.doc('n').updates[0];
  const ct = unb64(u.ciphertext);
  ct[0] ^= 1;
  u.ciphertext = b64(ct);
  const b = new DocSync(mk(), 'n');
  await assert.rejects(b.load());
  [a, b].forEach((s) => s.close());
});

export async function makeFixture() {
  const { signKey, pubkey } = await importSigningKey(new Uint8Array(32).fill(7));
  const fx = {
    pubkey: b64(pubkey),
    pubkey_hash: bytesToHex(await sha256(pubkey)),
    account_id: '0123456789abcdef0123456789abcdef',
    doc_id: 'index',
    kind: 'snapshot',
    key_version: 3,
    covers_seq: 42,
    nonce: b64(new Uint8Array(12).fill(1)),
    ciphertext: b64(new TextEncoder().encode('opaque ciphertext bytes')),
    auth_nonce: b64(new Uint8Array(32).fill(2)),
  };
  const msg = blobMsg(fx.account_id, fx.doc_id, fx.kind, fx.key_version, fx.covers_seq, unb64(fx.nonce), unb64(fx.ciphertext));
  fx.blob_msg = b64(msg);
  fx.blob_sig = b64(await sign(signKey, msg));
  fx.auth_sig = b64(await sign(signKey, authMsg(unb64(fx.auth_nonce), fx.pubkey_hash)));
  const dmsg = deleteAccountMsg(fx.account_id, unb64(fx.auth_nonce));
  fx.delete_msg = b64(dmsg);
  fx.delete_sig = b64(await sign(signKey, dmsg));
  // A destructive action (#144), with data: a passkey's copy, its nonce then its ciphertext.
  const data = new Uint8Array([...unb64(fx.nonce), ...unb64(fx.ciphertext)]);
  const amsg = actionMsg(fx.account_id, ACTION.putPasskey, fx.doc_id, unb64(fx.auth_nonce), data);
  fx.action_msg = b64(amsg);
  fx.action_sig = b64(await sign(signKey, amsg));
  return fx;
}
