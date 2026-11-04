import { backToList, mobile, newBlankNote, shot, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 25: Type / for a menu. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow25(shared) {
  const { A } = shared;
  // 25. Type / for a menu (#311): a `/` typed at a line's start or after a space offers Today,
  // Now, Yesterday, Date and time; picked, the `/` (and what's typed after it) becomes the text,
  // one undo step. Typed anywhere else, in code, pasted, or typed past, it's only a `/`.
  await A.bringToFront();
  const phone = mobile(A);
  const menu = () => A.evaluate(() => {
    const m = document.querySelector('#editor .slash-menu');
    const field = document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-content');
    return {
      open: Boolean(m && !m.hidden),
      options: m ? [...m.querySelectorAll('[role=option]')].map((o) => o.querySelector('.slash-label').textContent) : [],
      active: m?.querySelector('[aria-selected=true] .slash-label')?.textContent ?? null,
      expanded: field.getAttribute('aria-expanded'), owns: field.getAttribute('aria-activedescendant'),
    };
  });
  const text = () => A.evaluate(() => document.getElementById('editor').noteText());
  const opened = async (why) => until(A, () => { const m = document.querySelector('#editor .slash-menu'); return m && !m.hidden; }, undefined, 3000)
    .catch(async () => { throw new Error(`${why}: the / menu should open (${JSON.stringify(await menu())}, ${JSON.stringify(await text())})`); });
  const closed = async (why) => until(A, () => document.querySelector('#editor .slash-menu')?.hidden ?? true, undefined, 3000)
    .catch(async () => { throw new Error(`${why}: the / menu should close (${JSON.stringify(await menu())})`); });
  const stays = async (why) => { await wait(250); if ((await menu()).open) throw new Error(`${why}: no menu (${JSON.stringify(await text())})`); };
  const today = await A.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const yesterday = await A.evaluate(() => { const n = new Date(); const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1, 12); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const ends = async (want, why) => {
    const t = await text();
    if (!t.endsWith(want)) throw new Error(`${why}: the note should end ${JSON.stringify(want)}: ${JSON.stringify(t.slice(-60))} (${JSON.stringify(await menu())}, focus in ${await A.evaluate(() => document.activeElement?.className)})`);
  };

  await backToList(A);
  await newBlankNote(A);
  await A.cdp.send('Input.insertText', { text: '# Standup\n\n## ' });
  // A bare /: all four, the first chosen, the editor saying so (for a screen reader).
  await A.keyboard.type('/');
  await opened('a / after a heading’s marks');
  const m = await menu();
  if (m.options.join() !== 'Today,Now,Yesterday,Date and time' || m.active !== 'Today' || m.expanded !== 'true' || !m.owns) throw new Error(`the menu: ${JSON.stringify(m)}`);
  await shot(A, '25-slash-1-menu', { focused: true });
  if (phone) {
    // A phone: Return after a bare / is a new line (the menu goes); a tap picks, and the keyboard stays (the focus too).
    await A.keyboard.press('Enter');
    await closed('Return after a bare /');
    await ends('/\n', 'Return after a bare /');
    await A.keyboard.press('Backspace');
    await A.keyboard.press('Backspace');
    await A.keyboard.type('/');
    await opened('a / typed again');
    await A.tap('#editor .slash-option:nth-child(2)');
    await closed('Now tapped');
    if (!(await A.evaluate(() => document.activeElement === document.querySelector('#editor textarea')))) throw new Error('a tap in the menu should leave the focus (and the keyboard) in the note');
    if (!/## \d{1,2}:\d\d [AP]M$/.test(await text())) throw new Error(`Now tapped: ${JSON.stringify((await text()).slice(-30))}`);
    // Return once a filter is typed: picks.
    await A.keyboard.type(' /tod');
    await opened('/tod');
    if ((await menu()).options.join() !== 'Today') throw new Error(`/tod: ${JSON.stringify(await menu())}`);
    await A.keyboard.press('Enter');
    await closed('Return after /tod');
    await ends(` ${today}`, 'Return after /tod');
  } else {
    // A computer: Enter on a bare / picks (as Notion does); ↓ ↓ Enter, Yesterday; Tab picks too.
    await A.keyboard.press('Enter');
    await closed('Enter after a bare /');
    await ends(`## ${today}`, 'Enter after a bare /');
    await A.keyboard.type(' /');
    await opened('a / after a space');
    await A.keyboard.press('ArrowDown');
    await A.keyboard.press('ArrowDown');
    if ((await menu()).active !== 'Yesterday') throw new Error(`↓ ↓: ${JSON.stringify(await menu())}`);
    await A.keyboard.press('Enter');
    await ends(`${today} ${yesterday}`, '↓ ↓ Enter');
    await A.keyboard.type(' /date and');
    await opened('/date and');
    if ((await menu()).options.join() !== 'Date and time') throw new Error(`/date and: ${JSON.stringify(await menu())}`);
    await A.keyboard.press('Tab');
    await closed('Tab');
    if (!/ \d{4}-\d\d-\d\d \d{1,2}:\d\d [AP]M$/.test(await text())) throw new Error(`Tab picks Date and time: ${JSON.stringify((await text()).slice(-40))}`);
    // One undo step: Ctrl+Z brings back what was typed.
    await A.keyboard.down('Control');
    await A.keyboard.press('z');
    await A.keyboard.up('Control');
    await until(A, () => document.getElementById('editor').noteText().endsWith(' /date and'), undefined, 3000)
      .catch(async () => { throw new Error(`Ctrl+Z after a pick should bring back "/date and": ${JSON.stringify((await text()).slice(-40))}`); });
    for (let i = 0; i < ' /date and'.length; i++) await A.keyboard.press('Backspace');
  }
  // Typed past (nothing matches), Escape, backspacing over the /: closed, the text as typed.
  await A.keyboard.type('\n/etc');
  await closed('/etc');
  await ends('\n/etc', '/etc');
  await A.keyboard.type(' /');
  await opened('a / after /etc');
  await A.keyboard.press('Escape');
  await closed('Escape');
  await A.keyboard.type('t');
  await stays('after Escape, more typed');
  await A.keyboard.type(' /');
  await opened('a / again');
  await A.keyboard.press('Backspace');
  await closed('the / backspaced');
  // Not a command: after a character, in code, pasted.
  await A.keyboard.type('and/or 1/2');
  await stays('a / after a character');
  await A.cdp.send('Input.insertText', { text: '\n```\n' });
  await A.keyboard.type('/');
  await stays('a / in a fenced block');
  await A.cdp.send('Input.insertText', { text: 'x\n```\n`a ' });
  await A.keyboard.type('/');
  await stays('a / in inline code');
  await A.cdp.send('Input.insertText', { text: '`\n' });
  await A.evaluate(() => { // (a paste, as the browser sends one: the textarea's input, CodeMirror's paste event)
    const ta = document.querySelector('#editor textarea');
    if (ta) {
      ta.setRangeText('/', ta.selectionStart, ta.selectionEnd, 'end');
      return ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    }
    const data = new DataTransfer();
    data.setData('text/plain', '/');
    document.querySelector('#editor .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await ends('`\n/', 'pasted');
  await stays('a / pasted');
  // Someone else's edit above, the menu open: the / followed; the pick lands where it is.
  await A.keyboard.press('Enter');
  await A.keyboard.type('/to');
  await opened('/to');
  await A.evaluate(() => document.getElementById('editor').noteYText().insert(0, 'Moved down by someone\n'));
  await wait(100);
  if (!(await menu()).open) throw new Error('an edit above shouldn’t close the menu');
  if (phone) await A.tap('#editor .slash-option:first-child');
  else await A.keyboard.press('Enter');
  await closed('Today picked after an edit above');
  const t = await text();
  if (!t.startsWith('Moved down by someone\n# Standup') || !t.endsWith(`\n${today}`)) throw new Error(`the pick after an edit above: ${JSON.stringify(t)}`);
  // The title isn't taken from a command being typed: "Plan /to" is "Plan" while the menu's open.
  const title = () => A.evaluate(() => {
    const ytext = document.getElementById('editor').noteYText();
    const row = [...document.querySelectorAll('#note-list li[data-id]')].find((li) => li.classList.contains('active') || li.getAttribute('aria-current'));
    return { row: row?.querySelector('.title')?.textContent ?? null, text: ytext.toString().split('\n')[0] };
  });
  await backToList(A);
  await newBlankNote(A);
  await A.keyboard.type('Plan /to');
  await opened('/to on the first line');
  await wait(300);
  const listedTitle = () => A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] .title')].map((e) => e.textContent));
  let titles = await listedTitle();
  if (titles.some((x) => x.includes('/to')) || !titles.includes('Plan')) throw new Error(`while /to is typed, the title is "Plan": ${titles.slice(0, 4)} (${JSON.stringify(await title())})`);
  await A.keyboard.press('Escape');
  await closed('Escape on the first line');
  await until(A, () => [...document.querySelectorAll('#note-list li[data-id] .title')].some((e) => e.textContent === 'Plan /to'), undefined, 3000)
    .catch(async () => { throw new Error(`the menu gone, the title is the line as it is: ${(await listedTitle()).slice(0, 4)}`); });
  await backToList(A);
}
