// A note's history (#60): earlier versions of its text, kept on the server.
//
// A version is the note's whole text at a moment, encrypted with the note's
// key and signed like its edits (DocSync.seal, kind 'version'). Its time goes
// in the signature (as covers_seq), so the server can't reorder versions, and
// they keep their times when moved (a phrase change re-encrypts them). Every
// version is kept, its text packed (packText: compressed) before it's
// encrypted; the oldest go only when room is needed (server/src/quota.rs).
//
// Saving (DocSync, see sync.js): the note as it was before the first edit of
// a session, if the last version is older than the interval; then at most
// once per interval while edits keep coming. Restoring (the History dialog)
// makes the text that again, as one edit (applyText). The dialog shows what
// changed in each version since the one before (diffLines).

import { nowSecs } from './clock.js';
import { signedRequest } from './signed.js';
import { ACTION } from './sig.js';

/** The interval clients save at, unless the server said otherwise (GET /account). */
export const VERSION_EVERY_SECS = 3600;

export { nowSecs } from './clock.js'; // (versions are timed by the server's clock: the server refuses ones from the future)

/** Whether a version is due: none yet, or the last is at least an interval old. */
export const versionDue = (lastAt, now, everySecs = VERSION_EVERY_SECS) => !lastAt || now - lastAt >= everySecs;

// A packed version: MAGIC, then the text's UTF-8, raw-deflated (the terminal client the same:
// plim-core version.rs; web/tests/fixtures/versions.json holds what both must read). One
// without MAGIC is the text as it is, saved before versions were packed.
// One that says who wrote it (#505): MAGIC_WRITER, then raw-deflated: the writer as JSON (its
// length first, a u32 big-endian), then the text. Inside the encryption: the server never learns
// who writes in which note. A writer that can't be read is left out; the text still reads.
const MAGIC = new Uint8Array([0, 0x54, 0x5a, 1]); // NUL "TZ" 1
const MAGIC_WRITER = new Uint8Array([0, 0x54, 0x5a, 2]); // NUL "TZ" 2
const MAX_WRITER = 4096;
const WRITER_FIELDS = ['name', 'connection', 'session', 'sid'];

async function through(stream, bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const startsWith = (bytes, magic) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/**
 * A version's text, packed to be encrypted; with `writer` ({ name, connection, session, sid }:
 * the app, through what, which session and its id, #505), saying who wrote it.
 */
export async function packText(text, writer = null) {
  const te = new TextEncoder();
  let magic = MAGIC, raw = te.encode(text);
  if (writer) {
    const w = te.encode(JSON.stringify(cleanWriter(writer) ?? {}));
    const body = new Uint8Array(4 + w.length + raw.length);
    new DataView(body.buffer).setUint32(0, w.length);
    body.set(w, 4);
    body.set(raw, 4 + w.length);
    magic = MAGIC_WRITER;
    raw = body;
  }
  const packed = await through(new CompressionStream('deflate-raw'), raw);
  const out = new Uint8Array(magic.length + packed.length);
  out.set(magic);
  out.set(packed, magic.length);
  return out;
}

/** A writer's fields that are strings (anything else left out); null if it isn't an object. */
function cleanWriter(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const out = {};
  for (const k of WRITER_FIELDS) if (typeof w[k] === 'string' && w[k].length <= 200) out[k] = w[k];
  return out;
}

/** A version's text and, if it says, who wrote it: { text, writer } (writer null if it doesn't). */
export async function unpackVersion(bytes) {
  const utf8 = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b);
  if (startsWith(bytes, MAGIC_WRITER)) {
    const raw = await through(new DecompressionStream('deflate-raw'), bytes.subarray(MAGIC_WRITER.length));
    if (raw.length < 4) throw new Error('a version cut short');
    const len = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
    if (raw.length < 4 + len) throw new Error('a version cut short');
    let writer = null;
    if (len <= MAX_WRITER) {
      try {
        writer = cleanWriter(JSON.parse(utf8(raw.subarray(4, 4 + len))));
      } catch {
        /* a writer that can't be read: left out */
      }
    }
    return { text: utf8(raw.subarray(4 + len)), writer };
  }
  const raw = startsWith(bytes, MAGIC) ? await through(new DecompressionStream('deflate-raw'), bytes.subarray(MAGIC.length)) : bytes;
  return { text: utf8(raw), writer: null };
}

/** A version's text from its decrypted bytes: packed, or as it was saved before packing. */
export async function unpackText(bytes) {
  return (await unpackVersion(bytes)).text;
}

/** [{id, created_at, size}] of a note's versions, newest first. */
export async function listVersions(sync) {
  const r = await sync.getJSON(sync.uploadPath('versions'));
  return r.versions ?? [];
}

/**
 * Save `text` as a version taken at `at` (seconds), and who wrote it if `writer` says (#505).
 * Returns the server's answer ({id, kept}).
 */
export async function saveVersion(sync, text, at = nowSecs(), writer = null) {
  const body = await sync.seal('version', await packText(text, writer), at);
  return sync.ctx.api.post(sync.uploadPath('versions'), body);
}

/**
 * One version's text, time and writer (null: it doesn't say, #505); `packed`, its bytes as they
 * were saved, for moving it without changing it.
 */
export async function readVersion(sync, id) {
  const blob = await sync.getJSON(`${sync.uploadPath('versions')}/${id}`);
  // A shared note's: only one saved with an edit link counts (sharesync.js, #77).
  if (sync.checkVersion && !(await sync.checkVersion(blob))) throw new Error('this version isn’t signed with the note’s key');
  const packed = await sync.open('version', { ...blob, covers_seq: blob.created_at });
  const { text, writer } = await unpackVersion(packed);
  return { id, at: blob.created_at, text, writer, packed };
}

/**
 * A note's versions follow it to a new home (shared, links replaced, made
 * private again): each read from `from` and saved to `to` as it was (its
 * time, and who wrote it), oldest first, as they were made.
 */
export async function copyVersions(from, to) {
  for (const v of (await listVersions(from)).reverse()) {
    const { packed, at } = await readVersion(from, v.id);
    await to.ctx.api.post(to.uploadPath('versions'), await to.seal('version', packed, at));
  }
}

/**
 * A note's versions taken before `before` (seconds; by default, all of them) deleted for good,
 * signed with the account's key (#144); the note itself stays. Its owner's only: someone with a
 * shared note's link can't. Returns how many.
 */
export async function forgetHistory(sync, before = nowSecs() + 1) {
  const target = sync.share ? sync.share.id : sync.docId;
  const r = await signedRequest(sync.ctx, 'DELETE', `${sync.uploadPath('versions')}?before=${before}`, ACTION.forgetHistory, target, { data: new TextEncoder().encode(String(before)) });
  return r?.deleted ?? 0;
}

/** Re-encrypt every version of a note under the current key, keeping their times (a phrase change). */
export async function resealVersions(sync) {
  for (const v of await listVersions(sync)) {
    const { packed, at } = await readVersion(sync, v.id);
    const body = await sync.seal('version', packed, at); // (as it was: its writer too)
    await sync.ctx.api.request('PUT', `${sync.uploadPath('versions')}/${v.id}`, body);
  }
}

/**
 * Make `ytext` read `to` with the smallest edit: one deletion and one
 * insertion between the common start and end (as the terminal client's
 * binding::apply_text). As one transaction it syncs, merges with others'
 * edits, and the editor's undo takes it back.
 */
export function applyText(ytext, to, origin) {
  const from = ytext.toString();
  if (from === to) return;
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  // Don't split a surrogate pair (an emoji) between the kept and changed parts.
  const high = (s, i) => i > 0 && i <= s.length && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff;
  if (high(from, start) || high(to, start)) start--;
  if (end && (high(from, from.length - end) || high(to, to.length - end))) end--;
  ytext.doc.transact(() => {
    if (from.length - start - end) ytext.delete(start, from.length - start - end);
    if (to.length - start - end) ytext.insert(start, to.slice(start, to.length - end));
  }, origin);
}

// ---- what changed between two versions (the History dialog's Changes view) ----

/**
 * The shortest edit script from `a` to `b` (arrays, items compared with ===),
 * by Myers' O(ND) algorithm: [{op: '=' | '-' | '+', items}], in order. Past
 * `maxD` changes it gives up and says "all of a went, all of b came" rather
 * than spend long on a rewrite.
 */
export function diff(a, b, maxD = 1000) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const ops = [];
  const push = (op, item) => {
    const last = ops[ops.length - 1];
    if (last?.op === op) last.items.push(item);
    else ops.push({ op, items: [item] });
  };
  for (const x of a.slice(0, pre)) push('=', x);
  for (const step of middle(A, B, maxD)) push(step[0], step[1]);
  for (const x of a.slice(a.length - suf)) push('=', x);
  return ops;
}

/** The steps from A to B as [op, item] (Myers, with a trace of each round's furthest points). */
function middle(A, B, maxD) {
  const N = A.length;
  const M = B.length;
  if (!N || !M) return [...A.map((x) => ['-', x]), ...B.map((x) => ['+', x])];
  const max = N + M;
  const V = new Int32Array(2 * max + 2);
  const trace = []; // trace[d][k + d]: the furthest x on diagonal k after round d
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[max + k - 1] < V[max + k + 1]) ? V[max + k + 1] : V[max + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) x++, y++;
      V[max + k] = x;
      if (x >= N && y >= M) {
        trace.push(V.slice(max - d, max + d + 1));
        return backtrack(A, B, trace);
      }
    }
    trace.push(V.slice(max - d, max + d + 1));
  }
  return [...A.map((x) => ['-', x]), ...B.map((x) => ['+', x])];
}

function backtrack(A, B, trace) {
  const steps = [];
  let x = A.length;
  let y = B.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d - 1];
    const at = (k) => v[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1)); // came by an insertion
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const midX = down ? prevX : prevX + 1;
    while (x > midX) steps.push(['=', A[--x]]), y--;
    if (down) steps.push(['+', B[--y]]);
    else steps.push(['-', A[--x]]);
  }
  while (x > 0) steps.push(['=', A[--x]]), y--;
  return steps.reverse();
}

const lines = (text) => (text === '' ? [] : text.split('\n'));
const WORDS = /\s+|[\p{L}\p{N}_]+|./gsu;

/**
 * Line by line, what changed from `before` to `after`: rows of
 * {kind: 'same' | 'del' | 'add', text}. A changed line paired with its
 * replacement also gets `parts` ([{text, changed}]): the words that changed.
 */
export function diffLines(before, after) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const pairs = Math.min(dels.length, adds.length);
    const delRows = dels.map((text) => ({ kind: 'del', text }));
    const addRows = adds.map((text) => ({ kind: 'add', text }));
    for (let i = 0; i < pairs; i++) {
      const words = diffWords(dels[i], adds[i]);
      if (words) [delRows[i].parts, addRows[i].parts] = words;
    }
    rows.push(...delRows, ...addRows);
    dels = [];
    adds = [];
  };
  for (const { op, items } of diff(lines(before), lines(after))) {
    if (op === '-') dels.push(...items);
    else if (op === '+') adds.push(...items);
    else {
      flush();
      rows.push(...items.map((text) => ({ kind: 'same', text })));
    }
  }
  flush();
  return rows;
}

/** The changed words of a line and its replacement, or null when they have nothing (but spaces) in common. */
function diffWords(a, b) {
  const ops = diff(a.match(WORDS) ?? [], b.match(WORDS) ?? [], 200);
  if (!ops.some((o) => o.op === '=' && o.items.join('').trim())) return null;
  const side = (skip) => {
    const parts = [];
    for (const o of ops) {
      if (o.op === skip) continue;
      const changed = o.op !== '=';
      const text = o.items.join('');
      if (parts.at(-1)?.changed === changed) parts.at(-1).text += text;
      else parts.push({ text, changed });
    }
    return parts;
  };
  return [side('+'), side('-')];
}

/** Lines added and removed. */
export function diffSummary(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
  }
  return { added, removed };
}

/** A line as you'd name it: without its Markdown marks ("- ", "## ", "> ", "1. ", "[ ] "). */
const plainLine = (text) => text.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/, '').trim();
const quoted = (text) => `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;

/**
 * What a version changed, in a few words, from its diffLines rows: its first
 * change that isn't a blank line — `Changed “…”` (a line and its replacement:
 * the new one), `Added “…”` or `Removed “…”` — or '' when nothing changed.
 */
export function changeSummary(rows) {
  let blank = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'same') continue;
    const text = plainLine(r.text);
    if (!text) {
      blank = true;
      continue;
    }
    if (r.parts && r.kind === 'add') return `Changed ${quoted(text)}`;
    if (r.parts) {
      // (diffLines puts a run's removed lines before its added ones, paired in order.)
      let start = i;
      while (rows[start - 1]?.kind === 'del') start--;
      let end = i;
      while (rows[end]?.kind === 'del') end++;
      const pair = rows[end + (i - start)];
      if (pair?.kind === 'add' && plainLine(pair.text)) return `Changed ${quoted(plainLine(pair.text))}`;
    }
    return `${r.kind === 'add' ? 'Added' : 'Removed'} ${quoted(text)}`;
  }
  return blank ? 'Blank lines' : '';
}

/**
 * Unchanged lines more than `context` away from a change (3, as GitHub shows) are folded into
 * {kind: 'fold', count, rows} (shown as "Show 14 unchanged lines"); a fold would hide fewer than
 * 3, they're shown.
 */
export function foldContext(rows, context = 3) {
  const near = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) near[j] = true;
  });
  const out = [];
  let hidden = [];
  const flush = () => {
    if (hidden.length >= 3) out.push({ kind: 'fold', count: hidden.length, rows: hidden });
    else out.push(...hidden);
    hidden = [];
  };
  rows.forEach((r, i) => {
    if (r.kind === 'same' && !near[i]) hidden.push(r);
    else {
      flush();
      out.push(r);
    }
  });
  flush();
  return out;
}
