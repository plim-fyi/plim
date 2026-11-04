// Live pushes and polling (live.js).
import assert from 'node:assert/strict';
import { DocSync } from '../core/sync.js';
import { MemorySeen } from '../core/vault.js';
import { Live } from '../core/live.js';
import { test, fakeSession, text } from './lib.mjs';

test('live: polls while its socket is down, backing off; not while it is up; wake polls now (#261)', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The page's globals, enough for live.js: a tab that's shown, and a socket that never connects.
  const saved = { document: globalThis.document, WebSocket: globalThis.WebSocket, location: globalThis.location };
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { href: 'http://localhost/', protocol: 'http:' };
  globalThis.WebSocket = class {
    constructor() { setTimeout(() => this.onclose?.({ code: 1006 }), 0); }
    close() {}
  };
  const polls = [];
  let answer = false;
  const live = new Live({ token: 't' }, { onPoll: async () => { polls.push(Date.now()); return answer; }, intervals: { min: 20, max: 80, safety: 2000 } });
  try {
    const t0 = Date.now();
    live.start();
    // Down: polls at min, then backing off (20, +40, +80, +80…: 2 or 3 in the first 150 ms).
    await sleep(150);
    assert.ok(polls.length >= 2 && polls.length <= 3, `${polls.length} polls while down: ${polls.map((t) => t - t0)}`);
    // Something comes: back to every min.
    answer = true;
    live.wake({ now: true });
    const before = polls.length;
    await sleep(110);
    assert.ok(polls.length - before >= 4, `${polls.length - before} polls once changes come`);
    // Up (the server said ready): one poll now, to catch up, then only the safety poll, far off.
    answer = false;
    const before2 = polls.length;
    live.receive({ type: 'ready' });
    await sleep(10);
    assert.equal(polls.length, before2 + 1, 'one poll as the socket comes up');
    const up = polls.length;
    await sleep(200);
    assert.equal(polls.length, up, 'no polling while the socket is up');
    assert.equal(live.connected, true);
    // Shown again, or back online: a poll now, even while up.
    live.wake({ now: true });
    await sleep(10);
    assert.equal(polls.length, up + 1);
    // Down again: polling takes over, soon.
    const ws = {};
    live.ws = ws;
    await live.closed(ws, 1006);
    const down = polls.length;
    await sleep(60);
    assert.ok(polls.length > down, 'polling resumed after the socket closed');
    // A hidden tab doesn't poll.
    globalThis.document.hidden = true;
    const hidden = polls.length;
    await sleep(100);
    assert.equal(polls.length, hidden);
    live.stop();
    globalThis.document.hidden = false;
    await sleep(60);
    assert.equal(polls.length, hidden, 'nothing after stop');
  } finally {
    live.stop();
    Object.assign(globalThis, saved);
  }
});

test('live pushes: held until they are next, applied in order, no false rollback', async () => {
  const { api, mk } = await fakeSession();
  const a = new DocSync(mk(), 'n');
  for (const word of ['one ', 'two ', 'three ']) {
    a.ydoc.getText('body').insert(a.ydoc.getText('body').length, word);
    await a.flush();
  }
  const pushed = api.doc('n').updates.map((u) => ({ type: 'update', doc: 'n', ...u }));
  assert.deepEqual(pushed.map((u) => u.seq), [1, 2, 3]);

  const reports = [];
  const b = new DocSync(mk(new MemorySeen(), reports), 'n');
  await b.push(pushed[2]); // 3 before 1 and 2: held
  await b.push(pushed[1]);
  assert.equal(text(b.ydoc), '');
  assert.equal(b.lastSeq, 0);
  await b.push(pushed[0]); // the gap fills: 1, 2, 3 applied in order
  assert.equal(text(b.ydoc), 'one two three ');
  assert.equal(b.lastSeq, 3);
  await b.push(pushed[1]); // a repeat is ignored
  assert.equal(text(b.ydoc), 'one two three ');
  assert.deepEqual(reports, [], 'out-of-order arrival is not a rollback');
  [a, b].forEach((s) => s.close());
});

test('live pushes: a gap that never fills is fetched with a pull', async () => {
  const { api, mk } = await fakeSession();
  const a = new DocSync(mk(), 'n');
  for (const word of ['a', 'b', 'c']) {
    a.ydoc.getText('body').insert(a.ydoc.getText('body').length, word);
    await a.flush();
  }
  const third = { type: 'update', doc: 'n', ...api.doc('n').updates[2] };
  const b = new DocSync(mk(), 'n');
  await b.push(third); // 1 and 2 never get pushed (e.g. lost while reconnecting)
  assert.equal(text(b.ydoc), '');
  await new Promise((r) => setTimeout(r, 1700));
  await b.receiving;
  assert.equal(text(b.ydoc), 'abc');
  assert.equal(b.lastSeq, 3);

  // A pushed snapshot jumps ahead and drops held updates it covers.
  await a.snapshot();
  const snap = { type: 'snapshot', doc: 'n', ...api.doc('n').snapshot };
  const c = new DocSync(mk(), 'n');
  await c.push(snap);
  assert.equal(text(c.ydoc), 'abc');
  assert.equal(c.lastSeq, snap.covers_seq);
  [a, b, c].forEach((s) => s.close());
});
