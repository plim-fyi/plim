// Editing on a phone (#290): a plain textarea with the note's markdown, bound to its Y.Text both
// ways. The OS owns what a phone does best natively — the keyboard, selection and its handles,
// autocorrect, undo, scrolling — and none of what editor-ios.js does for CodeMirror is needed.
// What the editor's keys did for plain markdown is kept: Return continues a list (and ends an
// empty item), Backspace at a marker removes it, Tab and Shift-Tab indent an item. Nothing is
// drawn but others' cursors in a shared note (drawPeers): Preview shows the page (ui/reading.js),
// and switching keeps your place (anchorView).
//
// The same surface as NoteEditor (editor.js), as far as the app uses it.
import * as Y from '../vendor/yjs.mjs';
import { TITLE_HEAD, bodyStart, noteTitle } from '../core/frontmatter.js';
import { absolute, mapPos, relative } from '../core/textpos.js';
import { fitPageAboveKeyboard } from './keyboard.js';
import { SlashMenu } from './slashmenu.js';
import { withoutCommand } from './slash.js';

// A list item's, task's or quote's marker at the start of a line: indent, then the marker with its space.
const ITEM = /^(\s*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|>[ \t]?)/;
const LOCAL = Symbol('textarea'); // (the origin of this editor's own edits: not applied back)
const CURSOR_MS = 100; // (the cursor told to the others in a shared note, this often at most)

export class TextareaEditor {
  constructor(parent) {
    this.parent = parent;
    this.base = 0; // (where the text shown starts in the note's: after its frontmatter, hidden, #584)
    this.blockHidden = false;
    const ta = (this.ta = document.createElement('textarea'));
    ta.className = 'note-textarea';
    ta.setAttribute('aria-label', 'Note');
    // Decided on purpose (#266): the OS corrects typos and capitalises sentences, as on a phone it
    // should; smart punctuation (-- to —, straight quotes to curly) is off — this is the markdown
    // as it is, and code and marks need the plain characters.
    ta.spellcheck = false;
    ta.setAttribute('autocorrect', 'on');
    ta.setAttribute('autocapitalize', 'sentences');
    ta.placeholder = 'Start typing…';
    ta.readOnly = true;
    this.readOnly = false; // (the note's: a view-only link)
    this.ytext = null;
    this.awareness = null;
    this.unbind = null;
    this.value = '';
    this.cursorTimer = null;
    ta.addEventListener('beforeinput', (e) => this.beforeinput(e));
    ta.addEventListener('input', (e) => this.input(e));
    ta.addEventListener('keydown', (e) => this.keydown(e));
    this.marker = null; // (a list's next marker, to follow the new line Return is putting in)
    for (const type of ['select', 'keyup', 'mouseup', 'touchend', 'input', 'focus']) ta.addEventListener(type, () => this.tellCursor());
    // (Safari scrolls a textarea back to its top as the keyboard opens on it, a moment after the
    // focus: put back where it was at the touch — a frame later, and again as the keyboard's
    // resize comes, see showCursor. Not always to 0: on iOS 26, a little way down, 87 px.)
    this.scrollAtFocus = 0;
    this.focusedAt = 0;
    ta.addEventListener('touchstart', () => (this.scrollAtTouch = ta.scrollTop), { passive: true });
    ta.addEventListener('focus', () => {
      this.focusedAt = performance.now();
      const was = (this.scrollAtFocus = ta.scrollTop || this.scrollAtTouch || 0);
      if (was) requestAnimationFrame(() => { if (!ta.scrollTop) ta.scrollTop = was; });
    });
    ta.addEventListener('blur', () => this.tellCursor(true));
    // Others' cursors kept where their text is as it scrolls, and as the page is resized (the keyboard).
    ta.addEventListener('scroll', () => this.peersSoon(), { passive: true });
    const resized = new ResizeObserver(() => {
      this.peersSoon();
      this.fitEndRoom();
    });
    resized.observe(ta);
    resized.observe(parent); // (the editor's box: the textarea can't shrink below its padding, fitEndRoom)
    ta.addEventListener('input', () => this.fitEndRoom());
    // The page sized to what's above the keyboard; the cursor brought into view once it's open
    // (the page being what shrinks, Safari doesn't scroll the textarea to it). Not at the tap
    // itself: iOS hasn't placed the cursor yet, and text moving under the finger would put it wrong.
    fitPageAboveKeyboard({ parent, content: ta, onResize: () => this.showCursor() });
    parent.append(ta);
    // Type / for a menu (#311): Today, Now… Tapped, it keeps the focus (and the keyboard).
    parent.style.position ||= 'relative';
    this.menu = new SlashMenu({
      root: parent, field: ta, scroller: ta, touch: true,
      slice: (from, to) => ta.value.slice(from, to),
      cursor: () => (ta.selectionStart === ta.selectionEnd ? ta.selectionEnd : null),
      caretRect: (pos) => {
        const b = this.caretBox(pos), r = ta.getBoundingClientRect();
        const top = r.top + b.top - ta.scrollTop;
        return { top, bottom: top + b.height, left: r.left + b.left - ta.scrollLeft };
      },
      replace: (from, to, text) => this.insert(from, to, text),
      onToggle: (open) => parent.dispatchEvent(new CustomEvent('plim:menu', { bubbles: true, detail: { open } })),
    });
    document.addEventListener('selectionchange', () => document.activeElement === ta && this.menu.refresh());
    ta.addEventListener('blur', () => this.menu.close());
  }

  /**
   * `from`–`to` replaced with `text` as typing would (the browser's undo takes it back in one
   * step: shaking, or Ctrl/Cmd+Z), the cursor after it, into the note.
   */
  insert(from, to, text) {
    const { ta } = this;
    ta.setSelectionRange(from, to);
    let done = false;
    try {
      done = document.execCommand('insertText', false, text); // (its input event puts it into the note)
    } catch {}
    if (!done) this.replace(from, to, text);
    this.showCursor();
  }

  /** Show a note's text, kept in sync both ways from now on; `saved` (viewState) puts the cursor and scroll back. */
  show(ytext, saved = null, { editable = true, awareness = null } = {}) {
    this.menu.close();
    this.unbind?.();
    this.ytext = ytext;
    this.awareness = awareness;
    this.readOnly = !editable;
    const { ta } = this;
    // (Its frontmatter hidden, #584: the textarea holds the text after it, from `base` on.)
    const all = ytext.toString();
    this.base = this.blockHidden ? bodyStart(all) : 0;
    this.value = ta.value = all.slice(this.base);
    ta.readOnly = !editable;
    ta.placeholder = 'Start typing…';
    const observer = (ev, tr) => {
      if (tr.origin !== LOCAL) this.apply(ev.delta);
      this.peersSoon(); // (the text moved under the others' cursors)
    };
    ytext.observe(observer);
    const peers = () => this.peersSoon();
    awareness?.on('change', peers);
    this.unbind = () => {
      ytext.unobserve(observer);
      awareness?.off('change', peers);
      this.tellCursor(true);
    };
    this.peersSoon();
    const here = (p) => (p == null ? null : Math.max(0, p - this.base));
    const anchor = saved && here(absolute(ytext, saved.anchor));
    const head = saved && here(absolute(ytext, saved.head));
    if (anchor != null && head != null) ta.setSelectionRange(anchor, head);
    else ta.setSelectionRange(0, 0);
    // Where it was: the line that was `offset` above the top of the view (one saved before #302: its scrollTop).
    const top = saved?.top ? here(absolute(ytext, saved.top)) : null;
    if (top != null && ta.clientHeight) this.placeHere({ pos: top, y: -(saved.offset ?? 0) });
    else ta.scrollTop = saved?.scrollTop ?? 0;
    this.fitEndRoom(); // (a short note: no room after it)
  }

  /**
   * A change from elsewhere, applied where it happened (the selection and the browser's undo
   * kept). Lines arriving or going above the cursor would move what's under the eye: the
   * textarea is scrolled by what its text grew or shrank, so the cursor's line stays put.
   */
  apply(delta) {
    const { ta } = this;
    const height = ta.scrollHeight;
    // (A change in its hidden frontmatter, #584: where the text starts is read again, and what's
    // after it put right as one replacement. In the text after it: the delta, `base` earlier.)
    // (No block before, and none now: an edit at the top is the text's, as any other.)
    if (this.blockHidden && this.touchesBlock(delta) && (this.base || bodyStart(this.ytext.toString()))) return this.rebase();
    if (this.base) {
      // (Its first retain is at least `base` long, touchesBlock says: that much less.)
      const [lead, ...rest] = delta;
      const left = lead.retain - this.base;
      delta = left > 0 ? [{ ...lead, retain: left }, ...rest] : rest;
    }
    let pos = 0, first = null;
    for (const op of delta) {
      if (op.retain) pos += op.retain;
      else if (op.delete) {
        first ??= pos;
        ta.setRangeText('', pos, pos + op.delete, 'preserve');
      } else if (op.insert != null) {
        first ??= pos;
        const s = String(op.insert);
        ta.setRangeText(s, pos, pos, 'preserve');
        pos += s.length;
      }
    }
    this.value = ta.value;
    this.fitEndRoom();
    this.menu.map((pos) => mapPos(pos, delta));
    this.menu.refresh(); // (the `/` gone, or no longer before the cursor: the menu goes too)
    const grew = ta.scrollHeight - height;
    if (grew && first != null && first < ta.selectionStart && ta.scrollTop > 0) ta.scrollTop += grew;
  }

  /**
   * The room after the note's end (style.css --ta-end) only once it's taller than the view: a
   * short note (a new one) has none to scroll into. Marked on the editor: `short`.
   */
  fitEndRoom() {
    const { ta, parent } = this;
    if (!ta.clientHeight) return; // (not on screen)
    // (And never more than the editor's box holds: a textarea is at least as tall as its padding,
    // so with the note's header in its top padding (#592) and the keyboard up, the full room
    // pushed its bottom 51 px past the editor, behind the keyboard, where showCursor took the
    // cursor's line for in sight. Room for two lines of text is left in it.)
    const cs = getComputedStyle(ta), line = parseFloat(cs.lineHeight) || 24;
    const fits = Math.max(line, parent.clientHeight - (parseFloat(cs.paddingTop) || 0) - 2 * line);
    if (this.fits !== fits) parent.style.setProperty('--ta-fit', `${(this.fits = fits)}px`);
    const pad = parseFloat(getComputedStyle(ta).paddingBottom) || 0;
    this.parent.classList.toggle('short', ta.scrollHeight - pad <= ta.clientHeight);
  }

  /**
   * Whether a change from elsewhere is at or before where the text after the hidden frontmatter
   * starts (#584): it may be the block's, or make one, or end it. (Anything after: the text's.)
   */
  touchesBlock(delta) {
    return !(delta[0]?.retain > this.base);
  }

  /**
   * The frontmatter changed, or its end moved (#584): where the text starts read again, and
   * what the textarea shows put right as one replacement (the selection kept, as far as the
   * text it was in is the same).
   */
  rebase() {
    const { ta } = this;
    const all = this.ytext.toString();
    this.base = this.blockHidden ? bodyStart(all) : 0;
    const now = all.slice(this.base);
    if (now === ta.value) return;
    const old = ta.value;
    const n = Math.min(old.length, now.length);
    let start = 0;
    while (start < n && old.charCodeAt(start) === now.charCodeAt(start)) start++;
    let end = 0;
    while (end < n - start && old.charCodeAt(old.length - 1 - end) === now.charCodeAt(now.length - 1 - end)) end++;
    ta.setRangeText(now.slice(start, now.length - end), start, old.length - end, 'preserve');
    this.value = ta.value;
    this.menu.close();
  }

  /** The note's frontmatter hidden (#584: its header shows it), or shown as the text it is ("yaml ›"). */
  hideFrontmatter(hide) {
    if (this.blockHidden === hide) return;
    this.blockHidden = hide;
    if (!this.ytext) return;
    const { ta } = this;
    const was = this.base ?? 0;
    const [a, b] = [ta.selectionStart + was, ta.selectionEnd + was];
    const all = this.ytext.toString();
    this.base = hide ? bodyStart(all) : 0;
    this.value = ta.value = all.slice(this.base);
    ta.setSelectionRange(Math.max(0, a - this.base), Math.max(0, b - this.base));
  }

  /** Where the note's text after its frontmatter starts (0: none, or shown). */
  bodyFrom() {
    return this.base ?? 0;
  }

  /** The textarea changed (typing, a paste, autocorrect): the one replacement it amounts to, into the note. */
  changed() {
    const old = this.value, now = this.ta.value;
    if (old === now) return;
    const n = Math.min(old.length, now.length);
    let start = 0;
    while (start < n && old.charCodeAt(start) === now.charCodeAt(start)) start++;
    let end = 0;
    while (end < n - start && old.charCodeAt(old.length - 1 - end) === now.charCodeAt(now.length - 1 - end)) end++;
    const deleted = old.length - start - end;
    const inserted = now.slice(start, now.length - end);
    this.value = now;
    if (this.ytext && !this.readOnly) {
      this.ytext.doc.transact(() => {
        const at = start + (this.base ?? 0); // (after the hidden frontmatter, #584)
        if (deleted) this.ytext.delete(at, deleted);
        if (inserted) this.ytext.insert(at, inserted);
      }, LOCAL);
    }
    return inserted;
  }

  /** `from`–`to` replaced with `text` by a key of ours, the cursor after it, into the note. */
  replace(from, to, text, mode = 'end') {
    this.ta.setRangeText(text, from, to, mode);
    this.changed();
  }

  /** The line at `pos`: where it starts and ends, and its text. */
  lineAt(pos) {
    const v = this.ta.value;
    const from = v.lastIndexOf('\n', pos - 1) + 1;
    let to = v.indexOf('\n', pos);
    if (to < 0) to = v.length;
    return { from, to, text: v.slice(from, to) };
  }

  keydown(e) {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || this.ta.readOnly) return;
    let done = false;
    // (A keyboard's arrows, Tab and Escape choose in the menu; its Return is beforeinput's.)
    if (this.menu.isOpen && e.key !== 'Enter') done = this.menu.key(e.key);
    else if (e.key === 'Backspace') done = this.removeMarker();
    else if (e.key === 'Tab') done = this.indent(e.shiftKey);
    if (done) e.preventDefault();
  }

  /**
   * Return in a list, task list or quote: the new line goes in as the OS puts it (so the keyboard
   * knows a sentence starts: the next letter capitalised), and the next item's marker follows it
   * (`input`); on an empty item, the list ends there instead: its marker goes, no new line.
   */
  beforeinput(e) {
    this.marker = null;
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    // Return with the menu open: picks after a filter (`/tod`); after a bare `/`, a new line.
    if (this.menu.returnPicks()) return e.preventDefault();
    const { selectionStart: start, selectionEnd: end } = this.ta;
    if (start !== end) return;
    const line = this.lineAt(start);
    const m = ITEM.exec(line.text);
    if (!m || start < line.from + m[0].length) return;
    if (start === line.to && line.text.length === m[0].length) {
      e.preventDefault();
      this.replace(line.from, line.to, ''); // (the marker goes: as in most editors)
      return;
    }
    let marker = m[2];
    const numbered = /^(\d{1,9})([.)])([ \t]+)/.exec(marker);
    if (numbered) marker = `${Number(numbered[1]) + 1}${numbered[2]}${numbered[3]}${marker.slice(numbered[0].length)}`;
    this.marker = m[1] + marker.replace(/\[[xX]\]/, '[ ]');
  }

  input(e) {
    const marker = this.marker;
    this.marker = null;
    if (marker && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph')) {
      const at = this.ta.selectionStart;
      this.ta.setRangeText(marker, at, at, 'end');
    }
    const inserted = this.changed();
    // A new line, a paste, lines put in by a script (dictation's): the browser doesn't always scroll to the cursor itself.
    if (inserted && (inserted.length > 1 || inserted.includes('\n'))) this.showCursor();
    // A character typed (not pasted or dictated, nor mid-composition): a `/`, or a tag's first
    // letter, may open the menu (#311, #313).
    if (e.inputType === 'insertText' && e.data && [...e.data].length === 1 && !e.isComposing && !this.readOnly) this.menu.typed(this.ta.selectionStart - e.data.length, e.data);
    else this.menu.refresh();
  }

  /**
   * The text laid out as the textarea lays it out (a textarea doesn't say where its lines are: a
   * mirror with the same font, padding and width does), one text node per line of the note.
   * Made once per text and width; measuring in it reads no more layout than that.
   */
  layout() {
    const { ta } = this;
    let m = this.mirror;
    if (!m) {
      m = this.mirror = document.createElement('div');
      m.setAttribute('aria-hidden', 'true');
      Object.assign(m.style, { position: 'absolute', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box', margin: '0', border: '0', height: '0', overflow: 'hidden' });
      this.parent.style.position ||= 'relative';
      this.parent.append(m);
    }
    const width = ta.clientWidth, v = ta.value;
    const cs = getComputedStyle(ta);
    // (Its padding too: on a phone the note's header sits in its top padding, #581, which follows the header's height.)
    if (this.laidOut?.value === v && this.laidOut.width === width && this.laidOut.pad === cs.paddingTop) return this.laidOut;
    for (const k of ['font', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'tabSize']) m.style[k] = cs[k];
    m.style.width = `${width}px`;
    // (An empty line: a zero-width space, so it has a place to measure.)
    const lines = [];
    const parts = [];
    let from = 0;
    for (const text of v.split('\n')) {
      const node = document.createTextNode(text || '​');
      lines.push({ from, to: from + text.length, node, empty: !text });
      parts.push(node, '\n');
      from += text.length + 1;
    }
    parts.pop();
    m.replaceChildren(...parts);
    return (this.laidOut = { value: v, width, lines, pad: cs.paddingTop });
  }

  /**
   * Where the character at `pos` is drawn, from the top of the text (the textarea's scrollTop
   * counts the same way). The end of a line: where its last character is, or it would be.
   */
  caretTop(pos) {
    return this.caretBox(pos).top;
  }

  /** The box of the character at `pos` (its top, left, and the line's height), from the top-left of the text. */
  caretBox(pos) {
    const { lines } = this.layout();
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].from <= pos) lo = mid;
      else hi = mid - 1;
    }
    const line = lines[lo];
    const len = line.node.length;
    const at = line.empty ? 0 : Math.min(pos - line.from, len);
    const range = document.createRange();
    // (The character at `pos`, or the one before it at a line's end: its box is the line's.)
    if (at < len) range.setStart(line.node, at), range.setEnd(line.node, at + 1);
    else range.setStart(line.node, len - 1), range.setEnd(line.node, len);
    const rects = range.getClientRects();
    const box = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const m = this.mirror.getBoundingClientRect();
    // (At a line's end, the caret is after its last character; an empty line's, at its start.)
    const x = at < len || line.empty ? box.left : box.right;
    return { top: box.top - m.top, left: x - m.left, height: box.height };
  }

  /**
   * The others in a shared note, their cursors drawn over the textarea (#302): a line in their
   * colour where their cursor is, with their name above it. Redrawn as they move, as the text
   * changes, and as it scrolls.
   */
  drawPeers() {
    const { awareness, ytext, ta } = this;
    let layer = this.peerLayer;
    if (!layer) {
      layer = this.peerLayer = Object.assign(document.createElement('div'), { className: 'peer-carets' });
      layer.setAttribute('aria-hidden', 'true'); // (the header's chips say who's here)
      this.parent.style.position ||= 'relative';
      this.parent.append(layer);
    }
    const carets = [];
    const base = this.base ?? 0;
    if (awareness && ytext && ta.clientHeight && ta.value === ytext.toString().slice(base)) {
      for (const [id, st] of awareness.getStates()) {
        if (id === awareness.clientID || !st.user || !st.cursor?.head) continue;
        let pos;
        try {
          const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), ytext.doc);
          if (at?.type !== ytext) continue;
          pos = at.index;
        } catch {
          continue;
        }
        if (pos < base) continue; // (in the hidden frontmatter)
        const b = this.caretBox(pos - base);
        const top = b.top - ta.scrollTop, left = b.left - ta.scrollLeft;
        if (top + b.height < 0 || top > ta.clientHeight) continue; // (out of sight)
        const caret = Object.assign(document.createElement('span'), { className: 'peer-caret' });
        caret.dataset.ycolor = st.user.color;
        caret.dataset.client = String(id);
        caret.style.top = `${ta.offsetTop + top}px`;
        caret.style.left = `${ta.offsetLeft + left}px`;
        caret.style.height = `${b.height}px`;
        caret.append(Object.assign(document.createElement('span'), { className: 'peer-name', textContent: st.user.name }));
        carets.push(caret);
      }
    }
    layer.replaceChildren(...carets);
  }

  /** drawPeers, once this frame. */
  peersSoon() {
    if (this.peersFrame) return;
    this.peersFrame = requestAnimationFrame(() => {
      this.peersFrame = 0;
      this.drawPeers();
    });
  }

  /** The first position on the line drawn at height `h` from the top of the text (the line across it). */
  posAtHeight(h) {
    const v = this.ta.value;
    let lo = 0, hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.caretTop(mid) <= h) lo = mid;
      else hi = mid - 1;
    }
    // (Back to the start of that line as drawn.)
    const top = this.caretTop(lo);
    let a = v.lastIndexOf('\n', lo - 1) + 1, b = lo;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (this.caretTop(mid) < top) a = mid + 1;
      else b = mid;
    }
    return a;
  }

  /**
   * Your place in the note, to keep when switching to the page (#302): the cursor's line if
   * you're typing and it's in sight, else the line at the top of the view; and how far it is
   * from the top of the view.
   */
  anchorView() {
    const a = this.anchorHere();
    return a && { ...a, pos: a.pos + this.base }; // (in the note's text: after its hidden frontmatter, #584)
  }

  /** anchorView, in the textarea's own text. */
  anchorHere() {
    const { ta } = this;
    if (!ta.clientHeight) return null; // (not on screen)
    const top = ta.scrollTop, line = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    if (document.activeElement === ta) {
      const c = this.caretTop(ta.selectionEnd);
      if (c >= top && c + line <= top + ta.clientHeight) return { pos: ta.selectionEnd, y: c - top };
    }
    const pos = this.posAtHeight(top);
    return { pos, y: this.caretTop(pos) - top };
  }

  /**
   * The note scrolled so that `pos` is `y` from the top of the view — but never past the end of
   * the text with none of it in sight (#316: a place kept in text since removed would be under
   * the end): then the text's end at the bottom of the view.
   */
  placeAnchor({ pos, y }, opts = {}) {
    this.placeHere({ pos: Math.max(0, pos - this.base), y }, opts); // (`pos` in the note's text, #584)
  }

  /** placeAnchor, `pos` in the textarea's own text. */
  placeHere({ pos, y }, { cursor = false } = {}) {
    const { ta } = this;
    const at = Math.min(pos, ta.value.length);
    // (`cursor`: the cursor there too, as the editor's placeAnchor does: focused next, the
    // textarea scrolls to its cursor, so it's where you're looking, not the note's start. #538)
    if (cursor) ta.setSelectionRange(at, at);
    let top = this.caretTop(at) - y;
    const last = this.caretBox(ta.value.length);
    const end = last.top + last.height, line = last.height || 24;
    if (end - top < line) top = end - ta.clientHeight + line;
    ta.scrollTop = Math.max(0, top);
    if (this.scrollAtFocus) this.scrollAtFocus = ta.scrollTop; // (placed just after a focus: this is the place showCursor keeps)
  }

  /** Whether the cursor is in sight. */
  cursorInView() {
    const { ta } = this;
    const c = this.caretTop(ta.selectionEnd);
    return c >= ta.scrollTop && c < ta.scrollTop + ta.clientHeight;
  }

  showCursor() {
    const { ta } = this;
    if (document.activeElement !== ta || !ta.value) return;
    this.fitEndRoom(); // (the page has just shrunk to what's above the keyboard: the textarea within it first)
    // As it was before the tap, for the keyboard's first second: the page shrinks at the focus
    // (keyboard.js) and Safari resets the scroll after, as the keyboard slides up, so this runs
    // more than once. (Kept only to the first, the reset after it had the cursor's line, wherever
    // it was on screen, brought up to the keyboard.)
    if (this.scrollAtFocus && performance.now() - this.focusedAt < 1000) {
      if (ta.scrollTop !== this.scrollAtFocus) ta.scrollTop = this.scrollAtFocus;
    } else this.scrollAtFocus = 0;
    const top = this.caretTop(ta.selectionEnd), line = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    // (Only when it's out of sight: what's in view stays where it is.)
    // (A line only partly above the top, as Edit leaves your place a few px up: just into view.)
    if (top < ta.scrollTop) ta.scrollTop = Math.max(0, top + line > ta.scrollTop ? top : top - line);
    else if (top + line > ta.scrollTop + ta.clientHeight) ta.scrollTop = top + line - ta.clientHeight + line;
  }

  /** Backspace just after an item's marker: the marker goes, the item becomes text. */
  removeMarker() {
    const { selectionStart: start, selectionEnd: end } = this.ta;
    if (start !== end) return false;
    const line = this.lineAt(start);
    const m = ITEM.exec(line.text);
    if (!m || start !== line.from + m[0].length) return false;
    this.replace(line.from + m[1].length, start, '');
    return true;
  }

  /** Tab and Shift-Tab: the list items the selection is on, indented or outdented (elsewhere, Tab moves on as usual). */
  indent(out) {
    const { ta } = this;
    const first = this.lineAt(ta.selectionStart), last = this.lineAt(ta.selectionEnd);
    const lines = ta.value.slice(first.from, last.to).split('\n');
    if (!lines.every((l) => /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]/.test(l))) return false;
    const changed = lines.map((l) => (out ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n');
    this.replace(first.from, last.to, changed, 'select');
    return true;
  }

  /** Where your cursor is, for the others in a shared note (none while the note isn't focused). */
  tellCursor(gone = false) {
    const { awareness, ytext, ta } = this;
    if (!awareness || !ytext) return;
    clearTimeout(this.cursorTimer);
    const tell = () => {
      if (gone || document.activeElement !== ta) return awareness.setLocalStateField('cursor', null);
      awareness.setLocalStateField('cursor', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, ta.selectionStart + this.base),
        head: Y.createRelativePositionFromTypeIndex(ytext, ta.selectionEnd + this.base),
      });
    };
    if (gone) tell();
    else this.cursorTimer = setTimeout(tell, CURSOR_MS);
  }

  /** An empty, read-only textarea while a note this device has never seen is fetched. */
  waiting() {
    this.menu.close();
    this.unbind?.();
    this.unbind = null;
    this.ytext = null;
    this.awareness = null;
    this.peersSoon(); // (none now)
    this.value = this.ta.value = '';
    this.base = 0;
    this.ta.readOnly = true;
    this.ta.placeholder = '';
  }

  /** "Loading…", once waiting has taken a moment. */
  setLoading(on) {
    this.ta.placeholder = on ? 'Loading…' : 'Start typing…';
  }

  /** Keep what's on screen, but stop edits (while the next note loads). */
  freeze() {
    this.ta.readOnly = true;
  }

  /** Allow edits again (after freeze, when nothing else replaced the note). */
  unfreeze() {
    if (this.ytext && !this.readOnly) this.ta.readOnly = false;
  }

  focus() {
    this.ta.focus();
  }

  blur() {
    this.ta.blur();
  }

  /** The note's text (its hidden frontmatter too, #584). */
  text() {
    return this.base && this.ytext ? this.ytext.toString().slice(0, this.base) + this.ta.value : this.ta.value;
  }

  /** The title (#584: its frontmatter's, else its first line, as noteTitle makes it). */
  title(max = 200) {
    const block = this.base && this.ytext ? this.ytext.toString().slice(0, this.base) : ''; // (hidden, #584)
    return noteTitle((block + withoutCommand(this.ta.value, this.menu.range())).slice(0, TITLE_HEAD)).slice(0, max);
  }

  /** The cursor's position in the text. */
  cursor() {
    return this.ta.selectionEnd + this.base; // (in the note's text, #584)
  }

  /** The text of the line the cursor is on. */
  cursorLine() {
    return this.lineAt(this.ta.selectionEnd).text;
  }

  /** The cursor put at `pos`, and (with `scroll`) its line brought near the top of the view, with a little room. */
  setCursor(pos, { scroll = true } = {}) {
    const { ta } = this;
    const at = Math.max(0, Math.min(pos - this.base, ta.value.length)); // (`pos` in the note's text, #584)
    ta.setSelectionRange(at, at);
    if (scroll) ta.scrollTop = Math.max(0, this.caretTop(at) - 32);
  }

  /** Where the cursor and the scroll are, to come back to later (no text: positions only). */
  viewState() {
    const { ytext, ta } = this;
    if (!ytext) return null;
    const at = this.anchorHere();
    return {
      anchor: relative(ytext, ta.selectionStart + this.base), head: relative(ytext, ta.selectionEnd + this.base),
      ...(at && { top: relative(ytext, at.pos + this.base), offset: -at.y }),
      scrollTop: ta.scrollTop,
    };
  }
}
