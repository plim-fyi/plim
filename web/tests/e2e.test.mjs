// End to end, against a live server (PLIM_URL).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { generateMnemonic } from '../core/bip39.js';
import { b64, randomBytes, unb64 } from '../core/crypto.js';
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
