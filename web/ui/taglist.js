// Views and tags (#539). Views are where you are, in the sidebar (a phone: a switch at the top of
// the list): Notes, every note; Connected (#552), the notes agents see (shared with them) and those
// an agent or a script wrote in (once there are some, or an agent is connected); and Recently
// deleted (ui/trash.js). Tags (#308) are what a note is about,
// chips over the list, inside the view: each tag the view's notes have. A tag is a word: #gym/legs
// is a chip of its own, and #gym lists only the notes tagged #gym. The chips are one row that
// scrolls sideways (#549); none picked is every note (no All), and the one picked comes first,
// with ×, a tap on it every note again. A tag on a note's page (Preview) picks it too
// (ui/reading.js). The rest of the app it needs comes through init().
import { tagsByRecent } from '../core/tags.js';
import { now as clockNow } from '../core/clock.js';
import { writerSummary } from '../core/connections-sync.js';
import { agentMarks, agentNames, notebookReach, writerMarks } from './reach.js';
import { leaveTrash } from './trash.js';
import { $, el, keyed, notesMap, PHONE, state } from './shared.js';

// From app.js (init): the note list's render.
let renderList;
export function init(deps) {
  ({ renderList } = deps);
}

/**
 * A new tag (or one gone) moves the chips after it sideways, and the Connected view coming or going
 * moves the list under it: not while someone may be about to tap (#442). While the pointer moves
 * over the sidebar, and for a moment after it (or a touch, a scroll) stops, chips aren't added or
 * removed, nor the view; they catch up as the pointer leaves, or once things are still. (Not for
 * as long as a pointer rests there: someone reading with the mouse parked on the list.)
 */
const QUIET_MS = 1500;
let busyUntil = 0;
let behind = false; // chips (or the Connected view) waiting to be added or removed
let catchUpTimer;
const sidebar = $('sidebar-scroll');
const touched = () => {
  busyUntil = Date.now() + QUIET_MS;
  clearTimeout(catchUpTimer);
  catchUpTimer = setTimeout(catchUp, QUIET_MS + 50);
};
for (const type of ['pointermove', 'touchstart', 'wheel', 'scroll']) sidebar.addEventListener(type, touched, { passive: true });
sidebar.addEventListener('pointerleave', () => {
  busyUntil = 0;
  catchUp();
});
const inUse = () => Date.now() < busyUntil;
function catchUp() {
  if (behind && !inUse()) renderList();
}
let picking = false; // (a view or a chip picked just now: what's shown changes, as asked)

/** The views and the chips, from the notes listed (each with its tags, and whether it's connected). */
export function renderTags(all) {
  const reach = notebookReach();
  const connected = all.filter((n) => n.connected);
  // (Connected: once a note is, or an agent is connected; before, it'd have nothing to show.)
  const any = connected.length > 0 || reach.length > 0;
  if (state.inConnected && !any) state.inConnected = false;
  const viewBehind = any === $('view-connected').hidden && !picking && inUse();
  if (!viewBehind) $('view-connected').hidden = $('view-switch').hidden = !any;
  // The view you're in, marked (Recently deleted, when it's picked, marks itself: ui/trash.js, after this).
  for (const b of document.querySelectorAll('#notes-nav .view')) {
    if ((b.dataset.view === 'connected') === state.inConnected) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const b of $('view-switch').querySelectorAll('[data-view]')) b.setAttribute('aria-checked', String((b.dataset.view === 'connected') === state.inConnected));
  $('notes-count').textContent = String(all.length);
  for (const m of document.querySelectorAll('.view-marks')) m.replaceChildren(...(reach.length ? [agentMarks(reach, { label: false, compact: true })] : []));
  $('view-connected').title = 'The notes shared with agents, and those an agent or a script wrote in';
  // The view's name over its notes; Connected's, what's in it.
  $('notes-label').textContent = state.inConnected ? 'Agents' : 'Notes'; // (the view called Connected, then Authors, before: its data-view and state keep that name)
  $('notes-head').classList.remove('picked');
  $('tag-clear').hidden = true;
  $('notes-about').hidden = !state.inConnected;
  $('notes-about').replaceChildren(...(state.inConnected
    ? [agentMarks(reach, { label: false }), reach.length
      ? `Notes shared with agents, which ${agentNames(reach)} ${reach.length === 1 ? 'reads and edits' : 'read and edit'}, and notes an agent or a script wrote in.`
      : 'Notes shared with agents, and notes an agent or a script wrote in.']
    : []));
  // Who writes (#564): Connected's table, a row per agent or script; one picked, only its notes.
  const writers = state.inConnected ? writerSummary(notesMap(), clockNow()) : [];
  if (state.writerFilter && !writers.some((w) => w.name.toLowerCase() === state.writerFilter.toLowerCase())) state.writerFilter = null;
  $('writers').hidden = !writers.length;
  keyed($('writers-rows'), writers, (w) => w.name.toLowerCase(), () => {
    const tr = el('tr', '');
    const b = el('button', 'writer-pick', { type: 'button' });
    b.append(el('span', 'reach-badge'), el('span', 'visually-hidden')); // (the badge says its name; the words, for a screen reader)
    tr.append(el('th', '', { scope: 'row' }), el('td', 'num'), el('td', 'num'), el('td', 'num'));
    tr.firstChild.append(b);
    return tr;
  }, (tr, w) => {
    const on = state.writerFilter?.toLowerCase() === w.name.toLowerCase();
    const [mark] = writerMarks([w.name]);
    const b = tr.querySelector('.writer-pick');
    b.dataset.writer = w.name;
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? `${w.name}: showing its notes. Tap to show every note` : `Show the notes ${w.name} wrote in`;
    b.firstChild.className = mark.script ? 'reach-badge script' : 'reach-badge';
    b.firstChild.dataset.i = mark.initial;
    b.firstChild.dataset.name = w.name;
    b.firstChild.setAttribute('aria-hidden', 'true');
    b.lastChild.textContent = w.name;
    tr.classList.toggle('picked', on);
    tr.children[1].textContent = String(w.notes);
    tr.children[2].textContent = w.week ? String(w.week) : '–';
    tr.children[3].textContent = w.last ? shortAgo(w.last, clockNow()) : '–';
    tr.children[3].title = w.last ? new Date(w.last).toLocaleString() : 'Not known: written before times were kept';
  });
  // The view's tags, each a chip (updated in place, keyed); the one picked, pressed, first.
  // (The most recently used first: a tag on a note made or edited lately comes forward, old ones drift back.)
  let counts = tagsByRecent((state.inConnected ? connected : all).filter((n) => !state.inConnected || wroteIn(n)));
  // A tag picked that no note here has any more: all of them again.
  if (state.tagFilter && !counts.some(([t]) => t === state.tagFilter)) state.tagFilter = null;
  if (state.tagFilter) counts = [...counts.filter(([t]) => t === state.tagFilter), ...counts.filter(([t]) => t !== state.tagFilter)];
  // (Chips added or removed would move the others: not now if the sidebar is in use, above.)
  const shown = [...$('tag-chips').children].map((b) => b.dataset.key);
  const changed = shown.length !== counts.length || counts.some(([t], i) => t !== shown[i]);
  behind = viewBehind || (changed && !picking && shown.length > 0 && inUse());
  picking = false;
  if (behind) {
    const now = new Map(counts);
    counts = shown.map((t) => [t, now.get(t) ?? 0]);
  }
  $('chips').hidden = !counts.length;
  keyed($('tag-chips'), counts, ([t]) => t, () => el('button', 'chip tag-chip', { type: 'button' }), (b, [t, n]) => {
    const on = t === state.tagFilter;
    b.dataset.tag = t;
    b.replaceChildren(el('span', 'chip-name', { textContent: `#${t}` }), ...(on ? [clearIcon()] : []));
    b.title = on ? `#${t}: showing its notes. Tap to show every note` : `#${t}: ${n} ${n === 1 ? 'note' : 'notes'}`;
    b.setAttribute('aria-pressed', String(on));
  });
  fades();
}

/** Whether the writer picked in Connected's table (#564) wrote in note `n` (none picked: yes). */
export const wroteIn = (n) => !state.writerFilter || n.writers.some((w) => w.toLowerCase() === state.writerFilter.toLowerCase());

/** When, as short as a table's column: "now", "12m", "3h", "5d", then the date ("Oct 3"). */
function shortAgo(at, now) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The picked chip's ×: built, not markup (no innerHTML in the app). */
function clearIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon clear');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
  svg.append(p);
  return svg;
}

/** The row faded at an edge with more chips past it. */
function fades() {
  const row = $('chip-row');
  row.classList.toggle('more-left', row.scrollLeft > 1);
  row.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
}
$('chip-row').addEventListener('scroll', fades, { passive: true });
new ResizeObserver(fades).observe($('chip-row'));
// A computer's wheel over the row (up and down, as most mice have): sideways through it.
$('chip-row').addEventListener('wheel', (e) => {
  const row = $('chip-row');
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
  e.preventDefault();
  row.scrollLeft += e.deltaY;
}, { passive: false });

/** "Show all" under the list: every note, not the first few (until the page is reloaded or locked). */
export function showAllNotes() {
  state.showAllNotes = true;
}

/** Show only the view's notes tagged `tag`, or all of them (null). */
export function pickTag(tag) {
  picking = true;
  state.tagFilter = tag;
  state.showAllNotes = Boolean(tag) || state.showAllNotes; // (a tag's notes: all of them, not the first few)
  renderList();
  $('sidebar-scroll').scrollTop = 0;
  $('chip-row').scrollLeft = 0; // (the one picked first, in sight; none, the row from its start)
}

/** Go to a view: every note ('notes'), or Connected ('connected'); out of Recently deleted. */
function pickView(view) {
  leaveTrash();
  state.inConnected = view === 'connected';
  state.writerFilter = null;
  pickTag(state.tagFilter); // (a tag picked stays, if any of the view's notes have it)
}

/** Show only the notes `name` wrote in (Connected's table, #564), or every one (null). */
function pickWriter(name) {
  state.writerFilter = name;
  state.showAllNotes = Boolean(name) || state.showAllNotes;
  picking = true;
  renderList();
}
$('writers-rows').addEventListener('click', (e) => {
  const b = e.target.closest('.writer-pick');
  if (b) pickWriter(b.getAttribute('aria-pressed') === 'true' ? null : b.dataset.writer);
});

for (const b of document.querySelectorAll('#notes-nav .view, #view-switch [data-view]')) b.addEventListener('click', () => pickView(b.dataset.view));
// A phone: Recently deleted, at the end of the list, is the sidebar's.
$('btn-trash-foot').addEventListener('click', () => $('btn-trash').click());
// A tag: its notes (picked, or its ×: every note again).
$('tag-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.tag-chip');
  if (b) pickTag(b.dataset.tag === state.tagFilter ? null : b.dataset.tag);
});
// A tag on a note's page (Preview): its notes in the list, all of them (in Notes, not only those
// shared with agents). On a phone, the list is its own screen: back to it (the note closes, as Back does).
document.addEventListener('plim:tag', (e) => {
  e.preventDefault();
  leaveTrash();
  state.inConnected = false;
  state.writerFilter = null;
  pickTag(e.detail);
  if (PHONE.matches && state.note) $('btn-back').click();
});
