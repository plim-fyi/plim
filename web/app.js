// The app's page: opening and locking the vault (the session, its storage, other tabs, auto-lock),
// online or not, saving and its status, the storage meter, the sidebar; and each screen's module
// (ui/) wired up. All crypto lives in core/; nothing here sends the phrase, seed, keys or
// plaintext to the server.
import { unb64 } from './core/crypto.js';
import { Api, ApiError, isOffline } from './core/api.js';
import {
  checkKeyring,
  openSession,
  refreshSession,
} from './core/account.js';
import { DocSync } from './core/sync.js';
import { Live } from './core/live.js';

import {
  dateUndated,
  isPurged,
} from './core/trash.js';
import { ON_A_PHONE } from './editor/phone.js';
import { noteIdAt } from './core/noteurl.js';
import { TextareaEditor } from './editor/textarea.js';
import { $, PHONE, busy, editedHere, notesMap, show, state, tabs, tell } from './ui/shared.js';
import { renderList, visibleNotes } from './ui/notelist.js';
import './ui/history.js';
import { init as initNote, closeNote, flushTags, focusEditor, newNote, openNote, refreshHead, saveView, updateMeta, viewKey } from './ui/note.js';
import { init as initReading } from './ui/reading.js';
import { init as initTrash, dropOutbox, emptyExpiredTrash } from './ui/trash.js';
import { init as initMenus, closeMenu, renderAccount, renderShareLight } from './ui/menus.js';
import { init as initTagList } from './ui/taglist.js';
import { init as initNoteHead } from './ui/notehead.js';
import { moveToFrontmatter } from './ui/to-frontmatter.js';
import { init as initSearch } from './ui/search.js';
import { init as initOnboarding, askNewPhrase, endFlow, finishRotation, showWelcome, uploadPendingPasskeys } from './ui/onboarding.js';
import { init as initSettings, renderPhraseBanner, renderSettingsNav } from './ui/settings.js';
import { mergePhraseSaved } from './ui/vault-data.js';
import { init as initConnections, renderConnections, renderConnectionsNav } from './ui/connections.js';
import { init as initKeep, scheduleGrants } from './ui/connections-keep.js';
import { connectRequest, init as initConsent, showConsent } from './ui/consent.js';
import { maybeShowSwitch } from './ui/agents-switch.js';
import { setStatus } from './ui/save-status.js';
import './ui/sidebar.js';
import './ui/import.js';
import {
  init as initSharing,
  addSharedFromLink,
  moveUnsent,
  noteWithShare,
  profile,
  syncFor,
} from './ui/shares.js';
import { init as initShareDialog } from './ui/share-dialog.js';
import { AUTO_LOCK_OPTIONS, AutoLock, DEFAULT_AUTO_LOCK } from './core/idle.js';
import {
  forgetCredential,
} from './core/passkey.js';
import {
  IdbDocCache,
  IdbOutbox,
  IdbSeen,
  kvGet,
  kvPut,
  passkeyCache,
  removeLegacyUnlock,
  sessionStore,
} from './core/vault.js';

// Storage use only changes when something uploads: refresh it then (at most every
// 30 s), and otherwise every 5 minutes (other devices, other notes).
const STORAGE_MS = 30_000;
const STORAGE_IDLE_MS = 5 * 60_000;
const TITLE_MAX = 80;

const api = new Api();
// On a phone the note is edited in a plain textarea (#290); elsewhere in CodeMirror, loaded only there.
const editor = ON_A_PHONE ? new TextareaEditor($('editor')) : new (await import('./editor/editor.js')).NoteEditor($('editor'));
// For browser tests and debugging: the open note's text (CodeMirror only renders what's on
// screen), the line the cursor is on, and its text to change.
$('editor').noteText = () => editor.text();
$('editor').cursorLine = () => editor.cursorLine();
$('editor').noteYText = () => editor.ytext;
$('editor').caretTop = (pos) => editor.caretTop?.(pos) ?? null; // (the textarea's, from its mirror)
$('editor').cursorPos = () => editor.cursor();
$('editor').focusText = () => editor.focus(); // (the text, not the header's title, #584)
$('editor').noteTitle = () => editor.title(); // (its frontmatter's, else its first line's, #584)
// Where `pos` is drawn in the editor, from the top of its view (#302: places kept when switching).
$('editor').screenTop = (pos) => {
  if (editor.ta) return editor.caretTop(pos - editor.base) - editor.ta.scrollTop; // (`pos` in the note's text: after its hidden frontmatter, #584)
  const c = editor.view.coordsAtPos(pos, 1);
  return c ? c.top - editor.view.scrollDOM.getBoundingClientRect().top : null;
};
$('editor').editedHere = () => editedHere; // (when each note was edited here, this session)

// ---------- auto-lock ----------

const AUTO_LOCK_KEY = 'auto-lock-minutes';
const LOCK_REASON_KEY = 'tiro-lock-reason'; // sessionStorage: why the last reload locked
const DELETED_KEY = 'tiro-account-deleted'; // sessionStorage: the last reload followed deleting the account

/** This browser's auto-lock setting in minutes (0 = never). */
async function autoLockMinutes() {
  const v = await kvGet(AUTO_LOCK_KEY).catch(() => undefined);
  return AUTO_LOCK_OPTIONS.includes(v) ? v : DEFAULT_AUTO_LOCK;
}

async function startAutoLock() {
  state.autoLock?.stop();
  state.autoLock = new AutoLock({
    canLock: () => !state.busy, // never in the middle of a phrase change
    onLock: () => lock(undefined, { auto: true }),
    onActivity: tellActivity,
  });
  state.autoLock.start(await autoLockMinutes());
}

// ---------- other tabs ----------

// Tabs of this browser share the vault's outbox, offline copies and settings,
// so they keep each other in step: Lock (or auto-lock) in one locks them all,
// activity in one keeps the others from auto-locking, and changes to passkeys
// or settings reach every tab. (Uploads are kept apart by Web Locks, see sync.js.)
let toldActivityAt = 0;
function tellActivity() {
  if (Date.now() - toldActivityAt < 10_000) return;
  toldActivityAt = Date.now();
  tell({ type: 'activity' });
}

tabs?.addEventListener('message', ({ data }) => {
  if (data?.type === 'lock' && state.ctx) lock(undefined, { auto: data.auto, fromTab: true });
  else if (data?.type === 'activity') state.autoLock?.touch();
  else if (data?.type === 'auto-lock') state.autoLock?.setMinutes(data.minutes);
  else if (data?.type === 'passkeys') reloadPasskeys();
});

/** This device's passkey copies, read again (the welcome screen, a change in another tab). */
async function reloadPasskeys() {
  state.passkeys = await passkeyCache.list().catch(() => []);
}

/** Reload this device's passkey copies after changing them, and tell the other tabs. */
async function passkeysChanged() {
  state.passkeys = await passkeyCache.list();
  tell({ type: 'passkeys' });
}

/** The recovery phrase was changed (Settings): the open vault's entropy and identity are the new one's. */
function phraseChanged(entropy, identity) {
  state.entropy = entropy;
  state.ctx.identity = identity;
}

/** The page is about to go (the account deleted, Settings): nothing more starts or syncs. */
function leaving() {
  state.locking = true;
  state.autoLock?.stop();
  state.live?.stop();
}

// ---------- session ----------

/** Open the vault (callers then show the notes, or a step before them). */
async function startSession(entropy, identity) {
  const { accountId, keyring, offline } = await openSession(api, identity, { store: sessionStore });
  state.offline = offline;
  state.unreachable = offline;
  state.entropy = entropy;
  state.ctx = {
    api, accountId, identity, keyring,
    outbox: new IdbOutbox(accountId),
    seen: new IdbSeen(accountId),
    cache: new IdbDocCache(accountId),
    maxBlobBytes: await kvGet(MAX_BLOB_KEY).catch(() => undefined), // refreshed from /account

    onStatus: (docId, s) => {
      setStatus(docId, s); // (the save status in the note's bar: ui/save-status.js)
      if (s === 'saving') state.live?.wake(); // active here: keep other devices' edits coming quickly
      if (s === 'saved') state.storageDirty = true;
      if (s === 'offline') setReachable(false);
    },
    onSessionEnded: () => lock(SESSION_ENDED),
    onRollback: (docId, info) => {
      console.warn('rollback detected', docId, info);
      state.rollbacks.set(docId, info);
      renderRollback();
    },
    onForged: () => ($('forged-banner').hidden = false),
    // A note's private doc refuses writes (#119): moved to a share, or deleted for good.
    // (A shared note's 410, its links turned off, is handled by the share itself.)
    onGone: (docId) => !docId.startsWith('share:') && moveUnsent(docId),
  };
  const keyRollback = await checkKeyring(state.ctx.seen, keyring);
  if (keyRollback) state.ctx.onRollback('keyring', keyRollback);
  // A phrase change left unfinished (#7v4r): its new key is under the new phrase only. Asked for
  // before anything opens (the index may already be under it); the change is finished below.
  let unfinished = null;
  if (keyring.locked.size) {
    const version = Math.max(...keyring.locked.keys());
    unfinished = { ...(await askNewPhrase(keyring, accountId)), version };
    busy('Opening your vault…');
  }
  state.index = new DocSync(state.ctx, 'index');
  await state.index.load();
  notesMap().observeDeep(renderList);
  notesMap().observeDeep(() => scheduleGrants()); // (an app's notes follow its tags, #369)
  state.index.ydoc.getMap('connections').observe(() => {
    renderConnectionsNav();
    renderList(); // (the agents' marks, #514: one connected or gone)
  });
  await mergePhraseSaved();
  // Changed on another device (the phrase saved, your name): shown here too, at once.
  profile().observe((e) => {
    if (e.keysChanged.has('phraseSaved')) renderPhraseBanner();
    if (e.keysChanged.has('name')) renderAccount();
  });
  renderAccount();
  // Other devices' edits pushed at once (live.js); while its socket is down, it polls (pullChanges).
  state.live = new Live(api, {
    onChange: (connected) => {
      document.documentElement.dataset.live = connected ? 'on' : 'off'; // the share light's colour (and tests)
      renderShareLight();
    },
    onPoll: pullChanges,
  });
  state.live.watch(state.index);
  state.live.start(); // (opened offline: a poll signs in once the server's back, goOnline)
  if (unfinished && !offline) {
    // (Offline: open with the key for now; asked again, and finished, on the next sign-in online.)
    await flushStrayOutboxes();
    await finishRotation(unfinished.entropy, unfinished.identity, unfinished.version);
  } else {
    flushStrayOutboxes();
  }
  if (!offline) uploadPendingPasskeys();
  dateUndated(notesMap());
  if (!offline) emptyExpiredTrash();
  return Boolean(unfinished && !offline); // (a phrase change finished: the passkey that signed in is re-wrapped by its caller)
}

/** Upload edits left in the outbox for notes that aren't open (e.g. tab closed mid-save). */
async function flushStrayOutboxes() {
  for (const docId of await state.ctx.outbox.docs()) {
    if (docId === 'index' || docId === state.note?.sync.docId) continue;
    // A shared note's edits: upload them to its share, if the note still has it.
    const noteId = docId.startsWith('share:') ? noteWithShare(docId.slice(6)) : docId;
    // Deleted forever (maybe on another device), or no longer shared: its edits would only bring its data back.
    if (!noteId || isPurged(notesMap(), noteId)) {
      await dropOutbox(docId);
      continue;
    }
    const s = await syncFor(noteId);
    await s.load().catch(() => {});
    await s.flush();
    if (!(await s.hasPending())) s.close();
  }
}

function enterNotes() {
  endFlow();
  startAutoLock();
  renderOffline();
  renderPhraseBanner();
  show('notes');
  // (In through /login: the notes are at /, as a bookmark or the home-screen app has them.)
  if (location.pathname === '/login') history.replaceState(history.state, '', `/${location.search}${location.hash}`);
  renderList();
  refreshStorage();
  const first = visibleNotes()[0];
  const wanted = noteIdAt(location.pathname); // (#299: a note's address, opened or bookmarked, or kept through a lock)
  const connect = connectRequest(); // (#369: an app asked to connect; nothing else starts on the notes meanwhile)
  renderConnectionsNav();
  if (connect) showConsent(connect);
  else if (!maybeShowSwitch()) scheduleGrants(2000); // (#514: once, the notes agents reached through tags)
  // (#582: your notes moved to frontmatter, once, in the background; then the open note's header.)
  if (!connect) setTimeout(() => moveToFrontmatter({ onDone: () => { refreshHead(); renderList(); } }).catch((e) => console.warn('moving notes to frontmatter', e)), 1500);
  if (addSharedFromLink()) {
    /* opening the shared note instead */
  } else if (wanted) openNote(wanted, { replace: true });
  else if (state.note) focusEditor();
  else if (first && window.innerWidth > 720) openNote(first.id, { replace: true }); // (in place: Back leaves the app, not the note)
}

/**
 * Pull the index and the open note: what live.js polls with while its socket is down (and now
 * and then while it's up). Whether anything came; nothing to say while a flow is under way.
 * A vault opened offline signs in first (goOnline).
 */

let storageAt = 0; // (the last /account refresh: refreshStorage)
async function pullChanges() {
  if (!state.ctx || state.locking || state.busy) return;
  let changed = false;
  try {
    if (state.offline) {
      await goOnline();
      state.live?.check({ now: true }); // (signed in: the socket can come up now)
    }
    const got = (r) => Boolean(r.snapshot || r.updates.length);
    changed = got(await state.index.pull());
    if (state.note) changed = got(await state.note.sync.pull()) || changed;
    setReachable(true);
    const since = Date.now() - storageAt;
    if (((state.storageDirty || changed) && since >= STORAGE_MS) || since >= STORAGE_IDLE_MS) refreshStorage();
    state.index.maybeCompact();
    state.note?.sync.maybeCompact();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      lock(SESSION_ENDED);
    } else if (isOffline(e)) setReachable(false);
    else console.warn('pull failed', e);
    return false;
  }
  return changed;
}

/** The vault was opened offline and the server is back: sign in, then sync everything waiting. */
async function goOnline() {
  const { ctx } = state;
  await refreshSession(api, ctx.identity, ctx.keyring, sessionStore);
  const keyRollback = await checkKeyring(ctx.seen, ctx.keyring);
  if (keyRollback) ctx.onRollback('keyring', keyRollback);
  state.offline = false;
  state.live?.start();
  refreshStorage(); // also what the server allows (the largest blob), unknown while offline
  flushStrayOutboxes();
  flushAll(false);
  uploadPendingPasskeys();
}

/** Show or hide the offline bar, and what needs a connection. */
function setReachable(ok) {
  if (state.unreachable === !ok) return;
  state.unreachable = !ok;
  renderOffline();
}

function renderOffline() {
  const off = state.offline || state.unreachable;
  $('offline-bar').hidden = !off;
  $('settings-rotate').disabled = off;
  $('settings-rotate-offline').hidden = !off;
  $('settings-delete').disabled = off;
  $('settings-delete-offline').hidden = !off;
}

async function refreshStorage() {
  storageAt = Date.now();
  state.storageDirty = false;
  try {
    const a = await api.get('/account');
    rememberBlobLimit(a.max_blob_bytes);
    if (state.ctx && a.version_every_secs) state.ctx.versionEverySecs = a.version_every_secs; // how often notes keep a version
    const pct = Math.min(100, (a.used_bytes / a.quota_bytes) * 100);
    $('meter-fill').style.width = `${pct}%`;
    $('storage-text').textContent = `${fmtBytes(a.used_bytes)} of ${fmtBytes(a.quota_bytes)} used`;
    $('settings-nav-storage').textContent = $('storage-text').textContent; // (Settings' list too)
    // How much of it is history (every version kept): the oldest go first if room runs short.
    $('storage-history').hidden = !a.history_bytes;
    $('storage-history').textContent = a.history_bytes ? `${fmtBytes(a.history_bytes)} of it is your notes’ history.` : '';
  } catch {
    /* offline: keep last value */
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Ctrl+Alt+N: a new note. (Ctrl+\, the sidebar: ui/sidebar.js.)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'n' && state.index && !$('view-notes').hidden) {
    e.preventDefault();
    newNote();
  }
});

// ---------- rollback warning ----------

function renderRollback() {
  const n = state.rollbacks.size;
  $('rollback-banner').hidden = n === 0;
  if (!n) return;
  const parts = [];
  if (state.rollbacks.has('keyring')) parts.push('an older set of encryption keys');
  if (state.rollbacks.has('index')) parts.push('an older list of notes');
  const notes = [...state.rollbacks.keys()].filter((k) => k !== 'keyring' && k !== 'index').length;
  if (notes) parts.push(`${notes === 1 ? 'an older version of a note' : `older versions of ${notes} notes`}`);
  $('rollback-text').textContent =
    `It returned ${parts.join(', ')}. Recent changes may be missing. This happens if the server ` +
    'was restored from a backup, or if it is withholding data. Nothing can be forged or read by ' +
    'the server, and new edits still save normally.';
}

$('rollback-ack').addEventListener('click', async () => {
  // Accept the server's current state as the new baseline.
  for (const [docId, info] of state.rollbacks) {
    if (docId === 'keyring') await state.ctx.seen.setKeyVersion(info.got);
    else if (!info.sync.closed) await info.sync.acceptServerState();
    else await state.ctx.seen.setSV(docId, info.current);
  }
  state.rollbacks.clear();
  renderRollback();
});

$('forged-ack').addEventListener('click', () => ($('forged-banner').hidden = true));

// ---------- server limits ----------

const MAX_BLOB_KEY = 'max-blob-bytes';

/** The server's largest blob (uploads are split to fit), kept for offline sessions too. */
function rememberBlobLimit(n) {
  if (!Number.isFinite(n) || n <= 0 || !state.ctx) return;
  state.ctx.maxBlobBytes = n;
  kvPut(MAX_BLOB_KEY, n).catch(() => {});
}

// ---------- saving ----------

/** Something was stored or deleted for good (trash.js): the storage meter is out of date. */
function storageChanged() {
  state.storageDirty = true;
}

// Upload immediately when the tab is hidden or closed; and write the offline copies waiting to
// be written (a short session would otherwise leave none behind, and a bookmarked note wouldn't open offline).
function flushAll(keepalive) {
  if (state.index) flushTags(); // (the open note's tags, if typing just stopped: into the list first)
  state.index?.flush({ keepalive });
  state.note?.sync.flush({ keepalive });
  state.index?.writeCache();
  state.note?.sync.writeCache();
}
// Also remember where you were in the open note: the tab may not come back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return; // (shown again: live.js polls now)
  flushAll(true);
  saveView();
});
window.addEventListener('pagehide', () => {
  flushAll(true);
  saveView();
  state.note?.presence?.leave(); // in a shared note: our cursor goes for the others now
});
// Back to this page as it was (the browser's back/forward cache): here again for the others.
window.addEventListener('pageshow', (e) => e.persisted && state.note?.presence?.rejoin());
window.addEventListener('online', () => {
  flushAll(false);
  state.live?.wake({ now: true });
});
window.addEventListener('offline', () => state.ctx && setReachable(false));

// ---------- lock ----------

const SESSION_ENDED = 'Your session ended — the recovery phrase may have been changed on another device.';

/**
 * Lock: save, then reload. `auto` notes it was auto-lock; a plain Lock (or
 * auto-lock) locks the other tabs too, unless `fromTab` (another tab asked).
 */
async function lock(message, { auto = false, fromTab = false } = {}) {
  if (state.locking) return;
  state.locking = true;
  if (!message && !fromTab) tell({ type: 'lock', auto });
  state.live?.stop();
  state.autoLock?.stop();
  await saveView(); // before the reload below
  if (auto) {
    try {
      sessionStorage.setItem(LOCK_REASON_KEY, String(state.autoLock?.minutes ?? ''));
    } catch {
      /* the note is optional */
    }
  }
  if (!message) {
    busy('Locking…');
    await Promise.allSettled([state.index?.flush(), state.note?.sync.flush()]);
  } else {
    alert(message);
  }
  // The session ends on the server now (#146), its edits sent first: as the page unloads, the
  // browser may drop a request that leaves with others (pagehide below is only the fallback).
  if (api.token) await api.request('POST', '/auth/logout', undefined, { retry: false }).catch(() => {});
  api.token = null;
  // A reload is the most reliable way to drop every key from memory.
  location.reload();
}

// The page going away (a reload; the tab closed): its session ends on the server at once (#146),
// not when it would have expired, so a token that leaked stops working with it. Best effort: the
// browser may drop it among the page's last uploads (Lock ends it before reloading, for sure).
// (Not a page kept for Back, which can come back unlocked: it carries on.)
addEventListener('pagehide', (e) => {
  if (e.persisted || !api.token) return;
  api.request('POST', '/auth/logout', undefined, { keepalive: true, retry: false }).catch(() => {});
  api.token = null;
});

$('btn-logout').addEventListener('click', () => {
  closeMenu();
  lock();
});

// ---------- dialogs: a click outside closes them (#175) ----------

/**
 * A click on the dimmed area around a dialog closes it, as Escape does (its
 * close handlers run as usual). The backdrop's clicks reach the dialog itself,
 * as do its padding's, so it's where the click is that counts; and the press
 * must start outside too, so a drag that selects text inside doesn't close it.
 * Not while it's busy (data-busy: links being made, the account being deleted).
 */
function closeOnClickOutside(dialog) {
  const outside = (e) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => (pressedOutside = outside(e)));
  dialog.addEventListener('click', (e) => {
    if (!pressedOutside || !outside(e) || dialog.dataset.busy) return;
    pressedOutside = false;
    if (dialog.requestClose) dialog.requestClose();
    else dialog.close();
  });
}
for (const id of ['share-dialog', 'history-dialog', 'settings', 'delete-dialog']) closeOnClickOutside($(id));

// ---------- no zoom on touch devices ----------

// The viewport meta covers Android/Chrome; iOS Safari ignores
// user-scalable=no, so cancel its pinch gestures directly. One-finger
// scrolling is untouched: only multi-touch moves are cancelled.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });

// The screens' modules get what they need from here (#259).
// Each screen's module gets, here, what only app.js has: the server, the session and its
// storage, the editor, the note list and how it's drawn. A module imports the others' functions
// itself, except where they import it back (#446): the open note's module (note.js) and those it
// opens (trash.js, reading.js, shares.js) need each other, as Settings and Sharing do, so those
// few are handed over here (openNote, closeNote, viewKey, saveView, updateMeta, dropOutbox,
// renderSettingsNav).
initNote({ TITLE_MAX, editor, flushAll, renderList, visibleNotes });
initReading({ editor, saveView }); // (Edit and Preview, #302)
initTrash({ api, closeNote, openNote, renderList, storageChanged, viewKey });
initMenus({ renderList });
initTagList({ renderList });
initNoteHead({ editor, visibleNotes });
initSearch({ editor, renderList }); // (#24)
initSettings({ api, AUTO_LOCK_KEY, DELETED_KEY, autoLockMinutes, flushAll, leaving, passkeysChanged, refreshStorage, renderOffline });
initOnboarding({ api, DELETED_KEY, LOCK_REASON_KEY, enterNotes, passkeysChanged, phraseChanged, reloadPasskeys, startSession });
initSharing({ api, editor, openNote, renderSettingsNav, updateMeta, dropOutbox });
initShareDialog({ api, renderList });
initKeep();
initConsent({ api });
initConnections({ api });
// Settings → Connections draws itself when opened (the server says when each was used).
document.querySelector('.settings-nav button[data-section="connections"]').addEventListener('click', () => renderConnections());

// ---------- boot ----------

if (!crypto.subtle || !('indexedDB' in window)) {
  document.body.textContent = 'This browser lacks the cryptography features Plim needs (open it over HTTPS or localhost).';
} else {
  // Device passwords and per-device passkeys are gone: drop any left from before.
  removeLegacyUnlock()
    .then((id) => id && forgetCredential(unb64(id)))
    .catch((e) => console.warn('removing the old unlock failed', e))
    .finally(() => showWelcome().catch((e) => window.plimFatal?.('Plim couldn’t start', e)));
  // Lets the app open without a connection (see sw.js).
  navigator.serviceWorker
    ?.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      // Everything this page loaded from /v/<hash>/, so it's available offline from the first visit.
      const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(`${location.origin}/v/`));
      reg.active?.postMessage({ type: 'precache', urls });
    })
    .catch((e) => console.warn('offline support unavailable', e));
}

window.plimStarted = true; // (boot.js: from here, failures are the app's to show)
