// What every part of the app's page shares (#259): its state, and the small things each screen
// does the same way: switching views, a toast, an error under a form, a word to the other tabs.
// Nothing here knows about any one screen: the screens' modules (ui/*.js) and app.js import it.
import { notAfterNow, now as clockNow } from '../core/clock.js';

export const $ = (id) => document.getElementById(id);

/** A new element with its class and properties: el('span', 'setting-sub', { textContent: '…' }). */
export const el = (tag, className, props = {}) => Object.assign(document.createElement(tag), { className, ...props });

/**
 * A list drawn again in place (#442): each item's element found by its key and updated, made
 * only for a new item, removed only for one that's gone, moved only if its order changed. So a
 * redraw doesn't replace what's under someone's finger, or lose its focus, or move anything that
 * didn't change. `make(item)` builds an element, `update(el, item)` fills it in (every time).
 */
export function keyed(container, items, keyOf, make, update) {
  const old = new Map([...container.children].map((c) => [c.dataset.key, c]));
  let at = container.firstElementChild;
  for (const item of items) {
    const key = String(keyOf(item));
    let node = old.get(key);
    old.delete(key);
    if (!node) {
      node = make(item);
      node.dataset.key = key;
    }
    update(node, item);
    if (node === at) at = at.nextElementSibling;
    else container.insertBefore(node, at);
  }
  for (const gone of old.values()) gone.remove();
}

// A phone or tablet: no pointer that hovers, a finger. (Focusing the editor anywhere but in a
// tap doesn't open the keyboard there; and a note opens as a page, #283.)
export const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');

/** A phone-width window: the list and the note as screens of their own, sheets for menus. */
export const PHONE = matchMedia('(max-width: 720px)');

/**
 * What more than one module needs to know (#446). Each field has one owner, in brackets: the only
 * module that writes it; the others read it, or ask the owner to change it (web/tests/state.test.mjs
 * checks). What only one module needs is kept in that module, not here (signing up and passkeys:
 * ui/flow.js).
 */
export const state = {
  // The open vault.
  ctx: null, // [app.js] { api, accountId, identity, keyring, outbox, seen, cache, onStatus, … }
  index: null, // [app.js] DocSync for the note index
  entropy: null, // [app.js] the recovery entropy (the 12 words), for passkeys and Settings
  live: null, // [app.js] Live (live.js) while a vault is open
  autoLock: null, // [app.js] AutoLock while a vault is open
  offline: false, // [app.js] opened from this device's copy; not signed in to the server yet
  unreachable: false, // [app.js] the last contact with the server failed
  locking: false, // [app.js] locking (or the account deleted): the page is about to reload
  statuses: new Map(), // [ui/save-status.js] docId → what its sync last said ('saving', 'saved', 'offline', …)
  rollbacks: new Map(), // [app.js] docId (or 'keyring') → detection info
  storageDirty: false, // [app.js] something stored or deleted since the storage meter's last refresh
  passkeys: [], // [app.js] this device's cached passkey copies, loaded before the tap (vault.js passkeyCache)
  busy: false, // [ui/onboarding.js] the phrase is being changed (no locking meanwhile)

  // The notes.
  note: null, // [ui/note.js] the open note: { id, sync, unbind, … }
  tagFilter: null, // [ui/taglist.js] the tag picked in the sidebar: the list shows only its notes (#308)
  inConnected: false, // [ui/taglist.js] the Connected view (#552): the notes shared with agents, or written in by an agent or a script
  writerFilter: null, // [ui/taglist.js] the writer picked in Connected's table (#564): only the notes it wrote in
  showAllNotes: false, // [ui/taglist.js] every note in the list, not the first few
  sortBy: undefined, // [ui/menus.js] the list's order (notesort.js), once picked
  menu: null, // [ui/menus.js] { menu, id, anchor } while a menu is open
};

/**
 * When this device last edited each note (this session), by the server's clock: a note deleted
 * elsewhere while it was edited here comes back (ui/notelist.js), and a connection's notes follow
 * an edit made here at once (ui/connections-keep.js). Written wherever a note is changed. (Here,
 * not in notelist.js: modules that notelist.js imports need it too, #521.)
 */
export const editedHere = new Map();

/** The open vault's notes, in its note list (the index): id → its Y.Map (title, tags, share, …). */
export const notesMap = () => state.index.ydoc.getMap('notes');

// ---------- view switching ----------

export function show(view) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${view}`;
  // A toast is about the notes ("Note deleted · Undo"): it doesn't follow you to another screen.
  if (view !== 'notes') $('toast').hidden = true;
}

export function busy(text) {
  $('busy-text').textContent = text;
  show('busy');
}

export function setError(id, e) {
  $(id).textContent = e ? (typeof e === 'string' ? e : e.message) : '';
  // What the browser reported, if any: smaller, under the message.
  if (e?.details) $(id).append(Object.assign(document.createElement('span'), { className: 'error-details', textContent: e.details }));
}

let toastTimer;
/** A short message at the bottom, with an optional action (gone after a few seconds). */
export function showToast(text, { action, onAction } = {}) {
  clearTimeout(toastTimer);
  $('toast-text').textContent = text;
  const button = $('toast-action');
  button.hidden = !action;
  button.textContent = action ?? '';
  button.onclick = () => {
    $('toast').hidden = true;
    onAction?.();
  };
  // (Over a dialog that's open, as Settings is when an app is disconnected: inside it, in the
  // top layer, or the toast would be behind it.)
  const host = [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body;
  if ($('toast').parentElement !== host) host.append($('toast'));
  $('toast').hidden = false;
  stackToast();
  toastTimer = setTimeout(() => ($('toast').hidden = true), action ? 8000 : 3000);
}

/**
 * A toast above a banner that's up where it would be, never on it (#319: one hid the other), or
 * above a bar of actions (.keep-clear: a deleted note's Restore on a phone, #190). Again when such
 * a bar comes or goes under a toast that's up.
 */
export function stackToast() {
  const toast = $('toast');
  if (toast.hidden) return;
  toast.style.bottom = '';
  const r = toast.getBoundingClientRect();
  let top = Infinity;
  for (const b of document.querySelectorAll('.banner:not([hidden]), .keep-clear')) {
    const br = b.getBoundingClientRect();
    if (br.width && br.left < r.right && br.right > r.left && br.top < r.bottom && br.bottom > r.top) top = Math.min(top, br.top);
  }
  if (top !== Infinity) toast.style.bottom = `${Math.round(innerHeight - top + 8)}px`;
}

// Tabs of this browser share the vault's outbox, offline copies and settings, so they keep each
// other in step (app.js listens): a word to them all.
export const tabs = globalThis.BroadcastChannel ? new BroadcastChannel('tiro') : null;

export function tell(message) {
  try {
    tabs?.postMessage(message);
  } catch {
    /* best effort */
  }
}

/**
 * A button's label for a moment ("Copied"), then its own again; its width kept, so the buttons
 * beside it don't move as it changes back (#442).
 */
export function flashLabel(button, text, ms = 2000) {
  button.dataset.label ??= button.textContent;
  button.style.minWidth = `${button.offsetWidth}px`;
  button.textContent = text;
  clearTimeout(button.flashTimer);
  button.flashTimer = setTimeout(() => (button.textContent = button.dataset.label), ms);
}

/** "just now", "5 min ago", "3 h ago", else the date. */
export function relTime(ts) {
  if (!ts) return '';
  const s = (clockNow() - notAfterNow(ts)) / 1000; // (never "in 5 min": another device's clock may be ahead)
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
