// The open note (#259): opening, closing and making one, its title and status, who else is
// in it, its address in the bar (#299: /n/<id>, Back and Forward moving between notes), and
// its cursor and scroll remembered per note on this device. (The editor itself: ../editor.js.)
// The rest of the app it needs comes through init().
import * as Y from '../vendor/yjs.mjs';
import { DocSync, REMOTE } from '../core/sync.js';
import { now as clockNow } from '../core/clock.js';
import { Presence } from '../core/presence.js';
import { kvGet, kvPut } from '../core/vault.js';
import { noteIdAt, notePath } from '../core/noteurl.js';
import { noteTags, setTags, setTitle } from '../core/frontmatter.js';
import { bindHead, focusTitle, headOpening, headed, unbindHead } from './notehead.js';
import { localNow, stamp, withoutCommand } from '../editor/slash.js';
import { renderPresence, syncFor, yourName } from './shares.js';
import { renderShareLight } from './menus.js';
import { leaveTrash } from './trash.js';
import { currentMode, noteBound, noteClosed, previewView, reading } from './reading.js';
import { $, TOUCH, editedHere, notesMap, relTime, state } from './shared.js';
import { forgetStatus } from './save-status.js';
import { ago, appMark, appTimes, lastAppEdit, whoOf } from '../core/authorship.js';
import { addWriter } from '../core/connections-sync.js';

let openError = null; // why the last note didn't open, or null
let noteMissing = false; // the address names no note of yours (#299)
let openingNow = null; // the open in progress (a token: a later open replaces it)

// From app.js (init): a title's length, the notes edited here, the editor, flushing unsent
// edits, the note list and its render, the save status, and the notes shown.
let TITLE_MAX, editor, flushAll, renderList, visibleNotes;
export function init(deps) {
  ({ TITLE_MAX, editor, flushAll, renderList, visibleNotes } = deps);
  // The menu came or went (#311, #313): the title and tags again, without what's being typed for
  // it (`/tod`, `#gy`), or with what stayed.
  $('editor').addEventListener('plim:menu', () => {
    if (!state.note || !editor.ytext) return;
    updateMeta(state.note.id);
    updateTags(state.note.id, editor.ytext, { soon: true });
  });
}

/**
 * A new note, dated (#313): its first line, so its title, is the date and time it was made; with
 * a tag picked in the sidebar, that tag on the line under it (so it's in the list you're looking
 * at); then a blank line and the cursor, for the body. The first line is yours to rename. The AI
 * notebook picked (#484): made in it.
 */
export function newNote() {
  const id = crypto.randomUUID();
  const now = clockNow();
  const title = stamp(localNow());
  const tags = state.tagFilter ? [state.tagFilter] : [];
  const text = setTags(setTitle('', title), tags); // (#584: the title and the tag in its block, the body empty)
  notesMap().set(id, new Y.Map([['title', title], ['created', now], ['updated', now], ['deleted', false], ...(tags.length ? [['tags', tags]] : []), ...(state.inConnected ? [['place', 'ai']] : [])]));
  editedHere.set(id, now);
  $('sidebar-scroll').scrollTop = 0; // the new note goes at the top
  openNote(id, { fresh: true, text });
}

/**
 * Switch the editor to a note without passing through the empty state.
 * `fresh` notes were just created here: nothing exists on the server or in
 * the outbox yet, so they bind synchronously (instant, and focus stays inside
 * the tap so mobile keyboards open).
 */
/**
 * Open a note. If that fails, the note's place says so (with Reload) instead
 * of staying blank and read-only (#134).
 */
export async function openNote(id, opts) {
  const opened = openNoteNow(id, opts);
  const mine = openingNow; // (set at once by openNoteNow: a later open replaces it)
  try {
    return await opened;
  } catch (e) {
    console.error(e);
    if (openingNow === mine) cantOpen(e);
  }
}

/** The open note failed: close what's left of it, and say so where it would be. */
function cantOpen(e) {
  const n = detachNote();
  if (n) retire(n).catch(() => {});
  openError = e instanceof NotHere ? null : String(e?.message ?? e);
  noteMissing = e instanceof NotHere;
  noteClosed();
  unbindHead({ hide: true });
  $('editor').hidden = true;
  $('empty').hidden = false;
  $('view-notes').classList.add('editing'); // (on a phone: this, with "← Notes", rather than the list)
  for (const b of ['note-share', 'note-history', 'note-more']) $(b).hidden = true; // (no note to act on; bindNote shows them again)
  $('presence').replaceChildren();
  renderList(); // (no note highlighted: none is open; it also says why, in renderEmpty)
}

/**
 * An address that opens no note of yours (#299): deleted, someone else's, or mistyped, all the
 * same (nothing tells them apart, so an address never says whether a note exists).
 */
class NotHere extends Error {}

/** Where a note would be when none is open: what to do, or why the note didn't open. */
export function renderEmpty() {
  const failed = openError != null;
  const missing = noteMissing;
  $('empty-text').textContent = failed ? 'This note couldn’t be opened.'
    : missing ? 'There’s no note of yours at this address.'
    : visibleNotes().length ? 'Select a note, or start a new one.' : 'Write your first note.';
  $('empty-detail').textContent = failed ? openError : missing ? 'It may have been deleted, or be someone else’s. Your notes are all in the list.' : '';
  $('empty-detail').classList.toggle('plain', missing);
  $('empty-detail').hidden = !failed && !missing;
  $('empty-new').hidden = failed || missing;
  $('empty-reload').hidden = !failed;
}

/** Whether a note of yours is at `id`: in your list, and not deleted. */
const inList = (id) => Boolean(notesMap().get(id)) && !notesMap().get(id).get('deleted');

/**
 * The address bar follows the open note (#299): /n/<id>, as a history entry (Back closes it),
 * or in place of the current one (`replace`: a note opened by the app itself, at start). An
 * address already there (Back, Forward, a reload) stays as it is.
 */
function placeAddress(id, replace) {
  if (location.pathname === notePath(id)) return;
  history[replace ? 'replaceState' : 'pushState']({ note: id }, '', notePath(id));
}

async function openNoteNow(id, { fresh = false, reopen = false, replace = false, text = '' } = {}) {
  leaveTrash(); // (a note opened, or a new one: back to your notes, from Recently deleted)
  if (state.note?.id === id && !reopen) return reading() ? undefined : focusEditor({ fromTap: true });
  openError = null;
  noteMissing = false;
  if (!fresh && !inList(id)) throw new NotHere(id);
  placeAddress(id, replace);
  // A shared note's keys take a moment to derive (a new note is never shared,
  // and must open inside the tap, so it doesn't wait).
  // The same note opened again (its keys replaced, it moved to a share): it stays in the mode it's in.
  const keep = reopen && state.note?.id === id ? currentMode() : null;
  const opening = (openingNow = {});
  const next = fresh ? new DocSync(state.ctx, id) : await syncFor(id);
  if (openingNow !== opening) return next.close(); // another note was opened meanwhile
  const prev = detachNote();
  if (prev) retire(prev); // upload in the background; don't block the switch
  const sync = next;
  state.note = { id, sync, unbind: null };
  state.live?.wake();
  // Until the new note is bound, keep what's on screen (no blank flash), read-only.
  noteClosed(); // (a page, if one was up: the editor meanwhile)
  if ($('editor').hidden) editor.waiting();
  else editor.freeze();
  headOpening(); // (its header up already, #581: nothing moves when it's bound)
  $('editor').hidden = false;
  $('empty').hidden = true;
  $('view-notes').classList.add('editing');
  renderList();
  const current = () => state.note?.sync === sync;
  const failed = (e) => {
    console.error(e);
    if (current()) alert('This note could not be decrypted.');
  };
  // Live pushes start once the first load is in (so the subscription only catches up from there).
  const watch = () => current() && state.live?.watch(sync);
  if (fresh) {
    // (What a new note starts with, newNote's: before the editor's undo, which doesn't take it back.)
    if (text) sync.ydoc.getText('body').insert(0, text);
    bindNote(id, sync, null, { fromTap: true, fresh: true }); // still inside the tap on "+ New"
    if (text && state.note?.sync === sync) editor.setCursor(text.length, { scroll: false }); // (the body, after it)
    if (state.note?.sync === sync && !TOUCH.matches) focusTitle(); // (in frontmatter, #584: its title, the date, selected to rename; a phone: the keyboard stays the body's)
    return watch();
  }
  const saved = loadView(id); // where the cursor and scroll were last time

  // What this device has (offline copy, unsent edits) shows at once; the
  // server's copy merges in behind it.
  let local = false;
  try {
    local = await sync.loadLocal();
  } catch (e) {
    failed(e);
  }
  const view = await saved;
  if (!current()) return; // switched away meanwhile
  if (local) {
    bindNote(id, sync, view, { keep });
    sync.loadRemote().then(watch, failed);
    return;
  }
  // Nothing on this device yet: wait for the server, saying "Loading…" only if it's slow.
  editor.waiting();
  const slow = setTimeout(() => current() && editor.setLoading(true), 250);
  try {
    await sync.loadRemote();
  } catch (e) {
    failed(e);
  }
  clearTimeout(slow);
  if (current()) bindNote(id, sync, view, { keep });
  watch();
}

/** Connect the editor to the open note's text and make it editable, with the cursor and scroll `view` left them. */
function bindNote(id, sync, view = null, { fromTap = false, fresh = false, keep = null } = {}) {
  const ytext = sync.ydoc.getText('body');
  // A shared note: who else is in it, and their cursors.
  const presence = sync.share && state.live
    ? new Presence(sync, state.live, { name: yourName(), viewing: !sync.writable }, { onChange: renderPresence })
    : null;
  state.note.presence = presence;
  // Its header (#581): its frontmatter folded, the editor without the block's lines (first: the
  // phone's textarea shows the text after it).
  editor.hideFrontmatter(headed(ytext));
  editor.show(ytext, view, { editable: sync.writable, awareness: presence?.awareness });
  bindHead(ytext, { editable: sync.writable });
  // The bar's button, changed with the text (not before: no frame of the old note under the new label).
  $('note-share').hidden = Boolean(notesMap().get(id)?.get('deleted')); // (not from Recently deleted)
  $('note-history').hidden = $('note-share').hidden || !sync.keepsHistory; // (view-only links keep none)
  $('note-more').hidden = $('note-share').hidden;
  renderShareLight(); // (its light or an app's badge, and its label: ui/menus.js)
  const onChange = (_, tr) => {
    updateTags(id, ytext, { soon: true }); // (others' edits too: a shared note's tags are its text's)
    if (tr.origin === REMOTE) return;
    editedHere.set(id, clockNow());
    updateMeta(id);
    renderAppHere(sync.ydoc, id); // (you've edited it: not an app's last any more, #555)
  };
  ytext.observe(onChange);
  // An app writing in it (#389): its chip in the bar for a couple of minutes; on a phone, whose
  // editor has no margin to mark, a word the first time the note is opened after it wrote.
  const authors = sync.ydoc.getMap('authors');
  const onAuthors = () => {
    renderAppHere(sync.ydoc, id);
    keepWriters(id, sync.ydoc);
  };
  authors.observe(onAuthors);
  renderAppHere(sync.ydoc, id);
  keepWriters(id, sync.ydoc);
  state.note.unbind = () => {
    unbindHead();
    ytext.unobserve(onChange);
    authors.unobserve(onAuthors);
    clearTimeout(appHereTimer);
    $('app-here').hidden = true;
    flushTags(); // (what was typed last, before the note goes)
  };
  updateTags(id, ytext); // (put right on opening: a note written where tags aren't kept, #308)
  // The editor (or Preview: a view-only link, or a computer's that was left on, #302).
  if (!noteBound(ytext, view, { fresh, editable: sync.writable, awareness: presence?.awareness, keep })) focusEditor({ fromTap });
  document.dispatchEvent(new CustomEvent('plim:note-bound', { detail: { id } })); // (a search's matches in it: ui/search.js)
}

/** The open note's header drawn again (#582: your notes just moved to frontmatter, so it has one now). */
export function refreshHead() {
  const n = state.note;
  if (!n?.sync) return;
  const ytext = n.sync.ydoc.getText('body');
  const at = editor.cursor();
  bindHead(ytext, { editable: n.sync.writable });
  editor.setCursor(Math.max(at, editor.bodyFrom()), { scroll: false });
}

// On phones and tablets (TOUCH), focusing the editor anywhere but directly in a tap
// doesn't open the keyboard, yet the editor would still show a blinking
// cursor. There it's focused only from a tap (a new note, or the open note
// tapped again); otherwise the cursor appears when you tap into the text.
// Phones (style.css's small-screen layout): the note bar's actions are all in its ⋯.

export function focusEditor({ fromTap = false } = {}) {
  if (TOUCH.matches && !fromTap) return;
  editor.focus();
}

/** Title = first non-empty line; "updated" bumps at most every 30 s while typing. */
// ---------- what an app wrote (#389, authorship.js) ----------

/** For how long after an app wrote its chip stays in the note's bar, whoever edited since. */
const APP_HERE_MS = 2 * 60 * 1000;
let appHereTimer;

/**
 * The bar's chip of who wrote (#389, #555): an app (an agent; a script, with `plim --as`) that
 * wrote in the note, for as long as it's the last to have (the note list's "by NAME", which your
 * next edit takes off), or for a couple of minutes after it wrote: "Claude, just now", then
 * "Backup script, 3 h ago", kept up to date.
 */
function renderAppHere(ydoc, id) {
  clearTimeout(appHereTimer);
  const last = lastAppEdit(ydoc);
  const lastBy = notesMap().get(id)?.get('lastBy');
  const recent = Boolean(last) && clockNow() - last.at < APP_HERE_MS;
  const stillLast = Boolean(last) && typeof lastBy === 'string' && lastBy.toLowerCase() === last.name.toLowerCase();
  const chip = $('app-here');
  chip.hidden = !recent && !stillLast;
  if (chip.hidden) return;
  chip.textContent = `${last.name}, ${relTime(last.at)}`;
  chip.dataset.initial = appMark(last.name).letter;
  chip.dataset.tone = appMark(last.name).tone;
  chip.title = `${whoOf(last)} wrote in this note ${ago(last.at, clockNow())}`;
  appHereTimer = setTimeout(() => renderAppHere(ydoc, id), 30_000); // (its time said again; gone, if it's only recent, once it isn't)
}

/**
 * The note's writers in your note list (#552): the apps the note itself says wrote in it (its
 * 'authors'), so a note written before writers were kept is in Connected, its letters on its row,
 * once it's opened; and an app writing in it while it's open.
 */
function keepWriters(id, ydoc) {
  const m = notesMap().get(id);
  const times = appTimes(ydoc); // (and when each last wrote, #564)
  if (!m || !times.size) return;
  state.index.ydoc.transact(() => times.forEach((at, n) => addWriter(m, n, at)));
}

export function updateMeta(id) {
  const m = notesMap().get(id);
  if (!m || m.get('deleted')) return; // (a deleted note's edits are kept by keepEditsHere, not by its time here)
  const title = editor.title(TITLE_MAX);
  const now = clockNow();
  const updated = m.get('updated') || 0;
  state.index.ydoc.transact(() => {
    if (m.get('title') !== title) m.set('title', title);
    // (Also when it's from the future: a device with its clock ahead wrote it.)
    if (now - updated > 30_000 || updated - now > 30_000) m.set('updated', now);
    if (m.get('lastBy') !== undefined) m.delete('lastBy'); // (you edited it last now, not an app: #389)
  });
}

// ---------- tags (#308): the note's, kept beside its title in the note list ----------
// Read from its whole text, so not at every keystroke: a second after typing (or anyone's edit)
// stops, when the note is left, and when it's opened (put right if another app wrote it).

const TAGS_MS = 1000;
let pendingTags = null; // { id, ytext, timer }

/** The note's tags put right in the list from its text: now, or (`soon`) once typing stops. */
function updateTags(id, ytext, { soon = false } = {}) {
  if (pendingTags) clearTimeout(pendingTags.timer);
  pendingTags = null;
  if (soon) {
    pendingTags = { id, ytext, timer: setTimeout(() => updateTags(id, ytext), TAGS_MS) };
    return;
  }
  const m = notesMap().get(id);
  if (!m || m.get('deleted')) return;
  // (Not a tag half typed with the menu offering yours: `#gy` isn't one yet.)
  const typing = state.note?.id === id ? editor.menu?.range() : null;
  const tags = noteTags(withoutCommand(ytext.toString(), typing)); // (#584: its block's)
  const old = m.get('tags');
  if (Array.isArray(old) && old.length === tags.length && old.every((t, i) => t === tags[i])) return;
  m.set('tags', tags);
}

/** Tags waiting for typing to stop: stored now. */
export function flushTags() {
  if (pendingTags) updateTags(pendingTags.id, pendingTags.ytext);
}

/** Unbind the open note (no UI change) and return it for retire(). */
function detachNote() {
  const n = state.note;
  if (!n) return null;
  saveView();
  state.note = null;
  n.unbind?.();
  document.dispatchEvent(new CustomEvent('plim:note-gone')); // (nothing of it marked any more: ui/search.js)
  $('presence').replaceChildren(); // another note now: no fading out over it
  // A shared note: our goodbye goes out before we unsubscribe (see Presence.destroy).
  Promise.resolve(n.presence?.destroy()).then(() => state.live?.unwatch(n.sync.docId, n.sync));
  return n;
}

// ---------- cursor and scroll, per note, on this device ----------
// Saved in the device's kv store (no text: positions only), cleared by "Forget this device".

export const viewKey = (id) => `view:${state.ctx.accountId}:${id}`;

const loadView = (id) => kvGet(viewKey(id)).catch(() => null);

/** Remember where the cursor and scroll are in the open note (once it's on screen). */
export function saveView() {
  const n = state.note;
  if (!n?.unbind) return; // still loading: the editor shows something else
  const view = editor.viewState();
  if (view && reading()) Object.assign(view, previewView()); // (in Preview: the page's place is yours, #302)
  return view && kvPut(viewKey(n.id), view).catch(() => {});
}

/** Upload a closed note's pending edits, then release it (or keep retrying). */
async function retire(n) {
  await n.sync.flush();
  if (!(await n.sync.hasPending())) n.sync.close();
  forgetStatus(n.id);
}

/** Close the note and show the empty state (Back, Delete, deleted elsewhere). The address bar goes back to the list's. */
export async function closeNote() {
  if (location.pathname !== '/') history.pushState({}, '', '/');
  if (openError != null || noteMissing) {
    openError = null; // (Back from a note that didn't open)
    noteMissing = false;
    $('view-notes').classList.remove('editing');
    renderEmpty();
  }
  const n = detachNote();
  if (!n) return;
  noteClosed();
  unbindHead({ hide: true });
  $('editor').hidden = true;
  $('empty').hidden = false;
  $('view-notes').classList.remove('editing');
  renderList();
  await retire(n);
}

$('btn-new').addEventListener('click', newNote);
$('btn-new-foot').addEventListener('click', newNote); // (the same, in the footer on phones)
$('empty-new').addEventListener('click', newNote);
$('empty-reload').addEventListener('click', () => {
  flushAll(true);
  location.reload();
});
$('btn-back').addEventListener('click', closeNote);
// Back and Forward (#299): the note the address names opens, or none (the list, on a phone).
window.addEventListener('popstate', () => {
  if (!state.index || $('view-notes').hidden) return; // (locked: the address is read once the notes show)
  const id = noteIdAt(location.pathname);
  if (id) openNote(id);
  else closeNote();
});
// While the note is scrolled, its text fades as it reaches the bar (desktop: style.css).
export function renderScrolled() {
  const top = $('editor').hidden ? (!$('reading').hidden ? $('reading').scrollTop : 0) : (document.querySelector('#editor .cm-scroller')?.scrollTop ?? 0);
  $('editor').closest('.editor-pane').classList.toggle('scrolled', top > 0);
}
$('editor').addEventListener('scroll', renderScrolled, { capture: true, passive: true }); // (the scroller's own, which doesn't bubble)
$('reading').addEventListener('scroll', renderScrolled, { passive: true });
