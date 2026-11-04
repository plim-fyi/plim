// Large notes (sync.js).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { unb64 } from '../core/crypto.js';
import { DocSync } from '../core/sync.js';
import { MemoryDocCache } from '../core/vault.js';
import { test, fakeSession, text } from './lib.mjs';

const KB = 1024;
const filler = (n, tag = 'x') => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);

test('large notes: an edit too big for the server says so and stops retrying', async () => {
  const { api, mk } = await fakeSession();
  api.maxBlob = 64 * KB;
  const statuses = [];
  const a = new DocSync({ ...mk(), maxBlobBytes: 64 * KB, onStatus: (_, st) => statuses.push(st) }, 'n');
  a.ydoc.getText('body').insert(0, filler(200 * KB)); // one transaction: one record
  await a.flush();
  assert.equal(statuses.at(-1), 'too-large');
  assert.equal(a.retryTimer, undefined, 'no retry loop');
  assert.equal(await a.hasPending(), true, 'kept in the outbox');
  await a.flush(); // nothing changed: no new attempt
  assert.equal(api.posted?.length ?? 0, 0);
  a.close();
});

test('snapshots and the offline copy leave out text an undo manager keeps alive', async () => {
  const { api, mk } = await fakeSession();
  const cache = new MemoryDocCache();
  const a = new DocSync({ ...mk(), cache }, 'n');
  // An editor's undo manager keeps deleted text in the live doc so it can restore it.
  const undo = new Y.UndoManager(a.ydoc.getText('body'), { trackedOrigins: new Set([null]) });
  for (let i = 0; i < 6; i++) {
    const t = a.ydoc.getText('body');
    a.ydoc.transact(() => {
      t.delete(0, t.length);
      t.insert(0, filler(100 * KB, `v${i}`));
    });
    await a.flush();
  }
  await a.pull();
  await a.snapshot();
  await a.writeCache();
  const live = Y.encodeStateAsUpdate(a.ydoc).length;
  const snap = unb64(api.doc('n').snapshot.ciphertext).length;
  const copy = unb64((await cache.get('n')).ciphertext).length;
  assert.ok(live > 500 * KB, `the live doc keeps the deleted text for undo (${live})`);
  assert.ok(snap < 120 * KB && copy < 120 * KB, `snapshot ${snap}, offline copy ${copy}: about one version`);
  const b = new DocSync(mk(), 'n');
  await b.load();
  assert.equal(text(b.ydoc), text(a.ydoc));
  undo.destroy();
  [a, b].forEach((d) => d.close());
});

test('large notes: a note too big to snapshot is flagged, and keeps saving', async () => {
  const { api, mk } = await fakeSession();
  api.maxBlob = 64 * KB;
  const statuses = [];
  const a = new DocSync({ ...mk(), maxBlobBytes: 64 * KB, onStatus: (_, st) => statuses.push(st) }, 'n');
  for (let i = 0; i < 4; i++) a.ydoc.getText('body').insert(a.ydoc.getText('body').length, filler(25 * KB, `q${i}`));
  await a.flush();
  await a.pull();
  await a.maybeCompact();
  assert.equal(api.doc('n').snapshot, null, 'no snapshot');
  assert.ok(statuses.includes('too-large'));
  a.ydoc.getText('body').insert(0, 'still saves ');
  await a.flush();
  assert.equal(await a.hasPending(), false);
  assert.equal(statuses.at(-1), 'too-large', '"saved" keeps the warning');
  a.close();
});
