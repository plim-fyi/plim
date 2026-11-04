// Passkeys (passkey.js, account.js).
import assert from 'node:assert/strict';
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy } from '../core/bip39.js';
import { bytesToHex, hexToBytes, randomBytes, sha256 } from '../core/crypto.js';
import { NAME_MAX, PasskeyError, aaguidOf, cleanName, completePasskey, createPasskey, defaultPasskeyName, describeCreation, signInWithPasskey, unwrapWithPrf, wrapWithPrf } from '../core/passkey.js';
import { identityFromEntropy, identityFromMnemonic, openPasskeyCopy, wrapPasskey } from '../core/account.js';
import { test } from './lib.mjs';

test('passkey PRF wrap: round trip, wrong secret and wrong credential fail', async () => {
  const prf = randomBytes(32);
  const credId = randomBytes(32);
  const entropy = randomBytes(16);
  const { nonce, ciphertext } = await wrapWithPrf(prf, credId, entropy);
  assert.deepEqual(await unwrapWithPrf(prf, credId, nonce, ciphertext), entropy);
  await assert.rejects(unwrapWithPrf(randomBytes(32), credId, nonce, ciphertext));
  // Bound to the credential: the same secret under another credential ID fails.
  await assert.rejects(unwrapWithPrf(prf, randomBytes(32), nonce, ciphertext));
  // The entropy is not stored in the clear.
  assert.ok(!Buffer.from(ciphertext).includes(Buffer.from(entropy)));
});

test('passkey copy: opens to the same identity as the 12 words', async () => {
  const phrase = await generateMnemonic();
  const fromPhrase = await identityFromMnemonic(phrase);
  assert.deepEqual(fromPhrase.entropy, await mnemonicToEntropy(phrase));
  assert.equal(await entropyToMnemonic(fromPhrase.entropy), phrase);

  const prf = randomBytes(32);
  const credId = randomBytes(16);
  const rec = await wrapPasskey('aabbccddeeff00112233445566778899', credId, prf, fromPhrase.entropy);
  assert.equal(rec.credHash, bytesToHex(await sha256(credId)));
  assert.equal(rec.synced, false);
  const entropy = await openPasskeyCopy(prf, credId, rec);
  const fromPasskey = await identityFromEntropy(entropy);
  assert.equal(fromPasskey.identity.pubkeyHash, fromPhrase.identity.pubkeyHash);
  await assert.rejects(openPasskeyCopy(randomBytes(32), credId, rec), (e) => e instanceof PasskeyError);
});

test('bip39: mnemonicToEntropy inverts entropyToMnemonic and rejects bad phrases', async () => {
  const e = randomBytes(16);
  assert.deepEqual(await mnemonicToEntropy(await entropyToMnemonic(e)), e);
  await assert.rejects(mnemonicToEntropy('abandon '.repeat(12).trim()), /Checksum/);
});

/** Run fn with a fake WebAuthn API (navigator.credentials) and location. */
async function withFakeWebAuthn({ create, get }, fn) {
  const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  const calls = { get: 0 };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
    create: async (o) => ((calls.createOptions = o), create()),
    get: async (o) => (calls.get++, (calls.getOptions = o), get()),
  } } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'plim.test' } });
  try {
    return await fn(calls);
  } finally {
    for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
}

const fakeCred = (prf) => ({ rawId: randomBytes(16).buffer, getClientExtensionResults: () => (prf === undefined ? {} : { prf }) });

test('passkey: creation flags never decide; only a sign-in without a secret fails', async () => {
  assert.equal(describeCreation({ enabled: true, results: { first: new ArrayBuffer(32) } }), 'secret returned');
  assert.equal(describeCreation({ enabled: true }), 'supported, no secret yet');
  assert.equal(describeCreation({ enabled: false }), 'reported unsupported');
  assert.equal(describeCreation(undefined), 'not reported');

  // Creation says "not enabled" (as some iOS password managers do): we must
  // still go on to the confirming sign-in instead of failing right away.
  for (const created of [{ enabled: false }, undefined, { enabled: true }]) {
    const r = await withFakeWebAuthn({ create: () => fakeCred(created), get: () => fakeCred({}) },
      () => createPasskey('aabbccddeeff00112233445566778899'));
    assert.ok(r.pending, `creation ${JSON.stringify(created)} should lead to the confirm step`);
    assert.equal(r.pending.creation, describeCreation(created));
  }

  // Creation asks only for PRF support (`prf: {}`), never for a secret: some
  // password managers (Proton Pass on iOS) create the passkey without PRF if
  // a secret is requested during creation. It must be discoverable, so a new
  // device can sign in with it.
  await withFakeWebAuthn({ create: () => fakeCred({ enabled: true }), get: () => fakeCred({}) }, async (calls) => {
    await createPasskey('aabbccddeeff00112233445566778899');
    assert.deepEqual(calls.createOptions.publicKey.extensions, { prf: {} });
    assert.equal(calls.createOptions.publicKey.authenticatorSelection.residentKey, 'required');
  });

  // The confirming sign-in returns no secret: now it fails, with details.
  const pending = { credentialId: randomBytes(16), creation: 'reported unsupported' };
  await withFakeWebAuthn({ create: () => null, get: () => fakeCred({}) }, async (calls) => {
    await assert.rejects(completePasskey(pending), (e) => {
      assert.ok(e instanceof PasskeyError);
      assert.match(e.message, /didn’t give Plim what it needs/);
      assert.doesNotMatch(e.message, /Creation:|passphrase|PRF extension/);
      assert.equal(e.details, 'Creation: reported unsupported; sign-in: no secret.');
      return true;
    });
    assert.equal(calls.get, 1);
  });
});

test('passkey names: AAGUID, default name, cleaning', async () => {
  const authData = new Uint8Array(37 + 16 + 2);
  authData.set(hexToBytes('fbfc3007154e4ecc8c0b6e020557d7bd'), 37);
  assert.equal(aaguidOf(authData), 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
  assert.equal(aaguidOf(new Uint8Array(60)), null); // zeroed (attestation "none" in some browsers)
  assert.equal(aaguidOf(new Uint8Array(37)), null);

  assert.equal(defaultPasskeyName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd', ''), 'iCloud Keychain');
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0';
  assert.equal(defaultPasskeyName(null, mac), 'Chrome on macOS');
  assert.equal(defaultPasskeyName('00000000-1111-2222-3333-444444444444', iphone), 'Safari on iOS');
  assert.equal(defaultPasskeyName(null, edge), 'Edge on Windows');
  assert.equal(defaultPasskeyName(null, 'curl/8'), 'Passkey');

  assert.equal(cleanName('  Work   laptop \n'), 'Work laptop');
  assert.equal(cleanName('x'.repeat(100)).length, NAME_MAX);
  assert.equal(cleanName('   '), '');

  // Creation reports the AAGUID, through the confirming step too.
  const cred = () => ({ ...fakeCred({ enabled: true }), response: { getAuthenticatorData: () => authData.buffer } });
  const secret = new Uint8Array(32).fill(4).buffer;
  await withFakeWebAuthn({ create: cred, get: () => fakeCred({ results: { first: secret } }) }, async () => {
    const { pending } = await createPasskey('aabbccddeeff00112233445566778899');
    assert.equal(pending.aaguid, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
    assert.equal((await completePasskey(pending)).aaguid, pending.aaguid);
  });
});

test('passkey sign-in: one fixed salt, any passkey or only the given ones', async () => {
  const salts = [];
  const secret = new Uint8Array(32).fill(3).buffer;
  await withFakeWebAuthn({ create: () => null, get: () => fakeCred({ results: { first: secret } }) }, async (calls) => {
    const got = await signInWithPasskey();
    assert.deepEqual(got.prf, new Uint8Array(secret));
    assert.equal(calls.getOptions.publicKey.allowCredentials, undefined); // the browser lets the user pick
    salts.push(calls.getOptions.publicKey.extensions.prf.eval.first);

    const id = randomBytes(16);
    await signInWithPasskey([id]);
    assert.deepEqual(calls.getOptions.publicKey.allowCredentials, [{ type: 'public-key', id }]);
    salts.push(calls.getOptions.publicKey.extensions.prf.eval.first);
  });
  // The same salt every time, so a synced passkey gives the same secret on every device.
  assert.deepEqual(salts[0], salts[1]);
  assert.deepEqual(salts[0], await sha256(new TextEncoder().encode('tiro/v1/passkey-signin')));
});
