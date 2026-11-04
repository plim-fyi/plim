// Your notes moved to frontmatter (#582, #584), once: each note without a block gets one, its
// first line its title and its tags (the `#word`s it has) its tags (core/frontmatter.js
// toFrontmatter), the note as it was kept first as a version (History brings it back). Then the
// mark in your note list (its 'format' map), which every device and `plim` read: from then on a
// `#word` is text, and a note's tags are its block's. Done on unlock, in the background, once per
// note list; a device that's offline, or a note that can't be opened, waits for the next unlock.
import { movedToFrontmatter, noteTags, noteTitle, toFrontmatter } from '../core/frontmatter.js';
import { saveVersion } from '../core/history.js';
import { syncFor } from './shares.js';
import { notesMap, state } from './shared.js';

const TITLE_MAX = 200;
let running = false;

/**
 * Changes not the editor's (the header's, the move): an origin of their own, so the editor's undo
 * (which takes back what's typed in it, and anything without an origin) leaves them be.
 */
export const HEAD = Symbol('note head');

/** The note's text in `ytext` made `next`: the one replacement between them. */
export function replaceText(ytext, next) {
  const old = ytext.toString();
  if (old === next) return;
  const n = Math.min(old.length, next.length);
  let start = 0;
  while (start < n && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < n - start && old.charCodeAt(old.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  ytext.doc.transact(() => {
    if (old.length - start - end) ytext.delete(start, old.length - start - end);
    const ins = next.slice(start, next.length - end);
    if (ins) ytext.insert(start, ins);
  }, HEAD);
}

/**
 * Every note moved, then the mark set; `onDone` once it is (the open note's header shown). Each
 * note's own work: opened (the open one's, as it is), kept as a version, changed, saved.
 */
export async function moveToFrontmatter({ onDone = () => {} } = {}) {
  if (running || !state.index || state.offline || movedToFrontmatter(state.index.ydoc)) return;
  running = true;
  let left = 0;
  try {
    for (const [id, m] of [...notesMap().entries()]) {
      if (m.get('deleted') || m.get('purged')) continue;
      if (!(await moveNote(id, m).catch((e) => (console.warn('could not move a note to frontmatter', id, e), false)))) left++;
      if (!state.index) return; // (locked meanwhile)
    }
    if (left) return; // (the next unlock tries those again; the mark waits for them)
    state.index.ydoc.getMap('format').set('frontmatter', true);
    onDone();
  } finally {
    running = false;
  }
}

/** One note moved (or nothing to move): true; false if it couldn't be. */
async function moveNote(id, m) {
  const open = state.note?.id === id ? state.note.sync : null;
  const sync = open ?? (await syncFor(id));
  try {
    if (!open) await sync.load();
    if (sync.writable === false) return true; // (a view-only note of someone else's: theirs to move)
    const ytext = sync.ydoc.getText('body');
    const before = ytext.toString();
    const next = toFrontmatter(before);
    if (next === before) return true;
    if (sync.keepsHistory !== false) await saveVersion(sync, before).catch((e) => console.warn('could not keep the note as it was', e));
    replaceText(ytext, next);
    await sync.flush();
    state.index.ydoc.transact(() => {
      const title = noteTitle(next).slice(0, TITLE_MAX);
      if (m.get('title') !== title) m.set('title', title);
      m.set('tags', noteTags(next));
    });
    return true;
  } finally {
    if (!open) sync.close();
  }
}
