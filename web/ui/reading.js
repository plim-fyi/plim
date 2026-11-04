// A note's views (#302): the editor, the note's markdown as it is; Preview, the note as a page
// (render.js), with native scrolling, selection and copy, and real tables; and on a computer
// Split, the two side by side. On a phone, Preview is a toggle in the bar, and where a note opens
// (a new one excepted: you're about to type): a phone is mostly for reading, and a tap on a word
// edits there, the keyboard up, as a tap into the editor would. Elsewhere it's Edit / Split /
// Preview, the last one used kept on the device. A view-only link opens in Preview.
//
// Switching keeps your place, to the character: the cursor's line if you're typing and it's in
// sight, else the line at the top of the view, ends up as far from the top in the other view
// (the editors' anchorView and placeAnchor; here, the same for the page, whose every piece of
// text knows its place in the note, render.js). A tap on the page edits there: the cursor on the
// tapped word, which stays under the finger. Others' edits never move what you're reading: the
// page is drawn again with the line at its top where it was.
//
// In Split the two scroll together (sync): the side you last touched leads, the other follows,
// set once a frame, by matching places: the line across the leader's top edge, as a stretch of the
// note from its start to the next line's, and how far down it the edge is, is found in the other
// side and put at its top edge the same way down; so headings, code and tables, taller on one
// side than the other, never put them out of step. While you type, the cursor leads: its block on
// the page level with its line, and tinted.
//
// Others in a shared note, on the page (peers): each a marker in its colour, with an initial,
// in the margin beside the block their cursor is in; a block someone else just changed lights
// up and fades. The page never follows them. The rest of the app it needs comes through init().
import * as Y from '../vendor/yjs.mjs';
import { render, toDOM } from '../editor/render.js';
import { ago, appMark, appRanges, whoOf } from '../core/authorship.js';
import { absolute, mapPos, relative, unmapPos } from '../core/textpos.js';
import { ON_A_PHONE } from '../editor/phone.js';
import { $, TOUCH, notesMap, state } from './shared.js';

// From the page (init): the editor, and saving where the open note is.
let editor, saveView;
export function init(deps) {
  ({ editor, saveView = () => {} } = deps);
}

const MODE_KEY = 'tiro-view'; // (a computer's Edit / Split / Preview, kept on the device)
const RENDER_MS = 150; // (the note changed: the page drawn again this soon after)
const WIDE = matchMedia('(min-width: 900px)'); // (room for Split: two columns of text)
const MODES = ['edit', 'split', 'preview'];
// Others' text arriving at once (#480): typed in at this pace, if it's at least this long.
const ARRIVING_MIN = 8, TYPE_CHAR_MS = 22, TYPE_MAX_MS = 1400;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
let typing = 0;

let note = null; // { ytext, editable, awareness, onPeers } while a note is open (awareness: a shared note's others)
let mode = 'edit';
// While the page is up: the note's text, its observer, the changes since it was drawn, each text
// node of the page with the note's text it came from (in order, and by node), and its blocks.
let shown = null;
let timer = null;
// Split: which side leads ('editor' or 'page'), and how ('keys': typing, the cursor leads; else scrolling).
let leader = 'editor', ledBy = 'scroll';
let frame = 0;

// Split is a choice in Settings → This device, off unless turned on (kept on this device only).
const SPLIT_KEY = 'plim-split-view';
/** Whether Split is turned on, on this device. */
export function splitEnabled() {
  try {
    return localStorage.getItem(SPLIT_KEY) === '1';
  } catch {
    return false; // (no storage here: off, as it starts)
  }
}
/** Split turned on or off here: a note in Split goes back to the editor, and the bar follows. */
export function setSplitEnabled(on) {
  try {
    if (on) localStorage.setItem(SPLIT_KEY, '1');
    else localStorage.removeItem(SPLIT_KEY);
  } catch {
    /* (no storage: for this page only) */
  }
  if (note && mode === 'split' && !splitAllowed()) setMode('edit', { keep: false });
  renderControls();
}
const splitAllowed = () => splitEnabled() && !ON_A_PHONE && WIDE.matches;
const splitOn = () => mode === 'split' && Boolean(shown) && !$('editor').hidden;

function remembered() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.includes(m) ? m : 'edit';
  } catch {
    return 'edit';
  }
}
function remember(m) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* (not kept, then) */
  }
}

/** Whether the open note's page is on screen (in Preview, or in Split). */
export const reading = () => Boolean(shown);

/** The open note's mode ('edit', 'split', 'preview'), or null with no note open. */
export const currentMode = () => (note ? mode : null);

/**
 * A note just bound to the editor: a new note in the editor; else in Preview if it's view-only or
 * on a phone, or (on a computer) in what was used last. `view`: where it was (the note's saved place),
 * for the page. Returns whether only the page shows (the editor isn't to be focused).
 */
export function noteBound(ytext, view, { fresh = false, editable = true, awareness = null, keep = null } = {}) {
  unwatchPeers();
  note = { ytext, editable, awareness };
  // A view-only note's markdown can be shown, not edited: its view says so (#322).
  const source = $('note-mode').querySelector('[data-mode="edit"]');
  source.textContent = editable ? 'Edit' : 'Markdown';
  source.title = editable ? 'Edit (Ctrl+/)' : 'The note’s markdown, read-only (Ctrl+/)';
  if (awareness) {
    note.onPeers = () => renderPeers();
    awareness.on('change', note.onPeers);
  }
  // (`keep`: the same note opened again where it is now, its keys replaced say: in the mode it was in.)
  mode = !editable ? 'preview' : keep ?? (fresh ? 'edit' : ON_A_PHONE ? 'preview' : remembered());
  if (mode === 'split' && !splitAllowed()) mode = 'edit';
  if (mode === 'preview') {
    show(ytext);
    const pos = view?.top ? absolute(ytext, view.top) : null;
    if (pos != null) placeAnchor({ pos, y: -(view.offset ?? 0) });
    else $('reading').scrollTop = 0;
  } else if (mode === 'split') {
    leader = 'editor';
    ledBy = 'scroll';
    show(ytext, { beside: true }); // (the page set beside the editor's place: sync)
  } else leave();
  renderControls();
  return mode === 'preview';
}

/** No note open (closed, or one that didn't open): the page is down, the controls too. */
export function noteClosed() {
  unwatchPeers();
  note = null;
  leave();
  renderControls();
}

function unwatchPeers() {
  if (note?.awareness && note.onPeers) note.awareness.off('change', note.onPeers);
}

/**
 * Switch to `next` ('edit', 'split' or 'preview'), keeping your place. To the editor: at `at` if
 * given (a tap's word, where it was on screen), with the cursor at `cursor`; `focus`: for typing
 * (on a phone, within a tap: the keyboard opens).
 */
function setMode(next, { at = null, cursor = null, focus = false, keep = true } = {}) {
  if (!note) return;
  if (next === 'split' && !splitAllowed()) next = 'edit';
  if (next === mode) return;
  const was = mode;
  const typing = $('editor').contains(document.activeElement);
  mode = next;
  if (next === 'preview') {
    if (was === 'edit') {
      const a = editor.anchorView();
      editor.blur(); // (a phone's keyboard goes)
      show(note.ytext);
      if (a) placeAnchor(a);
    } else {
      editor.blur(); // (from Split: the page stays as it is, the editor goes)
      $('editor').hidden = true;
    }
  } else if (next === 'edit') {
    let a = null;
    if (was === 'preview') {
      if (shown?.pending.length) draw();
      a = at ?? (shown ? anchorView() : null);
      leave();
      $('editor').hidden = false;
      if (cursor != null) editor.setCursor(cursor, { scroll: false });
      // (On a computer, the cursor comes to where you're looking if it was out of sight: typing starts
      // there. On a phone too when it's focused (Edit, #538): focusing would scroll to it, elsewhere.)
      if (a) editor.placeAnchor(a, { cursor: (!ON_A_PHONE || focus) && cursor == null });
    } else leave(); // (from Split: the editor stays as it is, the page goes)
    if (focus) editor.focus();
    // (Focusing brings the cursor's line wholly into view, a few px: the place put back, to the pixel.)
    if (focus && a) editor.placeAnchor(a);
  } else if (was === 'edit') {
    // Split, from the editor: the page beside it, set where the editor is (sync, as the editor leads).
    leader = 'editor';
    ledBy = typing ? 'keys' : 'scroll';
    show(note.ytext, { beside: true });
  } else {
    // Split, from Preview: the editor beside the page, set where the page is.
    if (shown.pending.length) draw();
    const a = anchorView();
    $('editor').hidden = false;
    leader = 'page';
    if (a) editor.placeAnchor(a);
    if (focus) editor.focus();
  }
  if (!ON_A_PHONE && note.editable && keep) remember(next);
  renderControls();
  saveView();
}

/** The page's place, to keep with the note's (as the editor's viewState has it: `top`, `offset`). */
export function previewView() {
  if (!shown || splitOn()) return null; // (in Split, the editor's place is yours)
  if (shown.pending.length) draw();
  const a = anchorView();
  return a && { top: relative(shown.ytext, a.pos), offset: Math.round(-a.y) };
}

/** The page up: alone (the editor hidden), or `beside` the editor (Split). */
function show(ytext, { beside = false } = {}) {
  leave();
  shown = { ytext, pending: [], sources: [], byNode: new Map(), blocks: [], changed: [], drawn: false };
  shown.observer = (ev) => {
    shown.pending.push(ev.delta);
    // What someone else changed, to light up once drawn (where it is now: earlier changes followed through this one).
    shown.changed = shown.changed.map(([a, b]) => [mapPos(a, ev.delta), mapPos(b, ev.delta)]);
    if (!ev.transaction.local) shown.changed.push(...changedRanges(ev.delta));
    clearTimeout(timer);
    timer = setTimeout(() => shown && draw(), RENDER_MS);
  };
  ytext.observe(shown.observer);
  $('editor').hidden = !beside;
  $('reading').hidden = false;
  draw();
}

function leave() {
  if (!shown) return;
  clearTimeout(timer);
  shown.ytext.unobserve(shown.observer);
  shown = null;
  $('reading').hidden = true;
}

/**
 * The page drawn from the note's text, the line at the top of the view kept where it is (found
 * on the page as it was drawn, then followed through the changes since); in Split, with the
 * editor leading, set beside it instead. Links open in a tab of their own; a view-only link's
 * boxes can't be ticked.
 */
function draw() {
  clearTimeout(timer);
  const body = $('reading');
  const following = splitOn() && leader === 'editor';
  const at = shown.drawn && !following ? anchorView() : null;
  if (at) for (const delta of shown.pending) at.pos = mapPos(at.pos, delta);
  shown.pending = [];
  const sources = [];
  const frag = toDOM(render(shown.ytext.toString()), document, sources);
  for (const a of frag.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  if (!note?.editable) for (const box of frag.querySelectorAll('input[type=checkbox]')) box.disabled = true;
  body.replaceChildren(frag);
  shown.sources = sources;
  shown.byNode = new Map(sources.map((s) => [s.node, s]));
  // Its blocks that hold text (a paragraph, a heading, a row, an item: not a list around them), in order.
  shown.blocks = [...body.querySelectorAll('[data-from]')]
    .filter((el) => el.tagName !== 'INPUT' && ![...el.querySelectorAll('[data-from]')].some((d) => d.tagName !== 'INPUT'))
    .map((el) => ({ el, from: Number(el.dataset.from), to: Number(el.dataset.to) }));
  shown.tinted = null;
  // Blocks someone else just changed: lit up, fading (style.css); text they put in at once, typed in.
  for (const [a, b] of shown.changed) {
    for (const block of shown.blocks) if (block.from <= b && block.to >= a) block.el.classList.add('just-changed');
  }
  const arriving = shown.changed.filter(([a, b]) => b - a >= ARRIVING_MIN);
  shown.changed = [];
  // Blocks an app wrote in today (#389): its mark in the margin (renderRuns), who and when on hover.
  for (const r of appRanges(shown.ytext)) {
    for (const block of shown.blocks) {
      if (!(block.from < r.to && block.to > r.from)) continue;
      block.el.classList.add('app-edit');
      block.el.dataset.app = appMark(r.name).letter;
      block.el.dataset.tone = appMark(r.name).tone;
      block.el.title = `Added by ${whoOf(r)} · ${ago(r.at)}`;
    }
  }
  // Its badge once per run, at the run's first block: one whose block before it, in reading order,
  // isn't the same app's (#471: not the element before it on the page, which a list item's text,
  // first in its item, never has, so each item had a badge of its own).
  shown.blocks.forEach((block, i) => {
    const before = shown.blocks[i - 1]?.el;
    const mine = block.el.classList.contains('app-edit');
    block.el.classList.toggle('app-edit-start', mine && !(before?.classList.contains('app-edit') && before.dataset.app === block.el.dataset.app && before.dataset.tone === block.el.dataset.tone));
  });
  shown.drawn = true;
  if (at) placeAnchor(at);
  if (splitOn()) sync();
  renderRuns();
  renderPeers();
  typeIn(arriving);
  body.dispatchEvent(new CustomEvent('plim:drawn')); // (a search's marks, again: ui/search.js)
}

/**
 * Text that came in at once from elsewhere (an agent's edit, a paste on another device, #480),
 * shown as if typed: painted in left to right, a little at a time. It's in its place from the
 * start, only transparent (::highlight(arriving)), so nothing moves while it appears; the page's
 * text isn't touched, so its places in the note stay right. Drawn again, the page shows what was
 * still arriving at once, and types in what's new.
 */
function typeIn(ranges) {
  cancelAnimationFrame(typing);
  if (!globalThis.CSS?.highlights) return;
  CSS.highlights.delete('arriving');
  if (!ranges.length || REDUCED_MOTION.matches) return;
  const start = performance.now();
  const each = ranges.map(([a, b]) => ({ a, b, ms: Math.min(TYPE_MAX_MS, (b - a) * TYPE_CHAR_MS) }));
  const step = (now) => {
    const t = now - start;
    const left = each.filter((r) => t < r.ms).map((r) => [Math.round(r.a + ((r.b - r.a) * t) / r.ms), r.b]);
    if (!left.length || !shown) return CSS.highlights.delete('arriving');
    CSS.highlights.set('arriving', new Highlight(...pageRanges(left)));
    typing = requestAnimationFrame(step);
  };
  step(start);
}

/** Where a change (a Y.Text delta) put text in, or took it out, as ranges of the text after it. */
function changedRanges(delta) {
  const out = [];
  let at = 0;
  for (const op of delta) {
    if (op.retain != null) at += op.retain;
    else if (op.insert != null) {
      const n = typeof op.insert === 'string' ? op.insert.length : 1;
      out.push([at, at + n]);
      at += n;
    } else if (op.delete != null) out.push([at, at]);
  }
  return out;
}

/** A layer over the page, for marks in its margin: made the first time, kept while the page is drawn again. */
function layerOf(key, className) {
  let layer = shown[key];
  if (!layer?.isConnected) {
    layer = shown[key] = Object.assign(document.createElement('div'), { className: `layer ${className}` });
    layer.setAttribute('aria-hidden', 'true');
    $('reading').append(layer);
  }
  return layer;
}

/** The left edge of the page's text column, on screen (a list's bullets are inside it). */
function columnLeft() {
  const body = $('reading');
  return [...body.children].find((c) => !c.classList.contains('layer'))?.getBoundingClientRect().left ?? body.getBoundingClientRect().left + 24;
}

/**
 * Each run of blocks an app wrote (#477): one bar in the margin, from its first block's top to its
 * last one's bottom, the app's badge at its top. In a fixed gutter left of the text column, so a
 * list's items, a task or a nested list are marked where a paragraph is, and the gaps between
 * blocks don't break it (each block's own bar moved with its indent, and stopped at its edges).
 */
function renderRuns() {
  if (!shown) return;
  const body = $('reading');
  const layer = layerOf('runLayer', 'app-runs');
  const box = body.getBoundingClientRect();
  layer.style.left = `${columnLeft() - box.left}px`;
  const bars = [];
  for (const [i, block] of shown.blocks.entries()) {
    if (!block.el.classList.contains('app-edit-start')) continue;
    let last = block;
    for (const next of shown.blocks.slice(i + 1)) {
      if (!next.el.classList.contains('app-edit') || next.el.classList.contains('app-edit-start')) break;
      last = next;
    }
    const top = block.el.getBoundingClientRect().top - box.top + body.scrollTop;
    const bottom = last.el.getBoundingClientRect().bottom - box.top + body.scrollTop;
    const bar = Object.assign(document.createElement('span'), { className: 'app-run' });
    bar.dataset.app = block.el.dataset.app; // (its badge: style.css, not text, which a search would find)
    bar.dataset.tone = block.el.dataset.tone;
    bar.style.top = `${top}px`;
    bar.style.height = `${bottom - top}px`;
    bars.push(bar);
  }
  layer.replaceChildren(...bars);
}

/**
 * The others in the note (a shared one), on the page: a marker each, in their colour with their
 * initial, in the margin beside the block their cursor is in (several in one: one under the other).
 */
function renderPeers() {
  if (!shown) return;
  const body = $('reading');
  const layer = layerOf('peerLayer', 'peers'); // (hidden from a reader: the header's chips say who's here)
  const awareness = note?.awareness;
  const marks = [];
  // (Not while the page is behind the note: their places are in the text as it is now. Drawn next.)
  if (awareness && !shown.pending.length) {
    const box = body.getBoundingClientRect();
    // (Left of the text column, clear of a list's bullets.)
    const column = columnLeft();
    const inBlock = new Map();
    for (const [id, st] of awareness.getStates()) {
      if (id === awareness.clientID || !st.user || !st.cursor?.head) continue;
      let pos;
      try {
        const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), shown.ytext.doc);
        if (at?.type !== shown.ytext) continue;
        pos = at.index;
      } catch {
        continue;
      }
      const block = shown.blocks.find((b) => pos <= b.to) ?? shown.blocks[shown.blocks.length - 1];
      if (!block) continue;
      // On the line their cursor is on (in a long paragraph, not its top), the block's start else.
      const top = boxOf(pos)?.top ?? block.el.getBoundingClientRect().top;
      const nth = inBlock.get(block) ?? 0;
      inBlock.set(block, nth + 1);
      const m = Object.assign(document.createElement('span'), { className: 'peer', textContent: [...st.user.name][0]?.toUpperCase() ?? '?', title: st.user.name });
      m.dataset.ycolor = st.user.color;
      m.dataset.client = String(id);
      m.style.top = `${top - box.top + body.scrollTop + nth * 20}px`;
      m.style.left = `${Math.max(2, column - box.left - 26)}px`;
      marks.push(m);
    }
  }
  layer.replaceChildren(...marks);
}

// ---- places on the page ----

/** A text node's character `offset`, as a place in the note. */
function posOf(s, offset) {
  const len = s.node.length;
  return len ? s.from + Math.round((Math.min(offset, len) * (s.to - s.from)) / len) : s.from;
}

/** The box of the character at `pos` in the note (the text after it, where the note's own marks are left out). */
function boxOf(pos) {
  const list = shown.sources;
  if (!list.length) return null;
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].to >= pos) hi = mid;
    else lo = mid + 1;
  }
  const s = list[lo];
  const len = s.node.length, span = s.to - s.from;
  const off = pos <= s.from ? 0 : Math.min(len, span ? Math.round(((pos - s.from) * len) / span) : 0);
  const range = document.createRange();
  if (off < len) range.setStart(s.node, off), range.setEnd(s.node, off + 1);
  else range.setStart(s.node, len - 1), range.setEnd(s.node, len);
  const rects = range.getClientRects();
  return (off < len ? rects[0] : rects[rects.length - 1]) ?? range.getBoundingClientRect();
}

/** The page's text node and offset at `pos` in the note; `end`: as a range's end (the text before it). */
function pointAt(pos, end = false) {
  const list = shown.sources;
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (end ? list[mid].to >= pos : list[mid].to > pos) hi = mid;
    else lo = mid + 1;
  }
  const s = list[lo];
  const len = s.node.length, span = s.to - s.from;
  const off = pos <= s.from ? 0 : Math.min(len, span ? Math.round(((pos - s.from) * len) / span) : 0);
  return { node: s.node, offset: off };
}

/**
 * Ranges of the note's text (`[from, to]`, a search's matches, #24) as ranges of the page, for
 * highlights; none while the page isn't up, or is behind the note (it's drawn again soon).
 */
export function pageRanges(ranges) {
  if (!shown?.sources.length || shown.pending.length) return [];
  const out = [];
  for (const [a, b] of ranges) {
    const start = pointAt(a), end = pointAt(b, true);
    const r = document.createRange();
    try {
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
    } catch {
      continue;
    }
    if (!r.collapsed) out.push(r);
  }
  return out;
}

/** The page scrolled to show `pos` in the note (a match) a third of the way down. */
export function revealOnPage(pos) {
  if (!shown) return;
  if (shown.pending.length) draw();
  placeAnchor({ pos, y: $('reading').clientHeight / 3 });
}

/** The place in the note of the text at a point on screen (not on text: the start of the block there). */
function posAtPoint(x, y) {
  let node = null, offset = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) ({ offsetNode: node, offset } = p);
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) (node = r.startContainer), (offset = r.startOffset);
  }
  const s = node && shown.byNode.get(node);
  if (s) return posOf(s, offset);
  const block = document.elementFromPoint(x, y)?.closest?.('#reading [data-from]');
  return block ? Number(block.dataset.from) : null;
}

/** The page's place: the line at the top of the view (where it starts), and how far it is from the top. */
function anchorView() {
  const list = shown.sources;
  const edge = $('reading').getBoundingClientRect().top;
  if (!list.length) return null;
  const lines = (s) => {
    const r = document.createRange();
    r.selectNodeContents(s.node);
    return [...r.getClientRects()].filter((b) => b.height);
  };
  // The first piece of text whose last line reaches below the top of the view, then that line.
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ls = lines(list[mid]);
    if ((ls[ls.length - 1]?.bottom ?? -Infinity) > edge) hi = mid;
    else lo = mid + 1;
  }
  const s = list[lo];
  const line = lines(s).find((b) => b.bottom > edge);
  if (!line) return { pos: s.from, y: (boxOf(s.from)?.top ?? edge) - edge };
  const p = posAtPoint(line.left + 1, Math.min(line.bottom - 1, Math.max(line.top + line.height / 2, edge + 1)));
  const pos = p != null && p >= s.from && p <= s.to ? p : s.from; // (another element over it: its start)
  return { pos, y: (boxOf(pos)?.top ?? line.top) - edge };
}

/**
 * The page scrolled so that `pos` is `y` from the top of the view — but never past the end of the
 * text, with none of it in sight (#316: a place kept in text since removed, a version restored or
 * lines deleted elsewhere, would be under the end): then the text's end at the bottom of the view.
 */
function placeAnchor({ pos, y }) {
  const body = $('reading');
  const box = boxOf(pos);
  if (!box) return;
  const view = body.getBoundingClientRect();
  let shift = box.top - (view.top + y);
  const last = [...body.children].filter((c) => !c.classList.contains('layer')).at(-1);
  if (last) {
    const end = last.getBoundingClientRect().bottom - shift; // (where the text ends, once scrolled)
    if (end < view.top + LINE_PX) shift += end - view.bottom + LINE_PX;
  }
  if (body.scrollTop + shift < 0) shift = -body.scrollTop;
  if (Math.abs(shift) >= 0.5) body.scrollTop += shift; // (not at all otherwise: a fling carries on)
}
// (About a line of the page: what's kept in sight of the text's end, at least.)
const LINE_PX = 28;

// ---- Split: the two in step ----

function schedule() {
  if (frame || !splitOn()) return;
  frame = 1;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    frame = 0;
    sync();
  };
  // (The editor leading: once it has drawn the lines it scrolled to, so its places are real. And
  // a frame later whatever happens: the editor drops a request when its note is replaced, and the
  // sync mustn't wait on it for ever.)
  if (leader === 'editor' && editor.afterLayout) {
    editor.afterLayout(run);
    requestAnimationFrame(() => requestAnimationFrame(run));
  } else requestAnimationFrame(run);
}

/**
 * The follower set where the leader is, now: the leader's stretch across its top edge found on the
 * follower's side and put at its top edge, as far down it. The ends pinned together. Typing (the
 * cursor in sight): the cursor's block on the page level with its line.
 */
function sync(again = false) {
  if (!splitOn()) return;
  const ed = editor.scroller(), page = $('reading');
  const fromPage = leader === 'page';
  const focused = $('editor').contains(document.activeElement);
  tint(focused ? editor.cursor() : null);
  if (!fromPage && ledBy === 'keys' && focused) {
    const pos = editor.cursor();
    const y = editor.topOf(pos) - ed.getBoundingClientRect().top;
    if (y >= 0 && y < ed.clientHeight) return placeAnchor({ pos: drawnPos(pos), y });
  }
  const [L, F] = fromPage ? [page, ed] : [ed, page];
  const blocks = shown.blocks, n = blocks.length;
  if (L.scrollTop <= 0) F.scrollTop = 0;
  else if (L.scrollTop >= L.scrollHeight - L.clientHeight - 1) F.scrollTop = F.scrollHeight;
  else if (n) {
    // The matching points: where each block of the page starts, on each side (its first character),
    // and the end of the note. Between two, each side's top edge is as far from one to the next.
    const pageTop = (i) => (i >= n ? blocks[n - 1].el.getBoundingClientRect().bottom : boxOf(blocks[i].from)?.top ?? blocks[i].el.getBoundingClientRect().top);
    const editorTop = (i) => (i >= n ? editor.bottomOfText() : editor.topOf(blocks[i].from));
    let i = 0, edge;
    if (fromPage) {
      edge = page.getBoundingClientRect().top;
      let hi = n - 1;
      while (i < hi) {
        const mid = (i + hi + 1) >> 1;
        if (pageTop(mid) <= edge) i = mid;
        else hi = mid - 1;
      }
    } else {
      const at = editor.posAtTop();
      edge = at.edge;
      let hi = n - 1;
      while (i < hi) {
        const mid = (i + hi + 1) >> 1;
        if (blocks[mid].from <= at.pos) i = mid;
        else hi = mid - 1;
      }
    }
    const [lead, follow] = fromPage ? [pageTop, editorTop] : [editorTop, pageTop];
    const la = lead(i), lb = lead(i + 1);
    const f = lb > la ? (edge - la) / (lb - la) : 0;
    const fa = follow(i), fb = follow(i + 1);
    const shift = fa + f * (fb - fa) - F.getBoundingClientRect().top;
    if (Math.abs(shift) >= 0.5) F.scrollTop += shift;
  }
  // (The editor draws the lines it was scrolled to, and measures them: once more, with their real heights.)
  if (fromPage && !again) editor.afterLayout?.(() => sync(true));
}

/**
 * Where `pos` in the note as it is now is on the page as drawn (#331): the page is drawn again
 * only once typing pauses, so what's been typed since isn't on it yet; followed back through those
 * changes. (A cursor at the end of a paragraph being typed is at the end of that paragraph as drawn.)
 */
function drawnPos(pos) {
  for (let i = shown.pending.length - 1; i >= 0; i--) pos = unmapPos(pos, shown.pending[i]);
  return pos;
}

/** The page's block the cursor is in, tinted (or none). `pos`: in the note as it is now. */
function tint(pos) {
  const at = pos == null ? null : drawnPos(pos);
  const block = at == null ? null : shown.blocks.find((b) => at >= b.from && at <= b.to)?.el ?? null;
  if (block === shown.tinted) return;
  shown.tinted?.classList.remove('cursor-block');
  block?.classList.add('cursor-block');
  shown.tinted = block;
}

// The cursor moved however it did (a key, a click, or no event at all: a jump to a search's match,
// the editor placing it): its block tinted at once, not at the next sync, which only keys, clicks
// and scrolls ask for (#554: the block before stayed tinted until something was typed). Only the
// tint: no scrolling here.
document.addEventListener('selectionchange', () => {
  if (shown && splitOn() && $('editor').contains(document.activeElement)) tint(editor.cursor());
});

// Who leads: the side last touched (a wheel, a press, a touch, a key).
for (const type of ['wheel', 'pointerdown', 'touchstart']) {
  $('editor').addEventListener(type, () => ((leader = 'editor'), (ledBy = 'scroll')), { capture: true, passive: true });
  $('reading').addEventListener(type, () => ((leader = 'page'), (ledBy = 'scroll')), { passive: true });
}
$('editor').addEventListener('keydown', () => ((leader = 'editor'), (ledBy = 'keys')), { capture: true });
$('reading').addEventListener('keydown', () => ((leader = 'page'), (ledBy = 'scroll')));
// The leader scrolled, or typed, or the cursor moved: the follower follows. (Only the leader's
// scrolling counts: the follower's, which sync makes, would send it round in a loop.)
$('editor').addEventListener('scroll', () => leader === 'editor' && schedule(), { capture: true, passive: true });
$('reading').addEventListener('scroll', () => leader === 'page' && schedule(), { passive: true });
for (const type of ['keyup', 'mouseup', 'input']) $('editor').addEventListener(type, () => leader === 'editor' && schedule());
// The window, the sidebar or a side resized: the text wraps anew, and the follower is set again.
// (The page itself too: Preview ↔ Split changes its width, not the note's, and the others'
// markers kept Preview's places, over the text, #320.)
const resized = new ResizeObserver(() => {
  schedule();
  renderRuns(); // (the blocks moved)
  renderPeers();
});
resized.observe($('note-body'));
resized.observe($('reading'));

/** A task's box tapped: its marker in the note is the box's new state. */
function toggleTask(box) {
  const { ytext } = shown;
  const from = Number(box.dataset.from);
  if (!note?.editable || !/^\[[ xX]\]$/.test(ytext.toString().slice(from, from + 3))) return draw(); // (the note changed under it: drawn afresh)
  ytext.doc.transact(() => {
    ytext.delete(from, 3);
    ytext.insert(from, box.checked ? '[x]' : '[ ]');
  });
}

// ---- the controls ----

/** The bar's Preview (a phone's toggle) or Edit / Split / Preview (elsewhere), as the open note is. */
function renderControls() {
  const open = Boolean(note);
  const toggle = $('note-preview'), modes = $('note-mode');
  toggle.hidden = !open || !ON_A_PHONE;
  // (A phone's one button (#538): Edit while it's the page, Preview while it's the editor.)
  const editNext = open && mode === 'preview' && note.editable;
  toggle.setAttribute('aria-label', editNext ? 'Edit' : 'Preview');
  toggle.title = editNext ? 'Edit' : 'Preview';
  toggle.classList.toggle('to-edit', editNext);
  modes.hidden = !open || ON_A_PHONE;
  for (const b of modes.querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    if (b.dataset.mode === 'split') b.hidden = !splitAllowed();
  }
  $('note-body').dataset.view = open ? mode : '';
}

// (A phone's Edit (#538): the editor, focused within the tap, the keyboard up, to type; Preview: the page.)
$('note-preview').addEventListener('click', () => (mode === 'preview' ? setMode('edit', { focus: true }) : setMode('preview')));
for (const b of $('note-mode').querySelectorAll('[data-mode]')) {
  // (Into the editor, to type at once: with a mouse. On a touch screen focusing brings up the
  // keyboard over half of it: a tap in the text does that, as on a phone, #333.)
  b.addEventListener('click', () => setMode(b.dataset.mode, { focus: b.dataset.mode !== 'preview' && !TOUCH.matches }));
}
// (A press on them leaves the focus in the editor: typing there, the cursor's line is your place.)
for (const b of [$('note-preview'), ...$('note-mode').querySelectorAll('button')]) b.addEventListener('mousedown', (e) => e.preventDefault());
// Too narrow for Split now: the editor (what you chose stays chosen, for when there's room again).
WIDE.addEventListener('change', () => {
  if (note && mode === 'split' && !splitAllowed()) setMode('edit', { keep: false });
  renderControls();
});

// A click (or a tap) on the page stays on the page (#538): to select its text, tick a task, open
// a link. Edit is the bar's (a phone's ✎; Ctrl+/, Enter or E on a computer), and keeps
// your place. In Split: the editor's cursor put on that word, neither side moving.
$('reading').addEventListener('click', (e) => {
  if (!shown) return;
  if (e.target.closest('a[href]')) return; // (the link: its own)
  if (e.target.matches('input[type=checkbox]')) return toggleTask(e.target);
  if (!splitOn()) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return; // (text selected: a click ending a selection, or on it)
  if (!note?.editable) return;
  let pos = posAtPoint(e.clientX, e.clientY) ?? shown.ytext.length;
  // (The note changed since the page was drawn: the word followed to where it is now, on the page drawn afresh.)
  if (shown.pending.length) {
    for (const delta of shown.pending) pos = mapPos(pos, delta);
    draw();
  }
  editor.setCursor(pos, { scroll: false });
  editor.focus();
  leader = 'page';
  tint(pos);
});

// On a computer: Ctrl+/ (⌘/) goes round Edit, Split and Preview; on the page alone, Enter or E edits.
document.addEventListener('keydown', (e) => {
  if (!note || ON_A_PHONE) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === '/') {
    e.preventDefault();
    const order = MODES.filter((m) => m !== 'split' || splitAllowed());
    const next = order[(order.indexOf(mode) + 1) % order.length];
    return setMode(next, { focus: next !== 'preview' });
  }
  if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || TOUCH.matches) return;
  if (state.menu || document.querySelector('dialog[open]')) return;
  const active = document.activeElement;
  if (shown && !splitOn() && note.editable && (e.key === 'Enter' || e.key === 'e' || e.key === 'E') && (!active || active === document.body)) {
    e.preventDefault();
    setMode('edit', { focus: true });
  }
});
