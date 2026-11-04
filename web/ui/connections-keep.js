// Keeping each connection's notes in step with what's shared with agents (#369, #514): its holders
// made, re-sealed or taken back, its list note written (the decisions are connections-sync.js's,
// #410). And the
// connections as the encrypted index keeps them, which the consent page (ui/consent.js) and
// Settings → Connections (ui/connections.js) read and change.
import * as Y from '../vendor/yjs.mjs';
import { unb64 } from '../core/crypto.js';
import { ShareDocSync } from '../core/sharesync.js';
import { now as clockNow } from '../core/clock.js';
import { connectionHolderSecret } from '../core/connection.js';
import { shareKeys } from '../core/share.js';
import { adoptMade, duplicates, entryFor, heldNotes, madeAndHeld, noteAppEdits, plan, privateAgain, strays, wantedNotes } from '../core/connections-sync.js';
import { addConnectionHolder, deleteHolder, deleteShare, removeHolder, resealHolder, shareOf, stopSharing } from './shares.js';
import { editedHere, notesMap, state } from './shared.js';

// From app.js (init): upkeep starts.
export function init() {
  // (Notes the connector made appear in its list, not in yours: looked for now and then.)
  setInterval(() => {
    if (state.index && !state.offline && connectionsMap().size) scheduleGrants(0);
  }, LOOK_EVERY_MS);
}

/** connection id → { name, secret, listShareId, listSeed, created, from } (ui/connections.js; one from before #514 may still have tags, ownTag, notebook: the switch, ui/agents-switch.js, takes them out). */
export const connectionsMap = () => state.index.ydoc.getMap('connections');

/** A connection kept in step: its page drawn again, if it's showing (ui/connections.js). */
let whenKept = () => {};
export const onKept = (fn) => (whenKept = fn);

/** What a pass is doing for a connection ("Sharing with Claude: 1 of 2…"; '' when done), for its page. */
let say = () => {};
export const onKeepStatus = (fn) => (say = fn);

/**
 * An app connecting (ui/consent.js): no passes until it's done or cancelled; the page may be
 * about to leave for the connector, and nothing else should start on the notes meanwhile.
 */
let held = false;
export function holdGrants(on) {
  held = on;
  if (on) clearTimeout(grantsTimer);
}

// ---- one connection per app you connect (#390) ----
// Each consent makes a connection of its own: claude.ai (and its apps) is one, Claude Code on a
// computer another, so each can be disconnected alone. Where it came from is kept, to tell them apart.

/** A connection's name, as two are told apart: "Claude" and "claude " are the same. */
export const pastKey = (name) => name.trim().toLowerCase();

// ---- keeping each connection's notes in step with what's shared with agents ----

let keeping = false;
let again = false;
let grantsTimer;

/** Soon (the list changed: a tag typed, a note made): once, however many changes. */
export function scheduleGrants(ms = 3000) {
  clearTimeout(grantsTimer);
  if (held) return; // (an app connecting: the page may be about to leave)
  grantsTimer = setTimeout(() => keepGrants(), ms);
}

/** Each connection's holders made, re-sealed or taken away to match what's shared with agents; never two at once. */
export async function keepGrants() {
  if (!state.index || state.offline || held) return;
  if (keeping) {
    again = true;
    return;
  }
  keeping = true;
  try {
    for (const [cid, c] of connectionsMap().entries()) {
      await keepConnection(cid, c).catch((e) => console.warn('could not keep a connection’s notes in step', cid, e));
    }
  } finally {
    keeping = false;
    if (again) {
      again = false;
      scheduleGrants(500);
    }
  }
}

export async function openList(c) {
  const list = new ShareDocSync(state.ctx, { id: c.listShareId, keys: await shareKeys(unb64(c.listSeed)) }, new Y.Doc());
  await list.load();
  return list;
}

/** When each connection's list was last looked at (for notes the connector made). */
export const looked = new Map();
export const grantsEdited = new Set(); // (connections whose notes change was made on this device: the switch, #514; its work done here at once)
export const nameEdited = new Set(); // (and whose name was, likewise)
const LOOK_EVERY_MS = 60_000;
// Another device's change: its notes left to it for this long (when each was first wanted here).
const HANDOFF_MS = 45_000;
const MINE_MS = 5 * 60_000; // (a note edited here this recently: a tag typed here, its sharing this device's)
const wantedSince = new Map(); // `${connection}:${what}:${note}` → when this device first saw it needed
const takenBackHere = new Set(); // notes this device took back from an app (their making private again is its own)

// ---- an app's holders on shares no note uses (#465) ----

const SWEEP_MS = 10 * 60_000; // (looked for this often, per connection, on each device)
const STRAY_MS = 10 * 60_000; // (one younger than this may be another device's, its note not here yet)
const swept = new Map(); // connection id → when this device last looked

/** A connection's holders on shares no note uses (core/connections-sync.js strays): deleted, and their share if no one else holds it. */
async function dropStrays(cid, c, entries) {
  if (Date.now() - (swept.get(cid) ?? 0) < SWEEP_MS) return;
  // (Your notes as the server has them, first: a device that's been asleep would take holders
  // made since, on notes it hasn't heard are shared, for strays. Not reachable: not this time.)
  await state.index.pull();
  swept.set(cid, Date.now());
  const { holders } = await state.ctx.api.get(`/connections/${cid}/holders`);
  for (const s of strays(holders, notesMap(), entries, c.listShareId, clockNow(), STRAY_MS)) {
    // (Another device sweeping at the same time may have deleted it already.)
    if (!(await deleteHolder(s.holderId).then(() => true, (e) => e?.status === 404))) continue;
    entries.delete(s.holderId);
    if (s.dropShare) await deleteShare(s.shareId).catch((e) => console.warn('could not delete a stray share', e));
  }
}

/**
 * Two of a connection's holders on one note (two of your devices kept it in step at once, each
 * not yet seeing the other's): all but the first deleted, from the server and the note's entry.
 * (No new keys needed: both were the connection's.)
 */
async function dropDuplicates(cid, entries) {
  for (const [id, extra] of duplicates(notesMap(), cid)) {
    for (const hid of extra) {
      await deleteHolder(hid);
      entries.delete(hid);
    }
    const share = notesMap().get(id).get('share');
    notesMap().get(id).set('share', { ...share, holders: share.holders.filter((h) => !extra.includes(h.id)) });
  }
}

/**
 * One connection kept in step (the decisions are connections-sync.js's, #410): the grants written
 * to its list, notes it made taken in, its edits marked, then holders made, changed and taken back
 * to match what's shared with agents, and its list put right.
 */
async function keepConnection(cid, c) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const grantedHere = grantsEdited.has(cid); // (before it's written to the list, below)
  const stale = Date.now() - (looked.get(cid) ?? 0) > LOOK_EVERY_MS || grantsEdited.has(cid) || nameEdited.has(cid);
  const doubled = duplicates(notesMap(), cid).size > 0;
  const wantedNow = wantedNotes(notesMap());
  const idle = !plan(wantedNow, heldNotes(notesMap(), cid)).count && !privateAgain(notesMap(), cid, wantedNow).length;
  if (idle && !stale && !doubled) return; // (nothing to do, and the list looked at lately)
  const secret = unb64(c.secret);
  const list = await openList(c);
  looked.set(cid, Date.now());
  const entries = list.ydoc.getMap('notes');
  const info = list.ydoc.getMap('info');
  // What its list says of it (#514): it sees the notes shared with agents (what connectors from
  // before read, as `notebook`), and no tags: any it was granted before are taken out.
  for (const old of ['tags', 'ownTag']) if (info.has(old)) info.delete(old);
  if (info.get('notebook') !== true) info.set('notebook', true);
  grantsEdited.delete(cid);
  // Its name, likewise (renamed in Settings): what the connector marks its edits with (#389).
  if (nameEdited.has(cid) || info.get('name') === undefined) {
    if (info.get('name') !== c.name) info.set('name', c.name);
    nameEdited.delete(cid);
  }
  const adopted = new Set(adoptMade(notesMap(), cid, entries, clockNow(), c.name)); // (taken in here: given their holder here; written by it, #564)
  noteAppEdits(notesMap(), cid, c.name, list.ydoc.getArray('activity').toArray(), clockNow());
  await dropDuplicates(cid, entries);
  let want = wantedNotes(notesMap());
  let have = heldNotes(notesMap(), cid);
  let todo = plan(want, have);
  // Done by one device, not two (#463, #466): two sharing the same note at once each make a share
  // of their own (the index keeps one; the other stays on the server with the app's holder on it),
  // and two taking it back at once each give it new keys. So what a change made here wants (a
  // grant given or taken here, a tag typed here, a note the app made taken in here) is done at
  // once; what another device's change wants is that device's to do, and done here only if it
  // still isn't after a while (it went offline, say), the notes brought up to date first.
  const mine = (id) => grantedHere || adopted.has(id) || takenBackHere.has(id) || clockNow() - (editedHere.get(id) ?? 0) < MINE_MS;
  const now = Date.now();
  const pending = new Set();
  const due = (kind) => (id) => {
    const key = `${cid}:${kind}:${id}`;
    pending.add(key);
    if (!wantedSince.has(key)) wantedSince.set(key, now);
    return mine(id) || now - wantedSince.get(key) >= HANDOFF_MS;
  };
  const others = (kind, ids) => ids.some((id) => !mine(id) && due(kind)(id));
  if (others('add', todo.add.map(([id]) => id)) || others('remove', todo.remove)) {
    await state.index.pull().catch((e) => console.warn('could not bring the notes up to date', e));
    want = wantedNotes(notesMap());
    have = heldNotes(notesMap(), cid);
    todo = plan(want, have);
  }
  let waiting = false;
  const doNow = (kind, list, idOf = (x) => x) => {
    const out = list.filter((x) => due(kind)(idOf(x)));
    if (out.length < list.length) waiting = true;
    return out;
  };
  const add = doNow('add', todo.add, ([id]) => id);
  const remove = doNow('remove', todo.remove);
  todo = { ...todo, add, remove, count: add.length + todo.change.length + remove.length };
  const status = (text) => {
    say(cid, text);
  };
  let done = 0;
  try {
    for (const [id, role] of todo.add) {
      status(`Sharing with ${c.name}: ${++done} of ${todo.count}…`);
      // (One note that can't be shared, too large say, doesn't hold up the rest: tried again next pass.)
      const hid = await addConnectionHolder(id, { connection: cid, label: c.name, role, secretFor: (holderId) => connectionHolderSecret(secret, holderId) })
        .catch((e) => console.warn('could not share a note with an app', id, e));
      if (hid) entries.set(hid, entryFor(notesMap(), id, role));
    }
    for (const [id, h, role] of todo.change) {
      status(`Updating ${c.name}: ${++done} of ${todo.count}…`);
      await resealHolder(id, h.id, role);
      entries.set(h.id, entryFor(notesMap(), id, role));
    }
    for (const [id, role] of want) {
      const h = have.get(id);
      if (h && h.role === role && !same(entries.get(h.id), entryFor(notesMap(), id, role))) entries.set(h.id, entryFor(notesMap(), id, role)); // (its title or tags changed)
    }
    for (const id of todo.remove) {
      status(`Taking back from ${c.name}: ${++done} of ${todo.count}…`);
      // (Every holder of the connection's on it: two devices may each have made one.)
      for (const h of (shareOf(id)?.holders ?? []).filter((x) => x.connection === cid)) {
        entries.delete(h.id);
        // (The note gets new keys: what it could still open goes too. One that can't, a note
        // deleted for good say, doesn't hold up the rest: its holder is gone on the server first.)
        await removeHolder(id, h.id).catch((e) => console.warn('could not take a note back from an app', id, e));
      }
      takenBackHere.add(id); // (what follows, making it private again, is this device's too)
    }
    // A note shared only for this connection, which no longer reaches it: private again.
    for (const id of doNow('private', privateAgain(notesMap(), cid, want))) await stopSharing(id).catch((e) => console.warn('could not make a note private again', id, e));
    // A note the connector made, taken in and given a holder: its seeded entry goes. (Only what this
    // device did is taken out of the list: another device's holders may not have reached it yet.)
    for (const hid of madeAndHeld(entries, heldNotes(notesMap(), cid))) entries.delete(hid);
    // Holders of its left on shares no note uses (#465), now and then.
    await dropStrays(cid, c, entries).catch((e) => console.warn('could not look for an app’s stray holders', e));
    await list.flush();
  } finally {
    list.close();
    status('');
    // (What was left to another device: looked at again once its while is up.)
    for (const key of wantedSince.keys()) if (key.startsWith(`${cid}:`) && !pending.has(key)) wantedSince.delete(key);
    if (waiting) setTimeout(() => scheduleGrants(0), HANDOFF_MS + 1000);
  }
  whenKept(cid);
}
