import { backToList, mobile, newBlankNote, SAMPLE } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 20: A long note, measured whole. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow20(shared) {
  const { A } = shared;
  // 20. A long note is measured whole once it's open (#220, phones): scrolled through from its
  // end to its top, its height doesn't change, so nothing is left for a fling to find. (The
  // measure is CodeMirror's print mode, not public API: this is what says it still works.)
  // (A phone edits in a textarea since #290, which draws everything: nothing to measure. The
  // check would need a touch device running CodeMirror, a tablet; none in these profiles.)
  if (mobile(A) && !(await A.$('#editor textarea')) && false) {
    await A.bringToFront();
    await backToList(A);
    await newBlankNote(A);
    await A.cdp.send('Input.insertText', { text: [SAMPLE, SAMPLE, SAMPLE].join('\n\n') }); // (the cursor at its end: the middle never drawn)
    await wait(1800); // (measured a second after lines arrive off-screen)
    const height = () => A.$eval('#editor .cm-scroller', (e) => e.scrollHeight);
    const before = await height();
    // To the top, a screen at a time, each drawn and measured.
    await A.evaluate(() => new Promise((done) => {
      const s = document.querySelector('#editor .cm-scroller');
      const step = () => { s.scrollTop -= 400; if (s.scrollTop > 0) requestAnimationFrame(() => requestAnimationFrame(step)); else done(); };
      step();
    }));
    await wait(300);
    const after = await height();
    if (after !== before) throw new Error(`a long note's height changed as it was scrolled through: ${before} → ${after}px (#220: not measured whole)`);
    if (before < 15000) throw new Error(`the long note is only ${before}px tall`);
  }
}
