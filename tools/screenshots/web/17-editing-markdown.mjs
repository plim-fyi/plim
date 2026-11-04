import { backToList, browser, closeSettings, mobile, newBlankNote, openSettings, s, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 17: Editing markdown. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow17(shared) {
  const { A } = shared;
  if (mobile(A)) return; // (a phone edits in a textarea, #290: its typing is checked on the simulator, ios.mjs)
  // 17. Editing markdown (#138): the editor shows the note's markdown as it is (the page is the
  // formatted view, flow 21); typing knows it (lists, Ctrl+B, Ctrl+Enter); a link opens with
  // Ctrl+click and shows a card where it goes, to open, copy or edit; room at the bottom (#200).
  {
    const md = '# Trip to Lisbon\n## Before we go\n- [x] Book the flights\n- [ ] Reserve the **tram 28** tour\n- [ ] Pack the _good_ camera\n'
      + '## Plan\nDay one is **Alfama** and the castle. Day two, a ~~train~~ ferry to Cacilhas.\n> Pastéis de Belém open at 8: go early.\n'
      + 'Notes from [the guidebook](https://example.com), and the wifi: `lisboa2026`\n---\n- Feira da Ladra (Tue, Sat)\n- LX Factory';
    const title = 'Trip to Lisbon';
    const editorText = (p) => p.evaluate(() => document.getElementById('editor').noteText());
    const cursorAt = (p, text) => p.evaluate((t) => {
      const v = document.querySelector('#editor .cm-content').cmTile.view;
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf(t) + 4 } });
    }, text);
    /** Where `text` is drawn, as a box on screen (the link's text, to click in). */
    const boxOf = (p, text) => p.evaluate((t) => {
      const v = document.querySelector('#editor .cm-content').cmTile.view;
      const from = v.state.doc.toString().indexOf(t);
      const a = v.coordsAtPos(from), b = v.coordsAtPos(from + t.length);
      return { x: a.left, y: a.top, width: b.right - a.left, height: a.bottom - a.top };
    }, text);
    const ctrl = async (p, key) => {
      await p.keyboard.down('Control');
      await p.keyboard.press(key);
      await p.keyboard.up('Control');
    };

    await A.bringToFront();
    await backToList(A);
    await newBlankNote(A);
    await A.cdp.send('Input.insertText', { text: md });
    // Listed by its text, without the "#" (title.js).
    await until(A, (t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), title);
    await cursorAt(A, 'tram 28');
    await wait(300);
    // The markdown as it is: every line its text, nothing drawn in a mark's place.
    const seen = await A.evaluate(() => ({
      first: document.querySelector('#editor .cm-line')?.textContent,
      drawn: document.querySelectorAll('#editor .cm-content [class^="md-"], #editor .cm-content .cm-widgetBuffer').length,
    }));
    if (seen.first !== '# Trip to Lisbon' || seen.drawn) throw new Error(`the editor should show the markdown as it is: ${JSON.stringify(seen)}`);
    await s(A, '17-edit-1-markdown');
    // A selection of whole lines stays in the text column, not out to the window's edges.
    await A.evaluate(() => {
      const v = document.querySelector('#editor .cm-content').cmTile.view;
      v.focus();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.line(4).to } });
    });
    await wait(300); // (the selection is drawn on the next frame)
    const spill = await A.evaluate(() => {
      const line = document.querySelector('#editor .cm-line').getBoundingClientRect();
      return [...document.querySelectorAll('#editor .cm-selectionBackground')].map((e) => e.getBoundingClientRect())
        .filter((r) => r.width && (r.left < line.left - 1 || r.right > line.right + 1)).length;
    });
    if (spill) throw new Error(`the selection spills out of the text column (${spill} pieces)`);
    // A tick (Ctrl+Enter on the task's line) is one character of the text; Ctrl+Z takes it back.
    const ticks = () => document.getElementById('editor').noteText().split('- [x]').length - 1;
    await cursorAt(A, 'Reserve the');
    await ctrl(A, 'Enter');
    await until(A, () => document.getElementById('editor').noteText().split('- [x]').length - 1 === 2, undefined, 5000)
      .catch(async () => { throw new Error(`a tick: ${await editorText(A)}`); });
    await ctrl(A, 'z');
    await wait(300);
    if ((await A.evaluate(ticks)) !== 1) throw new Error(`Ctrl+Z after a tick: ${await editorText(A)}`);

    // Settings → Editor: what markdown is, and the shortcuts (the same on every device).
    await openSettings(A, 'editor');
    await s(A, '17-edit-2-settings');
    await closeSettings(A);
    if (!(await editorText(A)).startsWith('# Trip to Lisbon\n## Before we go')) throw new Error(`the text changed: ${await editorText(A)}`);

    // Typing: Enter continues a list, and ends it on an empty item; Ctrl+B bolds; Ctrl+Enter ticks a task.
    await A.evaluate(() => {
      const v = document.querySelector('#editor .cm-content').cmTile.view;
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.length } });
    });
    await A.keyboard.press('Enter');
    await A.keyboard.type('Time Out Market');
    await A.keyboard.press('Enter');
    await A.keyboard.press('Enter');
    await A.keyboard.type('Then home');
    await A.keyboard.down('Shift');
    for (let i = 0; i < 4; i++) await A.keyboard.press('ArrowLeft');
    await A.keyboard.up('Shift');
    await ctrl(A, 'b');
    if (!(await editorText(A)).endsWith('- LX Factory\n- Time Out Market\nThen **home**')) throw new Error(`typing a list: ${JSON.stringify(await editorText(A))}`);
    await cursorAt(A, 'Pack the');
    await ctrl(A, 'Enter');
    if (!(await editorText(A)).includes('- [x] Pack the')) throw new Error('Ctrl+Enter should tick the task');
    // Links: Ctrl+click opens one in a new tab (a plain click places the cursor, and shows the link card).
    await cursorAt(A, 'Alfama');
    await wait(200);
    const box = await boxOf(A, 'the guidebook');
    const opened = browser.waitForTarget((t) => t.url().startsWith('https://example.com'), { timeout: 8000 }).then((t) => t, () => null);
    await A.keyboard.down('Control');
    await A.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await A.keyboard.up('Control');
    const tab = await opened;
    if (!tab) throw new Error('Ctrl+click on a link should open it');
    await (await tab.page())?.close();
    // A plain click (or tap) puts the cursor in the link, and a card shows where it goes, to open or copy (#149).
    await cursorAt(A, 'Alfama');
    await wait(200);
    const again = await boxOf(A, 'the guidebook');
    await A.mouse.click(again.x + 8, again.y + again.height / 2);
    await until(A, () => document.querySelector('.md-linkcard-url')?.textContent === 'https://example.com', undefined, 5000)
      .catch(() => { throw new Error("a click in a link should show its card, with the link's address"); });
    // The card stands out from the note, by its ink edge (#181, #560: no shadows), and the link it's
    // about is highlighted meanwhile.
    {
      const seen = await A.evaluate(() => ({
        active: document.querySelector('#editor .md-link-active')?.textContent,
        card: getComputedStyle(document.querySelector('#editor .cm-tooltip.md-linkcard')).borderTopColor,
        note: getComputedStyle(document.querySelector('.editor-pane')).backgroundColor,
      }));
      if (seen.active !== 'the guidebook' || seen.card === seen.note) throw new Error(`the link card should stand out, its link highlighted: ${JSON.stringify(seen)}`);
    }
    await s(A, '17-edit-3-link');
    const fromCard = browser.waitForTarget((t) => t.url().startsWith('https://example.com'), { timeout: 8000 }).then((t) => t, () => null);
    await A.evaluate(() => [...document.querySelectorAll('.md-linkcard button')].find((b) => b.textContent.startsWith('Open')).click());
    const tab2 = await fromCard;
    if (!tab2) throw new Error("the link card's Open should open the link");
    await (await tab2.page())?.close();
    // Editing a link (#194): the card's Edit holds its text and address; Save writes the markdown.
    await A.bringToFront();
    const g = await boxOf(A, 'the guidebook');
    await A.mouse.click(g.x + 8, g.y + g.height / 2);
    await until(A, () => document.querySelector('.md-linkcard-url'), undefined, 5000);
    await A.evaluate(() => [...document.querySelectorAll('.md-linkcard button')].find((b) => b.textContent === 'Edit').click());
    await until(A, () => document.querySelector('.md-linkcard.editing input[name="address"]'), undefined, 3000)
      .catch(() => { throw new Error("the link card's Edit should show the link's text and address"); });
    const fields = await A.$$eval('.md-linkcard.editing input', (e) => e.map((i) => i.value));
    if (fields[0] !== 'the guidebook' || fields[1] !== 'https://example.com') throw new Error(`the Edit form: ${fields}`);
    await s(A, '17-edit-4-link-edit');
    await A.click('.md-linkcard.editing input[name="address"]', { count: 3 });
    await A.keyboard.type('https://example.org/lisbon');
    await A.keyboard.press('Enter');
    await until(A, () => document.getElementById('editor').noteText().includes('[the guidebook](https://example.org/lisbon)'), undefined, 5000)
      .catch(async () => { throw new Error(`Save should write the link's markdown: ${await A.evaluate(() => document.getElementById('editor').noteText())}`); });
    if (await A.$('.md-linkcard')) throw new Error('the card should close once the link is saved');
    // Typing in a link's text: the card keeps out of the way; it's back once the cursor moves.
    const g2 = await boxOf(A, 'the guidebook');
    await A.mouse.click(g2.x + 8, g2.y + g2.height / 2);
    await until(A, () => document.querySelector('.md-linkcard'), undefined, 5000);
    await A.keyboard.type('x');
    await wait(200);
    if (await A.$('.md-linkcard')) throw new Error('typing in a link should put its card away');
    await A.keyboard.press('Backspace');
    await A.keyboard.press('ArrowLeft');
    await until(A, () => document.querySelector('.md-linkcard'), undefined, 3000)
      .catch(() => { throw new Error('the card should come back when the cursor moves in the link'); });
    // Room at the bottom (#200): after the last line, and below the line you're typing on.
    {
      const room = await A.evaluate(async () => {
        const view = document.querySelector('#editor .cm-content').cmTile.view;
        const added = '\n' + Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join('\n');
        const start = view.state.doc.length;
        view.focus();
        view.dispatch({ changes: { from: start, insert: added }, selection: { anchor: start + added.length }, scrollIntoView: true, userEvent: 'input.type' });
        const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))));
        await settle();
        const box = view.scrollDOM.getBoundingClientRect();
        const caret = () => view.coordsAtPos(view.state.selection.main.head).bottom;
        const out = { endRoom: parseFloat(getComputedStyle(view.contentDOM).paddingBottom), window: innerHeight, below: box.bottom - caret(), height: box.height };
        view.dispatch({ changes: { from: start, to: view.state.doc.length } });
        return out;
      });
      const ok = room.endRoom >= room.window * 0.4 - 1 && room.below >= room.height * 0.25 - 6;
      if (!ok) throw new Error(`room at the bottom: ${JSON.stringify(room)}`);
    }
    await backToList(A);
  }
}
