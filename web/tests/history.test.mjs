// History: diffs, versions, and what a session changed (history.js).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { b64, encrypt, randomBytes } from '../core/crypto.js';
import { DocSync } from '../core/sync.js';
import { ShareDocSync } from '../core/sharesync.js';
import { MemoryDocCache, MemoryOutbox } from '../core/vault.js';
import { shareAad } from '../core/sig.js';
import { newShareId, newShareSeed, readKeys, shareKeys } from '../core/share.js';
import { applyText, changeSummary, copyVersions, diff, diffLines, diffSummary, foldContext, listVersions, packText, readVersion, resealVersions, saveVersion, unpackText, unpackVersion, versionDue } from '../core/history.js';
import { readFileSync } from 'node:fs';
import { here, test, fakeSession, FakeShareServer } from './lib.mjs';

test('history: diff gives the shortest edit script', () => {
  const show = (ops) => ops.map((o) => o.op + o.items.join('')).join(' ');
  assert.equal(show(diff([], [])), '');
  assert.equal(show(diff([...'abc'], [...'abc'])), '=abc');
  assert.equal(show(diff([], [...'ab'])), '+ab');
  assert.equal(show(diff([...'ab'], [])), '-ab');
  assert.equal(show(diff([...'abc'], [...'xabc'])), '+x =abc');
  assert.equal(show(diff([...'abc'], [...'ab'])), '=ab -c');
  assert.equal(show(diff([...'abcd'], [...'abxd'])), '=ab -c +x =d');
  // Random inputs: the ops turn a into b, in as few steps as the longest common subsequence allows.
  const lcs = (a, b) => {
    const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
    return t[a.length][b.length];
  };
  for (let n = 0; n < 500; n++) {
    const r = () => Array.from({ length: Math.floor(Math.random() * 14) }, () => 'abc'[Math.floor(Math.random() * 3)]);
    const [a, b] = [r(), r()];
    const ops = diff(a, b);
    assert.deepEqual(ops.flatMap((o) => (o.op === '+' ? [] : o.items)), a);
    assert.deepEqual(ops.flatMap((o) => (o.op === '-' ? [] : o.items)), b);
    const steps = ops.filter((o) => o.op !== '=').reduce((k, o) => k + o.items.length, 0);
    assert.equal(steps, a.length + b.length - 2 * lcs(a, b), `${a.join('')} → ${b.join('')}`);
  }
  // Past the cap: everything out, everything in (a rewrite can't hang the page).
  assert.equal(show(diff([...'abcd'], [...'wxyz'], 2)), '-abcd +wxyz');
});

test('history: diffLines marks changed lines and, inside them, the changed words', () => {
  const rows = diffLines('Groceries\n- limes\n- oat milk', 'Groceries\n- lemons 🍋\n- oat milk\n- bread');
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.text}`), ['same:Groceries', 'del:- limes', 'add:- lemons 🍋', 'same:- oat milk', 'add:- bread']);
  assert.deepEqual(rows[1].parts, [{ text: '- ', changed: false }, { text: 'limes', changed: true }]);
  assert.deepEqual(rows[2].parts, [{ text: '- ', changed: false }, { text: 'lemons 🍋', changed: true }]);
  assert.equal(rows[4].parts, undefined, 'a new line is all new');
  assert.deepEqual(diffLines('', 'a\nb').map((r) => r.kind), ['add', 'add'], 'an empty note has no lines');
  assert.deepEqual(diffLines('same', 'same').map((r) => r.kind), ['same']);
  assert.equal(diffLines('one two', 'three four')[0].parts, undefined, 'nothing in common: no word marks');
  assert.deepEqual(diffSummary(rows), { added: 2, removed: 1 });
});

test('history: changeSummary names a version’s first change in words', () => {
  const said = (a, b) => changeSummary(diffLines(a, b));
  assert.equal(said('Trip\n- limes', 'Trip\n- lemons'), 'Changed “lemons”', 'a line and its replacement: the new one, no list mark');
  assert.equal(said('Trip', 'Trip\n## To eat\n- Ramiro'), 'Added “To eat”', 'the first change, without the heading mark');
  assert.equal(said('Trip\n- [ ] LX Factory\n- Tram', 'Trip\n- Tram'), 'Removed “LX Factory”');
  assert.equal(said('a\nb', 'a\n\n\nb\n> c'), 'Added “c”', 'blank lines are skipped for one that says something');
  assert.equal(said('a\nb', 'a\n\nb'), 'Blank lines');
  assert.equal(said('same', 'same'), '');
  assert.equal(said('one two', 'three four'), 'Removed “one two”', 'nothing in common: not a change of one line');
  assert.equal(said('', 'x'.repeat(100)), `Added “${'x'.repeat(79)}…”`, 'long lines are cut');
});

test('history: foldContext keeps 3 lines around each change and folds longer runs', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 10', 'line ten');
  const out = foldContext(diffLines(before, after));
  assert.deepEqual(out.map((r) => (r.kind === 'fold' ? `fold ${r.count}` : r.text)),
    ['fold 7', 'line 7', 'line 8', 'line 9', 'line 10', 'line ten', 'line 11', 'line 12', 'line 13', 'fold 6']);
  assert.equal(out[0].rows[0].text, 'line 0', 'a fold keeps its lines, to show them');
  // A gap of fewer than 3 lines isn't folded.
  const short = foldContext(diffLines('a\nb\nc\nd\ne\nf\ng\nh\ni', 'A\nb\nc\nd\ne\nf\ng\nh\nI'));
  assert.ok(short.every((r) => r.kind !== 'fold'));
  assert.equal(foldContext(diffLines('x\ny\nz\nw', 'x\ny\nz\nw'))[0].count, 4, 'no changes: all folded');
});

test('history: applyText makes the smallest edit, merges, and undoes', () => {
  const doc = new Y.Doc();
  const t = doc.getText('body');
  t.insert(0, 'Groceries: oat milk, lemons, bread');
  let edits = 0;
  doc.on('update', () => edits++);
  const undo = new Y.UndoManager(t, { trackedOrigins: new Set(['restore']) });
  applyText(t, 'Groceries: oat milk, limes, bread', 'restore');
  assert.equal(t.toString(), 'Groceries: oat milk, limes, bread');
  assert.equal(edits, 1, 'one transaction');
  undo.undo();
  assert.equal(t.toString(), 'Groceries: oat milk, lemons, bread', 'undone like typing');
  // Emoji are never split in half.
  for (const [from, to] of [['a😀b', 'a😃b'], ['😀', ''], ['', '🎉 hi'], ['x😀', 'x😀😀'], ['same', 'same']]) {
    const d = new Y.Doc();
    d.getText('body').insert(0, from);
    applyText(d.getText('body'), to);
    assert.equal(d.getText('body').toString(), to, `${from} → ${to}`);
  }
  // It merges with someone else's concurrent edit elsewhere in the note.
  const a = new Y.Doc();
  a.getText('body').insert(0, 'one two three');
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  applyText(a.getText('body'), 'one 2 three');
  b.getText('body').insert(b.getText('body').length, ' four');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(a.getText('body').toString(), 'one 2 three four');
  assert.equal(b.getText('body').toString(), a.getText('body').toString());
  assert.ok(versionDue(0, 100) && versionDue(100, 3700) && !versionDue(100, 3699));
});

test('history: a note keeps the text from before a session’s edits, then one per interval', async () => {
  const { api, keyring, mk } = await fakeSession();
  const ctx = () => ({ ...mk(), versionEverySecs: 1 });
  const a = new DocSync(ctx(), 'note-h');
  a.ydoc.getText('body').insert(0, 'Before');
  await a.flush();
  await a.versioning;
  assert.equal(api.versions('note-h').length, 0, 'a new note: nothing to keep yet');
  // Another session edits it: what it was first, then (an interval later) what it became.
  const b = new DocSync(ctx(), 'note-h');
  await b.load();
  b.ydoc.getText('body').insert(6, ' and after');
  await b.flush();
  await b.versioning;
  await new Promise((r) => setTimeout(r, 1100));
  b.ydoc.getText('body').insert(0, '> ');
  await b.flush();
  await b.versioning;
  const texts = await Promise.all((await listVersions(b)).map((v) => readVersion(b, v.id)));
  assert.deepEqual(texts.map((v) => v.text), ['> Before and after', 'Before'], 'newest first');
  assert.ok(texts[0].at > texts[1].at);
  // The note list keeps no history.
  assert.equal(new DocSync(ctx(), 'index').keepsHistory, false);
  // A phrase change re-encrypts them under the new key, same times (and writers, #505), still readable.
  const claude = { name: 'Claude', session: 'amber fox' };
  await saveVersion(b, 'by Claude', texts[0].at + 1, claude);
  keyring.add(2, randomBytes(32));
  await resealVersions(b);
  assert.ok(api.versions('note-h').every((v) => v.key_version === 2));
  assert.deepEqual((await Promise.all((await listVersions(b)).map((v) => readVersion(b, v.id)))).map((v) => [v.text, v.at, v.writer]),
    [['by Claude', texts[0].at + 1, claude], ...texts.map((v) => [v.text, v.at, null])]);
  [a, b].forEach((s) => s.close());
});

test('history: when someone else wipes most of a note, it’s kept as it was', async () => {
  const { api, mk } = await fakeSession();
  const ctx = () => ({ ...mk(), versionEverySecs: 3600 });
  const a = new DocSync(ctx(), 'note-w');
  const text = 'A shopping list long enough to matter: oat milk, lemons, sourdough, coffee.';
  a.ydoc.getText('body').insert(0, text);
  await a.flush();
  await a.versioning;
  const b = new DocSync(ctx(), 'note-w');
  await b.load();
  b.editedThisSession = true; // (a wiper whose app saves no versions, as one that means it wouldn't)
  b.ydoc.getText('body').delete(0, b.ydoc.getText('body').length);
  await b.flush();
  // a hadn't saved a version (a new note), and an hour hasn't passed: the wipe arriving keeps it anyway.
  await a.pull();
  await a.versioning;
  const kept = await Promise.all((await listVersions(a)).map((v) => readVersion(a, v.id)));
  assert.deepEqual(kept.map((v) => v.text), [text]);
  // A small deletion keeps nothing.
  a.ydoc.getText('body').insert(0, text);
  await a.flush();
  b.ydoc.getText('body').delete(0, 5);
  await b.pull();
  assert.equal(api.versions('note-w').length, 1);
  [a, b].forEach((s) => s.close());
});

test('history: a shared note keeps versions under its keys, checks them, and takes a private note’s along', async () => {
  const id = newShareId();
  const keys = await shareKeys(newShareSeed());
  const api = new FakeShareServer(id, keys.pubkey);
  const ctx = () => ({ api, outbox: new MemoryOutbox(), cache: new MemoryDocCache(), versionEverySecs: 1 });
  const a = new ShareDocSync(ctx(), { id, keys }, new Y.Doc());
  a.ydoc.getText('body').insert(0, 'Shared text');
  await a.flush();
  const b = new ShareDocSync(ctx(), { id, keys }, new Y.Doc());
  await b.pull();
  b.ydoc.getText('body').insert(0, '>> ');
  await b.flush();
  await b.versioning;
  assert.deepEqual((await Promise.all((await listVersions(b)).map((v) => readVersion(b, v.id)))).map((v) => v.text), ['Shared text']);
  // A view link can read them, not save one.
  const viewer = new ShareDocSync(ctx(), { id, keys: await readKeys(keys.encRaw, keys.pubkey) }, new Y.Doc());
  assert.equal(viewer.keepsHistory, false);
  assert.equal((await readVersion(viewer, 1)).text, 'Shared text');
  // One the server took without the share's signature (what a view link could make): refused.
  const { nonce, ciphertext } = await encrypt(keys.encKey, new TextEncoder().encode('FORGED'), shareAad(id, 'version'));
  api.versions.push({ id: 99, created_at: 100, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: api.versions[0].sig });
  await assert.rejects(readVersion(viewer, 99), /isn’t signed/);
  // A private note's history comes along when it's shared, times kept.
  const { mk } = await fakeSession();
  const priv = new DocSync({ ...mk(), versionEverySecs: 1 }, 'note-p');
  for (const [text, at] of [['first', 1000], ['second', 2000]]) await saveVersion(priv, text, at);
  // One that says who wrote it (#505): moved as it was, writer and all.
  const claude = { name: 'Claude', connection: 'plim mcp', session: 'amber fox', sid: '9f2c41d07a3b' };
  await saveVersion(priv, 'third, by Claude', 3000, claude);
  const id2 = newShareId();
  const keys2 = await shareKeys(newShareSeed());
  const dest = new ShareDocSync({ ...ctx(), api: new FakeShareServer(id2, keys2.pubkey) }, { id: id2, keys: keys2 }, new Y.Doc());
  await copyVersions(priv, dest);
  const moved = await Promise.all((await listVersions(dest)).map((v) => readVersion(dest, v.id)));
  assert.deepEqual(moved.map((v) => [v.text, v.at, v.writer]), [['third, by Claude', 3000, claude], ['second', 2000, null], ['first', 1000, null]]);
  [a, b, viewer, priv, dest].forEach((s) => s.close());
});

test('history: a version is packed (compressed) to be encrypted; packed or not, it reads back, as the terminal client reads it', async () => {
  const text = `Trip to Lisbon\n\n${'- Tram 28 early, before the crowds\n'.repeat(50)}`;
  const packed = await packText(text);
  assert.ok(packed.length * 4 < text.length, `${text.length} → ${packed.length}`);
  assert.equal(await unpackText(packed), text);
  // Every case in the shared fixture: packed here, packed by the terminal client, or saved before packing.
  const f = JSON.parse(readFileSync(new URL('fixtures/versions.json', here)));
  for (const c of f.cases) {
    const bytes = Uint8Array.from(Buffer.from(c.packed, 'base64'));
    assert.equal(await unpackText(bytes), c.text, c.by);
    assert.deepEqual((await unpackVersion(bytes)).writer, c.writer ?? null, c.by);
  }
});

test('history: a version can say who wrote it (#505); one whose writer can’t be read still gives its text', async () => {
  const w = { name: 'Claude', connection: 'plim mcp', session: 'amber fox', sid: '9f2c41d07a3b' };
  assert.deepEqual(await unpackVersion(await packText('Plan\n- one', w)), { text: 'Plan\n- one', writer: w });
  assert.deepEqual(await unpackVersion(await packText('no writer')), { text: 'no writer', writer: null }, 'format 1');
  assert.deepEqual(await unpackVersion(await packText('', {})), { text: '', writer: {} });
  // Only its string fields are kept, written or read.
  const odd = await unpackVersion(await packText('t', { name: 'Codex', colour: 'green', session: 7 }));
  assert.deepEqual(odd.writer, { name: 'Codex' });
  // Cut short: refused.
  const { deflateRawSync } = await import('node:zlib');
  const raw = (body) => Uint8Array.from(Buffer.concat([Buffer.from([0, 0x54, 0x5a, 2]), deflateRawSync(Buffer.from(body))]));
  await assert.rejects(unpackVersion(raw([0, 0])), /cut short/);
  await assert.rejects(unpackVersion(raw([0, 0, 0, 99, 0x7b, 0x7d])), /cut short/);
});
