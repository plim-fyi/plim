// What a phone's Safari needs of the editor (editor-ios.js).
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '../vendor/codemirror.mjs';
import { IOS, KEEP_WORD_MS, LONG_PRESS_MS, MEASURE_MAX_LINES, covered, keepPressedWord, keepWholeNoteMeasured, keyboardHeightOf, linesArrivedOffScreen, measureWholeNote, oneReturnOneLine, returnFromKey, scrollToShow, wordToKeep } from '../editor/editor-ios.js';
import { test } from './lib.mjs';

/** Something listened to (an element, the document): handlers kept, events given to them by hand. */
class Listened {
  constructor() { this.handlers = {}; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn); }
  emit(type, e = {}) { for (const fn of this.handlers[type] ?? []) fn(e); }
}

test('iOS: not this (Node); the Return extension is nothing elsewhere', () => {
  assert.equal(IOS, false);
  assert.deepEqual(oneReturnOneLine(false), []);
  assert.equal(oneReturnOneLine(true).length, 2);
});

test('one Return, one new line (#241): the key’s new line runs the Return CodeMirror holds, at once', () => {
  let t = 1000;
  const on = returnFromKey({ now: () => t });
  const saved = globalThis.KeyboardEvent;
  globalThis.KeyboardEvent = class extends Event {
    constructor(type, init) {
      super(type, init);
      const { bubbles, cancelable, composed, ...rest } = init; // (Event's own: getters)
      Object.assign(this, rest);
    }
  };
  try {
    const contentDOM = new EventTarget();
    const dispatched = [];
    contentDOM.addEventListener('keydown', (e) => dispatched.push(e));
    const view = { contentDOM, inputState: { pendingIOSKey: { key: 'Enter' } } };
    const input = (inputType) => {
      const e = { inputType, prevented: false, preventDefault() { this.prevented = true; } };
      return [on.beforeinput(e, view), e.prevented];
    };
    // Return pressed, iOS's new line 30 ms later: stopped, and the held Return run now as a synthetic key.
    on.keydown({ key: 'Enter' });
    t += 30;
    assert.deepEqual(input('insertParagraph'), [true, true]);
    assert.equal(view.inputState.pendingIOSKey, undefined);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].key, 'Enter');
    assert.equal(dispatched[0].synthetic, true);
    // A second new line for the same press (what made two lines): not the key's any more.
    assert.deepEqual(input('insertParagraph'), [false, false]);
    // Dictation's new line, no key pressed: goes in as it always has.
    t += 5000;
    assert.deepEqual(input('insertLineBreak'), [false, false]);
    // Return pressed long ago (over a second): not its new line either.
    on.keydown({ key: 'Enter' });
    t += 1001;
    assert.deepEqual(input('insertParagraph'), [false, false]);
    // The synthetic Return the extension itself dispatches doesn't count as a press.
    on.keydown({ key: 'Enter', synthetic: true });
    assert.deepEqual(input('insertParagraph'), [false, false]);
    // Other input is never the key's.
    on.keydown({ key: 'Enter' });
    assert.deepEqual(input('insertText'), [false, false]);
    assert.equal(dispatched.length, 1);
  } finally {
    globalThis.KeyboardEvent = saved;
  }
});

test('a long press’s word (#196): put back when iOS takes the selection on from it, until the next touch', () => {
  const word = EditorSelection.range(10, 14);
  const taken = (from, to) => EditorSelection.range(from, to);
  assert.equal(wordToKeep(word, taken(10, 30)), true, 'taken further from its end');
  assert.equal(wordToKeep(word, taken(0, 14)), true, 'taken further from its start');
  assert.equal(wordToKeep(word, taken(10, 14)), false, 'the word itself');
  assert.equal(wordToKeep(word, taken(11, 14)), false, 'shrunk: someone’s doing');
  assert.equal(wordToKeep(word, taken(20, 30)), false, 'somewhere else');
  assert.equal(wordToKeep(word, taken(5, 30)), false, 'grown at both ends: a drag');

  let t = 0;
  const frames = [];
  const dispatched = [];
  const contentDOM = new Listened();
  const doc = new Listened();
  let main = EditorSelection.range(0, 0);
  const view = { contentDOM, state: { selection: { get main() { return main; } } }, dispatch: (tr) => dispatched.push(tr.selection) };
  const pending = [];
  keepPressedWord(view, { doc, now: () => t, raf: (fn) => frames.push(fn), caf: () => frames.length = 0, later: (fn) => pending.push(fn) });
  const runPending = () => { while (pending.length) pending.shift()(); };
  const runFrames = () => { const fs = frames.splice(0); for (const f of fs) f(); };
  // Finger down at 100; iOS selects the word under it; up after a long press, finger still.
  contentDOM.emit('touchstart', { timeStamp: 100, touches: [{ clientX: 50, clientY: 300 }] });
  main = word;
  doc.emit('selectionchange');
  runPending();
  contentDOM.emit('touchend', { timeStamp: 100 + LONG_PRESS_MS + 100, changedTouches: [{ clientX: 52, clientY: 303 }] });
  // The keyboard opens, the text goes up, and the selection is taken on to where the finger is.
  main = taken(10, 80);
  t = 50;
  runFrames();
  assert.deepEqual(dispatched, [{ anchor: 10, head: 14 }], 'the word again');
  main = word;
  t = KEEP_WORD_MS + 1;
  runFrames();
  assert.equal(frames.length, 0, 'stops after KEEP_WORD_MS');
  // A short tap keeps nothing; neither does a press that moved (a drag).
  dispatched.length = 0;
  contentDOM.emit('touchstart', { timeStamp: 1000, touches: [{ clientX: 50, clientY: 300 }] });
  main = word;
  doc.emit('selectionchange');
  runPending();
  contentDOM.emit('touchend', { timeStamp: 1100, changedTouches: [{ clientX: 50, clientY: 300 }] });
  assert.equal(frames.length, 0, 'a tap: nothing kept');
  contentDOM.emit('touchstart', { timeStamp: 2000, touches: [{ clientX: 50, clientY: 300 }] });
  doc.emit('selectionchange');
  runPending();
  contentDOM.emit('touchend', { timeStamp: 2000 + LONG_PRESS_MS + 100, changedTouches: [{ clientX: 50, clientY: 400 }] });
  assert.equal(frames.length, 0, 'a press and drag: nothing kept');
});

test('the keyboard (#209, #214): its height from what the viewport lost, what it covers, the scroll to show the cursor', () => {
  assert.equal(keyboardHeightOf(800, { height: 500, scale: 1 }), 300);
  assert.equal(keyboardHeightOf(800, { height: 250, scale: 2 }), 300, 'zoomed');
  assert.equal(keyboardHeightOf(800, { height: 700, scale: 1 }), 0, 'a toolbar, not a keyboard');
  assert.equal(covered({ bottom: 800 }, { offsetTop: 0, height: 500 }), 300);
  assert.equal(covered({ bottom: 800 }, { offsetTop: 100, height: 500 }), 200, 'the viewport scrolled down');
  assert.equal(covered({ bottom: 400 }, { offsetTop: 0, height: 500 }), 0, 'above the keyboard');
  assert.equal(covered({ bottom: 800 }, null), 0, 'no visual viewport');
  const box = { top: 100, bottom: 800 };
  assert.equal(scrollToShow({ top: 300, bottom: 320 }, box, 300), 0, 'in sight');
  assert.equal(scrollToShow({ top: 600, bottom: 620 }, box, 300), 620 - (800 - 300 - 16), 'under the keyboard: down by what it takes');
  assert.equal(scrollToShow({ top: 50, bottom: 70 }, box, 300), 50 - 100 - 16, 'above the top: up, with the gap');
});

test('a note measured whole (#220): once shown, after a scroll settles, on re-wrapping, never over the cap', () => {
  // The measure itself: CodeMirror's print mode, or nothing without it.
  assert.equal(measureWholeNote({}), false, 'no viewState: nothing');
  assert.equal(measureWholeNote({ viewState: {} }), false, 'no print mode: nothing');
  const calls = [];
  const cm = { viewState: { printing: false }, measure() { calls.push(['measure', this.viewState.printing]); }, requestMeasure() { calls.push(['requestMeasure', this.viewState.printing]); } };
  assert.equal(measureWholeNote(cm), true);
  assert.deepEqual(calls, [['measure', true], ['requestMeasure', false]], 'drawn whole while measuring, then back to normal');

  // When: a fake clock, timers run by hand, the scroller's events given by hand.
  let t = 0;
  const timers = [];
  const measured = [];
  let widthChanged = null;
  const scrollDOM = new Listened();
  const view = { scrollDOM, state: { doc: { lines: 100 } } };
  const soon = keepWholeNoteMeasured(view, {
    now: () => t, later: (fn, ms) => timers.push({ fn, at: t + ms }), measure: (v) => measured.push(t), widthChanges: (el, fn) => (widthChanged = fn),
  });
  /** The timers due, in order, the clock set to each. */
  const run = () => { const ts = timers.splice(0).sort((a, b) => a.at - b.at); for (const x of ts) { t = Math.max(t, x.at); x.fn(); } };
  soon();
  assert.deepEqual(timers.map((x) => x.at - t), [300], 'a moment after the note is shown');
  run();
  assert.deepEqual(measured, [300]);
  // Asked twice (a note shown, then another): the last one counts.
  soon(); soon();
  run();
  assert.deepEqual(measured, [300, 600]);
  // Still scrolling when it's due: later, once the scroll has settled.
  soon(); // (due at 900)
  t += 250;
  scrollDOM.emit('scroll'); // (at 850)
  run();
  assert.deepEqual(measured, [300, 600], 'not mid-scroll');
  assert.deepEqual(timers.map((x) => x.at - t), [150], 'once the scroll has settled');
  run();
  assert.deepEqual(measured, [300, 600, 1050]);
  // Too long: not measured (what a fling would find is bounded by what's drawn around the screen anyway).
  view.state.doc.lines = MEASURE_MAX_LINES + 1;
  soon();
  run();
  assert.deepEqual(measured, [300, 600, 1050]);
  view.state.doc.lines = 100;
  // The editor's width changed (the text re-wraps, CodeMirror forgets its heights): again.
  widthChanged();
  run();
  assert.equal(measured.length, 4);

  // Lines arriving beyond the screen: a paste at the end, or an edit from elsewhere; not typing on screen.
  const doc = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const changes = (from, insert) => EditorState.create({ doc }).update({ changes: { from, insert } }).changes;
  const viewport = { from: 0, to: 200 };
  assert.equal(linesArrivedOffScreen(changes(0, 'a\nb\nc'), viewport), false, 'a few lines on screen');
  assert.equal(linesArrivedOffScreen(changes(0, 'x'), viewport), false, 'one line');
  assert.equal(linesArrivedOffScreen(changes(doc.length, 'a\nb\nc'), viewport), true, 'lines past the end of what’s drawn');
  assert.equal(linesArrivedOffScreen(changes(100, 'many\n'.repeat(100)), viewport), true, 'a paste on screen that runs past it');
  assert.equal(linesArrivedOffScreen(changes(doc.length, 'x'), viewport), false, 'a letter off screen: its line was measured already');
});
