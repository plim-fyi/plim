// Offline: the copy on this device, signing in without the server, the API (vault.js, account.js, api.js).
import assert from 'node:assert/strict';
import { b64, bytesToHex, deriveIdentity, randomBytes, wrapVaultKey } from '../core/crypto.js';
import { DocSync } from '../core/sync.js';
import { MemoryDocCache, MemorySessionStore } from '../core/vault.js';
import { Api, ApiError, isOffline } from '../core/api.js';
import { NeedsConnectionError, openSession, refreshSession } from '../core/account.js';
import { test, fakeSession, text } from './lib.mjs';

/** The same API, but the server can't be reached (as fetch reports it). */
const unreachable = () => ({
  get: async () => { throw new TypeError('Failed to fetch'); },
  post: async () => { throw new TypeError('Failed to fetch'); },
});

test('offline copy: a note opens from this device when the server is unreachable', async () => {
  const { mk } = await fakeSession();
  const cache = new MemoryDocCache();
  const online = new DocSync({ ...mk(), cache }, 'n');
  await online.load();
  online.ydoc.getText('body').insert(0, 'written online');
  await online.flush();
  online.close();
  await online.cacheWriting;
  const rec = await cache.get('n');
  assert.ok(rec && !JSON.stringify(rec).includes('written'), 'the copy is encrypted');

  const statuses = [];
  const offline = new DocSync({ ...mk(), api: unreachable(), cache, onStatus: (_, st) => statuses.push(st) }, 'n');
  await offline.load();
  assert.equal(text(offline.ydoc), 'written online');
  assert.ok(statuses.includes('offline'));
  // Edits made offline wait in the outbox as usual.
  offline.ydoc.getText('body').insert(0, 'and offline: ');
  await offline.enqueued;
  assert.equal(await offline.hasPending(), true);
  offline.close();
});

test('offline copy: bound to its note, and pulls keep it current', async () => {
  const { mk } = await fakeSession();
  const cache = new MemoryDocCache();
  const writer = new DocSync(mk(), 'a');
  writer.ydoc.getText('body').insert(0, 'v1');
  await writer.flush();

  const reader = new DocSync({ ...mk(), cache }, 'a');
  await reader.load();
  await reader.writeCache();
  writer.ydoc.getText('body').insert(2, ' v2');
  await writer.flush();
  await reader.pull(); // new data: the copy is refreshed
  await reader.writeCache();
  const fromCopy = new DocSync({ ...mk(), api: unreachable(), cache }, 'a');
  await fromCopy.load();
  assert.equal(text(fromCopy.ydoc), 'v1 v2');

  // A copy moved to another note doesn't open there (the note ID is in the AAD).
  await cache.put('b', await cache.get('a'));
  const other = new DocSync({ ...mk(), api: unreachable(), cache }, 'b');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await other.load();
  } finally {
    console.warn = warn;
  }
  assert.equal(text(other.ydoc), '');
  [writer, reader, fromCopy, other].forEach((d) => d.close());
});

test('loadLocal shows what the device has with no server call; loadRemote merges the rest', async () => {
  const { mk } = await fakeSession();
  const cache = new MemoryDocCache();
  const writer = new DocSync({ ...mk(), cache }, 'n');
  writer.ydoc.getText('body').insert(0, 'cached text');
  await writer.flush();
  writer.close();
  await writer.cacheWriting;

  // The server gets a newer edit from elsewhere.
  const other = new DocSync(mk(), 'n');
  await other.load();
  other.ydoc.getText('body').insert(other.ydoc.getText('body').length, ' + newer');
  await other.flush();

  const calls = [];
  const ctx = { ...mk(), cache };
  const realGet = ctx.api.get.bind(ctx.api);
  ctx.api = Object.assign(Object.create(Object.getPrototypeOf(ctx.api)), ctx.api, { get: async (p) => (calls.push(p), realGet(p)) });
  const d = new DocSync(ctx, 'n');
  assert.equal(await d.loadLocal(), true);
  assert.equal(text(d.ydoc), 'cached text');
  assert.equal(calls.length, 0, 'no server request');
  await d.loadRemote();
  assert.equal(text(d.ydoc), 'cached text + newer');
  assert.equal(calls.length, 1);

  // Nothing on this device: loadLocal says so.
  const fresh = new DocSync({ ...mk(), cache: new MemoryDocCache() }, 'n');
  assert.equal(await fresh.loadLocal(), false);
  // Unsent edits alone count as something to show.
  const ctx2 = { ...mk(), cache: new MemoryDocCache() };
  const typed = new DocSync(ctx2, 'm');
  typed.ydoc.getText('body').insert(0, 'not uploaded yet');
  await typed.enqueued;
  typed.close();
  const again = new DocSync({ ...ctx2, api: unreachable() }, 'm');
  assert.equal(await again.loadLocal(), true);
  assert.equal(text(again.ydoc), 'not uploaded yet');
  await again.loadRemote(); // offline: no throw, keeps the edit queued
  assert.equal(await again.hasPending(), true);
  [other, d, fresh, again].forEach((x) => x.close());
});

/** Answers the two sign-in requests like the server (signature not checked). */
async function fakeAuth(identity, accountId, versions = [1]) {
  const keys = new Map(versions.map((v) => [v, randomBytes(32)]));
  const entries = [];
  for (const [v, k] of keys) entries.push(await wrapVaultKey(identity, accountId, v, k));
  return {
    keys,
    entries,
    api: Object.assign(new Api(), {
      post: async (path) => {
        if (path === '/auth/challenge') return { nonce: b64(randomBytes(32)) };
        if (path === '/auth/verify') return { token: 't', account_id: accountId, keyring: entries };
        throw new Error(path);
      },
    }),
  };
}

test('offline unlock: opens from the saved sign-in with the same phrase only', async () => {
  const identity = await deriveIdentity(randomBytes(64));
  const accountId = bytesToHex(randomBytes(16));
  const store = new MemorySessionStore();
  const { api, keys } = await fakeAuth(identity, accountId);
  const online = await openSession(api, identity, { store });
  assert.equal(online.offline, false);
  assert.ok(await store.load(identity.pubkeyHash), 'the sign-in is saved');

  const down = Object.assign(new Api(), unreachable());
  const off = await openSession(down, identity, { store });
  assert.equal(off.offline, true);
  assert.equal(off.accountId, accountId);
  assert.deepEqual(off.keyring.vaultKeys.get(1), keys.get(1));
  assert.equal(typeof down.reauth, 'function', 'signs in once the server answers');

  // Another phrase has nothing saved here.
  const stranger = await deriveIdentity(randomBytes(64));
  await assert.rejects(openSession(down, stranger, { store }), NeedsConnectionError);
  // A saved record under the wrong key doesn't unwrap.
  await store.save(stranger.pubkeyHash, await store.load(identity.pubkeyHash));
  await assert.rejects(openSession(down, stranger, { store }));
  // Without a store, or for a real refusal, the error passes through.
  await assert.rejects(openSession(down, identity), TypeError);
  const refused = Object.assign(new Api(), { post: async () => { throw new ApiError(401, 'no'); } });
  await assert.rejects(openSession(refused, identity, { store }), (e) => e.status === 401);
});

test('offline unlock: back online, new vault key versions are added', async () => {
  const identity = await deriveIdentity(randomBytes(64));
  const accountId = bytesToHex(randomBytes(16));
  const store = new MemorySessionStore();
  const v1 = await fakeAuth(identity, accountId, [1]);
  await openSession(v1.api, identity, { store });
  const { keyring } = await openSession(Object.assign(new Api(), unreachable()), identity, { store });
  const v2 = await fakeAuth(identity, accountId, [1, 2]);
  v2.entries[0] = v1.entries[0]; // same v1 key as before
  await refreshSession(v2.api, identity, keyring, store);
  assert.deepEqual([...keyring.vaultKeys.keys()].sort(), [1, 2]);
  assert.deepEqual(keyring.vaultKeys.get(2), v2.keys.get(2));
  assert.equal((await store.load(identity.pubkeyHash)).keyringEntries.length, 2);
});

test('isOffline: network errors, timeouts and proxy errors; not real refusals', () => {
  assert.ok(isOffline(new TypeError('Failed to fetch')));
  assert.ok(isOffline(Object.assign(new Error('t'), { name: 'TimeoutError' })));
  for (const status of [502, 503, 504, 520, 522, 530]) assert.ok(isOffline(new ApiError(status, '')), String(status));
  for (const status of [400, 401, 404, 409, 500, 507]) assert.ok(!isOffline(new ApiError(status, '')), String(status));
  assert.ok(!isOffline(new Error('x')));
});

test('api: a 401 signs in again and retries once, never for sign-in requests', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let authed = false;
  globalThis.fetch = async (url) => {
    const path = new URL(url, 'http://x').pathname;
    calls.push(path);
    const ok = authed || path.startsWith('/api/auth/');
    return new Response(JSON.stringify(ok ? { fine: true } : { error: 'unauthorized' }), { status: ok ? 200 : 401 });
  };
  try {
    const api = new Api('http://x');
    await assert.rejects(api.get('/docs'), (e) => e.status === 401); // no reauth hook: plain 401
    api.reauth = async () => {
      authed = true;
    };
    assert.deepEqual(await api.get('/docs'), { fine: true }); // no token yet (opened offline): still signs in
    authed = false;
    let reauths = 0;
    api.reauth = async () => void reauths++;
    await assert.rejects(api.get('/docs'), (e) => e.status === 401);
    assert.equal(reauths, 1, 'retried once');
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(api.post('/auth/verify', {}), (e) => e.status === 401);
    assert.equal(reauths, 1, 'sign-in requests never trigger a sign-in');
  } finally {
    globalThis.fetch = realFetch;
  }
});
