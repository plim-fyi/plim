// Hiding the sidebar on desktop (#522: out of app.js). It can be hidden (its button, or Ctrl+\ /
// ⌘\), kept so in this browser. While hidden, pointing at the window's left edge or at the button
// in the note's bar slides it in over the note ("peeking"), to pick another note; it slides away
// once the pointer leaves it (not while one of its menus is open) or a note is picked. Clicking
// either button keeps it open. Phones are unaffected: there the list and the note are separate
// screens.
import { $, PHONE, state } from './shared.js';

const SIDEBAR_KEY = 'tiro-sidebar';
let peekTimer;

function sidebarHidden() {
  return document.documentElement.dataset.sidebar === 'hidden';
}

function setSidebarHidden(hidden) {
  if (hidden) document.documentElement.dataset.sidebar = 'hidden';
  else delete document.documentElement.dataset.sidebar;
  peek(false);
  try {
    if (hidden) localStorage.setItem(SIDEBAR_KEY, 'hidden');
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    /* not kept, then */
  }
  const label = hidden ? 'Keep the sidebar open' : 'Hide the sidebar';
  $('sidebar-toggle').setAttribute('aria-label', label);
  $('sidebar-toggle').title = `${label} (Ctrl+\\)`;
}

function peek(on) {
  clearTimeout(peekTimer);
  $('view-notes').classList.toggle('sidebar-peek', on && sidebarHidden());
}

/** The pointer left it: slide away soon, unless it came back or a menu from it is open. */
function peekLater() {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(function check() {
    if (state.menu || document.querySelector('.sidebar:hover')) peekTimer = setTimeout(check, 300);
    else peek(false);
  }, 300);
}

try {
  if (localStorage.getItem(SIDEBAR_KEY) === 'hidden') setSidebarHidden(true);
} catch {
  /* shown, then */
}
$('sidebar-toggle').addEventListener('click', () => setSidebarHidden(!sidebarHidden()));
$('sidebar-show').addEventListener('click', () => setSidebarHidden(false));
// The button opens it at once; the edge after a moment's rest, so passing over it on the way
// to something else (the window's edge is easy to brush) doesn't.
$('sidebar-show').addEventListener('mouseenter', () => peek(true));
$('sidebar-edge').addEventListener('mouseenter', () => {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => peek(true), 150);
});
$('sidebar-edge').addEventListener('mouseleave', () => !$('view-notes').classList.contains('sidebar-peek') && clearTimeout(peekTimer));
document.querySelector('.sidebar').addEventListener('mouseenter', () => sidebarHidden() && peek(true));
document.querySelector('.sidebar').addEventListener('mouseleave', () => sidebarHidden() && peekLater());
$('sidebar-show').addEventListener('mouseleave', () => sidebarHidden() && peekLater());
// A note picked from it while peeking: it slides away.
$('note-list').addEventListener('click', () => sidebarHidden() && peek(false));

// Ctrl+\ (⌘\): hide the sidebar, or show it again (desktop).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '\\' && !$('view-notes').hidden && !PHONE.matches) {
    e.preventDefault();
    setSidebarHidden(!sidebarHidden());
  }
});

// A phone: the list's order beside the search field, one row for both (the list's label row, then
// empty, isn't shown: style.css). A computer: at the label's right, over the list, as it was.
function placeSort() {
  const sort = $('notes-sort');
  const search = document.querySelector('.sidebar-search');
  if (PHONE.matches) {
    if (sort.parentElement !== search) search.insertBefore(sort, $('search-summary'));
  } else if (sort.parentElement !== $('notes-head')) $('notes-head').append(sort);
}
placeSort();
PHONE.addEventListener('change', placeSort);
