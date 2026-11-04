// The sync cases (fixtures/sync-cases.json, #441), played with the web app's engine: DocSync and
// ShareDocSync against lib.mjs's FakeServer and FakeShareServer. The terminal client plays the
// same cases with its engine against the real server (crates/plim-cli/src/sync_cases.rs).
//
// The engine's own timers (autosave, retries) are off and its background work is awaited after
// each step: the cases say what happens, not when.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from '../vendor/yjs.mjs';
import { b64, encrypt } from '../core/crypto.js';
import { ApiError } from '../core/api.js';
import { shareAad } from '../core/sig.js';
import { newShareId, newShareSeed, readKeys, sealShareBlob, shareKeys } from '../core/share.js';
import { DocSync } from '../core/sync.js';
import { ShareDocSync } from '../core/sharesync.js';
import { MemoryOutbox, MemorySeen } from '../core/vault.js';
import { FakeShareServer, fakeSession, here, test } from './lib.mjs';

const { cases } = JSON.parse(readFileSync(new URL('fixtures/sync-cases.json', here)));
const DOC = 'c0ffee'; // (hex, as the server takes)

for (const c of cases) test(`sync case: ${c.name}`, () => play(c));

/** The steps, with each { repeat, steps } spelled out ('{i}' in their text: the count). */
function expand(steps) {
  return steps.flatMap((s) => (s.repeat === undefined ? [s]
    : Array.from({ length: s.repeat }, (_, i) => expand(s.steps).map((x) => JSON.parse(JSON.stringify(x).replaceAll('{i}', i)))).flat()));
}

async function play(c) {
  const { api, keyring } = await fakeSession();
  const { accountId, identity } = api;
  const shared = c.note === 'shared';
  const share = shared ? { id: newShareId(), seed: newShareSeed() } : null;
  if (share) share.keys = await shareKeys(share.seed);
  const server = shared ? new FakeShareServer(share.id, share.keys.pubkey) : api;
  if (c.maxBlob) server.maxBlob = c.maxBlob;
  // What the engines ask the server, through here: the requests it refuses are counted (as the
  // real server's metrics count them).
  let refused = 0;
  const counting = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) refused++;
      throw e;
    }
  };
  const counted = Object.fromEntries(['get', 'post', 'request'].filter((m) => server[m]).map((m) => [m, counting(server[m].bind(server))]));
  const devices = new Map();
  const device = (name) => devices.get(name) ?? devices.set(name, { outbox: new MemoryOutbox(), seen: new MemorySeen() }).get(name);

  const ops = {
    async open(d, step) {
      d.sync?.close();
      d.reports = [];
      d.forged = 0;
      d.status = undefined;
      const ctx = {
        api: counted, accountId, identity, keyring, outbox: d.outbox, seen: d.seen, maxBlobBytes: c.clientMaxBlob ?? c.maxBlob,
        onRollback: (_, info) => d.reports.push(info),
        onStatus: (_, s) => (d.status = s),
        onForged: () => d.forged++,
      };
      const keys = step.link === 'view' ? await readKeys(share.keys.encRaw, share.keys.pubkey) : share?.keys;
      d.sync = shared ? new ShareDocSync(ctx, { id: share.id, keys }, new Y.Doc()) : new DocSync(ctx, DOC);
      tame(d.sync);
      // (What load does, without the autosave it schedules: this device's copy and outbox, then the server's.)
      await d.sync.loadLocal();
      await d.sync.pull();
    },
    type: (d, s) => {
      const t = d.sync.ydoc.getText('body');
      t.insert(s.at === undefined || s.at === 'end' ? t.length : s.at, s.text.repeat(s.times ?? 1));
    },
    replace: (d, s) => {
      const t = d.sync.ydoc.getText('body');
      d.sync.ydoc.transact(() => {
        t.delete(0, t.length);
        t.insert(0, s.text.repeat(s.times ?? 1));
      });
    },
    flush: (d) => d.sync.flush(),
    pull: (d) => d.sync.pull(),
    compact: (d) => d.sync.maybeCompact(),
    snapshot: (d) => d.sync.snapshot(),
    acknowledge: (d) => d.sync.acceptServerState(),
  };

  const serverOps = {
    async share(s) {
      await server.post(`/shares/${share.id}/updates`, await sealShareBlob(share.keys, share.id, 'update', textState(s.text)));
    },
    'drop-update': (s) => {
      const h = history();
      h.updates = h.updates.filter((u) => u.seq !== s.seq);
    },
    'drop-updates': () => (history().updates = []),
    close: () => api.close(DOC),
    'turn-off-links': () => server.turnOff(),
    async 'forge-update'(s) {
      // Encrypted with the share's key (anyone with a view link has it), not signed with its signing key.
      const { nonce, ciphertext } = await encrypt(share.keys.encKey, textState(s.text), shareAad(share.id, 'update'));
      const h = history();
      h.updates.push({ seq: Math.max(h.updates.at(-1)?.seq ?? 0, h.snapshot?.covers_seq ?? 0) + 1, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: b64(new Uint8Array(64)) });
    },
  };
  /** Where the note's history is kept on the server: { updates, snapshot }. */
  const history = () => (shared ? server : api.doc(DOC));

  const steps = expand(c.steps);
  for (const [n, step] of steps.entries()) {
    const where = `step ${n + 1} (${JSON.stringify(step).slice(0, 120)})`;
    if (step.expect) {
      await check(step.expect, where);
      continue;
    }
    let refused = null;
    try {
      if (step.server) await serverOps[step.server](step);
      else {
        const d = device(step.on);
        if (!ops[step.do]) throw new Error(`no such step: ${step.do}`);
        if (step.do !== 'open' && !d.sync) throw new Error(`${step.on} hasn't opened the note`);
        await ops[step.do](d, step);
        await settle(d.sync);
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw new Error(`${where}: ${e.stack ?? e}`);
      refused = e.status;
    }
    if (step.refused !== undefined && refused !== step.refused) throw new Error(`${where}: should be refused with ${step.refused}, was ${refused ?? 'not refused'}`);
    if (refused !== null && refused !== step.refused && !(step.tolerate ?? []).includes(refused)) throw new Error(`${where}: refused with ${refused}`);
  }
  for (const d of devices.values()) d.sync?.close();

  async function check(expect, where) {
    for (const [who, want] of Object.entries(expect)) {
      const got = who === 'server' ? serverState() : await deviceState(devices.get(who));
      for (const [k, v] of Object.entries(want)) {
        const value = v?.sameAs ? (await deviceState(devices.get(v.sameAs)))[k] : v;
        matches(got[k], value, `${where}: ${who}.${k}`);
      }
    }
  }
  function serverState() {
    const h = history();
    return { updates: h.updates.length, snapshot: h.snapshot?.covers_seq ?? null, refused };
  }
}

async function deviceState(d) {
  const s = d.sync;
  return {
    text: s.ydoc.getText('body').toString(),
    pending: (await d.outbox.list(s.docId)).length,
    rollbacks: d.reports.map((r) => ({ missing: r.missing.length, incomplete: r.incomplete })),
    forged: d.forged,
    status: d.status,
    gone: Boolean(s.gone),
    writable: s.writable,
    lastSeq: s.lastSeq,
    snapshotSeq: s.snapshotSeq,
  };
}

function matches(got, want, what) {
  if (want && typeof want === 'object' && 'atLeast' in want) {
    assert.ok(got >= want.atLeast, `${what}: expected at least ${want.atLeast}, got ${got}`);
    return;
  }
  const short = (x) => (typeof x === 'string' && x.length > 80 ? `${JSON.stringify(x.slice(0, 80))}… (${x.length} chars)` : JSON.stringify(x));
  try {
    assert.deepEqual(got, want);
  } catch {
    throw new assert.AssertionError({ message: `${what}: expected ${short(want)}, got ${short(got)}` });
  }
}

/** The engine's timers off, and its background work kept where settle can wait for it. */
function tame(sync) {
  sync.schedule = () => {};
  const compact = sync.maybeCompact.bind(sync);
  sync.maybeCompact = () => (sync.compacting = compact());
}

/** Everything a step set going, done (twice: one piece of work can start another). */
async function settle(sync) {
  for (let i = 0; i < 2; i++) {
    for (const p of [sync.enqueued, sync.flushing, sync.compacting, sync.versioning, sync.persisting, sync.receiving]) await p?.catch?.(() => {});
  }
}

function textState(text) {
  const doc = new Y.Doc();
  doc.getText('body').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}
