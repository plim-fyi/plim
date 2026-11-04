// Encrypted sync against an in-memory server (sync.js, vault.js).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { b64 } from '../core/crypto.js';
import { DocSync } from '../core/sync.js';
import { MemoryOutbox } from '../core/vault.js';
import { test, fakeSession, text } from './lib.mjs';

test('two devices converge through encrypted updates in any order', async () => {
  const { api, mk } = await fakeSession();
  const a = new DocSync(mk(), 'note-1');
  const b = new DocSync(mk(), 'note-1');
  a.ydoc.getText('body').insert(0, 'Hello from A. ');
  await a.flush();
  await b.load();
  b.ydoc.getText('body').insert(0, 'B first! ');
  a.ydoc.getText('body').insert(text(a.ydoc).length, 'A again.');
  await Promise.all([a.flush(), b.flush()]);
  await a.pull();
  await b.pull();
  assert.equal(text(a.ydoc), text(b.ydoc));
  assert.match(text(a.ydoc), /B first!/);
  assert.match(text(a.ydoc), /A again\./);

  // Replaying the stored ciphertexts in reverse yields the same document.
  const fresh = new DocSync(mk(), 'note-1');
  const d = api.doc('note-1');
  for (const u of [...d.updates].reverse()) Y.applyUpdate(fresh.ydoc, await fresh.open('update', u));
  assert.equal(text(fresh.ydoc), text(a.ydoc));

  // The server stored no plaintext.
  const blob = JSON.stringify([...api.docs.values()]);
  assert.ok(!blob.includes('Hello') && !blob.includes(b64(new TextEncoder().encode('Hello'))));
  [a, b, fresh].forEach((s) => s.close());
});

test('outbox records are encrypted but not signed, and still load', async () => {
  const { mk } = await fakeSession();
  const ctx = mk();
  const a = new DocSync(ctx, 'n');
  a.ydoc.getText('body').insert(0, 'not uploaded yet');
  await a.enqueued;
  a.close();
  const [{ record }] = await ctx.outbox.list('n');
  assert.equal(record.sig, undefined);
  const b = new DocSync(ctx, 'n');
  await b.loadLocal();
  assert.equal(text(b.ydoc), 'not uploaded yet');
  b.close();
});

test('snapshot plus remaining updates equals full history', async () => {
  const { mk } = await fakeSession();
  const a = new DocSync(mk(), 'n');
  for (let i = 0; i < 5; i++) {
    a.ydoc.getText('body').insert(0, `line ${i}\n`);
    await a.flush();
  }
  await a.pull();
  await a.snapshot();
  a.ydoc.getText('body').insert(0, 'after snapshot\n');
  await a.flush();
  const b = new DocSync(mk(), 'n');
  await b.load();
  assert.equal(text(b.ydoc), text(a.ydoc));
  assert.equal(b.snapshotSeq, 5);
  [a, b].forEach((s) => s.close());
});

/** A minimal navigator.locks: one holder per name, others queue; ifAvailable gets null when held. */
function fakeLocks() {
  const held = new Map();
  return {
    request(name, opts, fn) {
      if (opts.ifAvailable && held.has(name)) return Promise.resolve(fn(null));
      const run = (held.get(name) ?? Promise.resolve()).then(() => fn({ name }));
      const tail = run.catch(() => {});
      held.set(name, tail);
      tail.then(() => held.get(name) === tail && held.delete(name));
      return run;
    },
  };
}

async function withNavigator(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
  try {
    return await fn();
  } finally {
    saved ? Object.defineProperty(globalThis, 'navigator', saved) : delete globalThis.navigator;
  }
}

test('tabs sharing an outbox upload each edit once (Web Locks)', async () => {
  const { api, mk } = await fakeSession();
  // Two tabs: their own DocSync for the same note, one outbox (IndexedDB is shared).
  const uploads = async () => {
    const outbox = new MemoryOutbox();
    const a = new DocSync({ ...mk(), outbox }, 'n');
    const b = new DocSync({ ...mk(), outbox }, 'n');
    a.ydoc.getText('body').insert(0, 'hello');
    await a.enqueued;
    api.posted = [];
    await Promise.all([a.flush(), b.flush()]);
    [a, b].forEach((s) => s.close());
    return api.posted.filter((p) => p.kind === 'updates').length;
  };
  assert.equal(await withNavigator({}, uploads), 2, 'without locks both tabs post it (the bug)');
  assert.equal(await withNavigator({ locks: fakeLocks() }, uploads), 1);

  // Closing a tab (keepalive) doesn't wait for another tab's upload: it leaves the edits to it.
  await withNavigator({ locks: fakeLocks() }, async () => {
    const { mk: mk2, api: api2 } = await fakeSession();
    const ctx = mk2();
    const s = new DocSync(ctx, 'n');
    s.ydoc.getText('body').insert(0, 'x');
    await s.enqueued;
    let release;
    navigator.locks.request(`tiro-flush:${ctx.accountId}:n`, {}, () => new Promise((r) => (release = r)));
    api2.posted = [];
    await s.flush({ keepalive: true });
    assert.equal(api2.posted.length, 0);
    assert.equal(await s.hasPending(), true);
    release();
    s.close();
  });
});
