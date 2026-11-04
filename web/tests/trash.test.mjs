// Recently deleted (trash.js).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { TRASH_DAYS, dateUndated, daysLeft, deleteNote, expired, forgetPurged, isPurged, markPurged, purgedRestorable, restoreNote, restorePurged, reviveEdited, trashed } from '../core/trash.js';
import { test } from './lib.mjs';

test('trash: a note deleted on one device and edited on another comes back (#54)', () => {
  // Two devices with the same note list; they sync by exchanging updates.
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };
  a.getMap('notes').set('n1', new Y.Map([['title', 'Plans'], ['updated', 1000], ['deleted', false]]));
  a.getMap('notes').set('n2', new Y.Map([['title', 'Old'], ['updated', 1000], ['deleted', false]]));
  sync();
  // A deletes both; B, offline, edits n1 (its "updated" moves on) but not n2.
  deleteNote(a.getMap('notes'), 'n1', 5000);
  deleteNote(a.getMap('notes'), 'n2', 5000);
  b.getMap('notes').get('n1').set('updated', 4000); // (before the deletion by the clock: still not seen by it)
  sync();
  for (const doc of [a, b]) assert.ok(doc.getMap('notes').get('n1').get('deleted'), 'merged: deleted, with B’s edit');
  // Either device sees it: n1 comes back, n2 (not edited) stays deleted.
  assert.deepEqual(reviveEdited(b.getMap('notes')), [{ id: 'n1', title: 'Plans' }]);
  sync();
  for (const doc of [a, b]) {
    const n = doc.getMap('notes');
    assert.equal(n.get('n1').get('deleted'), false);
    assert.equal(n.get('n1').get('deletedAt'), undefined);
    assert.equal(n.get('n2').get('deleted'), true);
  }
  assert.deepEqual(reviveEdited(a.getMap('notes')), [], 'once back, nothing more to do');
  // A deletion not edited since stays; one from before deletedSeen existed is left alone; so is a purged one.
  const n = new Y.Doc().getMap('notes');
  n.set('kept', new Y.Map([['updated', 1], ['deleted', false]]));
  deleteNote(n, 'kept', 10);
  n.set('legacy', new Y.Map([['updated', 99], ['deleted', true], ['deletedAt', 5]]));
  n.set('gone', new Y.Map([['updated', 99], ['deleted', true], ['deletedSeen', 1]]));
  markPurged(n, 'gone');
  n.get('gone').set('updated', 200);
  assert.deepEqual(reviveEdited(n), []);
  // Restoring (or purging) clears what the deletion saw.
  restoreNote(n, 'kept', 20);
  assert.equal(n.get('kept').get('deletedSeen'), undefined);
});

test('trash: a note deleted forever can be restored for 30 days, a shared one with its link (#253)', () => {
  const day = 86_400_000;
  const notes = new Y.Doc().getMap('notes');
  const share = { id: '00112233445566778899aabbccddeeff', seed: 'c2VlZA==', role: 'owner' };
  notes.set('p', new Y.Map([['title', 'Plans'], ['updated', 1], ['deleted', true]]));
  notes.set('s', new Y.Map([['title', 'Shared'], ['updated', 1], ['deleted', true], ['share', share]]));
  markPurged(notes, 'p', 10 * day);
  markPurged(notes, 's', 11 * day);
  // A shared one isn't shared while it's gone, but keeps its link's key to be read again.
  assert.equal(notes.get('s').has('share'), false);
  assert.deepEqual(purgedRestorable(notes, 12 * day).map((n) => [n.id, n.title, n.share]), [['s', 'Shared', share], ['p', 'Plans', null]]);
  // Restored: in the list again, at the top, shared again; nothing left of it being purged.
  restorePurged(notes, 's', 12 * day);
  const s = notes.get('s');
  assert.deepEqual([s.get('deleted'), s.get('updated'), s.get('share'), isPurged(notes, 's')], [false, 12 * day, share, false]);
  for (const key of ['purgedAt', 'purgedShare']) assert.equal(s.has(key), false, key);
  assert.deepEqual(purgedRestorable(notes, 12 * day).map((n) => n.id), ['p']);
  // Not one that isn't purged.
  restorePurged(notes, 'nope', 12 * day);
  assert.equal(notes.has('nope'), false);
});

test('trash: delete, restore, 30 days, delete forever, and undated old deletes', () => {
  const ydoc = new Y.Doc();
  const notes = ydoc.getMap('notes');
  const add = (id, title) => notes.set(id, new Y.Map([['title', title], ['created', 1], ['updated', 1], ['deleted', false]]));
  ['a', 'b', 'c', 'd'].forEach((id) => add(id, `note ${id}`));
  const day = 86_400_000;
  const t0 = 1_000 * day;

  deleteNote(notes, 'a', t0);
  deleteNote(notes, 'b', t0 + day);
  assert.deepEqual(trashed(notes).map((n) => n.id), ['b', 'a']); // most recent first
  assert.equal(daysLeft(t0, t0 + day), TRASH_DAYS - 1);
  assert.deepEqual(expired(notes, t0 + (TRASH_DAYS - 1) * day), []);
  assert.deepEqual(expired(notes, t0 + TRASH_DAYS * day), ['a']);

  restoreNote(notes, 'b', t0 + 2 * day);
  assert.equal(notes.get('b').get('deleted'), false);
  assert.equal(notes.get('b').get('updated'), t0 + 2 * day); // back at the top
  assert.equal(notes.get('b').has('deletedAt'), false);

  const title = notes.get('a').get('title');
  markPurged(notes, 'a', t0 + 3 * day);
  assert.equal(isPurged(notes, 'a'), true);
  assert.deepEqual(trashed(notes).map((n) => n.id), []);
  restoreNote(notes, 'a', t0);
  assert.equal(notes.get('a').get('deleted'), true, 'a note deleted forever stays gone from the trash');
  // The server keeps its data 30 days more (#253): restorable meanwhile, its title kept for that.
  assert.deepEqual(purgedRestorable(notes, t0 + 4 * day), [{ id: 'a', title, purgedAt: t0 + 3 * day, share: null }]);
  assert.deepEqual(purgedRestorable(notes, t0 + (3 + TRASH_DAYS) * day), [], 'not after 30 days');
  assert.equal(forgetPurged(notes, t0 + 4 * day), 0);
  assert.equal(forgetPurged(notes, t0 + (3 + TRASH_DAYS) * day), 1);
  assert.equal(notes.get('a').get('title'), '', 'then nothing about the note is kept');
  assert.equal(notes.get('a').has('purgedAt'), false);

  // Deleted by an older client (no deletedAt): its 30 days start now.
  notes.get('c').set('deleted', true);
  assert.equal(dateUndated(notes, t0 + 5 * day), 1);
  assert.equal(notes.get('c').get('deletedAt'), t0 + 5 * day);
  assert.equal(dateUndated(notes, t0 + 6 * day), 0);
});
