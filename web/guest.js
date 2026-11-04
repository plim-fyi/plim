// The page a shared note's link opens (/s/<id>#<key>, #70): the note,
// decrypted in the browser, for anyone with the link and no account needed.
// An edit link can change it, a view link only read it. Like the app, it
// keeps an offline copy and unsent edits on this device (encrypted with the
// share's key), and follows other people's edits live.

import { Api, ApiError, isOffline, whenOutdated } from './core/api.js';
import { ON_A_PHONE } from './editor/phone.js';
import { TextareaEditor } from './editor/textarea.js';
import { Live } from './core/live.js';
import { keysFromLink, parseHolderLink, parseShareLink, readTokenHex, resolveHolder } from './core/share.js';
import { fallbackName } from './core/names.js';
import { Presence, renderChips } from './core/presence.js';
import { ShareDocSync } from './core/sharesync.js';
import { noteTitle } from './core/frontmatter.js';
import { IdbDocCache, IdbOutbox, IdbSeen } from './core/vault.js';
import * as Y from './vendor/yjs.mjs';
import { init as initReading, noteBound, noteClosed } from './ui/reading.js';

const $ = (id) => document.getElementById(id);

function message(title, text) {
  $('guest-message-title').textContent = title;
  $('guest-message-text').textContent = text;
  $('guest-message').hidden = false;
  noteClosed(); // (the page, on a touch device)
  $('editor').hidden = true;
  $('guest-add').hidden = true;
  $('guest-mode').hidden = true;
  $('guest-name').hidden = true;
  $('guest-more').hidden = true;
  $('guest-view-only').hidden = true;
  $('guest-title').textContent = '';
  closeMenu();
  // (Its place kept, empty: on a phone it's a line of its own, and the header shrank, #442.)
  $('presence').style.visibility = 'hidden';
  $('guest-status').textContent = '';
}

// ⋯: below its button, right-aligned; closed by a press elsewhere, Escape, or choosing something.
function openMenu() {
  const menu = $('guest-menu');
  const r = $('guest-more').getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - 8 - menu.offsetWidth))}px`;
  $('guest-more').setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  $('guest-menu').hidden = true;
  $('guest-more').setAttribute('aria-expanded', 'false');
}
$('guest-more').addEventListener('click', () => ($('guest-menu').hidden ? openMenu() : closeMenu()));
document.addEventListener('pointerdown', (e) => {
  if (!$('guest-menu').hidden && !$('guest-menu').contains(e.target) && !$('guest-more').contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('guest-menu').hidden) {
    closeMenu();
    $('guest-more').focus();
  }
});
window.addEventListener('resize', closeMenu);
$('guest-menu-add').addEventListener('click', () => {
  closeMenu();
  $('guest-add').click();
});
// Your name: typed in the menu; Enter keeps it and closes the menu ("change" saves it).
$('guest-name').addEventListener('keydown', (e) => e.key === 'Enter' && closeMenu());

/** The note's title in the header: its frontmatter's, else its first non-empty line, as the app lists it (#584). */
function renderTitle(text) {
  const title = noteTitle(text).slice(0, 80);
  $('guest-title').textContent = title || 'Untitled';
  $('guest-title').classList.toggle('untitled', !title);
}

// Kept on this device (any storage problem: just ask again):
// what others see a guest as, and the server's largest blob (for offline starts).
const NAME_KEY = 'tiro-guest-name';
const BLOB_KEY = 'tiro-max-blob-bytes';
function remembered(key) {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function remember(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* not remembered, then */
  }
}
const guestName = () => remembered(NAME_KEY) ?? '';

/** The others here, as chips in the header. */
const renderPresence = (people) => renderChips($('presence'), people);

// Only what needs attention: saving is what normally happens, so it says nothing.
const STATUS = { saving: '', saved: '', offline: 'Offline — your edits are kept and sent when you’re back', full: 'This note is full (or its owner’s storage is): edits can’t be saved', 'too-large': 'This note is too large to save', error: 'Couldn’t save' };

async function start() {
  const api = new Api();
  let link = parseShareLink(location.pathname, location.hash);
  let keys;
  // A link of someone's own (#369): its holder's row says which share the note is in now, and
  // holds its keys; from there on it's a share link. (Replaced links: the row was re-sealed.)
  const holder = link ? null : parseHolderLink(location.pathname, location.hash);
  if (holder) {
    try {
      const r = await resolveHolder(api, holder);
      link = { shareId: r.shareId, noteId: holder.noteId, mode: r.mode, holder };
      keys = r.keys;
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) return message('This link was turned off', 'Whoever shared this note took this link back, or stopped sharing it.');
      if (err instanceof ApiError && err.status === 404) return message('This link doesn’t work', 'The note may have been unshared or deleted, or this link taken back.');
      if (!isOffline(err)) throw err;
      return message('Couldn’t open this note', 'You’re offline. This link needs a connection the first time.');
    }
  }
  if (!link) return message('This link is incomplete', 'Ask for the link again: it needs everything after the “#”.');
  keys ??= await keysFromLink(link);
  const token = readTokenHex(keys);

  let maxBlobBytes = Number(remembered(BLOB_KEY)) || undefined;
  let versionEverySecs; // how often the note keeps a version (history.js; its default if unknown)
  try {
    const r = await api.request('GET', `/shares/${link.shareId}`, undefined, { headers: { 'x-share-token': token } });
    if (r.status === 'revoked') return message('This link was turned off', 'Whoever shared this note stopped sharing it, or replaced the link.');
    if (r.max_blob_bytes) remember(BLOB_KEY, (maxBlobBytes = r.max_blob_bytes));
    versionEverySecs = r.version_every_secs;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return message('This link doesn’t work', 'The note may have been unshared or deleted, or the link replaced with a new one.');
    }
    if (!isOffline(err)) throw err;
    // Offline: open this device's copy, if there is one.
  }

  const gone = () => {
    live.stop();
    message('This link was turned off', 'Whoever shared this note stopped sharing it, or replaced the link. Ask them for a new one.');
  };
  const ctx = {
    api,
    outbox: new IdbOutbox('guest'),
    cache: new IdbDocCache('guest'),
    seen: new IdbSeen('guest'),
    maxBlobBytes, // big pastes upload in pieces that fit (unknown: sync.js assumes 1 MiB)
    versionEverySecs,
    onStatus: (_, s) => ($('guest-status').textContent = STATUS[s] ?? ''),
    onRollback: () => console.warn('this shared note is older on the server than on this device'),
    onForged: () => ($('forged-banner').hidden = false),
  };
  $('forged-ack').addEventListener('click', () => ($('forged-banner').hidden = true));
  const sync = new ShareDocSync(ctx, { id: link.shareId, keys }, new Y.Doc(), { onGone: gone });
  // Running an older (or newer) Plim than the server's (api.js): offer to reload.
  whenOutdated(() => ($('update-banner').hidden = false));
  $('update-reload').addEventListener('click', () => {
    sync.flush({ keepalive: true }); // (unsent edits are kept on this device anyway, and go after the reload)
    location.reload();
  });
  // On a phone the note is edited in a plain textarea (#290); elsewhere in CodeMirror, loaded only there.
  const editor = ON_A_PHONE ? new TextareaEditor($('editor')) : new (await import('./editor/editor.js')).NoteEditor($('editor'));
  initReading({ editor }); // (Edit and Preview, #302; nowhere to keep its place)
  const ytext = sync.ydoc.getText('body');
  // Other people's edits and cursors, live (started once the note is loaded); while its socket is
  // down, it polls (#261).
  const live = new Live(api, {
    guest: true,
    onChange: (connected) => {
      // The status light on "You can edit" / "View only" (style.css: .live-light).
      document.documentElement.dataset.live = connected ? 'on' : 'off';
      $('guest-mode').title = connected ? 'Live: others’ edits and cursors show up at once'
        : 'Reconnecting: your edits are kept, and others’ catch up when it’s back';
    },
    onPoll: async () => {
      try {
        const r = await sync.pull();
        sync.maybeCompact();
        return Boolean(r.snapshot || r.updates.length);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 410 || err.status === 404)) gone();
        return false;
      }
    },
  });
  // Without a name of your own, you're a character from Middle-earth (names.js), shown in the box until you type one.
  const presence = new Presence(sync, live, { name: guestName() || fallbackName(), viewing: !sync.writable }, { onChange: renderPresence });
  $('guest-name').value = guestName();
  $('guest-name').placeholder = fallbackName();
  $('guest-name').hidden = false;
  $('presence').hidden = false; // its row is kept from the start (style.css): the note doesn't move when people arrive
  $('guest-name').addEventListener('change', (e) => {
    const name = e.target.value.replace(/\s+/g, ' ').trim().slice(0, 40);
    e.target.value = name;
    remember(NAME_KEY, name);
    presence.setName(name || fallbackName());
  });
  // The page title stays "Shared note — Plim": a title goes into browser
  // history (and history sync), so it mustn't carry any of the note's text.
  const show = () => {
    editor.show(ytext, null, { editable: sync.writable, awareness: presence.awareness });
    noteBound(ytext, null, { editable: sync.writable, awareness: presence.awareness }); // (the editor; a view link: Preview)
  };

  $('guest-mode').textContent = sync.writable ? 'You can edit' : 'View only';
  $('guest-mode').hidden = false;
  $('guest-view-only').hidden = sync.writable;
  $('editor').hidden = false;
  $('guest-add').hidden = false;
  $('guest-more').hidden = false;
  renderTitle(ytext.toString());
  ytext.observe(() => renderTitle(ytext.toString()));

  const local = await sync.loadLocal().catch(() => false);
  if (local) show();
  try {
    await sync.loadRemote();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 410 || err.status === 404)) return gone();
    if (!local) return message('Couldn’t open this note', isOffline(err) ? 'You’re offline, and this device has no copy yet.' : String(err.message ?? err));
  }
  if (!local) show();

  live.watch(sync);
  live.start();
  window.addEventListener('pagehide', () => {
    presence.leave(); // our cursor disappears for the others now, not after a timeout
    sync.flush({ keepalive: true });
  });
  // Back to this page as it was (Back, then Forward: the browser kept it): here again for the others.
  window.addEventListener('pageshow', (e) => e.persisted && presence.rejoin());
  document.addEventListener('visibilitychange', () => document.hidden && sync.flush({ keepalive: true }));

  // A Plim user can keep the note in their own list: the app takes it from here (the key stays in the fragment).
  $('guest-add').addEventListener('click', () => {
    // (A holder's link: the app keeps the holder, whose row follows the note's share, #369.)
    location.href = link.holder ? `/#add-holder=${location.hash.slice(3)}` : `/#add-share=${link.shareId}.${location.hash.slice(1)}`;
  });
  // For tests and debugging.
  $('editor').noteText = () => editor.text();
  $('editor').cursorLine = () => editor.cursorLine();
  $('editor').noteYText = () => editor.ytext;
}

start().catch((err) => window.plimFatal?.('Something went wrong', err));

// Lets the link open again without a connection, from this device's copy (see sw.js).
navigator.serviceWorker
  ?.register('/sw.js')
  .then(() => navigator.serviceWorker.ready)
  .then((reg) => {
    // Everything this page loaded from /v/<hash>/, so it's there offline from the first visit.
    const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(`${location.origin}/v/`));
    reg.active?.postMessage({ type: 'precache', urls, page: location.pathname });
  })
  .catch((e) => console.warn('offline support unavailable', e));

window.plimStarted = true; // (boot.js: from here, failures are the page's to show)
