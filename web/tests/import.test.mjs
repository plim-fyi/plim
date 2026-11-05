// Import (g87d, core/import.js): files as notes, folders as tags, export's fields read back, zips read.
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { exportText, zipFiles } from '../core/export.js';
import { readFrontmatter } from '../core/frontmatter.js';
import { commonFolder, decodeText, folderTag, isNoteFile, isZip, noteFromFile, planImport, unzip } from '../core/import.js';
import { test } from './lib.mjs';

const te = new TextEncoder();
const NOW = Date.parse('2026-11-05T12:00:00Z');
const file = (path, text) => ({ path, bytes: te.encode(text) });

test('import: a file\'s text: UTF-8, no byte-order mark, \\n line ends', () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x63])), 'a\nb\nc');
});

test('import: which files, and the folder they\'re all in', () => {
  assert.ok(isNoteFile('a.md') && isNoteFile('x/b.MARKDOWN') && isNoteFile('c.txt'));
  assert.ok(!isNoteFile('pic.png') && !isNoteFile('.obsidian/a.md') && !isNoteFile('__MACOSX/a.md') && !isNoteFile('v/.trash/a.md'));
  assert.equal(commonFolder(['Vault/a.md', 'Vault/x/b.md']), 'Vault/');
  assert.equal(commonFolder(['Vault/a.md', 'b.md']), '');
  assert.equal(commonFolder(['a.md']), '');
});

test('import: folders as a tag', () => {
  assert.equal(folderTag('a.md'), null);
  assert.equal(folderTag('Work/Clients/acme.md'), 'work/clients');
  assert.equal(folderTag('Work Stuff/2026 Trips!/a.md'), 'work-stuff/2026-trips');
  assert.equal(folderTag('Résumé/a.md'), 'résumé');
  assert.equal(folderTag('2026/a.md'), null); // (no letter: not a tag)
  assert.equal(folderTag('2026/Lisbon/a.md'), 'lisbon');
});

test('import: the title, from the block, a heading, the first line when it\'s the name, else the name', () => {
  const head = noteFromFile('a.md', '# Trip to Lisbon\n\nPack light.', NOW);
  assert.equal(head.title, 'Trip to Lisbon');
  assert.equal(head.text, '---\ntitle: Trip to Lisbon\n---\nPack light.');
  // (Apple Notes, Keep: the file is named for its first line.)
  const named = noteFromFile('Groceries.txt', 'Groceries\nmilk\neggs', NOW);
  assert.equal(named.text, '---\ntitle: Groceries\n---\nmilk\neggs');
  // (Obsidian: the name is the title, the text starts with the text, its #tags its tags.)
  const obs = noteFromFile('Ideas.md', 'Something about #work/plans here.\n', NOW);
  assert.equal(obs.title, 'Ideas');
  assert.deepEqual(obs.tags, ['work/plans']);
  assert.ok(obs.text.endsWith('---\nSomething about #work/plans here.\n'));
  // (A block without a title: the name.)
  const props = noteFromFile('Meeting.md', '---\naliases: [m]\n---\nbody', NOW);
  assert.equal(props.text, '---\ntitle: Meeting\naliases: [m]\n---\nbody');
  // (A block with one: as it is.)
  assert.equal(noteFromFile('x.md', '---\ntitle: Own\n---\nbody', NOW).text, '---\ntitle: Own\n---\nbody');
});

test('import: a folder\'s tag joins the note\'s own', () => {
  const n = noteFromFile('Gym/Legs.md', '---\ntitle: Leg day\ntags: [training]\n---\nsquats', NOW);
  assert.deepEqual(readFrontmatter(n.text).tags, ['training', 'gym']);
  assert.deepEqual(n.tags, ['gym', 'training']);
});

test('import: an exported note round-trips: dates to the list, id and shared out of the text', () => {
  const text = '---\ntitle: Leg day\ntags: [gym]\n---\nsquats\n';
  const meta = { id: 'abc-123', created: Date.parse('2026-01-02T03:04:05Z'), updated: Date.parse('2026-02-03T04:05:06Z'), shared: true };
  const n = noteFromFile('Leg day.md', exportText(text, meta), NOW);
  assert.equal(n.text, text);
  assert.equal(n.created, meta.created);
  assert.equal(n.updated, meta.updated);
  assert.equal(n.from, 'abc-123');
  assert.equal(n.deleted, false);
  assert.equal(noteFromFile('deleted/Leg day.md', exportText(text, meta), NOW).deleted, true);
  // (Another app's deleted/ folder is only a folder.)
  assert.equal(noteFromFile('deleted/x.md', 'x', NOW).deleted, false);
});

test('import: dates: none is now, the future is now, a date that isn\'t one stays as text', () => {
  const none = noteFromFile('a.md', 'a', NOW);
  assert.equal(none.created, NOW);
  assert.equal(none.updated, NOW);
  const ahead = noteFromFile('a.md', '---\ncreated: 2099-01-01T00:00:00Z\n---\na', NOW);
  assert.equal(ahead.created, NOW);
  const odd = noteFromFile('a.md', '---\ncreated: last spring\n---\na', NOW);
  assert.equal(odd.created, NOW);
  assert.match(odd.text, /created: last spring/);
  const day = noteFromFile('a.md', '---\ncreated: 2025-05-06\n---\na', NOW);
  assert.equal(day.created, Date.parse('2025-05-06'));
  assert.equal(day.updated, day.created);
});

test('import: the plan: what\'s here already, too large, empty, not a note, pictures left behind', () => {
  const plan = planImport([
    file('Vault/a.md', '# A\ntext'),
    file('Vault/Sub/b.md', '![photo](img/b.png)\n'),
    file('Vault/c.md', '  \n'),
    file('Vault/big.md', 'x'.repeat(100)),
    file('Vault/pic.png', 'png'),
    file('Vault/.obsidian/app.md', '{}'),
    file('Vault/here.md', exportText('# Here', { id: 'n1' })),
  ], { isHere: (id) => id === 'n1', maxBytes: 50, now: NOW });
  assert.deepEqual(plan.notes.map((n) => n.path), ['Vault/a.md', 'Vault/Sub/b.md']);
  assert.deepEqual(plan.notes[1].tags, ['sub']); // (Vault/, the folder all are in: no tag)
  assert.deepEqual(plan.skipped, [
    { path: 'Vault/pic.png', why: 'not a note' }, { path: 'Vault/c.md', why: 'empty' }, { path: 'Vault/big.md', why: 'too large' },
  ]);
  assert.deepEqual(plan.already, ['Vault/here.md']);
  assert.equal(plan.images, 1);
  assert.ok(plan.bytes > 0);
});

test('import: a zip read back, stored (Plim\'s export) and deflated (everyone else\'s)', async () => {
  const stored = zipFiles([{ path: 'a.md', text: 'one', time: NOW }, { path: 'deleted/ö.md', text: 'two', time: NOW }]);
  assert.ok(isZip(stored));
  assert.deepEqual((await unzip(stored)).map((f) => [f.path, decodeText(f.bytes)]), [['a.md', 'one'], ['deleted/ö.md', 'two']]);
  assert.deepEqual((await unzip(stored, (p) => p.startsWith('deleted/'))).map((f) => f.path), ['deleted/ö.md']);

  // (A deflated one: the stored zip with its second entry swapped for a deflated copy, as zip tools write.)
  const text = 'hello hello hello hello';
  const deflated = deflatedZip('Vault/x.md', text);
  assert.deepEqual((await unzip(deflated)).map((f) => [f.path, decodeText(f.bytes)]), [['Vault/x.md', text]]);
  await assert.rejects(unzip(te.encode('not a zip at all, not at all, not at all')), /not a zip/);
});

/** A one-file zip, its file deflated. */
function deflatedZip(path, text) {
  const name = te.encode(path);
  const data = deflateRawSync(te.encode(text));
  const raw = te.encode(text);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, 8, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, raw.length, true);
  local.setUint16(26, name.length, true);
  const entry = new DataView(new ArrayBuffer(46));
  entry.setUint32(0, 0x02014b50, true);
  entry.setUint16(10, 8, true);
  entry.setUint32(20, data.length, true);
  entry.setUint32(24, raw.length, true);
  entry.setUint16(28, name.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + name.length, true);
  end.setUint32(16, 30 + name.length + data.length, true);
  const parts = [new Uint8Array(local.buffer), name, data, new Uint8Array(entry.buffer), name, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
