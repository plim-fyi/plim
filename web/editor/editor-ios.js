// What a phone's Safari needs of the editor (#264): each a workaround for how iOS, contenteditable
// and CodeMirror meet, named after what it does and the issue that found it, in one place so the
// shim can be seen for what it is, measured, and pruned when an iOS update makes one unnecessary.
// (Pruned so far: taps in the margin beside a heading's level, #242 — a phone edits markdown as
// it is since #283, and shows no levels.)
// NoteEditor (editor.js) installs them. Those keyed to touch or to the visual viewport run on
// any phone (the browser checks' Chromium iPhone plays them: it has no iOS); those working
// around iOS's own Return and caret only on an iPhone or iPad (IOS).
//
// Each behaviour's decision is a plain function (exported, unit-tested); the DOM wiring around
// it is thin. The timing-dependent ones take their clock and frame functions as options.
import { EditorView, ViewPlugin } from '../vendor/codemirror.mjs';
import { KEYBOARD_GAP, LONG_PRESS_MS, covered, fitPageAboveKeyboard, keyboardHeightOf } from './keyboard.js';

export { KEYBOARD_GAP, LONG_PRESS_MS, covered, keyboardHeightOf };

/** Safari on an iPhone or iPad (as CodeMirror tells them apart). */
export const IOS = typeof navigator !== 'undefined' && /Apple Computer/.test(navigator.vendor)
  && (/Mobile\/\w+/.test(navigator.userAgent) || navigator.maxTouchPoints > 2);

// A long press's word kept (#196): the finger moved no more than this, and for this long after.
const STILL_PX = 10;
export const KEEP_WORD_MS = 400;

const defaultNow = () => performance.now();

// ---------- #241: on iPhone, one Return is one new line ----------

/**
 * CodeMirror holds an iPhone's Return until iOS's own new line comes into the page, and runs it
 * then, in place of it, or after 50ms if it hasn't come yet; when it came later than that, it
 * went in as well: a second new line. Now the Return key's new line never goes into the page:
 * when iOS asks for it, Return runs there and then (unless it already has, after those 50ms).
 * One with no key pressed (dictation's, or text with new lines in it, which comes as one new
 * line after another) goes in as it always has.
 *
 * Debt: this reads and clears CodeMirror's private `inputState.pendingIOSKey` (CodeMirror 6.43,
 * web/vendor). Remove it when CodeMirror itself stops a late new line from going in twice.
 */
export function returnFromKey({ now = defaultNow } = {}) {
  let pressed = -Infinity; // (when Return was last pressed)
  return {
    /** A keydown on the page (CodeMirror keeps an iPhone's Return to itself, before its handlers). */
    keydown(e) {
      if (e.key === 'Enter' && !e.synthetic) pressed = now();
    },
    /** A beforeinput: true when it was the Return key's new line, which is then run as the key. */
    beforeinput(e, view) {
      if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return false;
      if (now() - pressed > 1000) return false; // (not the Return key's)
      pressed = -Infinity; // (one Return, one new line)
      e.preventDefault();
      // The Return CodeMirror holds, run now, not in 50ms: a letter typed right after it goes on
      // the new line, not before it.
      const input = view.inputState;
      if (input?.pendingIOSKey?.key === 'Enter') {
        input.pendingIOSKey = undefined;
        const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, cancelable: true });
        enter.synthetic = true; // (CodeMirror's mark for a key it runs at once)
        view.contentDOM.dispatchEvent(enter);
      }
      return true;
    },
  };
}

/** The extension: nothing unless on iOS. */
export function oneReturnOneLine(ios = IOS) {
  if (!ios) return [];
  const on = returnFromKey();
  // (performance.now(), not the events' timeStamps, which can differ in base.)
  const listen = ViewPlugin.define((view) => {
    view.contentDOM.addEventListener('keydown', on.keydown, true);
    return { destroy: () => view.contentDOM.removeEventListener('keydown', on.keydown, true) };
  });
  return [listen, EditorView.domEventHandlers({ beforeinput: on.beforeinput })];
}

// ---------- #196: text selected on a touch screen, iOS draws it ----------

/** `selecting` on the editor's element while text is selected (style.css: the editor's own isn't drawn over iOS's). */
function selectionDrawnByPhone(parent) {
  return EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.focusChanged) parent.classList.toggle('selecting', !u.state.selection.main.empty);
  });
}

// ---------- #196: a long press selects the word under the finger, and only that ----------

/** `r`, the selection now, is `word` taken further from one end (iOS's doing, not someone's): the word again. */
export function wordToKeep(word, r) {
  return r.from <= word.from && r.to >= word.to && (r.from === word.from || r.to === word.to) && !r.eq(word);
}

/**
 * On iPhone, a word low on the screen: the keyboard opens as the finger lifts, the text goes up
 * above it, and iOS takes the selection on to wherever the finger now is (a line or two, or a
 * whole page, further). When the finger didn't move, the word iOS selected while it was down is
 * put back.
 */
export function keepPressedWord(view, {
  doc = document, now = defaultNow, raf = (fn) => requestAnimationFrame(fn), caf = (id) => cancelAnimationFrame(id), later = (fn) => setTimeout(fn),
} = {}) {
  let press = null; // { start, x, y, word }
  let stop = null; // (the word being kept: ends at the next touch)
  view.contentDOM.addEventListener('touchstart', (e) => {
    stop?.();
    press = { start: e.timeStamp, x: e.touches[0]?.clientX, y: e.touches[0]?.clientY, word: null };
  }, { passive: true });
  // What iOS selects while the finger is down (once CodeMirror has read it from the page).
  doc.addEventListener('selectionchange', () => {
    const p = press;
    if (p) later(() => { if (press === p && !view.state.selection.main.empty) p.word = view.state.selection.main; });
  });
  view.contentDOM.addEventListener('touchend', (e) => {
    const p = press, at = e.changedTouches[0];
    press = null;
    const word = p?.word;
    if (!word || !at || e.timeStamp - p.start < LONG_PRESS_MS) return;
    if (Math.hypot(at.clientX - p.x, at.clientY - p.y) > STILL_PX) return; // (a press and drag)
    const until = now() + KEEP_WORD_MS;
    let frame = 0;
    stop = () => { caf(frame); stop = null; };
    const keep = () => {
      if (wordToKeep(word, view.state.selection.main)) view.dispatch({ selection: { anchor: word.anchor, head: word.head } });
      if (now() < until) frame = raf(keep);
      else stop = null;
    };
    frame = raf(keep);
  }, { passive: true });
}

// ---------- #209, #213, #214: the keyboard, and CodeMirror's cursor kept in sight above it ----------
// (The page's part — sized to what's above the keyboard as it opens and closes — is keyboard.js's,
// shared with the phone's textarea.)

/**
 * How far the editor must scroll for the cursor (`c`: its top and bottom) to show in `box`
 * above what the keyboard covers, with a gap: positive down, negative up, 0 when it shows.
 */
export function scrollToShow(c, box, coveredPx, gap = KEYBOARD_GAP) {
  const limit = box.bottom - coveredPx - gap;
  if (c.bottom > limit) return c.bottom - limit;
  if (c.top < box.top) return c.top - box.top - gap;
  return 0;
}

/**
 * The page fitted above the keyboard (keyboard.js), and the cursor's line kept in sight above
 * it: scrolled only if it would be covered (#214; the room below the line you're typing on,
 * #200, is for typing). At a tap, the line tapped goes up above the keyboard at once (#213):
 * the cursor will be there, but CodeMirror only learns that a frame later, after Safari has
 * moved the page to show it.
 */
function fitAboveKeyboard(view, parent) {
  const scrollBy = (by) => (view.scrollDOM.scrollTop += by);
  const keepCursorInSight = () => requestAnimationFrame(() => {
    if (!view.hasFocus) return;
    const head = view.state.selection.main.head;
    const c = view.coordsAtPos(head);
    if (!c) return view.dispatch({ effects: EditorView.scrollIntoView(head) }); // (not drawn: far off)
    const box = view.scrollDOM.getBoundingClientRect();
    const by = scrollToShow(c, box, covered(box));
    if (by) scrollBy(by);
  });
  fitPageAboveKeyboard({
    parent,
    content: view.contentDOM,
    onResize: keepCursorInSight,
    onTapFocus: (y) => {
      const line = view.lineBlockAtHeight(y - view.documentTop);
      const below = view.documentTop + line.bottom; // (the line's bottom, as the cursor's is)
      const limit = view.scrollDOM.getBoundingClientRect().bottom - KEYBOARD_GAP;
      if (below > limit) scrollBy(below - limit);
    },
  });
}

// ---------- #220: the whole note measured, so a fling has nothing left to find ----------

/**
 * CodeMirror draws the lines near the screen and estimates the rest as plain text; headings,
 * code and quotes are taller. When those are drawn on the way up, it moves the scroll position
 * by the difference so the text on screen stays put — except during an iPhone's momentum
 * scroll (setting the position would stop it), where the text jumps instead. A note measured
 * whole, once, has nothing left to find. Returns whether it could.
 *
 * Debt: this is CodeMirror's print mode (`viewState.printing`, what its own `beforeprint`
 * handler does; 6.43, web/vendor), not public API. A version without it measures nothing (the
 * browser checks say so: a long note's height mustn't change as it's scrolled through).
 */
export function measureWholeNote(view) {
  const vs = view.viewState;
  if (!vs || typeof vs.printing !== 'boolean') return false;
  vs.printing = true;
  try {
    view.measure();
  } finally {
    vs.printing = false;
  }
  view.requestMeasure();
  return true;
}

// Measured whole: a note up to this long (about 10 ms per 1,000 lines on an iPhone simulator;
// tools/bench/editor.html), this soon after it's shown (first drawn, and any fling over), and
// not within this of a scroll.
export const MEASURE_MAX_LINES = 10_000;
const MEASURE_AFTER_MS = 300;
const SCROLL_SETTLE_MS = 150;
const measurers = new WeakMap(); // view → its soon() (for the extension below)

/**
 * The note on screen measured whole: once it's there, and again when the text re-wraps (the
 * editor's width changed: CodeMirror drops its measured heights then) or lines arrive beyond
 * the screen (a paste, an edit from elsewhere: linesArrivedOffScreen). Returns `soon`, which the
 * editor calls when it shows a note.
 */
export function keepWholeNoteMeasured(view, {
  maxLines = MEASURE_MAX_LINES, now = defaultNow, later = (fn, ms) => setTimeout(fn, ms), measure = measureWholeNote,
  widthChanges = observeWidth,
} = {}) {
  let lastScroll = -Infinity;
  let pending = 0;
  view.scrollDOM.addEventListener('scroll', () => (lastScroll = now()), { passive: true });
  const soon = (delay = MEASURE_AFTER_MS) => {
    const id = ++pending;
    later(() => {
      if (id !== pending) return; // (asked again since)
      if (now() - lastScroll < SCROLL_SETTLE_MS) return soon(SCROLL_SETTLE_MS); // (still scrolling: later)
      if (view.state.doc.lines > maxLines) return;
      measure(view);
    }, delay);
  };
  widthChanges(view.scrollDOM, () => soon());
  measurers.set(view, soon);
  return soon;
}

function observeWidth(el, fn) {
  if (typeof ResizeObserver === 'undefined') return;
  let width = el.clientWidth;
  new ResizeObserver(() => {
    if (el.clientWidth === width) return;
    width = el.clientWidth;
    fn();
  }).observe(el);
}

/** A change brought lines in beyond what's on screen (`viewport`: the drawn range), whose heights are then estimates. */
export function linesArrivedOffScreen(changes, viewport) {
  let off = false;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (inserted.lines > 1 && (fromB < viewport.from || toB > viewport.to)) off = true;
  });
  return off;
}

/** The extension side of keepWholeNoteMeasured: lines arriving off-screen ask for a measure, a moment later. */
const measureAfterOffScreenLines = EditorView.updateListener.of((u) => {
  if (u.docChanged && linesArrivedOffScreen(u.changes, u.view.viewport)) measurers.get(u.view)?.(1000);
});

/** Extensions for the editor's state: Return on iOS (#241), the selection class (#196), lines arriving off-screen (#220). */
export function phoneExtensions(parent) {
  return [oneReturnOneLine(), selectionDrawnByPhone(parent), measureAfterOffScreenLines];
}

/**
 * Listeners on the editor's view, once it exists: the keyboard, a long press's word; and on a
 * phone (a coarse pointer: only an iPhone skips the correction, but the browser checks' Chromium
 * iPhone has to be able to see it work), the note measured whole. Returns what the editor calls
 * when it shows a note.
 */
export function installPhoneBehaviours(view, parent) {
  fitAboveKeyboard(view, parent);
  keepPressedWord(view);
  const phone = matchMedia('(pointer: coarse)').matches;
  return { noteShown: phone ? keepWholeNoteMeasured(view) : () => {} };
}
