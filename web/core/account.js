// Account lifecycle: create (with proof-of-work), login, recovery-phrase rotation.
import * as Y from '../vendor/yjs.mjs';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed } from './bip39.js';
import { b64, bytesToHex, deriveIdentity, randomBytes, sign, unb64, unwrapVaultKey, wrapVaultKey } from './crypto.js';
import { ApiError, isOffline } from './api.js';
import { PasskeyError, credHash, unwrapWithPrf, wrapWithPrf } from './passkey.js';
import { Keyring } from './keyring.js';
import { DocSync } from './sync.js';
import { resealVersions } from './history.js';
import { ACTION, TAG, authMsg, deleteAccountMsg, rotateMsg } from './sig.js';
import { signedRequest } from './signed.js';

/** Default PoW solver: a module Web Worker. Tests inject a synchronous one. */
export function workerSolver(salt, difficulty) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./pow-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => (w.terminate(), e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.nonce));
    w.onerror = (e) => (w.terminate(), reject(e));
    w.postMessage({ salt: unb64(salt), difficulty });
  });
}

/** The phrase's entropy (what a passkey keeps), its seed, and the identity derived from it. */
export async function identityFromMnemonic(mnemonic) {
  const seed = await mnemonicToSeed(mnemonic);
  return { entropy: await mnemonicToEntropy(mnemonic), seed, identity: await deriveIdentity(seed) };
}

export async function identityFromEntropy(entropy) {
  return identityFromMnemonic(await entropyToMnemonic(entropy));
}

export const newAccountId = () => bytesToHex(randomBytes(16));

/** Register a brand-new account for this identity. Returns the account id. */
export async function createAccount(api, identity, solve = workerSolver, accountId = newAccountId()) {
  const vaultKey = randomBytes(32);
  const keyringEntry = await wrapVaultKey(identity, accountId, 1, vaultKey);
  vaultKey.fill(0);
  const { salt, difficulty } = await api.post('/pow', {});
  const powNonce = await solve(salt, difficulty);
  await api.post(
    '/accounts',
    {
      account_id: accountId,
      pubkey: b64(identity.pubkey),
      keyring_entry: keyringEntry,
      pow_salt: salt,
      pow_nonce: powNonce,
    },
    { retry: false },
  );
  return accountId;
}

/**
 * Challenge/response login. Returns { accountId, keyring } and installs a
 * re-auth hook so expired sessions renew transparently.
 */
export async function login(api, identity) {
  const { nonce } = await api.post('/auth/challenge', { pubkey_hash: identity.pubkeyHash });
  const sig = await sign(identity.signKey, authMsg(unb64(nonce), identity.pubkeyHash));
  api.token = null;
  const r = await api.post('/auth/verify', { pubkey_hash: identity.pubkeyHash, nonce, sig: b64(sig) });
  api.token = r.token;
  api.reauth = async () => {
    api.token = null;
    await login(api, identity);
  };
  return { accountId: r.account_id, keyringEntries: r.keyring };
}

/**
 * Delete the account and everything of it on the server (#51): notes, history,
 * keys, passkey copies, sessions, and the notes it shared. Its key signs a
 * fresh challenge: a session alone can't do it.
 */
export async function deleteAccount(api, identity, accountId) {
  const { nonce } = await api.post('/auth/challenge', { pubkey_hash: identity.pubkeyHash });
  const sig = await sign(identity.signKey, deleteAccountMsg(accountId, unb64(nonce)));
  await api.post('/account/delete', { nonce, sig: b64(sig) });
}

/** Thrown when the vault must be opened offline but this device has never signed in with this phrase. */
export class NeedsConnectionError extends Error {
  constructor() {
    super('You’re offline. Signing in on this device for the first time needs a connection.');
  }
}

/**
 * Sign in and unwrap the keyring. With `store` (see vault.js sessionStore),
 * what the server returned is saved, and when the server can't be reached
 * the vault opens from that instead: { accountId, keyring, offline: true }.
 * The saved keyring is wrapped with the key from the 12 words, so only the
 * same seed opens it. Offline, a 401 later signs in automatically (api.reauth).
 */
export async function openSession(api, identity, { store } = {}) {
  let accountId, keyringEntries;
  let offline = false;
  try {
    ({ accountId, keyringEntries } = await login(api, identity));
    await store?.save(identity.pubkeyHash, { accountId, keyringEntries });
  } catch (e) {
    if (!isOffline(e) || !store) throw e;
    const saved = await store.load(identity.pubkeyHash);
    if (!saved) throw new NeedsConnectionError();
    ({ accountId, keyringEntries } = saved);
    offline = true;
    api.token = null;
    api.reauth = () => login(api, identity);
  }
  const keyring = await Keyring.fromEntries(identity, accountId, keyringEntries);
  return { accountId, keyring, offline };
}

/**
 * Back online after opening offline: sign in, save the fresh keyring, and add
 * any vault key versions created meanwhile (e.g. a phrase change elsewhere —
 * though then the old phrase gets a 401 here instead).
 */
export async function refreshSession(api, identity, keyring, store) {
  const { accountId, keyringEntries } = await login(api, identity);
  await store?.save(identity.pubkeyHash, { accountId, keyringEntries });
  for (const e of keyringEntries) {
    if (!keyring.vaultKeys.has(e.key_version)) keyring.add(e.key_version, await unwrapVaultKey(identity, accountId, e));
  }
  return { accountId };
}

/**
 * Detect the server serving an older keyring than this device has seen
 * (e.g. hiding a newer vault key). Returns null if fine, else
 * { expected, got }. Raises the remembered version otherwise.
 */
export async function checkKeyring(seen, keyring) {
  const expected = await seen.getKeyVersion();
  const got = keyring.current;
  if (got < expected) return { expected, got };
  if (got > expected) await seen.setKeyVersion(got);
  return null;
}

/**
 * Change the recovery phrase. `ctx` is the live session context
 * ({ api, accountId, identity, keyring, outbox }); all outboxes must be empty.
 *
 * 1. new vault key v+1, registered under the *old* key
 * 2. every doc re-snapshotted under v+1
 * 3. whole keyring re-wrapped under the new phrase's KEK
 * 4. server swaps the public key (old key authorizes, new key proves possession)
 */
export async function rotatePhrase(ctx, newIdentity, { prune = true, onProgress = () => {} } = {}) {
  const { api, accountId, identity: oldIdentity, keyring } = ctx;
  if ((await ctx.outbox.docs()).length) throw new Error('Unsaved changes are still uploading — try again shortly.');

  const version = keyring.current + 1;
  const vaultKey = randomBytes(32);
  await api.post('/keyring', await wrapVaultKey(oldIdentity, accountId, version, vaultKey));
  keyring.add(version, vaultKey);
  await ctx.seen?.setKeyVersion(version);

  const { docs } = await api.get('/docs');
  for (const [i, docId] of docs.entries()) {
    onProgress(`Re-encrypting ${i + 1} of ${docs.length}…`);
    const s = new DocSync(ctx, docId, new Y.Doc());
    await s.pull();
    await s.snapshot();
    if (docId !== 'index') await resealVersions(s); // its history too (the prune below drops anything left under old keys)
    s.close();
  }

  onProgress('Switching keys…');
  const entries = [];
  for (const [v, key] of keyring.vaultKeys) entries.push(await wrapVaultKey(newIdentity, accountId, v, key));
  await api.post('/account/rotate', {
    new_pubkey: b64(newIdentity.pubkey),
    keyring: entries,
    old_sig: b64(await sign(oldIdentity.signKey, rotateMsg(TAG.rotateOld, accountId, newIdentity.pubkey))),
    new_sig: b64(await sign(newIdentity.signKey, rotateMsg(TAG.rotateNew, accountId, newIdentity.pubkey))),
    prune,
  });

  // Old sessions are gone: signed in again as the new identity. (The caller puts it in its
  // session's ctx: the app does, app.js phraseChanged, #446.)
  await login(api, newIdentity);
}

// ---- passkey sign-in ----

/**
 * Wrap the recovery entropy with a passkey's PRF secret. Returns the record a
 * device caches for offline unlock (see vault.js passkeyCache) and uploads
 * with uploadPasskey; `synced` says whether the server has it yet.
 */
export async function wrapPasskey(accountId, credentialId, prf, entropy) {
  const { nonce, ciphertext } = await wrapWithPrf(prf, credentialId, entropy);
  return {
    accountId, credentialId: b64(credentialId), credHash: await credHash(credentialId),
    nonce: b64(nonce), ciphertext: b64(ciphertext), synced: false,
  };
}

/** A passkey's copy saved on the server, signed over the copy itself (#144). */
export async function uploadPasskey(ctx, rec) {
  const copy = new Uint8Array([...unb64(rec.nonce), ...unb64(rec.ciphertext)]);
  await signedRequest(ctx, 'POST', '/passkeys', ACTION.putPasskey, rec.credHash, {
    body: { cred_hash: rec.credHash, nonce: rec.nonce, ciphertext: rec.ciphertext },
    data: copy,
  });
  rec.synced = true;
}

/** The server's copy for this passkey, or null if it has none. No session needed. */
export async function fetchPasskey(api, credentialId) {
  try {
    return await api.get(`/passkey-signin/${await credHash(credentialId)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** The recovery entropy, or throws if this secret and passkey don't open the copy. */
export async function openPasskeyCopy(prf, credentialId, copy) {
  try {
    return await unwrapWithPrf(prf, credentialId, unb64(copy.nonce), unb64(copy.ciphertext));
  } catch {
    throw new PasskeyError('That passkey doesn’t match the copy saved for it.');
  }
}

export const listPasskeys = async (api) => (await api.get('/passkeys')).passkeys;
export const removePasskey = (ctx, hash) => signedRequest(ctx, 'DELETE', `/passkeys/${hash}`, ACTION.deletePasskey, hash);
