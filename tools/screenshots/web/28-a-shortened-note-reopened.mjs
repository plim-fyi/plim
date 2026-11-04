import { mobile, newBlankNote, openNote, setView, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 28: A shortened note, reopened. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow28(shared) {
  const { A, B } = shared;
  // 28. (Here, while B is in the vault: flow 7 forgets it.) A note opens with some of its text in view (#316): its place was kept far down, then
  // the note was shortened elsewhere (another device; a version restored would do the same).
  // Reopened, the place is under the end now: the editor (and Preview) show the text's end, not
  // the empty room after it.
  const inView = (p) => p.evaluate(() => {
    const ed = document.getElementById('editor');
    if (!document.getElementById('reading').hidden) {
      const r = document.getElementById('reading'), box = r.getBoundingClientRect();
      const last = [...r.children].filter((c) => !c.classList.contains('layer')).at(-1).getBoundingClientRect();
      return { end: Math.round(last.bottom - box.top), height: Math.round(box.height) };
    }
    const end = ed.screenTop(ed.noteText().length);
    const height = (document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller')).clientHeight;
    return { end: Math.round(end), height };
  });
  const check = async (why) => {
    const v = await inView(A);
    if (!(v.end > 0 && v.end <= v.height)) throw new Error(`${why}: the note's end should be in view (${JSON.stringify(v)})`);
  };
  for (const view of mobile(A) ? ['edit'] : ['edit', 'preview']) {
    const title = `Shrinks ${view}`;
    await A.bringToFront();
    await newBlankNote(A);
    await A.cdp.send('Input.insertText', { text: `${title}\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a note that will get shorter.`).join('\n')}` });
    await setView(A, view);
    // Far down: near its end.
    await A.evaluate(() => {
      const s = !document.getElementById('reading').hidden ? document.getElementById('reading') : (document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller'));
      s.scrollTop = s.scrollHeight;
    });
    await wait(400);
    await openNote(A, 'Groceries', { edit: false }); // (its place kept on leaving)
    // Elsewhere: all but its first lines go.
    await B.bringToFront();
    await openNote(B, title);
    await B.evaluate(() => { const y = document.getElementById('editor').noteYText(); const keep = y.toString().indexOf('Line 6 '); y.delete(keep, y.length - keep); });
    await until(B, () => document.getElementById('save-status').dataset.state === 'saved', undefined, 20000);
    await A.bringToFront();
    await until(A, (t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), title, 20000);
    await openNote(A, title, { edit: false });
    await until(A, () => !document.getElementById('editor').noteText().includes('Line 6 '), undefined, 20000);
    await wait(500);
    await check(`reopened in ${view}, shortened elsewhere`);
    await setView(A, 'edit');
  }
  // A note this device has no place kept for (written on another device), opened after a long
  // one scrolled far down: at its top, not where the long one was.
  await B.bringToFront();
  await newBlankNote(B);
  await B.cdp.send('Input.insertText', { text: 'Short, from B\n\n- one\n- two' });
  await until(B, () => document.getElementById('save-status').dataset.state === 'saved', undefined, 20000);
  await A.bringToFront();
  await newBlankNote(A);
  await A.cdp.send('Input.insertText', { text: `Long one\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1}.`).join('\n')}` });
  await A.evaluate(() => { const s = document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller'); s.scrollTop = s.scrollHeight; });
  await wait(300);
  await until(A, () => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === 'Short, from B'), undefined, 20000);
  await openNote(A, 'Short, from B');
  await wait(500);
  await check('a note with no place kept, after a long one scrolled down');
}
