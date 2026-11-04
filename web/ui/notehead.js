// The note's header (#581, #584): its frontmatter, folded into what it says. The title, to edit
// in place; its tags as badges (a tap: that tag's notes; ×: off), "+ tag" for a picker of the
// tags you use (with how many notes each), and "yaml ›" for the block itself, in the editor.
// Above the editor and Preview alike; the editor hides the block's lines meanwhile
// (editor.js, textarea.js hideFrontmatter). Every change is the block's text changed, one
// line, as plim and the agents change it (core/frontmatter.js).
import { addTag, noteTitle, readFrontmatter, removeTag, setTitle, withoutRepeatedBlock } from '../core/frontmatter.js';
import { replaceText } from './to-frontmatter.js';
import { tagCounts, tagName } from '../core/tags.js';
import { $, PHONE, el } from './shared.js';

// From app.js (init): the editor; the notes listed (their tags, for the picker).
let editor, visibleNotes;
export function init(deps) {
  ({ editor, visibleNotes } = deps);
}

let bound = null; // { ytext, editable, observer }
let yamlShown = false;

/** Whether the open note shows a header: every note does (#584: its title and tags are its frontmatter's). */
export const headed = () => true;

/** The header for the note in `ytext`: drawn, and kept in step with its text, until unbind. */
export function bindHead(ytext, { editable = true } = {}) {
  unbindHead();
  yamlShown = false;
  const on = headed(ytext);
  editor.hideFrontmatter(on);
  $('note-head').hidden = !on;
  if (!on) return;
  // (Moved on two devices at once, #582: its block twice; the second taken out.)
  const fixed = editable ? withoutRepeatedBlock(ytext.toString()) : null;
  if (fixed != null) replaceText(ytext, fixed);
  const observer = () => draw();
  ytext.observe(observer);
  bound = { ytext, editable, observer };
  $('note-head-title').readOnly = !editable;
  $('note-head-add').hidden = !editable;
  draw();
  measureHead(); // (the text's room for it now, not a frame later: nothing on the page jumps)
}

/**
 * The header no longer the note's. It stays up (as it was) while the next note opens, so the text
 * under it doesn't move as you switch (#302); `hide`: gone (the note closed).
 */
export function unbindHead({ hide = false } = {}) {
  closePicker();
  if (bound) bound.ytext.unobserve(bound.observer);
  bound = null;
  if (hide) $('note-head').hidden = true;
}

/**
 * A note opening, its text not here yet: every note has a header, so it's up already (empty),
 * and the text under it doesn't move when it comes (#302).
 */
export function headOpening() {
  if (bound) return;
  $('note-head-title').value = '';
  $('note-head-title').placeholder = '';
  $('note-head-tags').replaceChildren();
  $('note-head').hidden = false;
  measureHead();
}

/** The title put in, its text selected (a new note's: its date, yours to rename). */
export function focusTitle() {
  if (!bound) return false;
  const t = $('note-head-title');
  t.focus();
  t.select();
  return true;
}

function draw() {
  if (!bound) return;
  const text = bound.ytext.toString();
  const { title, tags } = readFrontmatter(text);
  const t = $('note-head-title');
  if (document.activeElement !== t && t.value !== (title ?? '')) t.value = title ?? '';
  t.placeholder = (title ? '' : noteTitle(text)) || 'Untitled'; // (a note without a title field: its first line's, as the list has it)
  const list = $('note-head-tags');
  list.replaceChildren(...(tags ?? []).map((tag) => {
    const b = el('span', 'head-tag');
    const name = el('button', 'head-tag-name', { type: 'button', textContent: `#${tag}`, title: `#${tag}: its notes` });
    name.dataset.tag = tag;
    b.append(name);
    if (bound.editable) {
      const x = el('button', 'head-tag-x', { type: 'button', textContent: '×', title: `Take #${tag} off`, ariaLabel: `Take #${tag} off` });
      x.dataset.tag = tag;
      b.append(x);
    }
    return b;
  }));
  fades();
  $('note-head-yaml').textContent = yamlShown ? '‹ fold' : 'yaml ›';
  $('note-head-yaml').setAttribute('aria-pressed', String(yamlShown));
}

/** The note's text made `next`: the one replacement between them, as an edit of yours. */
const change = (next) => replaceText(bound.ytext, next);

// ---- the title ----
$('note-head-title').addEventListener('input', (e) => {
  if (bound?.editable) change(setTitle(bound.ytext.toString(), e.target.value));
});
$('note-head-title').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault(); // (the body, where the text starts)
  editor.focus();
  editor.setCursor(editor.bodyFrom(), { scroll: true });
});
$('note-head-title').addEventListener('blur', () => draw());

// ---- the tags: one row that scrolls sideways, + tag after it, always in sight ----

/** The row faded at an edge with more tags past it. */
function fades() {
  const row = $('note-head-tags');
  row.classList.toggle('more-left', row.scrollLeft > 1);
  row.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
}
$('note-head-tags').addEventListener('scroll', fades, { passive: true });
new ResizeObserver(fades).observe($('note-head-tags'));
// A computer's wheel over the row (up and down, as most mice have): sideways through it.
$('note-head-tags').addEventListener('wheel', (e) => {
  const row = $('note-head-tags');
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
  e.preventDefault();
  row.scrollLeft += e.deltaY;
}, { passive: false });

$('note-head-tags').addEventListener('click', (e) => {
  const x = e.target.closest('.head-tag-x');
  if (x && bound?.editable) {
    const next = removeTag(bound.ytext.toString(), x.dataset.tag);
    if (next != null) change(next);
    return;
  }
  const name = e.target.closest('.head-tag-name');
  if (name) document.dispatchEvent(new CustomEvent('plim:tag', { detail: name.dataset.tag, cancelable: true }));
});

// ---- the picker ----
let picked = 0;
let offered = [];

function openPicker() {
  if (!bound?.editable) return;
  $('tag-picker').hidden = false;
  $('note-head-add').setAttribute('aria-expanded', 'true');
  $('tag-picker-input').value = '';
  fill();
  $('tag-picker-input').focus();
}

function closePicker() {
  $('tag-picker').hidden = true;
  $('note-head-add').setAttribute('aria-expanded', 'false');
}

/** The tags you use, those this note hasn't, matching what's typed (its start first), each with its notes; a new one last. */
function fill() {
  const typed = $('tag-picker-input').value.trim().replace(/^#/, '').toLowerCase();
  const have = new Set(readFrontmatter(bound.ytext.toString()).tags ?? []);
  const counts = tagCounts(visibleNotes().map((n) => n.tags)).filter(([t]) => !have.has(t));
  const starts = counts.filter(([t]) => t.startsWith(typed));
  const inside = typed ? counts.filter(([t]) => !t.startsWith(typed) && t.includes(typed)) : [];
  const byUse = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1); // (most used first)
  offered = [...starts.sort(byUse), ...inside.sort(byUse)].slice(0, 8).map(([t, n]) => ({ tag: t, n })); // (those starting with what's typed first)
  const fresh = tagName(typed);
  if (fresh && !have.has(fresh) && !offered.some((o) => o.tag === fresh)) offered.push({ tag: fresh, n: 0, fresh: true });
  picked = Math.min(picked, Math.max(0, offered.length - 1));
  if (typed && offered.length) picked = Math.min(picked, offered.length - 1);
  $('tag-picker-list').replaceChildren(...offered.map((o, i) => {
    const li = el('li', i === picked ? 'on' : '', { role: 'option' });
    li.setAttribute('aria-selected', String(i === picked));
    li.dataset.i = String(i);
    li.append(el('span', 'tp-name', { textContent: o.fresh ? `New tag #${o.tag}` : `#${o.tag}` }), ...(o.fresh ? [] : [el('span', 'tp-n', { textContent: String(o.n) })]));
    return li;
  }));
  $('tag-picker-list').hidden = !offered.length;
}

function choose(i) {
  const o = offered[i];
  if (!o || !bound) return;
  const next = addTag(bound.ytext.toString(), o.tag);
  if (next != null) change(next);
  requestAnimationFrame(() => ($('note-head-tags').scrollLeft = $('note-head-tags').scrollWidth)); // (the one put on, last: in sight)
  $('tag-picker-input').value = '';
  picked = 0;
  fill();
}

$('note-head-add').addEventListener('click', () => ($('tag-picker').hidden ? openPicker() : closePicker()));
$('tag-picker-input').addEventListener('input', () => {
  picked = 0;
  fill();
});
$('tag-picker-input').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (offered.length) picked = (picked + (e.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length;
    fill();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(picked);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePicker();
    $('note-head-add').focus();
  }
});
$('tag-picker-list').addEventListener('pointerdown', (e) => e.preventDefault()); // (the field keeps the focus)
$('tag-picker-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) choose(Number(li.dataset.i));
});
document.addEventListener('pointerdown', (e) => {
  if (!$('tag-picker').hidden && !e.target.closest('#tag-picker, #note-head-add')) closePicker();
});

// ---- a phone: the header scrolls away with the text (#592) ----
// There the header sits in the note's own scroll: in the note's area, over the top padding of
// whatever scrolls there (the textarea, or CodeMirror in a narrow window, or Preview), moved up as
// it scrolls, so it leaves with the text. The editors still scroll themselves (positions, places
// kept, the keyboard: as they were). Once the big title is out of sight, the bar's small one comes
// in (style.css); a tap on it, back to the top. A computer: over the note, as it was.

const pane = () => $('note-body').closest('.editor-pane');

/** What scrolls the note now: Preview's page, or the editor's. */
function scroller() {
  if (!$('reading').hidden && $('editor').hidden) return $('reading');
  return document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller');
}

/** The header where it goes: in the note's area on a phone, over it otherwise. */
function placeHead() {
  const head = $('note-head');
  if (PHONE.matches) {
    if (head.parentElement !== $('note-body')) $('note-body').prepend(head);
  } else if (head.parentElement === $('note-body')) $('note-body').before(head);
  measureHead();
}

/** The room the text leaves for the header at its top (a phone's: the header's height). */
function measureHead() {
  const h = PHONE.matches && !$('note-head').hidden ? $('note-head').offsetHeight : 0;
  $('note-body').style.setProperty('--head-h', `${h}px`);
  follow();
}

/** The header moved up as the note scrolls; the bar's title, once the big one is gone. */
function follow() {
  const head = $('note-head');
  if (!PHONE.matches) {
    head.style.transform = '';
    pane().classList.remove('title-in-bar');
    return;
  }
  const y = Math.max(0, scroller()?.scrollTop ?? 0);
  head.style.transform = y ? `translateY(${-y}px)` : '';
  const t = $('note-head-title');
  pane().classList.toggle('title-in-bar', head.hidden || y > t.offsetTop + t.offsetHeight);
}

document.addEventListener('scroll', (e) => {
  if (PHONE.matches && e.target instanceof Element && e.target.closest('#note-body')) follow();
}, { capture: true, passive: true });
// (Edit and Preview switched, or a note opened: the other scroller, or the same at its place.)
new MutationObserver(() => follow()).observe($('note-body'), { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-view'] });
new ResizeObserver(() => measureHead()).observe($('note-head'));
PHONE.addEventListener('change', placeHead);
placeHead();
// The bar's title, tapped: back to the top of the note, the header in sight.
$('note-title').addEventListener('click', () => {
  if (!PHONE.matches) return;
  scroller()?.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

// ---- the block itself ----
$('note-head-yaml').addEventListener('click', () => {
  if (!bound) return;
  yamlShown = !yamlShown;
  editor.hideFrontmatter(!yamlShown);
  // (Shown: the block in sight, the cursor in it, at its top; the editor would keep the text in place, the block above it.)
  if (yamlShown) {
    editor.focus();
    editor.setCursor(0, { scroll: true });
  }
  draw();
});
