// Menus (#259): a note's (the note bar's ⋮, a row's right-click or long-press) and yours, the
// account button, and a shared note's status light. The rest of the app it needs comes through init().
import { $, PHONE, showToast, state } from './shared.js';
import { noteUrl } from '../core/noteurl.js';
import { SORTS, SORT_NAMES } from '../core/notesort.js';
import { NOTEBOOK } from '../core/connections-sync.js';
import { openShareDialog } from './share-dialog.js';
import { placeOf, profile, sharedWith } from './shares.js';
import { agentMarks, reachWords, sharedWords } from './reach.js';
import { deleteNote } from './trash.js';
import { showAllNotes } from './taglist.js';
import { downloadNote } from './export.js';

// From app.js (init): the note list's render.
let renderList;
export function init(deps) {
  ({ renderList } = deps);
}


/**
 * Open a menu by the button that opened it (`anchor`: below it, or above if
 * there's no room) or at a point (a right-click). `id`: the note it's for.
 * `align`: which edges line up with the anchor's.
 */
function openMenu(menu, { id = null, anchor = null, x, y, align = 'right' } = {}) {
  closeMenu();
  state.menu = { menu, id, anchor };
  anchor?.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  const r = x === undefined ? anchor.getBoundingClientRect() : { top: y, bottom: y, left: x, right: x };
  const below = r.bottom + 4 + menu.offsetHeight <= window.innerHeight;
  menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight)}px`;
  const left = x !== undefined || align === 'left' ? r.left : r.right - menu.offsetWidth;
  menu.style.left = `${Math.min(Math.max(8, left), window.innerWidth - 8 - menu.offsetWidth)}px`;
  menu.querySelector('button:not([hidden])').focus();
}

export function closeMenu({ refocus = false } = {}) {
  if (!state.menu) return;
  const { menu, anchor } = state.menu;
  state.menu = null;
  anchor?.setAttribute('aria-expanded', 'false');
  menu.hidden = true;
  if (refocus) anchor?.focus();
}

/**
 * A note's menu: Share…, Copy link and Delete note. From the open note's ⋮ on desktop, Share is
 * beside it instead; on phones its ⋯ holds all of the bar: who's here, History,
 * Share (with the sharing light).
 */
function openNoteMenu(id, opts) {
  const all = Boolean(opts.fromBar) && PHONE.matches;
  $('note-menu-share').hidden = Boolean(opts.fromBar) && !all;
  // Shared with people: "Shared" (and its light, Live, on a phone's ⋯); with agents (#514), said under it.
  const { people: forPeople } = sharedWith(id);
  $('note-menu-share-label').textContent = forPeople ? 'Shared' : 'Share…';
  const agents = placeOf(id) === NOTEBOOK;
  $('note-menu-share-sub').hidden = !agents;
  $('note-menu-share-sub').textContent = !agents ? '' : forPeople ? 'and with agents' : 'Shared with agents';
  $('note-menu-live').hidden = !(all && forPeople);
  $('note-menu-live').textContent = state.live?.connected ? 'Live' : 'Reconnecting';
  $('note-menu-history').hidden = !all || $('note-history').hidden;
  const people = all ? [...$('presence').children].filter((c) => !c.classList.contains('leaving')) : [];
  $('note-menu-people').hidden = !people.length;
  $('note-menu-people').replaceChildren();
  if (people.length) {
    const faces = Object.assign(document.createElement('span'), { className: 'faces' });
    faces.append(...people.map((c) => c.cloneNode(true)));
    const names = people.map((c) => c.dataset.name);
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    $('note-menu-people').append(faces, `${who} ${names.length === 1 ? 'is' : 'are'} here`);
  }
  openMenu($('note-menu'), { id, ...opts });
}
$('note-menu-history').addEventListener('click', () => {
  closeMenu();
  $('note-history').click();
});

// A row's menu: right-click (or the keyboard's menu key, Shift+F10), or a long press on a touch screen.
let pressedLong = false; // (the tap that ends a long press doesn't open the note too)
/** Whether this click ends a long press (then it doesn't open the note); asked once, it's forgotten. */
export function endsLongPress() {
  const was = pressedLong;
  pressedLong = false;
  return was;
}
export function rowMenu(btn, id) {
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (state.menu?.id === id) return; // (a long press opened it already)
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    openNoteMenu(id, fromKeyboard ? { anchor: btn, align: 'left' } : { anchor: btn, x: e.clientX, y: e.clientY });
  });
  let timer = null;
  let start = null;
  const cancel = () => clearTimeout(timer);
  btn.addEventListener('pointerdown', (e) => {
    pressedLong = false;
    if (e.pointerType !== 'touch') return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      pressedLong = true;
      openNoteMenu(id, { anchor: btn, x: start.x, y: start.y });
    }, 500);
  });
  btn.addEventListener('pointermove', (e) => start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10 && cancel());
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, cancel);
}

$('note-more').addEventListener('click', () => {
  if (state.menu?.anchor === $('note-more')) return closeMenu();
  if (state.note) openNoteMenu(state.note.id, { anchor: $('note-more'), fromBar: true });
});
$('note-menu-delete').addEventListener('click', () => {
  const id = state.menu?.id;
  closeMenu();
  if (id) deleteNote(id);
});
$('note-menu-share').addEventListener('click', () => {
  const id = state.menu?.id;
  closeMenu();
  if (id) openShareDialog(id);
});
// Download (#47): the note as a Markdown file.
$('note-menu-download').addEventListener('click', () => {
  const id = state.menu?.id;
  closeMenu();
  if (id) downloadNote(id);
});
// Copy link (#299): the note's address, /n/<id>. Yours to open (signed in); a name for the note
// anywhere else — a bookmark, a chat, the terminal client — and never a key to it.
$('note-menu-link').addEventListener('click', async () => {
  const id = state.menu?.id;
  closeMenu();
  if (!id) return;
  try {
    await navigator.clipboard.writeText(noteUrl(id));
    showToast('Link copied');
  } catch {
    showToast('Couldn’t copy the link. It’s in the address bar while the note is open.');
  }
});

// Yours: Settings and Recently deleted (Lock is its own button, beside it).
$('btn-account').addEventListener('click', () => {
  if (state.menu?.menu === $('account-menu')) return closeMenu();
  openMenu($('account-menu'), { anchor: $('btn-account'), align: 'left' });
});
$('btn-settings').addEventListener('click', () => closeMenu());

/** The account button: your name (for shared notes) if you've set one, and its first letter. */
export function renderAccount() {
  const name = profile().get('name') || '';
  $('account-name').textContent = name || 'Account';
  $('account-avatar').textContent = name ? [...name][0].toUpperCase() : '';
  $('account-avatar').classList.toggle('anonymous', !name);
}
for (const b of [$('note-share'), $('note-agents')]) b.addEventListener('click', () => state.note && openShareDialog(state.note.id));

/**
 * A shared note's button has a status light: green while others' edits and
 * cursors arrive live, grey while reconnecting (edits still save, and are
 * caught up then). The colour comes from html[data-live] (style.css); this
 * says the same in words. A note shared with agents (#514) has a pill beside it: their letters,
 * which opens Share (and, not shared with people, stands for it).
 */
export function renderShareLight() {
  const id = state.note?.id;
  const { people, apps } = id ? sharedWith(id) : { people: false, apps: [] };
  for (const b of [$('note-share'), $('note-more')]) b.classList.toggle('shared', people); // (on a phone, on ⋯)
  const b = $('note-share');
  b.setAttribute('aria-label', people ? (state.live?.connected ? 'Shared, live' : 'Shared, reconnecting') : 'Share');
  b.title = people
    ? state.live?.connected ? 'Shared: others’ edits and cursors show up live' : 'Shared: reconnecting (your edits are kept, and others’ catch up when it’s back)'
    : 'Share this note';
  const agents = Boolean(id) && placeOf(id) === NOTEBOOK;
  $('note-agents').hidden = !agents;
  b.classList.toggle('beside-agents', agents && !people);
  if (!agents) return;
  $('note-agents-marks').replaceChildren(agentMarks(apps, { label: false }));
  $('note-agents').title = `${sharedWords(apps)}. ${apps.length ? `${reachWords(apps)} it.` : 'Any agent you connect reads and edits it.'} Share…`;
  $('note-agents').setAttribute('aria-label', `${sharedWords(apps)}. Share…`);
}

// Close on a press anywhere else (its button toggles it itself), Escape, scrolling or resizing.
document.addEventListener('pointerdown', (e) => {
  if (state.menu && !state.menu.menu.contains(e.target) && !state.menu.anchor?.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.menu) closeMenu({ refocus: true });
  // Up and down move through a menu's items (round the end), as in a system menu.
  if (state.menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.menu.menu.contains(document.activeElement)) {
    const items = [...state.menu.menu.querySelectorAll('button')].filter((b) => !b.hidden && b.offsetParent);
    const at = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});

// The list's order (#344): Last edited (as always) or Date created, from the button beside its
// label; newest first; kept on this device. (The order itself: ../notesort.js, app.js renderList.)
const SORT_KEY = 'tiro-sort';
state.sortBy = (() => {
  try {
    const kept = localStorage.getItem(SORT_KEY);
    return SORTS.includes(kept) ? kept : 'edited';
  } catch {
    return 'edited';
  }
})();
function renderSort() {
  $('notes-sort-label').textContent = SORT_NAMES[state.sortBy];
  $('notes-sort').setAttribute('aria-label', `Sort the notes: ${SORT_NAMES[state.sortBy]}`);
  for (const b of $('sort-menu').querySelectorAll('[data-sort]')) b.setAttribute('aria-checked', String(b.dataset.sort === state.sortBy));
}
renderSort();
$('notes-sort').addEventListener('click', (e) => {
  if (state.menu?.menu === $('sort-menu')) return closeMenu();
  openMenu($('sort-menu'), { anchor: $('notes-sort') });
  // From the keyboard: on the order in use, as a system menu does. A tap or a click: on the menu
  // itself (arrows still go from there), not a focus ring drawn round an item (iPad Safari did).
  if (e.detail) $('sort-menu').focus();
  else $('sort-menu').querySelector('[aria-checked="true"]').focus();
});
$('sort-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  closeMenu({ refocus: true });
  if (b.dataset.sort === state.sortBy) return;
  state.sortBy = b.dataset.sort;
  try {
    localStorage.setItem(SORT_KEY, state.sortBy);
  } catch {
    /* (not kept, then: this page only) */
  }
  renderSort();
  renderList();
  $('sidebar-scroll').scrollTop = 0; // (the newest, in the new order)
});
$('sidebar-scroll').addEventListener('scroll', () => {
  closeMenu();
  $('sidebar-scroll').classList.toggle('scrolled', $('sidebar-scroll').scrollTop > 0); // (its list fades under New note: style.css)
});
$('notes-more').addEventListener('click', () => {
  showAllNotes();
  renderList();
});
window.addEventListener('resize', () => closeMenu());
