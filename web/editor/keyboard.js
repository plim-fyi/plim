// A phone's keyboard and the page (#209, #211, #213, #214, #215, #232, #236): while the keyboard
// is open over the note (or a dialog's field), the page is only as tall as what's above it
// (style.css: data-keyboard), as an app's would be. Otherwise Safari on iPhone scrolls the
// whole page up to show the cursor, taking the note's header and first lines out of sight.
// Shared by the editors: CodeMirror's (editor-ios.js adds its own cursor nudging) and the
// phone's textarea (textarea.js), which the OS scrolls itself.

// As a phone's keyboard opens: the gap kept between the cursor's line and the keyboard, and how
// long a touch is held before it's a long press (iOS selects a word from about half a second).
export const KEYBOARD_GAP = 16;
export const LONG_PRESS_MS = 400;

/** How much of a box a phone's keyboard covers: how far it reaches below the visual viewport. */
export function covered(box, vv = globalThis.visualViewport) {
  return vv ? Math.max(0, Math.round(box.bottom - (vv.offsetTop + vv.height))) : 0;
}

/** The keyboard's height from what the visual viewport lost of the page (a toolbar coming and going is less: 0). */
export function keyboardHeightOf(pageHeight, vv) {
  const h = pageHeight - vv.height * vv.scale;
  return h > 120 ? Math.round(h) : 0;
}

// How tall this device's keyboard was last time, so the page can make room for it as it opens.
const KEYBOARD_KEY = 'tiro-keyboard';
function rememberedKeyboard() {
  try {
    return Number(localStorage.getItem(KEYBOARD_KEY)) || 0;
  } catch {
    return 0;
  }
}
function rememberKeyboard(height) {
  try {
    localStorage.setItem(KEYBOARD_KEY, String(height));
  } catch {}
}

/**
 * The page sized to what's above the keyboard as it opens and closes. `parent` is the editor's
 * box (what the keyboard still covers of it is room after the note's end: --keyboard), `content`
 * the element typed in. `onResize` runs after each fit (CodeMirror keeps its cursor in sight);
 * `onTapFocus(y)` after the page has made room at once for a tap at `y` (CodeMirror moves the
 * tapped line up above the keyboard before Safari can move the page to it).
 */
export function fitPageAboveKeyboard({ parent, content, onResize = () => {}, onTapFocus = () => {} }) {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  // (window.visualViewport read each time: web.mjs plays a keyboard by replacing it.)
  const keyboardHeight = () => keyboardHeightOf(root.clientHeight, window.visualViewport);
  // Where what's visible starts (Safari moves it down a little with the keyboard up): a screen
  // that fills what's visible (Settings on a phone, #338) starts there, not under it.
  const top = () => root.style.setProperty('--visible-top', root.hasAttribute('data-keyboard') ? `${Math.round(window.visualViewport.offsetTop)}px` : '');
  /** The page `height` tall (what's above the keyboard), or the whole window again (null). */
  const fit = (height) => {
    root.toggleAttribute('data-keyboard', height != null);
    root.style.setProperty('--visible-height', height != null ? `${height}px` : '');
    top();
    if (height != null && scrollY) scrollTo(0, 0);
    parent.style.setProperty('--keyboard', `${covered(parent.getBoundingClientRect())}px`);
  };
  // Typing in the note (a link's card included), or in a dialog over the page (#236: Settings'
  // fields; before, Safari scrolled the whole page to them, the dialog's top out of sight).
  const typingHere = () => {
    const a = document.activeElement;
    return parent.contains(a) || Boolean(a?.closest?.('dialog[open]'));
  };
  vv.addEventListener('resize', () => {
    const height = typingHere() ? keyboardHeight() : 0;
    if (height) rememberKeyboard(height);
    fit(height ? Math.round(window.visualViewport.height) : null);
    onResize();
  });
  // (Safari still nudges the page a pixel or so as you type: the editor scrolls, not the page.)
  const unscroll = () => root.hasAttribute('data-keyboard') && scrollY && scrollTo(0, 0);
  vv.addEventListener('scroll', unscroll);
  vv.addEventListener('scroll', () => top());
  addEventListener('scroll', unscroll);
  // Tapping into the note: the page makes room for the keyboard at once (as tall as it was last
  // time), and the keyboard slides up into it (#213). Waiting until it's up, the note jumped:
  // Safari scrolled the page to show the cursor, then the page shrank and the editor scrolled
  // instead. A long press isn't a tap (#215): it selects a word, brings no keyboard, and the text
  // has to stay where it is under the finger meanwhile. (It focuses the editor before the finger lifts.)
  let touch = null; // { start, end, y }
  // Typing (#232, style.css: #editor.typing), until the next tap or click.
  content.addEventListener('beforeinput', () => parent.classList.add('typing'));
  for (const type of ['touchstart', 'mousedown']) content.addEventListener(type, () => parent.classList.remove('typing'), { passive: true });
  content.addEventListener('touchstart', (e) => (touch = { start: e.timeStamp, end: null, y: e.touches[0]?.clientY }), { passive: true });
  content.addEventListener('touchend', (e) => touch && Object.assign(touch, { end: e.timeStamp, y: e.changedTouches[0]?.clientY }), { passive: true });
  content.addEventListener('focus', () => {
    const expected = rememberedKeyboard();
    const t = touch;
    touch = null;
    const longPress = t && (t.end == null || t.end - t.start > LONG_PRESS_MS);
    if (longPress || !expected || root.hasAttribute('data-keyboard') || !matchMedia('(pointer: coarse)').matches) return;
    const scrolled = content.scrollTop; // (a textarea's own scroll: Safari resets it to the top as the page shrinks around it)
    fit(root.clientHeight - expected);
    if (content.scrollTop !== scrolled) content.scrollTop = scrolled;
    if (t?.y != null) onTapFocus(t.y);
    onResize();
    // No keyboard after all (a hardware one): the whole window again, and no more guessing.
    setTimeout(() => {
      if (keyboardHeight()) return;
      fit(null);
      rememberKeyboard(0);
    }, 1500);
  });
}
