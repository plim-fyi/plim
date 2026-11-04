// Recently deleted (#259): deleting a note (with Undo), Delete forever, what the server still
// keeps of notes deleted forever (#253), and Recently deleted itself, a place in the app (#190).
// (Its rules on the note index: ../trash.js.) The rest of the app it needs comes through init().
import { ApiError, isOffline } from '../core/api.js';
import { signedRequest } from '../core/signed.js';
import { ACTION } from '../core/sig.js';
import { kvDelete } from '../core/vault.js';
import {
  daysLeft, deleteNote as markDeleted, expired as expiredNotes, forgetPurged, markPurged, purgedRestorable, restoreNote,
  restorePurged, trashed,
} from '../core/trash.js';
import { render, toDOM } from '../editor/render.js';
import { deleteDoc, deleteShare, shareOf, syncFor } from './shares.js';
import { $, PHONE, editedHere, notesMap, relTime, showToast, stackToast, state } from './shared.js';

// From app.js (init): the server, opening and closing a note, the notes edited here, the note
// list (and its render), and the key a note's view is remembered under.
let api, closeNote, openNote, renderList, storageChanged, viewKey;
export function init(deps) {
  ({ api, closeNote, openNote, renderList, storageChanged, viewKey } = deps);
}


/** Delete moves the note to Recently deleted, with an Undo for a few seconds. */
export async function deleteNote(id) {
  editedHere.delete(id); // (deleted here, knowing its edits: it stays deleted)
  markDeleted(notesMap(), id);
  if (state.note?.id === id) await closeNote();
  showToast('Note deleted', { action: 'Undo', onAction: () => restore(id) });
}

export function restore(id) {
  restoreNote(notesMap(), id);
  showToast('Note restored');
}

/**
 * Delete forever: remove the note's data from the server, then keep only a
 * marker in the index (see trash.js), and drop what this device holds of it.
 */
async function purgeNote(id) {
  // A note you shared lives in its share: deleting it for good deletes the share (and its links).
  // One shared with you only leaves your list: the share is its owner's.
  const share = shareOf(id);
  const docId = share ? `share:${share.id}` : id;
  if (!share) await deleteDoc(id);
  else if (share.role === 'owner') {
    // Already gone (another of your devices, or an earlier try) is done too.
    await deleteShare(share.id).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
  }
  markPurged(notesMap(), id); // (what it takes to restore it, kept for 30 days: trash.js)
  await dropOutbox(docId);
  state.ctx.cache.delete(docId).catch(() => {});
  kvDelete(viewKey(id)).catch(() => {});
  storageChanged();
}

/** Unsent edits of a note deleted forever: never upload them. */
export async function dropOutbox(id) {
  const ids = (await state.ctx.outbox.list(id)).map((r) => r.id);
  if (ids.length) await state.ctx.outbox.remove(ids);
}

/** Notes deleted more than 30 days ago go for good (on any device that's online). */
export async function emptyExpiredTrash() {
  forgetPurged(notesMap()); // (deleted forever over 30 days ago: no longer restorable)
  for (const id of expiredNotes(notesMap())) {
    try {
      await purgeNote(id);
    } catch (err) {
      if (!isOffline(err)) console.warn('emptying the trash failed', err);
      return;
    }
  }
}

// ---------- Recently deleted: a place in the app (#190) ----------
//
// Picked in the sidebar, it's in the notes' place there, as a tag picked is (its label, and
// "All notes" back): the deleted notes, newest first, then those deleted forever that the server
// still keeps. One picked shows in the note's place as a page, read and not edited, with
// Restore and Delete forever; one deleted forever has no text here any more, only Restore.
// On a computer the first is shown on the way in; on a phone the list is a screen, a note
// another (‹ back, and the OS's Back).

/** Whether Recently deleted is picked, and which of its notes is shown (null: none). */
let picked = false;
let shown = null;
let lastDrawn = ''; // (what the rows were drawn from)
const DAY_MS = 86_400_000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "2 days ago" (not a date, as the note list says, for a week-old deletion), or "5 min ago". */
const ago = (ts) => {
  const days = Math.floor((Date.now() - ts) / DAY_MS);
  return days >= 1 ? `${plural(days, 'day')} ago` : relTime(ts);
};

/** Recently deleted, picked: its notes in the list, and (on a computer) the newest shown. */
async function enterTrash() {
  if (state.note) await closeNote();
  picked = true;
  shown = null;
  renderTrash();
  if (!PHONE.matches) {
    const first = trashItems()[0];
    if (first) showDeleted(first.id);
  }
  $('sidebar-scroll').scrollTop = 0;
  loadServerTrash();
}

/** Back to your notes (All notes, or a note opened, or a new one). Nothing re-rendered: the caller does. */
export function leaveTrash() {
  if (!picked) return;
  picked = false;
  hideDeleted({ fromHistory: true });
  renderTrash();
}

/** What's listed: deleted notes, then those deleted forever that can still be restored. */
function trashItems() {
  const deleted = trashed(notesMap()).map((n) => ({ ...n, forever: false, left: daysLeft(n.deletedAt) }));
  const forever = purgedRestorable(notesMap())
    .filter((n) => {
      const key = trashKey(n);
      return !key || serverTrash?.has(key);
    })
    .map((n) => ({ ...n, forever: true, left: daysLeft(n.purgedAt) }));
  return [...deleted, ...forever];
}

function trashRow(n) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-current', String(n.id === shown));
  btn.append(
    Object.assign(document.createElement('span'), { className: n.title ? 'title' : 'title untitled', textContent: n.title || 'Untitled' }),
    Object.assign(document.createElement('span'), {
      className: `when${!n.forever && n.left <= 3 ? ' soon' : ''}`,
      textContent: n.forever ? `Can be restored for ${plural(n.left, 'more day')}` : `Deleted ${ago(n.deletedAt)} · ${plural(n.left, 'day')} left`,
    }),
  );
  btn.addEventListener('click', () => showDeleted(n.id));
  const li = Object.assign(document.createElement('li'), { className: 'trashed' });
  li.dataset.id = n.id;
  li.append(btn);
  return li;
}

/**
 * Recently deleted's count beside it in the sidebar and, while it's picked, its notes in the
 * list and the one shown (it moves on to the next when that one goes, restored or emptied).
 */
export function renderTrash() {
  const deleted = trashed(notesMap());
  $('trash-count').textContent = $('trash-count-foot').textContent = String(deleted.length);
  $('trash-count').hidden = $('trash-count-foot').hidden = !deleted.length;
  $('view-notes').classList.toggle('trash-mode', picked);
  if (picked) $('btn-trash').setAttribute('aria-current', 'page');
  else $('btn-trash').removeAttribute('aria-current');
  if (picked) for (const b of document.querySelectorAll('#notes-nav .view')) b.removeAttribute('aria-current'); // (the view you were in: not now, #539)
  if (!picked) return;
  $('notes-label').textContent = 'Recently deleted';
  $('notes-head').classList.add('picked');
  $('tag-clear').hidden = false;
  const items = trashItems();
  const live = items.filter((n) => !n.forever);
  const gone = items.filter((n) => n.forever);
  // The rows only when they changed: a tap on one isn't lost to its being replaced under the finger.
  const drawn = JSON.stringify(items.map((n) => [n.id, n.title, n.forever, n.left, n.deletedAt]));
  if (drawn !== lastDrawn) {
    lastDrawn = drawn;
    $('trash-list').replaceChildren(...(live.length ? live.map(trashRow)
      : [Object.assign(document.createElement('li'), { className: 'list-empty', textContent: gone.length ? 'No recently deleted notes' : 'Nothing in Recently deleted' })]));
    $('trash-forever').replaceChildren(...gone.map(trashRow));
  }
  for (const b of document.querySelectorAll('.trash-list button')) b.setAttribute('aria-current', String(b.closest('li').dataset.id === shown));
  $('trash-forever-section').hidden = !gone.length;
  if (shown && !items.some((n) => n.id === shown)) {
    // Gone from here (restored, emptied, on another device too): the next, or none.
    hideDeleted();
    if (!PHONE.matches && items[0]) return showDeleted(items[0].id);
  }
  if (!PHONE.matches && !shown) showNothing(items.length);
  if (shown) renderShownBar(items.find((n) => n.id === shown));
}

/** A computer with nothing picked: the note's place says what this is (or that it's empty). */
function showNothing(count) {
  openPane();
  $('note-title').textContent = 'Recently deleted';
  message(count ? 'Pick a note to read it' : 'Nothing in Recently deleted', 'Notes you delete stay here for 30 days, then they’re deleted for good.');
  $('trash-view').classList.add('none');
}

function openPane() {
  $('view-notes').classList.add('editing');
  document.querySelector('.editor-pane').classList.add('trash-open');
  $('trash-view').hidden = false;
  $('trash-view').classList.remove('none');
  stackToast(); // (a toast that's up: above its actions, on a phone)
}

function message(title, detail) {
  $('trash-page').hidden = Boolean(title);
  $('trash-message').hidden = !title;
  $('trash-message-title').textContent = title;
  $('trash-message-detail').textContent = detail;
}

function renderShownBar(n) {
  if (!n) return;
  $('note-title').textContent = n.title || 'Untitled';
  $('note-title').classList.toggle('untitled', !n.title);
  $('trash-when').textContent = n.forever
    ? `Deleted forever · the server keeps it for ${plural(n.left, 'more day')}`
    : `Deleted ${ago(n.deletedAt)} · deleted for good in ${plural(n.left, 'day')}. Restore it to edit it.`;
  $('trash-purge').hidden = n.forever;
}

let loading = 0; // (the latest load: an earlier one finishing late doesn't draw)

/** Show a deleted note in the note's place: its text as a page, or (deleted forever) why there's none. */
async function showDeleted(id) {
  const n = trashItems().find((x) => x.id === id);
  if (!n) return;
  // A phone: a screen of its own, which Back (the OS's too) leaves.
  if (PHONE.matches && shown == null) history.pushState({ trash: id }, '', location.pathname);
  shown = id;
  for (const b of document.querySelectorAll('.trash-list button')) b.setAttribute('aria-current', String(b.closest('li').dataset.id === id));
  openPane();
  renderShownBar(n);
  for (const b of ['trash-restore', 'trash-purge']) $(b).disabled = false;
  $('trash-page').scrollTop = 0;
  if (n.forever) {
    return message('Its text is no longer on this device', `The server keeps it, encrypted, for ${plural(n.left, 'more day')}. Restore it to read it again.`);
  }
  const mine = ++loading;
  message('', '');
  $('trash-page').replaceChildren();
  const slow = setTimeout(() => mine === loading && message('Loading…', ''), 300);
  let text = null;
  let failure = null;
  let sync;
  try {
    sync = await syncFor(id);
    if (!(await sync.loadLocal())) await sync.loadRemote();
    text = sync.ydoc.getText('body').toString();
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(slow);
    sync?.close();
  }
  if (mine !== loading || shown !== id) return;
  if (text == null) {
    return message(isOffline(failure) ? 'This note isn’t on this device yet' : 'This note couldn’t be shown',
      isOffline(failure) ? 'Showing it needs a connection. You can still restore it.' : String(failure?.message ?? failure));
  }
  message('', '');
  const frag = toDOM(render(text), document, null);
  for (const a of frag.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const box of frag.querySelectorAll('input')) box.disabled = true;
  $('trash-page').replaceChildren(frag);
  if (!text.trim()) message('This note was empty', '');
}

/** The note's place back to normal (and, on a phone, the list). */
function hideDeleted({ fromHistory = false } = {}) {
  const was = shown;
  shown = null;
  loading++;
  for (const b of document.querySelectorAll('.trash-list button')) b.setAttribute('aria-current', 'false');
  $('trash-view').hidden = true;
  document.querySelector('.editor-pane').classList.remove('trash-open');
  if (!state.note) $('view-notes').classList.remove('editing');
  stackToast();
  if (!fromHistory && was != null && history.state?.trash) history.back();
}

/** The one after it in the list (or before, if it was last): shown next, on a computer. */
function nextAfter(id) {
  const items = trashItems();
  const at = items.findIndex((n) => n.id === id);
  return items[at + 1]?.id ?? items[at - 1]?.id ?? null;
}

/** After an action on the shown note: the next one (a computer) or the list (a phone). */
function moveOn(id) {
  const next = nextAfter(id);
  if (PHONE.matches) hideDeleted();
  else if (next) showDeleted(next);
  else {
    hideDeleted();
    renderTrash();
  }
}

$('trash-restore').addEventListener('click', async () => {
  const id = shown;
  const n = trashItems().find((x) => x.id === id);
  if (!n) return;
  const next = nextAfter(id);
  if (n.forever) {
    if (!(await restoreForever(n, $('trash-restore')))) return;
  } else {
    restoreNote(notesMap(), id);
  }
  showToast(`Restored “${n.title || 'Untitled'}”`, { action: 'Open', onAction: () => openNote(id) });
  if (shown !== id) return;
  if (PHONE.matches || !next) hideDeleted();
  else showDeleted(next);
  renderTrash();
});

$('trash-purge').addEventListener('click', async () => {
  const id = shown;
  const n = trashItems().find((x) => x.id === id && !x.forever);
  if (!n) return;
  // No "are you sure": the server keeps it 30 days more (#253), and Undo brings it straight back.
  for (const b of ['trash-restore', 'trash-purge']) $(b).disabled = true;
  try {
    await purgeNote(id);
  } catch (err) {
    for (const b of ['trash-restore', 'trash-purge']) $(b).disabled = false;
    return showToast(isOffline(err) ? 'Deleting forever needs a connection.' : `Couldn’t delete it: ${err.message}`);
  }
  showToast(`Deleted “${n.title || 'Untitled'}” forever`, {
    action: 'Undo',
    onAction: () => {
      // Back where it was: in Recently deleted (its 30 days from now).
      const gone = purgedRestorable(notesMap()).find((x) => x.id === id);
      if (gone) restoreForever(gone, null).then((ok) => {
        if (!ok) return;
        markDeleted(notesMap(), id);
        renderTrash();
        if (picked && !PHONE.matches) showDeleted(id);
        showToast(`“${n.title || 'Untitled'}” is back in Recently deleted`);
      });
    },
  });
  if (shown === id) moveOn(id);
  await loadServerTrash();
});

$('btn-trash').addEventListener('click', enterTrash);
$('tag-clear').addEventListener('click', () => {
  if (!picked) return;
  leaveTrash();
  renderList();
});
// A phone: the note's ‹ back to the list, as the OS's Back does.
$('btn-back').addEventListener('click', () => shown != null && hideDeleted());
window.addEventListener('popstate', () => {
  if (shown != null && !history.state?.trash) hideDeleted({ fromHistory: true });
});
// A phone turned or a window resized to a computer's width with nothing shown: show the newest.
PHONE.addEventListener('change', () => picked && renderTrash());

// ---- deleted forever, still restorable (#253) ----

/** What the server still keeps of notes deleted forever (GET /trash), as "doc:<id>" / "share:<id>"; null: not known (offline). */
let serverTrash = null;

/** Where a note deleted forever is kept on the server ("doc:<id>", "share:<id>"), or null if nothing needs restoring there (a note shared with you: the share is its owner's). */
function trashKey(n) {
  if (n.share) return n.share.role === 'owner' ? `share:${n.share.id}` : null;
  return `doc:${n.id}`;
}

async function loadServerTrash() {
  try {
    serverTrash = new Set((await api.get('/trash')).trash.map((t) => `${t.kind}:${t.target}`));
  } catch {
    serverTrash = null;
  }
  if (picked) renderTrash();
}

/** A note deleted forever, back: its data on the server (signed, #144), then in the list. Whether it came back. */
async function restoreForever(n, button) {
  const key = trashKey(n);
  if (button) button.disabled = true;
  try {
    if (key) {
      const [kind, target] = key.split(':');
      await signedRequest(state.ctx, 'POST', `/trash/${kind}/${target}/restore`, kind === 'share' ? ACTION.restoreShare : ACTION.restoreDoc, target);
    }
  } catch (err) {
    if (button) button.disabled = false;
    if (err instanceof ApiError && err.status === 404) serverTrash?.delete(key);
    renderTrash();
    showToast(isOffline(err) ? 'Restoring needs a connection.'
      : err instanceof ApiError && err.status === 404 ? 'It’s no longer kept on the server.'
      : `Couldn’t restore it: ${err.message}`);
    return false;
  }
  serverTrash?.delete(key);
  restorePurged(notesMap(), n.id);
  storageChanged();
  renderTrash();
  return true;
}
