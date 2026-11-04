// A connection's notes, kept in step with what's shared with agents (connections-sync.js, #514).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from '../vendor/yjs.mjs';
import * as cs from '../core/connections-sync.js';
import { here, test } from './lib.mjs';

const CONN = 'c0ffee00c0ffee00c0ffee00c0ffee00';
/** An index's notes map with these notes: id → { tags, place?, share?, deleted?, purged?, updated? }. */
function notesOf(spec) {
  const notes = new Y.Doc().getMap('notes');
  for (const [id, n] of Object.entries(spec)) {
    const m = new Y.Map([['title', n.title ?? id], ['tags', n.tags ?? []], ['deleted', Boolean(n.deleted)], ['updated', n.updated ?? 1000]]);
    notes.set(id, m);
    if (n.place) m.set('place', n.place);
    if (n.share) m.set('share', n.share);
    if (n.purged) m.set('purged', true);
    if (n.lastBy) m.set('lastBy', n.lastBy);
    if (n.writers) m.set('writers', n.writers);
    if (n.wroteAt) m.set('wroteAt', n.wroteAt);
  }
  return notes;
}
const holder = (id, role, connection = CONN) => ({ id, role, connection });

test('connections: what a note gives a connection, the same as the terminal client (the shared cases, #409, #514)', () => {
  const f = JSON.parse(readFileSync(new URL('fixtures/grants.json', here)));
  assert.ok(f.cases.length >= 8);
  for (const k of f.cases) assert.equal(cs.roleFor(k.place ?? undefined), k.role, JSON.stringify(k));
});

test('connections: the notes shared with agents go to every connection, whatever their tags (#514)', () => {
  const notes = notesOf({ a: { tags: ['gym'] }, b: { tags: ['health'], place: 'ai' }, c: { place: 'ai' } });
  assert.deepEqual([...cs.wantedNotes(notes)], [['b', 'edit'], ['c', 'edit']], 'a tag shares nothing');
  assert.deepEqual(cs.entryFor(notes, 'b', 'edit'), { noteId: 'b', title: 'b', tags: ['health'], role: 'edit', place: 'ai' }, 'the connector told it is shared with agents');
});

test('connections: the notes it should have and the steps to get there', () => {
  const notes = notesOf({
    a: { tags: ['gym/legs'], place: 'ai' },
    b: { tags: ['recipes'], place: 'ai', share: { id: 's'.repeat(32), holders: [holder('h1', 'read')] } },
    c: { tags: ['gym'], share: { id: 't'.repeat(32), holders: [holder('h2', 'edit')] } },
    d: { place: 'ai', deleted: true },
    e: { place: 'ai', purged: true },
    f: { place: 'ai', share: { id: 'u'.repeat(32), holders: [holder('h3', 'edit'), holder('h9', 'read', 'other')] } },
  });
  const want = cs.wantedNotes(notes);
  assert.deepEqual([...want], [['a', 'edit'], ['b', 'edit'], ['f', 'edit']], 'deleted and purged notes go to nobody');
  const have = cs.heldNotes(notes, CONN);
  assert.deepEqual([...have.keys()], ['b', 'c', 'f'], "only this connection's holders");
  const p = cs.plan(want, have);
  assert.deepEqual(p.add, [['a', 'edit']]);
  assert.deepEqual(p.change.map(([id, h, role]) => [id, h.id, role]), [['b', 'h1', 'edit']], 'read only before (a tag it read): resealed to edit');
  assert.deepEqual(p.remove, ['c'], 'reached through a tag before, not shared with agents: taken back');
  assert.equal(p.count, 3);
  assert.equal(cs.plan(want, new Map([['a', holder('x', 'edit')], ['b', holder('y', 'edit')], ['f', holder('z', 'edit')]])).count, 0, 'in step: nothing to do');
});

test('connections: two devices at once, and what goes private again or out of the list', () => {
  const notes = notesOf({
    a: { tags: ['gym'], share: { id: 's'.repeat(32), holders: [holder('hb', 'edit'), holder('ha', 'edit'), holder('hx', 'edit', 'other')] } },
    b: { tags: [], share: { id: 't'.repeat(32), via: CONN, holders: [] } },
    c: { tags: ['gym'], share: { id: 'u'.repeat(32), via: CONN, holders: [] } },
  });
  assert.deepEqual([...cs.duplicates(notes, CONN)], [['a', ['hb']]], 'the first by id stays; the other connection’s is not ours to drop');
  assert.deepEqual(cs.privateAgain(notes, CONN, new Map([['c', 'edit']])), ['b'], 'shared only for it, and no longer given it');
  const entries = new Map([['h1', { noteId: 'a', seed: 'x' }], ['h2', { noteId: 'z', seed: 'y' }], ['h3', { noteId: 'a' }]]);
  assert.deepEqual(cs.madeAndHeld(entries, new Map([['a', {}]])), ['h1'], 'made, taken in and held: its seeded entry goes');
});

test('connections: notes it made are taken in, shared with agents, with any tags (#405, #514)', () => {
  const notes = notesOf({ mine: { tags: ['diary'] } });
  const seed = 'A'.repeat(43) + '=';
  const now = 5_000_000;
  const entries = new Map([
    ['k1', { noteId: '1111-aaaa', shareId: '1'.repeat(32), seed, title: 'Ideas', tags: ['gym'], created: 10, updated: now + 9e9 }],
    ['k2', { noteId: '2222-bbbb', shareId: '2'.repeat(32), seed, title: 'x'.repeat(500), tags: [] }],
    ['k2b', { noteId: '2b2b', shareId: 'b'.repeat(32), seed, tags: ['finance', 'travel'] }],
    ['k3', { noteId: 'mine', shareId: '3'.repeat(32), seed, tags: ['gym'] }],
    ['k4', { noteId: 'index', shareId: '4'.repeat(32), seed }],
    ['k5', { noteId: 'Not/An/Id', shareId: '5'.repeat(32), seed }],
    ['k6', { noteId: '6666', shareId: 'short', seed }],
    ['k7', { noteId: '7777', shareId: '7'.repeat(32), seed: 'not a seed' }],
    ['k8', { noteId: '8888', shareId: '1'.repeat(32), seed }],
    ['k9', { noteId: '9999', shareId: '9'.repeat(32), seed, tags: 'gym', created: -5 }],
  ]);
  const adopted = cs.adoptMade(notes, CONN, entries, now, 'Claude');
  assert.deepEqual(adopted, ['1111-aaaa', '2222-bbbb', '2b2b', '9999'], 'well-formed only, never over a note of yours, one share once');
  const one = notes.get('1111-aaaa');
  assert.deepEqual([one.get('created'), one.get('updated'), one.get('tags'), one.get('place')], [10, now, ['gym'], 'ai'], 'no later than now; shared with agents');
  assert.equal(one.get('share').via, CONN);
  assert.deepEqual([one.get('writers'), one.get('wroteAt')], [['Claude'], { Claude: 10 }], 'written by it, when it made it (#564)');
  const two = notes.get('2222-bbbb');
  assert.equal(two.get('title').length, 200, 'a short title');
  assert.deepEqual([two.get('tags'), two.get('place')], [[], 'ai'], 'no tags: none put on');
  assert.deepEqual(notes.get('2b2b').get('tags'), ['finance', 'travel'], 'any topics');
  assert.deepEqual([notes.get('9999').get('tags'), notes.get('9999').get('created')], [[], now], 'tags that are no list, a time that is no time');
  assert.deepEqual([notes.get('mine').get('tags'), notes.get('mine').get('place')], [['diary'], undefined], 'yours untouched');
});

test('connections: the switch asks about the notes agents reached through tags, not yet shared with agents (#514)', () => {
  const notes = notesOf({
    legs: { tags: ['gym/legs'], updated: 300 },
    plan: { tags: ['gym'], updated: 500 },
    shared: { tags: ['gym'], place: 'ai' },
    made: { tags: ['claude/fox'], updated: 100 },
    gone: { tags: ['gym'], deleted: true },
    diary: { tags: ['diary'] },
  });
  const conns = [{ name: 'Claude', ownTag: 'claude/fox', tags: { gym: 'write' } }, { name: 'Codex', tags: {} }];
  assert.deepEqual(conns.map(cs.grantedTags), [['claude/fox', 'gym'], []]);
  assert.deepEqual(cs.reachedByTags(notes, conns), [
    { id: 'plan', title: 'plan', through: 'gym' },
    { id: 'legs', title: 'legs', through: 'gym/legs' },
    { id: 'made', title: 'made', through: 'claude/fox' },
  ], 'the latest edited first; not one shared already, deleted, or never reached');
  assert.deepEqual(cs.reachedByTags(notes, [{ name: 'Claude', tags: {} }]), [], 'no tags given: nothing to ask');
});

test('connections: what it did, newest first, repeats folded, by day', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  const h = (n) => now - n * 3_600_000;
  const items = [
    { what: 'Created "Test note"', at: h(30), noteId: 'a' },
    { what: 'Read 46 notes tagged #gym', at: h(7) },
    { what: 'Read 98 notes tagged #gym', at: h(6) },
    { what: 'Added to "Leg day"', at: h(5) },
    { what: 'Added to "Leg day"', at: h(4) },
    { what: 'Read "Leg day"', at: h(1) },
    { what: 'nonsense' },
    null,
  ];
  const f = cs.foldActivity(items, now, () => 'Sat, Oct 10');
  assert.deepEqual(f.map((e) => [e.day, e.kind, e.what]), [
    ['Today', 'read', 'Read "Leg day"'],
    ['Today', 'added', 'Added to "Leg day" · 2 times'],
    ['Today', 'read', 'Read #gym notes · 2 times'],
    ['Yesterday', 'created', 'Created "Test note"'],
  ]);
  assert.equal(f[2].at, h(6), 'the newest of a fold');
});

test('connections: its edits mark only notes it can reach (#405)', () => {
  const notes = notesOf({
    held: { tags: ['gym'], updated: 100, share: { id: 's'.repeat(32), holders: [holder('h1', 'edit')] } },
    made: { tags: ['claude/fox'], updated: 100, share: { id: 't'.repeat(32), via: CONN, holders: [] } },
    other: { tags: ['diary'], updated: 100 },
    newer: { tags: ['gym'], updated: 900, share: { id: 'u'.repeat(32), holders: [holder('h2', 'edit')] } },
  });
  const activity = [
    { noteId: 'held', at: 300, what: 'Added to "held"' },
    { noteId: 'made', at: 9e12, what: 'Created "made"' },
    { noteId: 'other', at: 400, what: 'Added to "other"' },
    { noteId: 'newer', at: 500, what: 'Added to "newer"' },
    { noteId: 'held', at: 700, what: 'Read "held"' },
    { noteId: 'held', at: 'soon', what: 'Added' },
  ];
  const marked = cs.noteAppEdits(notes, CONN, 'Claude', activity, 1000);
  assert.deepEqual(marked.sort(), ['held', 'made']);
  assert.deepEqual([notes.get('held').get('updated'), notes.get('held').get('lastBy')], [300, 'Claude'], 'reading is no edit');
  assert.equal(notes.get('made').get('updated'), 1000, 'no later than now');
  assert.equal(notes.get('other').get('lastBy'), undefined, 'a note it was never given');
  assert.equal(notes.get('newer').get('lastBy'), undefined, 'you edited it since');
  assert.deepEqual(notes.get('held').get('writers'), ['Claude'], 'among its writers (#552)');
});

test('connections: a note\'s writers, and whether it\'s in Connected (#552)', () => {
  const notes = notesOf({
    mine: { tags: [] },
    shared: { tags: [], place: 'ai' },
    lastOnly: { tags: [], lastBy: 'Claude' },
    kept: { tags: [], writers: ['Backup script', 'claude'], lastBy: 'Claude' },
  });
  assert.deepEqual(cs.writersOf(notes.get('mine')), []);
  assert.deepEqual(cs.writersOf(notes.get('lastOnly')), ['Claude'], 'from before writers were kept: the last one');
  assert.deepEqual(cs.writersOf(notes.get('kept')), ['Backup script', 'claude'], 'each once, a name without its case');
  assert.deepEqual(['mine', 'shared', 'lastOnly', 'kept'].map((id) => cs.isConnected(notes.get(id))), [false, true, true, true]);
  const m = notes.get('mine');
  cs.addWriter(m, 'Backup script');
  cs.addWriter(m, 'backup script');
  cs.addWriter(m, '  ');
  assert.deepEqual(m.get('writers'), ['Backup script']);
  assert.equal(cs.isConnected(m), true, 'written in by a script: Connected, though it\'s yours');
});

test('connections: who writes, for the top of Connected: notes, in the last 7 days, last (#564)', () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;
  const notes = notesOf({
    log: { tags: [], writers: ['Gym review'], wroteAt: { 'Gym review': NOW - DAY } },
    plan: { tags: [], writers: ['Claude', 'Gym review'], wroteAt: { claude: NOW - 2 * DAY, 'Gym review': NOW - 9 * DAY } },
    old: { tags: [], lastBy: 'Codex', updated: NOW - 30 * DAY }, // (from before: its last writer at its time)
    kept: { tags: [], writers: ['Claude'] }, // (from before #564: written in, when unknown)
    gone: { tags: [], writers: ['Claude'], wroteAt: { Claude: NOW }, deleted: true },
    mine: { tags: [] },
  });
  assert.deepEqual(cs.writerSummary(notes, NOW), [
    { name: 'Gym review', notes: 2, week: 1, last: NOW - DAY },
    { name: 'Claude', notes: 2, week: 1, last: NOW - 2 * DAY },
    { name: 'Codex', notes: 1, week: 0, last: NOW - 30 * DAY },
  ]);
  // Its time kept as the latest, under its name as first written (another case: the same writer).
  const m = notes.get('mine');
  cs.addWriter(m, 'Backup script', 5);
  cs.addWriter(m, 'backup script', 9);
  cs.addWriter(m, 'BACKUP SCRIPT', 7);
  cs.addWriter(m, 'Claude');
  assert.deepEqual(m.get('wroteAt'), { 'Backup script': 9 });
  assert.deepEqual([...cs.writerTimes(m)], [['backup script', 9]]);
});

test('connections: holders of its left on shares no note uses are strays, once old enough (#465)', () => {
  const S = (c) => c.repeat(32);
  const notes = notesOf({
    a: { tags: ['gym'], share: { id: S('a'), holders: [holder('ha', 'edit')] } },
    b: { tags: ['gym'], share: { id: S('b'), holders: [] } },
  });
  const entries = new Map([['hm', { noteId: 'm', shareId: S('m'), seed: 'x' }]]);
  const now = 1_000_000_000;
  const at = (minutesAgo) => Math.floor((now - minutesAgo * 60_000) / 1000);
  const holders = [
    { holder_id: 'ha', share_id: S('a'), created_at: at(60), others: 0 }, // a note's: kept
    { holder_id: 'hl', share_id: S('l'), created_at: at(60), others: 0 }, // the connection's list: kept
    { holder_id: 'hm', share_id: S('m'), created_at: at(60), others: 0 }, // a note it made, not yet taken in: kept
    { holder_id: 'hb', share_id: S('b'), created_at: at(60), others: 0 }, // on a note's share, not yet in its entry: kept
    { holder_id: 'hy', share_id: S('y'), created_at: at(2), others: 0 }, // young: another device's, its note maybe not here yet
    { holder_id: 'hx', share_id: S('x'), created_at: at(60), others: 0 }, // a stray: it and its share go
    { holder_id: 'hz', share_id: S('z'), created_at: at(60), others: 1 }, // a stray whose share someone else holds: the holder only
  ];
  assert.deepEqual(cs.strays(holders, notes, entries, S('l'), now, 10 * 60_000), [
    { holderId: 'hx', shareId: S('x'), dropShare: true },
    { holderId: 'hz', shareId: S('z'), dropShare: false },
  ]);
});
