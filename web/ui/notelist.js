// The note list: which notes it shows (newest first, a tag picked, the first few then "Show all"),
// each row drawn in place and sliding when the order changes, and the open note's title in its
// bar; and notes deleted on another device while they were being edited here, brought back.
// (Out of app.js, #446. The screens it draws with are imported; they get renderList from app.js.)
import { now as clockNow } from '../core/clock.js';
import { createdLabel, sortNotes } from '../core/notesort.js';
import { reviveEdited } from '../core/trash.js';
import { rowTags, tagMatches } from '../core/tags.js';
import { isConnected, NOTEBOOK, writersOf } from '../core/connections-sync.js';
import { closeNote, openNote, renderEmpty, renderScrolled } from './note.js';
import { renderTrash } from './trash.js';
import { closeMenu, endsLongPress, renderShareLight, rowMenu } from './menus.js';
import { renderTags, wroteIn } from './taglist.js';
import { appsOnly, checkNewlyShared, followHome, shareOf } from './shares.js';
import { renderSummary, resultLines, resultOpened, searchResults, searching } from './search.js';
import { agentMarks, agentNames, notebookReach, sharedWords, writerMarks } from './reach.js';
import { $, PHONE, editedHere, el, keyed, notesMap, relTime, showToast, state } from './shared.js';

const LIST_FIRST = 30; // notes listed before "Show all"

/** The notes (not deleted), each as the list shows it, in the order picked beside the list's label. */
export function visibleNotes() {
  const out = [];
  notesMap().forEach((m, id) => {
    if (!m.get('deleted')) {
      const tags = m.get('tags');
      out.push({
        id, title: m.get('title') || '', updated: m.get('updated') || 0, created: m.get('created') || 0,
        tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [],
        lastBy: typeof m.get('lastBy') === 'string' ? m.get('lastBy') : null, // (an app wrote in it last, #389)
        notebook: m.get('place') === NOTEBOOK, // (shared with agents, #484, #514)
        writers: writersOf(m), // (the agents and scripts that wrote in it, #552)
        connected: isConnected(m), // (in the Connected view, #552)
      });
    }
  });
  // In the order picked beside the list's label (#344): last edited, or date created; newest first.
  return sortNotes(out, state.sortBy, clockNow());
}

let listToTop = false; // (the open note moved to the top while the list was hidden: follow it there when it's back)
let agentsNow = []; // the agents that see the notes shared with them, for the rows' marks (#514)

// ---------- a note deleted elsewhere while it was being edited (#54) ----------

/**
 * Deleted notes come back if they were edited where the deletion wasn't seen
 * (trash.js reviveEdited). Edits here are only in a note's "updated" every
 * 30 s, so a deletion that arrives for a note edited here after what the
 * deleting device saw first gets that edit's time. Then: back, and said so.
 */
/** Deleted, but edited here after what the deletion saw: it's coming back. */
function editedSinceDeleted(id) {
  const m = notesMap().get(id);
  const seen = m?.get('deletedSeen');
  const at = editedHere.get(id);
  return Boolean(m?.get('deleted') && !m.get('purged') && typeof seen === 'number' && at > seen && at > (m.get('updated') ?? 0));
}

function keepEditsHere() {
  queueMicrotask(() => {
    if (!state.index) return;
    const notes = notesMap();
    state.index.ydoc.transact(() => {
      for (const id of editedHere.keys()) if (editedSinceDeleted(id)) notes.get(id).set('updated', editedHere.get(id));
    });
    const back = reviveEdited(notes);
    if (!back.length) return;
    const name = (n) => `“${n.title || 'Untitled'}”`;
    showToast(back.length === 1
      ? `${name(back[0])} was deleted on another device while it was being edited, so it’s back.`
      : `${back.length} notes were deleted on another device while being edited, so they’re back.`);
  });
}

/** A note's row in the list (or the "No notes yet" line): made once, then filled in by fillRow. */
function makeRow(n) {
  const li = document.createElement('li');
  if (n.empty) {
    li.className = 'list-empty';
    return li;
  }
  li.dataset.id = n.id;
  const btn = document.createElement('button');
  btn.addEventListener('click', (e) => {
    if (endsLongPress()) return e.preventDefault(); // (and the next click, a keyboard's too, opens it)
    if (searching()) resultOpened(n.id); // (shown at its first match, #24)
    openNote(n.id);
  });
  rowMenu(btn, n.id);
  li.append(btn);
  return li;
}

/** A row as its note is now: title, when (as the list is ordered), its tags, shared or not, open or not. */
function fillRow(li, n) {
  if (n.empty) {
    li.textContent = state.inConnected
      ? state.tagFilter ? `No notes here tagged #${state.tagFilter}` : 'No notes from agents yet'
      : state.tagFilter ? `No notes tagged #${state.tagFilter}` : 'No notes yet';
    return;
  }
  const btn = li.firstChild;
  btn.setAttribute('aria-current', String(n.id === state.note?.id));
  const title = Object.assign(document.createElement('span'), {
    className: n.title ? 'title' : 'title untitled',
    textContent: n.title || 'Untitled',
  });
  // ("Shared": with people. A note shared only so an app can reach it shows that app's badge instead, #369.)
  const shared = shareOf(n.id) && !appsOnly(shareOf(n.id)) ? ' · Shared' : '';
  if (shareOf(n.id)) btn.dataset.shared = shared ? 'people' : 'apps';
  else delete btn.dataset.shared;
  // Its date as the list is ordered (#344): when it was edited, or when it was made.
  const byCreated = state.sortBy === 'created';
  const at = byCreated ? n.created || n.updated : n.updated;
  // (The date in a span of its own, which says it again as time goes by: retime, below.)
  const ago = el('span', 'ago', { textContent: timeWords(byCreated, at) });
  ago.dataset.at = at;
  if (byCreated) ago.dataset.created = '';
  const when = el('span', 'when');
  when.append(ago, (byCreated ? '' : n.lastBy ? ` · by ${n.lastBy}` : '') + shared);
  if (at) when.title = `${byCreated ? 'Created' : 'Edited'} ${new Date(at).toLocaleString()}`; // the exact time, on hover
  when.dataset.updated = n.updated;
  // Its tags (#350), after its date: not the one picked (the list is already its), a few, then how many more.
  const { tags, more } = rowTags(n.tags, state.tagFilter, PHONE.matches ? 2 : 3);
  if (tags.length) {
    // (Only topics, #514: they share nothing.)
    const line = Object.assign(document.createElement('span'), { className: 'row-tags' });
    tags.forEach((t, i) => line.append(i ? ' ' : '', `#${t}`));
    when.append(' · ', line);
    if (more) when.append(Object.assign(document.createElement('span'), { className: 'row-more', textContent: ` +${more}` }));
  }
  // Shared with agents (#514): their letters, at its top right (none on a note that isn't, nor in
  // the agents' view, #539: every note there is).
  // Who's connected to it (#514, #552): the agents that see it, if it's shared with them, and each
  // agent or script that wrote in it, once each; in either view (Connected's notes differ too).
  const who = n.notebook ? [...agentsNow] : [];
  for (const w of writerMarks(n.writers)) if (!who.some((a) => a.name.toLowerCase() === w.name.toLowerCase())) who.push(w);
  const marks = n.notebook || who.length ? [el('span', 'row-marks')] : [];
  const said = [n.notebook && sharedWords(agentsNow), n.writers.length && `Written in by ${agentNames(writerMarks(n.writers))}`].filter(Boolean).join('. ');
  marks[0]?.append(agentMarks(who, { title: said }));
  // A search's result (#24): its lines that matched, under the title.
  btn.replaceChildren(title, ...marks, ...(n.match ? resultLines(n.match) : []), when);
}

/** A row's date: "5 min ago" (by when it was edited), or when it was made (by date created). */
const timeWords = (byCreated, at) => (byCreated ? createdLabel(at, clockNow()) : relTime(at));

/**
 * The rows' dates said again as time goes by (#532): "just now" becomes "1 min ago", then "2 h
 * ago", then the date, without waiting for the list to be drawn again (an edit, a sync, a click).
 * Every half minute, and as soon as the page is looked at again (a tab or a phone back from sleep).
 */
function retime() {
  for (const ago of document.querySelectorAll('#note-list .ago')) {
    const words = timeWords('created' in ago.dataset, Number(ago.dataset.at));
    if (ago.textContent !== words) ago.textContent = words;
  }
}
setInterval(() => !document.hidden && retime(), 30_000);
document.addEventListener('visibilitychange', () => !document.hidden && retime());

export function renderList() {
  keepEditsHere();
  if (!state.index) return;
  checkNewlyShared();
  const list = $('note-list');
  // The tags in the sidebar, and the notes with the tag picked there (#308).
  const everything = visibleNotes();
  renderTags(everything);
  // The view's notes (#539: all of them, or those shared with agents), and those with the tag picked
  // (a tag is a word: #gym, not the notes tagged #gym/legs).
  const tagged = everything.filter((n) => (!state.inConnected || (n.connected && wroteIn(n))) && (!state.tagFilter || n.tags.some((t) => tagMatches(t, state.tagFilter))));
  agentsNow = notebookReach();
  // A search (#24): the notes with every word (in what the chips picked), best first; Recently
  // deleted and the order step aside meanwhile, and the line under the field says how many.
  const found = searching() ? searchResults(tagged) : null;
  renderSummary(found);
  $('notes-nav').hidden = $('btn-trash-foot').hidden = Boolean(found); // (the views, and a phone's Recently deleted)
  $('notes-sort').hidden = Boolean(found);
  const all = found ? found.rows : tagged;
  // The most recent LIST_FIRST, then "Show all" for the rest (and the open note, wherever it is).
  const limited = !found && !state.showAllNotes && all.length > LIST_FIRST;
  const shown = limited ? all.slice(0, LIST_FIRST) : all;
  if (limited && state.note && !shown.some((n) => n.id === state.note.id)) {
    const open = all.find((n) => n.id === state.note.id);
    if (open) shown.push(open);
  }
  $('notes-more').hidden = !limited;
  $('notes-more').textContent = `Show all ${all.length} notes`;
  const rows = shown.length || found ? shown : [{ empty: true }]; // (no notes yet: say so in the list; a search says so under its field)
  // The open note's title in its bar (also as you type: a new first line re-renders the list).
  const openTitle = state.note ? everything.find((n) => n.id === state.note.id)?.title : null;
  $('note-title').textContent = openTitle ?? '';
  if (openTitle != null) $('note-title').textContent ||= 'Untitled';
  $('note-title').classList.toggle('untitled', openTitle === '');
  renderTrash(); // (after the title: a deleted note shown, or Recently deleted, has its own)
  renderShareLight(); // (the open note's light, or an app's badge: its tags or the apps may have changed)
  // A row per note, updated in place (keyed, #442): the row under a finger or a menu stays the same
  // element when the list is drawn again (an edit here or elsewhere, a sync); made once, removed
  // only when its note leaves the list.
  const before = rowPositions(list);
  keyed(list, rows, (n) => (n.empty ? '#empty' : n.id), makeRow, fillRow);
  // The open note just moved to the top (you edited it): follow it there. On
  // phones the list is hidden while editing, so that waits until it's back.
  const open = state.note?.id;
  if (open && list.firstElementChild?.dataset.id === open && [...before.keys()][0] !== open) listToTop = true;
  if (listToTop && list.offsetParent) {
    $('sidebar-scroll').scrollTop = 0;
    listToTop = false;
  }
  slideMoved(list, before);
  renderEmpty();
  renderScrolled(); // (another note, or none, is open)
  if (state.menu?.id && !visibleNotes().some((n) => n.id === state.menu.id)) closeMenu();
  // If the open note was deleted elsewhere, close it; if it was shared or unshared elsewhere, follow it.
  // (Not one edited here since the deletion saw it: that comes back, keepEditsHere.)
  if (state.note && notesMap().get(state.note.id)?.get('deleted') && !editedSinceDeleted(state.note.id)) closeNote();
  else if (state.note) followHome();
}

// When the order changes (an edited note moves to the top, a note is added or
// removed), rows slide from where they were to where they are now, rather
// than jumping. Only rows that moved animate; title changes don't.
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const SLIDE_MS = 200;

/** Each row's position on screen, by note id. */
function rowPositions(list) {
  const out = new Map();
  for (const li of list.children) if (li.dataset.id) out.set(li.dataset.id, li.getBoundingClientRect().top);
  return out;
}

function slideMoved(list, before) {
  if (REDUCED_MOTION.matches || !before.size || !list.offsetParent) return; // hidden (phone, editing)
  const box = list.getBoundingClientRect();
  for (const li of list.children) {
    const was = before.get(li.dataset.id);
    // Rows that were scrolled out of sight just appear (after a jump to the top).
    if (was == null || was < box.top - li.offsetHeight || was > box.bottom) continue;
    const dy = was - li.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    // A row moving up passes over the ones moving down: keep it on top.
    li.classList.toggle('rising', dy > 0);
    const slide = li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: SLIDE_MS,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    });
    slide.finished.then(() => li.classList.remove('rising'), () => {});
  }
}
