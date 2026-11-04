// Search (#24): the field under New note. With words in it, the list is the notes that have every
// one of them (in the tag picked, if one is), each with its lines that matched, those with every
// word in the title first; the tags step aside. It all happens on this device, over the notes'
// text (the server can't read it, so it can't search it): each note's text is read from this
// device's copy, or fetched once if there's none, and kept in memory while the vault is open.
// The open note shows what was found in it: every match marked, in the editor and on the page,
// and a bar with how many, the next and the one before. (The matching itself: ../core/search.js.)
import { isOffline } from '../core/api.js';
import { findAll, matchNote, queryWords, ranked } from '../core/search.js';
import { currentMode, pageRanges, reading, revealOnPage } from './reading.js';
import { syncFor } from './shares.js';
import { leaveTrash } from './trash.js';
import { $, notesMap, state, TOUCH } from './shared.js';

// From app.js (init): the editor, and the note list's render.
let editor, renderList;
export function init(deps) {
  ({ editor, renderList } = deps);
}

let query = ''; // what's in the field
let words = []; // its words, folded (core/search.js)
// What a search found in the open note: the match you're at, the note's ranges (as last found),
// whether its bar was closed (until the words change, or another result is opened), and a note
// just opened from the results (shown at its first match once it's up).
const find = { current: 0, ranges: [], closed: false, opened: null };

/** Whether the list is a search's results. */
export const searching = () => words.length > 0;

// ---- the notes' text ----

// Each note's text as last read, and the note's "updated" then (an older one is read again);
// `text: null`: it couldn't be read (offline, with no copy here; or it failed).
const texts = new Map();
const queue = [];
const queued = new Set();
let running = 0;
const AT_ONCE = 3; // (notes read at the same time)
const RETRY_MS = 30_000; // (a note that couldn't be read offline: tried again after this)

function want(id) {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
}

function pump() {
  while (running < AT_ONCE && queue.length) {
    const id = queue.shift();
    running++;
    readNote(id).finally(() => {
      running--;
      queued.delete(id);
      redrawSoon();
      pump();
    });
  }
}

/** A note's text: this device's copy, brought up to date from the server (which then keeps it here too). */
async function readNote(id) {
  const updated = notesMap().get(id)?.get('updated') ?? 0;
  let s = null;
  try {
    s = await syncFor(id);
    const here = await s.loadLocal();
    try {
      await s.pull();
    } catch (e) {
      if (!isOffline(e)) throw e;
      if (!here) return texts.set(id, { text: null, updated, offline: true, at: Date.now() });
    }
    texts.set(id, { text: s.ydoc.getText('body').toString(), updated });
  } catch (e) {
    console.warn('search: could not read a note', e);
    texts.set(id, { text: null, updated });
  } finally {
    s?.close();
  }
}

let redrawTimer = null;
function redrawSoon() {
  if (redrawTimer || !searching()) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    if (searching()) renderList();
  }, 120);
}

const openText = () => state.note?.sync?.ydoc?.getText('body').toString() ?? '';

/**
 * A note's text to search now (the open one's as it is, once it's in the editor), or null (not
 * read yet, or not readable). (Not the open one's while it loads: its text is empty until then, so
 * a result just opened would leave the list for a moment, and the others move up and back.)
 */
function textOf(n) {
  if (state.note?.id === n.id && state.note.unbind) return openText();
  const t = texts.get(n.id);
  // (Not read yet, or changed since; one that couldn't be read offline, tried again now and then.)
  if (!t || (t.text !== null && t.updated < n.updated) || (t.offline && Date.now() - t.at > RETRY_MS)) want(n.id);
  return t ? t.text : null;
}

// What each note matched, kept with the text and words it was for (the list is drawn often).
const matched = new Map();
function matchOf(n, text) {
  const m = matched.get(n.id);
  if (m && m.text === text && m.words === words && m.title === n.title) return m.match;
  const match = matchNote(n.title, text, words);
  matched.set(n.id, { text, words, title: n.title, match });
  return match;
}

/**
 * The notes (as the list has them, in its order) that have every word, best first, each with
 * `match` (core/search.js matchNote); and how many were searched, and how many couldn't be yet.
 */
export function searchResults(notes) {
  const rows = [];
  let searched = 0, waiting = 0, away = 0, failed = 0;
  for (const n of notes) {
    const text = textOf(n);
    if (text == null) {
      const t = texts.get(n.id);
      if (!t) waiting++;
      else if (t.offline) away++;
      else failed++;
      continue;
    }
    searched++;
    const match = matchOf(n, text);
    if (match) rows.push({ ...n, match });
  }
  return { rows: ranked(rows), searched, waiting, away, failed, total: notes.length };
}

/** The line under the field: how many found, or how far the search has got, or why not all. */
export function renderSummary(found) {
  const line = $('search-summary');
  line.hidden = !found;
  if (!found) return;
  const { rows, searched, waiting, away, failed, total } = found;
  const n = rows.length, count = rows.reduce((sum, r) => sum + r.match.count, 0);
  const said = `“${query.trim()}”`;
  let text;
  if (waiting) text = `Searching… ${searched} of ${total} notes`;
  else if (n) text = `${n === 1 ? '1 note' : `${n} notes`}${count > n ? ` · ${count} matches` : ''}`;
  else text = `No notes with ${said}${words.length > 1 ? ' (every word has to be in a note)' : ''}`;
  if (away && !waiting) text += ` · ${away === 1 ? '1 note isn’t' : `${away} notes aren’t`} on this device while offline`;
  if (failed && !waiting) text += ` · ${failed === 1 ? '1 note' : `${failed} notes`} couldn’t be read`;
  line.textContent = text;
}

/** A result's lines that matched, its words marked. */
export function resultLines(match) {
  return match.lines.map((l) => {
    const el = Object.assign(document.createElement('span'), { className: 'row-line' });
    let at = 0;
    for (const [a, b] of l.ranges) {
      el.append(l.text.slice(at, a), Object.assign(document.createElement('mark'), { textContent: l.text.slice(a, b) }));
      at = b;
    }
    el.append(l.text.slice(at));
    return el;
  });
}

// ---- the field ----

function setQuery(q) {
  query = q;
  const next = queryWords(q);
  const changed = next.join(' ') !== words.join(' ');
  words = next;
  $('search-clear').hidden = !q;
  if (!changed) return;
  if (words.length) leaveTrash();
  find.closed = false;
  find.current = 0;
  renderList();
  markNote();
}

/** The search over: the field empty, all notes listed, nothing marked. */
function clearSearch() {
  $('search-input').value = '';
  setQuery('');
}

$('search-input').addEventListener('input', (e) => setQuery(e.target.value));
$('search-clear').addEventListener('click', () => {
  clearSearch();
  $('search-input').focus();
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('search-input').value) clearSearch();
    else $('search-input').blur();
    e.preventDefault();
  } else if (e.key === 'Enter' && TOUCH.matches) {
    // A phone's (or a tablet's) Search key: the keyboard put away, the results in full view; a tap
    // opens one. (Not the first opened: that's a keyboard's Enter, below.)
    e.preventDefault();
    $('search-input').blur();
  } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
    // The first result: opened (Enter), or reached to move through them (↓).
    const first = $('note-list').querySelector('li[data-id] > button');
    if (!first || !searching()) return;
    e.preventDefault();
    if (e.key === 'Enter') first.click();
    else first.focus();
  }
});
// Ctrl+Shift+F: to the field, its words picked, from anywhere in your notes.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && state.index && !$('view-notes').hidden) {
    e.preventDefault();
    $('search-input').focus();
    $('search-input').select();
  }
});

// ---- what was found in the open note ----

/** A result picked from the list (before it opens): shown at its first match. */
export function resultOpened(id) {
  find.opened = id;
  find.current = 0;
  find.closed = false;
}

/** The open note's matches marked (in the editor, and on the page if it's up), and the bar. */
function markNote() {
  const on = searching() && state.note && !find.closed;
  find.ranges = on ? findAll(openText(), words) : [];
  const n = find.ranges.length;
  if (find.current >= n) find.current = Math.max(0, n - 1);
  editor.setFind?.(n ? words : null, find.current);
  markPage();
  // (A phone's editor marks nothing: the bar is for the page there.)
  const shows = n > 0 && (Boolean(editor.setFind) || reading());
  $('find-bar').hidden = !shows;
  if (!shows) return;
  $('find-words').textContent = `“${query.trim()}”`;
  $('find-count').textContent = `${find.current + 1} of ${n}`;
}

function markPage() {
  if (!globalThis.CSS?.highlights) return; // (a browser without highlights: the bar still counts and moves)
  const ranges = searching() && reading() && !find.closed ? find.ranges : [];
  const cur = ranges[find.current];
  CSS.highlights.set('find', new Highlight(...pageRanges(ranges.filter((r) => r !== cur))));
  CSS.highlights.set('find-current', new Highlight(...pageRanges(cur ? [cur] : [])));
}

/** The match you're at, in sight: on the page in Preview, else in the editor (in Split the page follows it). */
function reveal() {
  const at = find.ranges[find.current];
  if (!at) return;
  if (currentMode() === 'preview') revealOnPage(at[0]);
  else editor.reveal?.(at[0]);
}

function step(by) {
  const n = find.ranges.length;
  if (!n) return;
  find.current = (find.current + by + n) % n;
  markNote();
  reveal();
}

$('find-next').addEventListener('click', () => step(1));
$('find-prev').addEventListener('click', () => step(-1));
$('find-close').addEventListener('click', () => {
  find.closed = true;
  markNote();
});
document.addEventListener('keydown', (e) => {
  if ($('find-bar').hidden) return;
  // Ctrl+G (and F3) the next, with Shift the one before; Esc (not in a field or the editor) closes the bar.
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') || e.key === 'F3') {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape' && !e.target.closest?.('input, textarea, [contenteditable], dialog')) {
    find.closed = true;
    markNote();
  }
});

// A note shown (ui/note.js): its matches; one opened from the results, at its first. (On a phone it
// opens as a page, where they can be marked.)
document.addEventListener('plim:note-bound', (e) => {
  const fromResults = find.opened === e.detail.id;
  find.opened = null;
  if (fromResults) {
    find.current = 0;
    find.closed = false;
  }
  markNote();
  if (fromResults) reveal();
});
document.addEventListener('plim:note-gone', () => {
  find.ranges = [];
  $('find-bar').hidden = true;
  markPage();
});
// The page drawn again (the note changed, the mode switched): its marks again.
$('reading').addEventListener('plim:drawn', () => searching() && markNote());
// Typing in the note: its matches counted again (the editor marks them itself).
let typed = null;
$('editor').addEventListener('input', () => {
  clearTimeout(typed);
  if (searching()) typed = setTimeout(markNote, 200);
});
