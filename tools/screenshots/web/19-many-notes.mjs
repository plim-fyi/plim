import { backToList, mobile, newBlankNote, s, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 19: Many notes. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow19(shared) {
  const { A } = shared;
  // 19. Many notes (desktop): the 30 most recent, then "Show all"; New note stays at the top
  // while Recently deleted and the list scroll under it.
  if (!mobile(A)) {
    await A.bringToFront();
    await backToList(A);
    const count = () => A.evaluate(() => document.querySelectorAll('#note-list li[data-id]').length);
    for (let i = (await count()) + 1; i <= 34; i++) {
      await newBlankNote(A);
      await A.cdp.send('Input.insertText', { text: `Note ${i}` });
      await wait(150);
    }
    await until(A, () => !document.getElementById('notes-more').hidden, undefined, 15000)
      .catch(() => { throw new Error('more than 30 notes: "Show all" should show'); });
    const shown = await count();
    if (shown > 31) throw new Error(`more than 30 notes: ${shown} listed before "Show all"`);
    if (!/^Show all \d+ notes$/.test(await A.$eval('#notes-more', (e) => e.textContent))) throw new Error('"Show all" should say how many');
    // The open note's title is in its bar, as typed.
    const barTitle = await A.$eval('#note-title', (e) => e.textContent);
    if (barTitle !== 'Note 34') throw new Error(`the bar should show the open note's title: "${barTitle}"`);
    // Scrolled down: New note stays where it was, Recently deleted goes up out of view, and the
    // list fades under New note (as a note's text does under its bar); the scroll bar is the thin one.
    const scrolled = await A.evaluate(async () => {
      const box = document.getElementById('sidebar-scroll');
      const before = document.getElementById('btn-new').getBoundingClientRect().top;
      const fadeAtTop = getComputedStyle(box).maskImage;
      box.scrollTop = box.scrollHeight;
      await new Promise((r) => setTimeout(r, 100)); // (the scroll event)
      return {
        newStays: document.getElementById('btn-new').getBoundingClientRect().top === before && box.scrollTop > 0,
        trashAway: document.getElementById('btn-trash').getBoundingClientRect().bottom <= box.getBoundingClientRect().top,
        bar: getComputedStyle(box).scrollbarWidth,
        fadeAtTop, fade: getComputedStyle(box).maskImage,
      };
    });
    if (!scrolled.newStays || !scrolled.trashAway || scrolled.bar !== 'thin' || scrolled.fadeAtTop !== 'none' || !scrolled.fade.includes('gradient')) {
      throw new Error(`the sidebar: ${JSON.stringify(scrolled)}`);
    }
    await s(A, '03-notes-6-show-all');
    await A.click('#notes-more');
    await until(A, () => document.getElementById('notes-more').hidden, undefined, 5000);
    if ((await count()) < 34) throw new Error(`"Show all" should list every note (${await count()})`);
    // No line under the note's bar and no shadow; while scrolled, the text fades as it reaches it.
    await A.evaluate(() => {
      const view = document.querySelector('#editor .cm-content').cmTile.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n' + Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note`).join('\n') } });
    });
    const head = (y) => A.evaluate(async (y) => {
      const sc = document.querySelector('#editor .cm-scroller');
      sc.scrollTop = y;
      await new Promise((r) => setTimeout(r, 400));
      const h = getComputedStyle(document.querySelector('.editor-head'));
      return { line: h.borderBottomWidth, shadow: h.boxShadow, fade: getComputedStyle(sc).maskImage, scrolled: sc.scrollTop };
    }, y);
    const top = await head(0);
    const down = await head(400);
    if (top.line !== '0px' || top.shadow !== 'none' || top.fade !== 'none' || down.scrolled < 400 || down.shadow !== 'none' || !down.fade.includes('gradient')) {
      throw new Error(`the note's bar: no line or shadow; the text fades only once scrolled: ${JSON.stringify({ top, down })}`);
    }
    await s(A, '03-notes-7-scrolled');
    await head(0);

    // Hiding the sidebar: its button hides it (and is kept in this browser); resting at the
    // window's left edge brings it in over the note, picking a note sends it away; Ctrl+\ shows it again.
    const side = () => A.evaluate(() => {
      const r = document.querySelector('.sidebar').getBoundingClientRect();
      return { hidden: document.documentElement.dataset.sidebar === 'hidden', visible: getComputedStyle(document.querySelector('.sidebar')).visibility === 'visible' && r.right > 0 && r.left >= 0,
        noteLeft: Math.round(document.querySelector('.editor-pane').getBoundingClientRect().left), show: document.getElementById('sidebar-show').getClientRects().length > 0,
        kept: localStorage.getItem('tiro-sidebar') };
    });
    // The sidebar's icon column (New note's, Recently deleted's): shown, the logo's on it (#201).
    const centre = (sel) => A.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const column = (await centre('#btn-new .icon')).x;
    if (Math.abs((await centre('.sidebar-head .logo')).x - column) > 1) throw new Error('the logo should sit in the sidebar\'s icon column');
    await A.mouse.move(700, 400);
    await A.click('#sidebar-toggle');
    await wait(300);
    const hid = await side();
    // Hidden, its button's icon is on that column, at the top left.
    const hiddenAt = await centre('#sidebar-show .icon');
    if (Math.abs(hiddenAt.x - column) > 1) throw new Error(`hidden, the sidebar's icon should sit in its icon column: ${hiddenAt.x} vs ${column}`);
    if (!hid.hidden || hid.visible || hid.noteLeft > 2 || !hid.show || hid.kept !== 'hidden') throw new Error(`the sidebar should hide: ${JSON.stringify(hid)}`);
    // Its button in the note's bar shows no hand cursor: pointing at it brings the sidebar over it at once.
    if ((await A.$eval('#sidebar-show', (b) => getComputedStyle(b).cursor)) !== 'default') throw new Error('the button that shows the sidebar has a hand cursor (it flashes)');
    // Brushing past the edge on the way elsewhere doesn't open it…
    await A.mouse.move(3, 400);
    await wait(40);
    await A.mouse.move(700, 400);
    await wait(400);
    if ((await side()).visible) throw new Error('brushing past the left edge opened the sidebar');
    // …resting there does: it fades in where it sits, not moving at all.
    await A.evaluate(() => {
      window.peekFrames = [];
      const end = performance.now() + 700;
      const tick = () => {
        const el = document.querySelector('.sidebar');
        window.peekFrames.push({ left: Math.round(el.getBoundingClientRect().left), opacity: Number(getComputedStyle(el).opacity) });
        if (performance.now() < end) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await A.mouse.move(3, 400);
    await until(A, () => document.querySelector('.notes').classList.contains('sidebar-peek'), undefined, 3000)
      .catch(() => { throw new Error('resting at the left edge should show the sidebar'); });
    await wait(700);
    {
      const frames = await A.evaluate(() => window.peekFrames);
      const shown = frames.filter((f) => f.opacity > 0);
      const lefts = shown.map((f) => f.left);
      if (!shown.length || Math.min(...lefts) < 0 || Math.max(...lefts) !== Math.min(...lefts) || shown.at(-1).opacity !== 1) {
        throw new Error(`the sidebar should fade in where it sits: ${JSON.stringify(frames.slice(0, 40))}`);
      }
    }
    if (!(await side()).visible) throw new Error('the peeking sidebar should show');
    // Peeking: no logo, its button first, exactly where the note bar's is (it doesn't move).
    {
      const peekAt = await centre('#sidebar-toggle .icon');
      const logo = await A.$eval('.sidebar-head .brand', (e) => e.getClientRects().length > 0);
      if (logo || Math.abs(peekAt.x - hiddenAt.x) > 1 || Math.abs(peekAt.y - hiddenAt.y) > 1) {
        throw new Error(`peeking, the sidebar's icon should be where it was in the note bar, with no logo: ${JSON.stringify({ peekAt, hiddenAt, logo })}`);
      }
    }
    await s(A, '03-notes-8-sidebar-peek');
    // A note's menu (right-click), peeking: over the sidebar, not behind it; the sidebar stays meanwhile.
    {
      const rowBtn = await A.$('#note-list li:nth-child(2) > button');
      await rowBtn.evaluate((b) => b.scrollIntoView({ block: 'center' })); // (the list may be scrolled: the row in sight)
      await wait(150);
      const row = await rowBtn.boundingBox();
      await A.mouse.click(row.x + row.width / 2, row.y + row.height / 2, { button: 'right' });
      await until(A, () => !document.getElementById('note-menu').hidden, undefined, 3000)
        .catch(async () => { throw new Error(`right-click on a row, peeking: its menu should open: ${JSON.stringify(await A.evaluate((y) => ({ peek: document.querySelector('.notes').classList.contains('sidebar-peek'), at: document.elementFromPoint(150, y)?.outerHTML.slice(0, 120) }), row.y + row.height / 2))}`); });
      const top = await A.evaluate(() => {
        const r = document.getElementById('note-menu').getBoundingClientRect();
        return Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#note-menu'));
      });
      if (!top) throw new Error('a note\'s menu, with the sidebar peeking: it should be over the sidebar, not behind it');
      await A.keyboard.press('Escape');
      await until(A, () => document.getElementById('note-menu').hidden);
      if (!(await side()).visible) throw new Error('the peeking sidebar should stay while its menu was open');
    }
    const other = await A.$eval('#note-list li:nth-child(2) > button .title', (e) => e.textContent);
    await A.click('#note-list li:nth-child(2) > button');
    await until(A, (t) => document.getElementById('note-title').textContent === t, other, 5000);
    // As it fades away it lets the pointer through at once (no hand cursor over its buttons meanwhile).
    if ((await A.$eval('.sidebar', (e) => getComputedStyle(e).pointerEvents)) !== 'none') throw new Error('the sidebar still takes the pointer as it fades away');
    await wait(400);
    if ((await side()).visible) throw new Error('picking a note should slide the peeking sidebar away');
    await A.keyboard.down('Control');
    await A.keyboard.press('Backslash');
    await A.keyboard.up('Control');
    await wait(300);
    const back = await side();
    if (back.hidden || !back.visible || back.show || back.kept) throw new Error(`Ctrl+\\ should show the sidebar again: ${JSON.stringify(back)}`);
  }
}
