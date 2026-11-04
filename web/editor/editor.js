// The note editor: CodeMirror 6, bound to the note's Y.Text by
// y-codemirror.next. CodeMirror only draws the lines on screen and applies
// edits incrementally, so typing stays quick in long notes (a <textarea>
// slows down by ~150 ms per keystroke for every MB of text).
//
// One EditorView lives for the whole session; opening a note swaps in a new
// state bound to that note's text.
import * as Y from '../vendor/yjs.mjs';
import { absolute, relative } from '../core/textpos.js';
import {
  Compartment, drawSelection, EditorState, EditorView, keymap, placeholder, Prec, standardKeymap, yCollab, yUndoManagerKeymap,
} from '../vendor/codemirror.mjs';
import { markdownEditing } from './markdown.js';
import { covered, installPhoneBehaviours, phoneExtensions } from './editor-ios.js';
import { SlashMenu } from './slashmenu.js';
import { withoutCommand } from './slash.js';

import { TITLE_HEAD, bodyStart, noteTitle } from '../core/frontmatter.js';
import { ago, appMark, appRanges, whoOf } from '../core/authorship.js';
import { findAll } from '../core/search.js';
import { Decoration, StateField } from '../vendor/codemirror.mjs';

/**
 * The note's frontmatter (#584), hidden: the note's header (ui/notehead.js) shows its title and
 * tags, and "yaml ›" there shows the block again. Its lines are replaced by nothing, and the
 * cursor steps over them.
 */
function hiddenBlock(state) {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, TITLE_HEAD));
  const end = bodyStart(head);
  if (!end) return Decoration.none;
  return Decoration.set([Decoration.replace({ block: true }).range(0, head[end - 1] === '\n' ? end - 1 : end)]);
}
const frontmatterHidden = StateField.define({
  create: hiddenBlock,
  update: (deco, tr) => (tr.docChanged ? hiddenBlock(tr.state) : deco),
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none)],
});

/**
 * How far from the bottom the cursor is kept when the editor follows it (#200):
 * a quarter of the editor's height (at least 3rem), so the line you're typing
 * isn't against the bottom edge; plus, on a phone, whatever its keyboard covers
 * (the visual viewport ends above the editor's bottom while it's open).
 */
function bottomRoom(view) {
  const box = view.scrollDOM.getBoundingClientRect();
  return { bottom: covered(box) + Math.max(48, box.height * 0.25) };
}

export class NoteEditor {
  constructor(parent) {
    this.editable = new Compartment();
    this.hint = new Compartment();
    this.fm = new Compartment(); // (the frontmatter hidden, #584)
    this.blockHidden = false;
    this.undo = null;
    this.base = [
      // CodeMirror's own styles go in a <style> element, allowed by this page's CSP nonce.
      EditorView.cspNonce.of(document.querySelector('meta[name=style-nonce]')?.content ?? ''),
      EditorView.lineWrapping,
      // Draw the cursor and selection ourselves: the browser's caret is the full
      // line height on an empty line, and shrinks to the text once you type.
      drawSelection(),
      EditorView.contentAttributes.of({
        spellcheck: 'true',
        autocorrect: 'on',
        autocapitalize: 'sentences',
        'aria-label': 'Note',
      }),
      // Undo and redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y) for your own edits only.
      keymap.of(yUndoManagerKeymap),
      // Enter is a plain newline, as in a textarea (the standard one copies indentation).
      keymap.of([{ key: 'Enter', run: newline }]),
      // Backspace, Delete, arrows, Home/End, word deletes, select all.
      keymap.of(standardKeymap),
      // Room below the line you're typing on (#200).
      EditorView.scrollMargins.of(bottomRoom),
      // The markdown as it is, with typing that knows it, and a link's card (markdown.js).
      markdownEditing,
      // What a phone's Safari needs (editor-ios.js): one Return, one new line; its selection drawn once.
      phoneExtensions(parent),
      // The lines an app wrote today (#389): a mark in the margin and a tint, faded after a day.
      EditorView.decorations.of((view) => this.appMarks(view)),
      // What a search found (#24, ui/search.js): each match marked, the one you're at more so.
      EditorView.decorations.of((view) => this.findMarks(view)),
      // Type / for a menu (#311): its keys while it's open, before any other's; told what happens.
      Prec.highest(keymap.of(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].map((key) => ({ key, run: () => this.menu.key(key) })))),
      EditorView.updateListener.of((u) => this.menuUpdate(u)),
      // Text taken out elsewhere while the note is open (#316, #560): never left looking at the
      // room after its end, as placeAnchor sees to on opening. Also once the lines are measured:
      // the editor keeps its place by the heights it estimated, and puts it right after.
      EditorView.updateListener.of((u) => {
        if (!u.docChanged && !u.geometryChanged) return;
        this.keepEndInSight();
        this.fitEndRoom();
      }),
    ];
    this.view = new EditorView({ parent, state: this.state(null) });
    // (The keyboard, a long press's word, taps beside the text, the note measured whole.)
    this.phone = installPhoneBehaviours(this.view, parent);
    const { view } = this;
    parent.style.position ||= 'relative';
    this.menu = new SlashMenu({
      root: parent, field: view.contentDOM, scroller: view.scrollDOM,
      slice: (from, to) => view.state.sliceDoc(from, to),
      cursor: () => {
        const { ranges, main } = view.state.selection;
        return ranges.length === 1 && main.empty ? main.head : null;
      },
      caretRect: (pos) => view.coordsAtPos(pos),
      measure: (fn) => view.requestMeasure({ key: this.menu, read: fn }),
      replace: (from, to, text) => {
        // (One undo step of its own: Ctrl+Z brings back what was typed, `/tod`.)
        this.undo?.stopCapturing();
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: 'input.complete' });
        this.undo?.stopCapturing();
      },
      onToggle: (open) => parent.dispatchEvent(new CustomEvent('plim:menu', { bubbles: true, detail: { open } })),
    });
  }

  /**
   * The menu told what happened (#311, #313): a character you typed (not pasted, not someone
   * else's, not mid-composition: a `/`, or a tag's first letter) may open it; the text moving
   * keeps its start in place; the cursor moving or the focus going may close it.
   */
  menuUpdate(u) {
    const { menu } = this;
    if (!menu) return;
    if (u.docChanged) menu.map((pos) => u.changes.mapPos(pos, 1));
    if (u.focusChanged && !u.view.hasFocus) return menu.close();
    let typed = null;
    for (const tr of u.transactions) {
      if (!tr.isUserEvent('input.type') || tr.isUserEvent('input.type.compose')) continue;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const ch = inserted.toString();
        if ([...ch].length === 1) typed = { pos: fromB, ch };
      });
    }
    if (typed && !u.state.readOnly) menu.typed(typed.pos, typed.ch);
    else if (u.docChanged || u.selectionSet) menu.refresh();
  }

  /** `awareness` (presence.js): a shared note's other people, drawn as cursors and selections. */
  /**
   * The lines an app wrote within the day (#389, authorship.js), as line decorations: each a tint,
   * the first of a run with its mark (the app's initial) in the margin, and who and when on hover.
   * Worked out again only when the text changes (kept with the doc it was for).
   */
  appMarks(view) {
    const doc = view.state.doc;
    if (this.marks?.doc === doc) return this.marks.set;
    let set = Decoration.none;
    if (this.ytext && this.ytext.length === doc.length) {
      const lines = [];
      for (const r of appRanges(this.ytext)) {
        const first = doc.lineAt(Math.min(r.from, doc.length));
        const last = doc.lineAt(Math.max(r.from, Math.min(r.to - 1, doc.length)));
        for (let n = first.number; n <= last.number; n++) {
          const line = doc.line(n);
          if (line.from === line.to && n !== first.number) continue; // (a blank line between: not marked)
          lines.push(Decoration.line({
            class: n === first.number ? 'app-edit app-edit-start' : 'app-edit',
            attributes: { 'data-app': appMark(r.name).letter, 'data-tone': appMark(r.name).tone, title: `Added by ${whoOf(r)} · ${ago(r.at)}` },
          }).range(line.from));
        }
      }
      set = Decoration.set(lines, true);
    }
    this.marks = { doc, set };
    return set;
  }

  /**
   * A search's words marked in the note (#24), `current` (an index into them) more so; found again
   * as the text changes. No words: none marked.
   */
  setFind(words, current = -1) {
    this.find = words?.length ? { words, current } : null;
    this.view.dispatch({}); // (drawn again: findMarks)
  }

  /** Where the search's words are in the note now, as [from, to] ranges. */
  findRanges() {
    const doc = this.view.state.doc;
    if (!this.find) return [];
    if (this.found?.doc !== doc || this.found.words !== this.find.words) this.found = { doc, words: this.find.words, ranges: findAll(doc.toString(), this.find.words) };
    return this.found.ranges;
  }

  findMarks() {
    if (!this.find) return Decoration.none;
    const marks = this.findRanges().map(([a, b], i) => Decoration.mark({ class: i === this.find.current ? 'cm-find cm-find-current' : 'cm-find' }).range(a, b));
    return Decoration.set(marks);
  }

  /** The note scrolled to show `pos` (a match), a third of the way down. */
  reveal(pos) {
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: this.view.scrollDOM.clientHeight / 3 }) });
  }

  state(ytext, { editable = true, hint = 'Start typing…', selection, awareness = null } = {}) {
    this.undo?.destroy();
    this.undo = ytext ? new Y.UndoManager(ytext) : null;
    this.ytext = ytext;
    return EditorState.create({
      doc: ytext ? ytext.toString() : '',
      selection,
      extensions: [
        this.base,
        this.editable.of(editableExt(editable)),
        this.hint.of(placeholder(hint)),
        this.fm.of(this.blockHidden ? frontmatterHidden : []),
        ytext ? yCollab(ytext, awareness, { undoManager: this.undo }) : [],
      ],
    });
  }

  /**
   * Show a note's text, kept in sync both ways from now on. `saved` (from
   * viewState) puts the cursor and the scroll back where they were.
   */
  show(ytext, saved = null, { editable = true, awareness = null } = {}) {
    const anchor = saved && absolute(ytext, saved.anchor);
    const head = saved && absolute(ytext, saved.head);
    const selection = anchor != null && head != null ? { anchor, head } : undefined;
    this.readOnly = !editable; // e.g. a shared note opened with a view-only link
    this.menu.close();
    this.view.setState(this.state(ytext, { selection, editable, awareness }));
    this.view.dom.classList.remove('loading');
    this.fitEndRoom(); // (a short note: no room after it)
    const top = saved && absolute(ytext, saved.top);
    // Your place goes back where it was on screen.
    // (None kept, a note first opened here: at its top. The one view serves every note, and kept
    // the last one's scroll: a short note opened after a long one scrolled down showed blank, #316.)
    if (top != null) this.placeAnchor({ pos: top, y: -(saved.offset ?? 0) });
    else this.view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start', yMargin: 0 }) });
    this.phone.noteShown();
  }

  /**
   * Where the cursor and the scroll are in the note on screen, to come back to
   * later. Kept as Yjs relative positions, which stay with the same text when
   * it's edited around them (here or on another device). No text is included.
   */
  viewState() {
    const { view, ytext } = this;
    if (!ytext) return null;
    const rel = (pos) => relative(ytext, pos);
    const { anchor, head } = view.state.selection.main;
    // Your place (anchorView), and how far it is above the top edge (what scrollIntoView lines up when coming back).
    const at = this.anchorView();
    return { anchor: rel(anchor), head: rel(head), ...(at && { top: rel(at.pos), offset: Math.round(-at.y) }) };
  }

  /**
   * Your place in the note, to keep when switching to the page (#302): the cursor's line if
   * you're typing and it's in sight, else the line at the top of the view (where it starts, as
   * drawn); and how far it is from the top of the view.
   */
  anchorView() {
    const { view } = this;
    const box = view.scrollDOM.getBoundingClientRect();
    if (!box.height) return null; // (not on screen)
    const edge = box.top;
    const head = view.state.selection.main.head;
    if (view.hasFocus) {
      const c = view.coordsAtPos(head);
      if (c && c.top >= edge && c.bottom <= box.bottom) return { pos: head, y: c.top - edge };
    }
    const content = view.contentDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: content.left + 1, y: Math.max(edge, content.top) + 1 }, false);
    const c = view.coordsAtPos(pos, 1);
    return { pos, y: c ? c.top - edge : 0 };
  }

  /** What scrolls (Split keeps the page beside it in step, ui/reading.js). */
  scroller() {
    return this.view.scrollDOM;
  }

  /** Where `pos` is drawn on screen (its top); a line not drawn yet: where it would be. */
  topOf(pos) {
    const { view } = this;
    const c = view.coordsAtPos(pos, 1);
    return c ? c.top : view.documentTop + view.lineBlockAt(pos).top;
  }

  /** The start of the line across the top of the view, and where that edge is on screen. */
  posAtTop() {
    const { view } = this;
    const edge = view.scrollDOM.getBoundingClientRect().top;
    return { pos: view.lineBlockAtHeight(edge - view.documentTop).from, edge };
  }

  /**
   * `fn` run once this frame's lines are drawn and measured (CodeMirror draws what a scroll brings
   * into view in its own frame step: read before it, those lines' places are only estimates).
   */
  afterLayout(fn) {
    this.view.requestMeasure({ key: this.layoutKey ??= {}, read: () => fn() });
  }

  /** Where the end of the note is drawn on screen (its last line's bottom). */
  bottomOfText() {
    const { view } = this;
    return view.documentTop + view.lineBlockAt(view.state.doc.length).bottom;
  }

  /**
   * The note scrolled so that `pos` is `y` from the top of the view; with `cursor`, the cursor
   * put there too if it's out of sight then (so typing starts where you're looking).
   */
  placeAnchor({ pos, y }, { cursor = false } = {}) {
    const { view } = this;
    const at = Math.max(0, Math.min(pos, view.state.doc.length));
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: y }) });
    // (Lines not drawn yet have estimated heights: once drawn, put right.)
    view.requestMeasure({
      read: () => {
        const c = view.coordsAtPos(at, 1);
        const box = view.scrollDOM.getBoundingClientRect();
        const head = view.coordsAtPos(view.state.selection.main.head);
        let shift = c ? c.top - (box.top + y) : 0;
        // Never past the end of the text with none of it in sight (#316: a place kept in text since
        // removed would be under the end): then the text's end at the bottom of the view.
        const end = this.bottomOfText() - shift;
        if (end < box.top + view.defaultLineHeight) shift += end - box.bottom + view.defaultLineHeight;
        shift = Math.max(shift, -view.scrollDOM.scrollTop);
        return { shift, off: !head || head.top < box.top || head.bottom > box.bottom };
      },
      write: ({ shift, off }) => {
        if (Math.abs(shift) >= 0.5) view.scrollDOM.scrollTop += shift;
        if (cursor && off) view.dispatch({ selection: { anchor: at } });
      },
    });
  }

  /** If the text's end is above the view (none of it in sight), scroll it to the bottom of the view. */
  /**
   * The room after the note's end (#200, style.css --end-room) only once it's taller than the
   * view: a short note (a new one) has none to scroll into. Marked on the editor: `short`.
   */
  fitEndRoom() {
    const { view } = this;
    view.requestMeasure({
      key: 'fit-end-room',
      // (Where its last line ends, below the content's top padding: the content box itself is at
      // least the view's height, CodeMirror's min-height.)
      read: () => {
        const top = parseFloat(getComputedStyle(view.contentDOM).paddingTop) || 0;
        return top + view.lineBlockAt(view.state.doc.length).bottom <= view.scrollDOM.clientHeight;
      },
      write: (short) => view.dom.parentElement?.classList.toggle('short', short),
    });
  }

  keepEndInSight() {
    const { view } = this;
    view.requestMeasure({
      read: () => {
        const box = view.scrollDOM.getBoundingClientRect();
        const end = this.bottomOfText();
        if (end >= box.top + view.defaultLineHeight) return 0;
        return Math.max(end - box.bottom + view.defaultLineHeight, -view.scrollDOM.scrollTop);
      },
      write: (shift) => { if (Math.abs(shift) >= 0.5) view.scrollDOM.scrollTop += shift; },
    });
  }

  /** An empty, read-only editor while a note this device has never seen is fetched. */
  waiting() {
    // Blank, not "Start typing…": the note's text is a moment away (and "Loading…" if it isn't).
    this.menu.close();
    this.view.setState(this.state(null, { editable: false, hint: '' }));
  }

  /** "Loading…", once waiting has taken a moment. */
  setLoading(on) {
    this.view.dispatch({ effects: this.hint.reconfigure(placeholder(on ? 'Loading…' : 'Start typing…')) });
    this.view.dom.classList.toggle('loading', on);
  }

  /** Keep what's on screen, but stop edits (while the next note loads). */
  freeze() {
    this.view.dispatch({ effects: this.editable.reconfigure(editableExt(false)) });
  }

  /** Allow edits again (after freeze, when nothing else replaced the note). */
  unfreeze() {
    if (this.ytext && !this.readOnly) this.view.dispatch({ effects: this.editable.reconfigure(editableExt(true)) });
  }

  focus() {
    this.view.focus();
  }

  blur() {
    this.view.contentDOM.blur();
  }

  text() {
    return this.view.state.doc.toString();
  }

  /** The cursor's position in the text. */
  cursor() {
    return this.view.state.selection.main.head;
  }

  /** The text of the line the cursor is on. */
  cursorLine() {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).text;
  }

  /** The cursor put at `pos`, and (with `scroll`) its line brought to the top of the view, with a little room. */
  setCursor(pos, { scroll = true } = {}) {
    const at = Math.max(0, Math.min(pos, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor: at }, effects: scroll ? EditorView.scrollIntoView(at, { y: 'start', yMargin: 32 }) : [] });
  }

  /** The note's frontmatter hidden (#584: its header shows it), or shown as the text it is ("yaml ›"). */
  hideFrontmatter(hide) {
    if (this.blockHidden === hide) return;
    this.blockHidden = hide;
    this.view.dispatch({ effects: this.fm.reconfigure(hide ? frontmatterHidden : []) });
  }

  /** Where the note's text after its frontmatter starts (0: none, or shown). */
  bodyFrom() {
    if (!this.blockHidden) return 0;
    const { doc } = this.view.state;
    return bodyStart(doc.sliceString(0, Math.min(doc.length, TITLE_HEAD)));
  }

  /** The title (#584: its frontmatter's, else its first line, as noteTitle makes it), from the note's start — without building the whole text. */
  title(max = 200) {
    const { doc } = this.view.state;
    const head = doc.sliceString(0, Math.min(doc.length, TITLE_HEAD));
    const typing = this.menu?.range(); // (a command being typed, `/tod`: not part of the title)
    return noteTitle(typing && typing.to <= head.length ? withoutCommand(head, typing) : head).slice(0, max);
  }
}

function newline(view) {
  if (view.state.readOnly) return false;
  view.dispatch(view.state.replaceSelection('\n'), { scrollIntoView: true, userEvent: 'input' });
  return true;
}

const editableExt = (on) => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
