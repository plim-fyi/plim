// Keeping a connection's notes in step with what's shared with agents (#369, #410, #514): what it
// should have, what it has, and what to make of what its connector wrote. No DOM and no network:
// the Settings UI (ui/connections.js) does the requests these plan, and web/tests checks them.
//
// The rule is the terminal client's (crates/plim-cli/src/grants.rs): an agent reads and edits the
// notes you share with agents, and nothing else, whatever their tags (they're only topics). Both
// answer the cases in web/tests/fixtures/grants.json.
//
// `notes` is the index's notes map (note id → Y.Map of title, tags, share, place, …).
import * as Y from '../vendor/yjs.mjs';
import { isPurged } from './trash.js';

/** A note shared with agents (#514; the AI notebook's place, #484), as the index keeps it: place 'ai'. */
export const NOTEBOOK = 'ai';

const noteTags = (m) => (m.get('tags') ?? []).filter((t) => typeof t === 'string');

/** A connection from before #514, given tags (`tags`: { gym: 'write' | 'read' }, its own `ownTag`): what the switch asks about. */
export const grantedTags = (c) => [...(c?.ownTag ? [c.ownTag] : []), ...Object.keys(c?.tags ?? {})];

/**
 * The notes agents reached through the tags they were given before #514 and that aren't shared
 * with agents: the switch asks which to share (ui/agents-switch.js). `connections`: the index's
 * connection records. Each { id, title, through: the first tag that reached it }, the latest
 * edited first.
 */
export function reachedByTags(notes, connections) {
  const given = [...new Set([...connections].flatMap(grantedTags))];
  const out = [];
  for (const [id, m] of notes.entries()) {
    if (m.get('deleted') || isPurged(notes, id) || m.get('place') === NOTEBOOK) continue;
    // (A grant reached the notes with its tag or one under it: "gym" reached "gym/legs", as grants did.)
    const through = noteTags(m).find((t) => given.some((g) => t === g || t.startsWith(`${g}/`)));
    if (through) out.push({ id, title: m.get('title') || 'Untitled', through, updated: m.get('updated') || 0 });
  }
  return out.sort((a, b) => b.updated - a.updated).map(({ updated, ...n }) => n);
}

/** What a connection may do with a note in `place` (#514): 'edit' if it's shared with agents, else null. */
export const roleFor = (place) => (place === NOTEBOOK ? 'edit' : null);

/** The notes a connection should have (those shared with agents): note id → 'edit'. */
export function wantedNotes(notes) {
  const want = new Map();
  for (const [id, m] of notes.entries()) {
    if (m.get('deleted') || isPurged(notes, id)) continue;
    const role = roleFor(m.get('place'));
    if (role) want.set(id, role);
  }
  return want;
}

/** A connection's holders on your notes: note id → the holder entry ({ id, role, connection, … }). */
export function heldNotes(notes, cid) {
  const have = new Map();
  for (const [id, m] of notes.entries()) {
    for (const h of m.get('share')?.holders ?? []) if (h.connection === cid) have.set(id, h);
  }
  return have;
}

/**
 * What to do to go from the notes it has to the notes it should have: holders to `add` ([id, role]),
 * ones whose role changes (`change`: [id, holder, role]), notes to take back (`remove`: ids), and how
 * many steps that is (`count`).
 */
export function plan(want, have) {
  const add = [];
  const change = [];
  for (const [id, role] of want) {
    const h = have.get(id);
    if (!h) add.push([id, role]);
    else if (h.role !== role) change.push([id, h, role]);
  }
  const remove = [...have.keys()].filter((id) => !want.has(id));
  return { add, change, remove, count: add.length + change.length + remove.length };
}

/** The list note's entry for a note: what the connector shows Claude about it (and, for one in the AI notebook, that it is, #484: there any topic may go on it). */
export function entryFor(notes, id, role) {
  const m = notes.get(id);
  const entry = { noteId: id, title: m?.get('title') || '', tags: m ? noteTags(m) : [], role };
  return m?.get('place') === NOTEBOOK ? { ...entry, place: NOTEBOOK } : entry;
}

/** Two of a connection's holders on one note (two devices at once): note id → the extra holders' ids. */
export function duplicates(notes, cid) {
  const out = new Map();
  for (const [id, m] of notes.entries()) {
    const mine = (m.get('share')?.holders ?? []).filter((h) => h.connection === cid).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (mine.length > 1) out.set(id, mine.slice(1).map((h) => h.id));
  }
  return out;
}

const MADE_ID = /^[0-9a-f-]{1,64}$/;
const SHARE_ID = /^[0-9a-f]{32}$/;
const SEED = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Notes the connection made (the connector lists them with their seed): taken into your notes,
 * shared with agents (#514: that's where an agent's notes are), only as far as the connection may
 * go (#405): a well-formed id and seed, times no later than `now`, a short title. Any tags: they're
 * only topics. `entries` is its list's notes map. Returns the ids taken in. Written by the
 * connection (`name`, #564: Connected's table of who writes), when it made it.
 */
export function adoptMade(notes, cid, entries, now, name = null) {
  const held = new Set([...notes.values()].map((m) => m.get('share')?.id).filter(Boolean));
  const adopted = [];
  for (const [, e] of entries.entries()) {
    if (!e?.seed || !e.shareId || !e.noteId || held.has(e.shareId) || notes.has(e.noteId)) continue;
    if (!MADE_ID.test(e.noteId) || e.noteId === 'index' || !SHARE_ID.test(e.shareId) || !SEED.test(e.seed)) continue;
    const time = (t) => (typeof t === 'number' && t > 0 ? Math.min(t, now) : now);
    const tags = (Array.isArray(e.tags) ? e.tags : []).filter((t) => typeof t === 'string');
    const m = new Y.Map([['title', typeof e.title === 'string' ? e.title.slice(0, 200) : ''], ['created', time(e.created)], ['updated', time(e.updated)], ['deleted', false], ['tags', tags], ['share', { id: e.shareId, seed: e.seed, role: 'owner', via: cid }], ['place', NOTEBOOK]]);
    notes.set(e.noteId, m);
    addWriter(m, name, time(e.created));
    held.add(e.shareId);
    adopted.push(e.noteId);
  }
  return adopted;
}

/**
 * The names of the agents and scripts that wrote in a note (#552), from its entry in the note list:
 * its `writers`, kept from #552 on, and `lastBy` (the one that wrote in it last), which notes
 * from before have. Each once, as first written.
 */
export function writersOf(m) {
  const out = [];
  const add = (n) => typeof n === 'string' && n.trim() && !out.some((o) => o.toLowerCase() === n.toLowerCase()) && out.push(n);
  const kept = m.get('writers');
  if (Array.isArray(kept)) kept.forEach(add);
  add(m.get('lastBy'));
  return out;
}

/** In the Connected view (#552): shared with agents, or written in by an agent or a script. */
export const isConnected = (m) => m.get('place') === NOTEBOOK || writersOf(m).length > 0;

/**
 * `name` among the note's writers (#552), once (a name told apart without its case); and `at`
 * (ms), when it wrote, kept as its latest in `wroteAt` (#564: name → ms, as the terminal client's
 * set_last_by), for Connected's table of who writes.
 */
export function addWriter(m, name, at = null) {
  if (typeof name !== 'string' || !name.trim()) return;
  const kept = Array.isArray(m.get('writers')) ? m.get('writers').filter((n) => typeof n === 'string') : [];
  if (!kept.some((n) => n.toLowerCase() === name.toLowerCase())) m.set('writers', [...kept, name]);
  if (typeof at !== 'number' || !Number.isFinite(at)) return;
  const was = m.get('wroteAt');
  const times = was && typeof was === 'object' && !Array.isArray(was) ? was : {};
  const key = Object.keys(times).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  if (typeof times[key] === 'number' && times[key] >= at) return;
  m.set('wroteAt', { ...times, [key]: at });
}

/**
 * When each writer last wrote in the note (#564): lower-cased name → ms. From its `wroteAt`; a
 * note from before, its last writer (`lastBy`) at its time (`updated`); the others, unknown.
 */
export function writerTimes(m) {
  const out = new Map();
  const put = (name, at) => {
    if (typeof name !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return;
    const k = name.toLowerCase();
    if (at > (out.get(k) ?? 0)) out.set(k, at);
  };
  const kept = m.get('wroteAt');
  if (kept && typeof kept === 'object' && !Array.isArray(kept)) for (const [n, at] of Object.entries(kept)) put(n, at);
  const last = m.get('lastBy');
  if (typeof last === 'string' && !out.has(last.toLowerCase())) put(last, m.get('updated'));
  return out;
}

/**
 * Who writes in your notes (#564), for the top of Connected: each agent or script that wrote in a
 * note not deleted, with how many notes (`notes`), how many of them it wrote in within the last
 * 7 days of `now` (`week`), and when it last wrote (`last`, ms; null if no note says). Most recent
 * first (unknown last), then by name. Its name as first written.
 */
export const WEEK_MS = 7 * 86_400_000;
export function writerSummary(notes, now = Date.now()) {
  const by = new Map();
  for (const [, m] of notes.entries()) {
    if (m.get('deleted')) continue;
    const times = writerTimes(m);
    for (const name of writersOf(m)) {
      const k = name.toLowerCase();
      const w = by.get(k) ?? by.set(k, { name, notes: 0, week: 0, last: null }).get(k);
      const at = times.get(k);
      w.notes++;
      if (at != null && at >= now - WEEK_MS) w.week++;
      if (at != null && at > (w.last ?? 0)) w.last = at;
    }
  }
  return [...by.values()].sort((a, b) => (b.last ?? -1) - (a.last ?? -1) || a.name.localeCompare(b.name));
}

/**
 * What the connection changed, from its list's activity (the connector can't touch your note list,
 * #389): a note it wrote in after your last edit there is "edited … by <name>", and sorts as edited
 * then. Only notes it can reach count (#405): ones it holds, or made. Returns the ids marked.
 */
export function noteAppEdits(notes, cid, name, activity, now) {
  const reach = new Set(heldNotes(notes, cid).keys());
  for (const [id, m] of notes.entries()) if (m.get('share')?.via === cid) reach.add(id);
  const latest = new Map();
  for (const a of activity) {
    if (!a?.noteId || !reach.has(a.noteId) || typeof a.at !== 'number' || /^Read /.test(a.what ?? '')) continue;
    if (a.at > (latest.get(a.noteId) ?? 0)) latest.set(a.noteId, a.at);
  }
  const marked = [];
  for (const [id, at] of latest) {
    const m = notes.get(id);
    if (!m || m.get('deleted') || at <= (m.get('updated') || 0)) continue;
    m.set('updated', Math.min(at, now));
    m.set('lastBy', name);
    addWriter(m, name, Math.min(at, now)); // (#552: in Connected, and its letter on the row, after you edit it too; #564: when)
    marked.push(id);
  }
  return marked;
}

/**
 * What a connection did, for its page: newest first, the same thing done again in a row folded
 * into one ("Read #gym notes · 2 times"), each with its kind (for its mark) and its day (`today`
 * and `yesterday` are said as such). `items`: its list's activity, oldest first.
 */
export function foldActivity(items, now = Date.now(), dayName = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })) {
  const day = (t) => new Date(t).toDateString();
  const today = day(now);
  const yesterday = day(now - 86_400_000);
  const out = [];
  for (const a of [...items].reverse()) {
    if (typeof a?.what !== 'string' || typeof a.at !== 'number') continue;
    const tagged = a.what.match(/^Read \d+ notes? tagged (#\S+)$/);
    const kind = /^Read /.test(a.what) ? 'read' : /^Created /.test(a.what) ? 'created' : /^Added to /.test(a.what) ? 'added' : /^(Untagged|Tagged) /.test(a.what) ? 'tagged' : 'other';
    const key = tagged ? `read ${tagged[1]}` : a.what;
    const label = tagged ? `Read ${tagged[1]} notes` : a.what;
    const last = out.at(-1);
    if (last && last.key === key && day(last.at) === day(a.at)) {
      last.count++;
      continue;
    }
    const d = day(a.at);
    out.push({ key, kind, label, at: a.at, count: 1, day: d === today ? 'Today' : d === yesterday ? 'Yesterday' : dayName(new Date(a.at)) });
  }
  return out.map(({ key, ...e }) => ({ ...e, what: e.count > 1 ? `${e.label} · ${e.count} times` : e.label }));
}

/** Notes shared only for this connection that no longer reach it, with no one else holding them: to make private again. */
export function privateAgain(notes, cid, want) {
  const out = [];
  for (const [id, m] of notes.entries()) {
    const share = m.get('share');
    if (share?.via === cid && !want.has(id) && !(share.holders ?? []).length) out.push(id);
  }
  return out;
}

/**
 * A connection's holders on the server (`holders`: { holder_id, share_id, created_at (s), others })
 * that none of your notes knows (#465): left by two devices sharing the same note at once (#463),
 * each opening a copy of the note as it was then for the app, whatever its tags become. One is a
 * stray when no note has it, its share is no note's (nor the connection's list's, `listShareId`,
 * nor a note it made not yet taken in: `entries`, its list's), and it's older than `minAge` ms at
 * `now` (a younger one may be another device's, its note not here yet). Each with whether its
 * share can go too: no one else holds it.
 */
export function strays(holders, notes, entries, listShareId, now, minAge) {
  const known = new Set();
  const used = new Set([listShareId]);
  for (const [, m] of notes.entries()) {
    const share = m.get('share');
    if (!share) continue;
    used.add(share.id);
    for (const h of share.holders ?? []) known.add(h.id);
  }
  for (const [, e] of entries.entries()) if (e?.shareId) used.add(e.shareId);
  const out = holders.filter((h) => !known.has(h.holder_id) && !used.has(h.share_id) && h.created_at * 1000 <= now - minAge);
  return out.map((h) => ({ holderId: h.holder_id, shareId: h.share_id, dropShare: !h.others }));
}

/** Its list's entries for notes it made that are now taken in and held: to drop from the list. */
export function madeAndHeld(entries, held) {
  return [...entries.keys()].filter((hid) => {
    const e = entries.get(hid);
    return e?.seed && held.has(e.noteId);
  });
}
