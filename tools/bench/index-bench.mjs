// How the note index scales (#262): a Yjs doc shaped like the app's (one `notes` map of
// Y.Maps: title, created, updated, deleted…) at a given size, and what its load and save
// cost. Runs in Node (run.mjs) and in a browser (index.html, for Safari on an iPhone).
import * as Y from '../../web/vendor/yjs.mjs';
import { aesKey, decrypt, encrypt, randomBytes } from '../../web/core/crypto.js';

const WORDS = 'trip notes packing list ideas for the garden meeting with the team recipe lemon cake books to read birthday plans budget october'.split(' ');

/** A deterministic index of `n` notes, each with `edits` later changes to `updated` (what every save does). */
export function build(n, edits = 0, seed = 1) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const doc = new Y.Doc();
  const notes = doc.getMap('notes');
  const t0 = 1_700_000_000_000;
  const ids = [];
  doc.transact(() => {
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      const title = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
      const created = t0 + Math.floor(rnd() * 3e10);
      const m = new Y.Map([['title', title], ['created', created], ['updated', created], ['deleted', false]]);
      notes.set(id, m);
      const r = rnd();
      if (r < 0.1) m.set('format', 'plain');
      if (r > 0.95) m.set('share', { id: crypto.randomUUID().replace(/-/g, '').slice(0, 22), seed: 'c2VlZHNlZWRzZWVkc2VlZHNlZWRzZWVkc2VlZA' });
      if (r > 0.85 && r < 0.95) m.set('deleted', true), m.set('deletedAt', created + 1e6);
      if (r > 0.8 && r < 0.85) m.set('deleted', true), m.set('purged', true), m.set('purgedAt', created + 2e6);
    }
  });
  // Later saves: one note at a time (each its own transaction and update, as in the app).
  for (let e = 0; e < edits; e++) {
    for (const id of ids) notes.get(id).set('updated', t0 + 3e10 + e * 1e6 + Math.floor(rnd() * 1e5));
  }
  return { doc, ids };
}

const now = () => (globalThis.performance ?? Date).now();
const ms = (t) => Math.round(t * 10) / 10;

/** Size and times for an index of `n` notes with `edits` saves each. */
export async function measure(n, edits = 0) {
  const key = await aesKey(randomBytes(32));
  const aad = new TextEncoder().encode('bench');
  let t = now();
  const { doc, ids } = build(n, edits);
  const buildMs = now() - t;

  // Save (a snapshot, or this device's offline copy): the whole state, encrypted.
  t = now();
  const state = Y.encodeStateAsUpdate(doc);
  const encodeMs = now() - t;
  t = now();
  const sealed = await encrypt(key, state, aad);
  const encryptMs = now() - t;

  // One save's upload: the update one transaction emits for a note's title and time (what
  // the outbox stores and the server gets; not a state diff, which would carry every deletion).
  let oneEdit = 0;
  const onUpdate = (u) => (oneEdit = u.length);
  doc.on('update', onUpdate);
  doc.transact(() => {
    const m = doc.getMap('notes').get(ids[0]);
    m.set('title', 'A new first line');
    m.set('updated', Date.now());
  });
  doc.off('update', onUpdate);

  // Load (the offline copy, or a snapshot): decrypt, then apply into a fresh doc.
  t = now();
  const plain = await decrypt(key, sealed.nonce, sealed.ciphertext, aad);
  const decryptMs = now() - t;
  t = now();
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, plain);
  const applyMs = now() - t;

  // The list: every note read and sorted by time (what renderList does on each change).
  t = now();
  const rows = [];
  fresh.getMap('notes').forEach((m, id) => {
    if (!m.get('deleted')) rows.push({ id, title: m.get('title'), updated: m.get('updated') });
  });
  rows.sort((a, b) => b.updated - a.updated);
  const listMs = now() - t;

  // Yjs's own memory: the doc's structs, roughly (a second doc the same size shows the delta).
  return {
    notes: n, edits, stateBytes: state.length, blobBytes: sealed.ciphertext.length + 12, oneEditBytes: oneEdit,
    buildMs: ms(buildMs), encodeMs: ms(encodeMs), encryptMs: ms(encryptMs), decryptMs: ms(decryptMs), applyMs: ms(applyMs), listMs: ms(listMs),
    loadMs: ms(decryptMs + applyMs), saveMs: ms(encodeMs + encryptMs), rows: rows.length,
  };
}

export const CASES = [[100, 0], [1000, 0], [1000, 20], [10_000, 0], [10_000, 20], [10_000, 100]];

export async function all(cases = CASES, log = () => {}) {
  const out = [];
  for (const [n, edits] of cases) {
    const r = await measure(n, edits);
    out.push(r);
    log(r);
  }
  return out;
}
