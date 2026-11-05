// End to end, against a live server (PLIM_URL).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { generateMnemonic } from '../core/bip39.js';
import { b64, randomBytes, unb64, unwrapVaultKey } from '../core/crypto.js';
import { DocSync } from '../core/sync.js';
import { MemoryOutbox } from '../core/vault.js';
import { solve } from '../core/pow-worker.js';
import { Api } from '../core/api.js';
import { credHash } from '../core/passkey.js';
import { createAccount, fetchPasskey, identityFromEntropy, identityFromMnemonic, listPasskeys, login, openPasskeyCopy, openSession, removePasskey, rotatePhrase, uploadPasskey, wrapPasskey } from '../core/account.js';
import { test } from './lib.mjs';

if (process.env.PLIM_URL) {
  const base = process.env.PLIM_URL.replace(/\/$/, '');

  test('e2e: security headers', async () => {
    for (const path of ['/', '/api/pow']) {
      const res = await fetch(base + path, path === '/' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  test('e2e: create, write, restore elsewhere, rotate phrase', async () => {
    const phrase = await generateMnemonic();
    const { identity } = await identityFromMnemonic(phrase);
    const api = new Api(base);
    const sync = async (salt, d) => solve(unb64(salt), d);
    const accountId = await createAccount(api, identity, sync);
    await assert.rejects(createAccount(api, identity, sync), (e) => e.status === 409);

    // Device 1 writes.
    const s1 = await openSession(api, identity);
    assert.equal(s1.accountId, accountId);
    const ctx1 = { api, identity, outbox: new MemoryOutbox(), ...s1 };
    const n1 = new DocSync(ctx1, 'index');
    n1.ydoc.getMap('notes').set('abc', 'first note');
    await n1.flush();
    assert.equal(await n1.hasPending(), false);

    // Device 2 restores from the phrase alone.
    const api2 = new Api(base);
    const { identity: id2 } = await identityFromMnemonic(phrase);
    const s2 = await openSession(api2, id2);
    const n2 = new DocSync({ api: api2, identity: id2, outbox: new MemoryOutbox(), ...s2 }, 'index');
    await n2.load();
    assert.equal(n2.ydoc.getMap('notes').get('abc'), 'first note');

    // Bad signature is rejected by the server.
    const bad = await n1.seal('update', Y.encodeStateAsUpdate(n1.ydoc));
    bad.sig = b64(randomBytes(64));
    await assert.rejects(api.post('/docs/index/updates', bad), (e) => e.status === 400);

    // Rotate phrase on device 1.
    const newPhrase = await generateMnemonic();
    const { identity: newId } = await identityFromMnemonic(newPhrase);
    await rotatePhrase(ctx1, newId, { prune: true });
    ctx1.identity = newId; // (as the app does, phraseChanged)

    // Old phrase can no longer log in; new phrase sees the data.
    await assert.rejects(login(new Api(base), identity), (e) => e.status === 401);
    const api3 = new Api(base);
    const s3 = await openSession(api3, newId);
    assert.equal(s3.accountId, accountId);
    assert.deepEqual([...s3.keyring.vaultKeys.keys()].sort(), [1, 2]);
    const n3 = new DocSync({ api: api3, identity: newId, outbox: new MemoryOutbox(), ...s3 }, 'index');
    await n3.load();
    assert.equal(n3.ydoc.getMap('notes').get('abc'), 'first note');
    // Pruned: only the v2 snapshot remains.
    const raw = await api3.get('/docs/index?after=0');
    assert.equal(raw.snapshot.key_version, 2);
    assert.equal(raw.updates.length, 0);

    // Device 2's session was revoked and cannot silently re-auth with the old key.
    await assert.rejects(api2.get('/account'), (e) => e.status === 401);
    [n1, n2, n3].forEach((s) => s.close());
  });

  // The new vault key is never on the server under the old phrase; a change interrupted after
  // registering it is finished with the new phrase, from the old phrase's sign-in.
  test('e2e: a phrase change interrupted leaves nothing the old phrase opens, and is finished later', async () => {
    const { identity: oldId } = await identityFromMnemonic(await generateMnemonic());
    const api = new Api(base);
    const accountId = await createAccount(api, oldId, async (salt, d) => solve(unb64(salt), d));
    const s1 = await openSession(api, oldId);
    const ctx = { api, identity: oldId, outbox: new MemoryOutbox(), ...s1 };
    const n1 = new DocSync(ctx, 'index');
    n1.ydoc.getMap('notes').set('abc', 'first note');
    await n1.flush();

    // Interrupted right after step 1 (the first progress report is the first doc's re-encryption).
    const { identity: newId } = await identityFromMnemonic(await generateMnemonic());
    const lost = () => { throw new Error('tab closed'); };
    await assert.rejects(rotatePhrase(ctx, newId, { prune: true, onProgress: lost }), (e) => e.message === 'tab closed' && e.registered === 2);

    // What the server holds for v2 opens with the new phrase, not the old.
    const { keyringEntries } = await login(new Api(base), oldId);
    const v2 = keyringEntries.find((e) => e.key_version === 2);
    await assert.rejects(unwrapVaultKey(oldId, accountId, v2));
    assert.equal((await unwrapVaultKey(newId, accountId, v2)).length, 32);

    // The old phrase signs in: v1 open, v2 locked, the note (still under v1) readable.
    const api2 = new Api(base);
    const s2 = await openSession(api2, oldId);
    assert.deepEqual([[...s2.keyring.vaultKeys.keys()], [...s2.keyring.locked.keys()]], [[1], [2]]);
    assert.deepEqual([s2.keyring.current, s2.keyring.highest], [1, 2]);
    const n2 = new DocSync({ api: api2, identity: oldId, outbox: new MemoryOutbox(), ...s2 }, 'index');
    await n2.load();
    assert.equal(n2.ydoc.getMap('notes').get('abc'), 'first note');
    // The new phrase can't sign in yet (the account's key is still the old one).
    await assert.rejects(login(new Api(base), newId), (e) => e.status === 401);

    // A wrong "new phrase" doesn't unlock; the right one does, and the change is finished from
    // where it stopped: no v3.
    const { identity: wrong } = await identityFromMnemonic(await generateMnemonic());
    await assert.rejects(s2.keyring.unlock(wrong, accountId));
    assert.equal(s2.keyring.locked.size, 1);
    await s2.keyring.unlock(newId, accountId);
    assert.deepEqual([[...s2.keyring.vaultKeys.keys()], s2.keyring.locked.size], [[1, 2], 0]);
    const ctx2 = { api: api2, identity: oldId, outbox: new MemoryOutbox(), accountId, keyring: s2.keyring };
    await rotatePhrase(ctx2, newId, { prune: true, resume: 2 });
    await assert.rejects(login(new Api(base), oldId), (e) => e.status === 401);
    const api3 = new Api(base);
    const s3 = await openSession(api3, newId);
    assert.deepEqual([[...s3.keyring.vaultKeys.keys()], s3.keyring.locked.size], [[1, 2], 0]);
    const n3 = new DocSync({ api: api3, identity: newId, outbox: new MemoryOutbox(), ...s3 }, 'index');
    await n3.load();
    assert.equal(n3.ydoc.getMap('notes').get('abc'), 'first note');
    [n1, n2, n3].forEach((s) => s.close());
  });

  test('e2e: passkey copy signs in a new device, and a phrase change removes it', async () => {
    const entropy = randomBytes(16);
    const { identity } = await identityFromEntropy(entropy);
    const api = new Api(base);
    const accountId = await createAccount(api, identity, async (salt, d) => solve(unb64(salt), d));
    const s1 = await openSession(api, identity);
    // (Saving and removing a copy are signed with the account's key, #144; a phrase change updates it.)
    const ctx = { api, identity, outbox: new MemoryOutbox(), ...s1 };

    // Device 1 saves a passkey's copy (a fake PRF secret stands in for the authenticator).
    const prf = randomBytes(32);
    const credId = randomBytes(16);
    const rec = await wrapPasskey(accountId, credId, prf, entropy);
    await uploadPasskey(ctx, rec);
    assert.equal(rec.synced, true);
    assert.deepEqual((await listPasskeys(api)).map((p) => p.cred_hash), [await credHash(credId)]);

    // Device 2 has only the passkey: fetch its copy with no session, open it, sign in.
    const api2 = new Api(base);
    assert.equal(await fetchPasskey(api2, randomBytes(16)), null);
    const copy = await fetchPasskey(api2, credId);
    const { identity: id2 } = await identityFromEntropy(await openPasskeyCopy(prf, credId, copy));
    assert.equal((await openSession(api2, id2)).accountId, accountId);

    // Changing the phrase removes every passkey copy.
    const { identity: newId } = await identityFromMnemonic(await generateMnemonic());
    await rotatePhrase(ctx, newId, { prune: true });
    ctx.identity = newId; // (as the app does, phraseChanged)
    assert.equal(await fetchPasskey(new Api(base), credId), null);
    assert.deepEqual(await listPasskeys(api), []);

    // And a copy can be removed on its own.
    const rec2 = await wrapPasskey(accountId, credId, prf, randomBytes(16));
    await uploadPasskey(ctx, rec2);
    await removePasskey(ctx, rec2.credHash);
    assert.equal(await fetchPasskey(new Api(base), credId), null);
  });

  test('e2e: login does not leak whether an account exists', async () => {
    const r = await new Api(base).post('/auth/challenge', { pubkey_hash: 'ab'.repeat(32) });
    assert.ok(r.nonce);
  });
}
