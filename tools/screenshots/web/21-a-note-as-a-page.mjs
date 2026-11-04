import { backToList, EDITOR_READY, mobile, newBlankNote, openNote, s, setView, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 21: A note as a page. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow21(shared) {
  const { A } = shared;
  // 21. Edit and Preview (#302): a note opens in the editor (on a phone, as a page: below); Preview (a phone's
  // toggle, a computer's Edit / Preview) shows the page: rendered, a real table, links in a tab
  // of their own. Switching keeps your place, measured to 2 px all through a long note, both
  // ways: the line at the top of the view, or the cursor's line while typing. A tap on the page
  // stays there, its text to select (#538): Edit is the bar's. A task's box toggles it;
  // others' edits redraw the page without moving what's on screen; a computer keeps Preview on.
  await A.bringToFront();
  await backToList(A);
  await newBlankNote(A);
  const md = '# Packing\n\nA paragraph to tap.\n\n- [ ] Rain jacket\n- [x] Socks\n\n| Key | Action |\n|---|---|\n| j/k or arrows | Move through the chat list |\n\nSee https://example.org/docs';
  await A.cdp.send('Input.insertText', { text: md });
  await wait(300);
  const shown = (id) => A.evaluate((i) => !document.getElementById(i).hidden, id);
  if (await shown('reading')) throw new Error('a new note should open in the editor');
  if (!(await shown(mobile(A) ? 'note-preview' : 'note-mode'))) throw new Error('the bar should have Preview');
  await setView(A, 'preview');
  const page = await A.evaluate(() => {
    const r = document.getElementById('reading');
    return { h1: r.querySelector('h1')?.textContent, rows: r.querySelectorAll('table tr').length, boxes: [...r.querySelectorAll('input[type=checkbox]')].map((b) => b.checked),
      link: r.querySelector('a')?.target === '_blank' && /noopener/.test(r.querySelector('a')?.rel),
      // (Preview on: a computer's Edit / Preview says so; a phone's one button offers Edit, #538.)
      pressed: document.querySelector('#note-preview[aria-label="Edit"]:not([hidden]), #note-mode [data-mode="preview"][aria-checked="true"]') !== null };
  });
  if (page.h1 !== 'Packing' || page.rows !== 2 || String(page.boxes) !== 'false,true' || !page.link || !page.pressed) throw new Error(`the page: ${JSON.stringify(page)}`);
  await s(A, '21-page-1-rendered');
  // The page's blocks line up: a heading's left edge is a paragraph's (not a wider box of its own, #291).
  const edges = await A.evaluate(() => [...document.querySelectorAll('#reading h1, #reading p, #reading ul, #reading table')].map((e) => Math.round(e.getBoundingClientRect().left)));
  if (new Set(edges).size !== 1) throw new Error(`the page's blocks don't line up on the left: ${edges}`);

  // Probes, in the page: where a word is drawn, from the top of the view showing, and putting it at a height.
  const probes = () => A.evaluate(() => {
    const view = () => (document.getElementById('reading').hidden ? 'edit' : 'preview');
    const editorTop = (m) => {
      const e = document.getElementById('editor');
      const at = e.noteText().indexOf(m);
      return at < 0 ? null : e.screenTop(at);
    };
    const pageTop = (m) => {
      const r = document.getElementById('reading');
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(m);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        return range.getClientRects()[0].top - r.getBoundingClientRect().top;
      }
      return null;
    };
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scroller = () => (view() === 'edit' ? document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller') : document.getElementById('reading'));
    window.probe = {
      view,
      top: (m) => (view() === 'edit' ? editorTop(m) : pageTop(m)),
      // `m` put `y` from the top of the view (lines not drawn yet: first roughly, then exactly).
      async place(m, y) {
        for (let i = 0; i < 8; i++) {
          const t = window.probe.top(m);
          const el = scroller();
          if (t == null) {
            const e = document.getElementById('editor');
            el.scrollTop = el.scrollHeight * (e.noteText().indexOf(m) / e.noteText().length);
          } else if (Math.abs(t - y) < 0.5) return true;
          else el.scrollTop += t - y;
          await frames();
        }
        return Math.abs(window.probe.top(m) - y) < 1;
      },
    };
  });
  await probes();

  // A click on a word stays on the page (#538): its text to select, not the editor; a double
  // click selects the word, still the page. (Edit is the bar's, and keeps the place: check, below.)
  const word = await A.evaluate(() => {
    const r = document.getElementById('reading');
    const n = [...r.querySelectorAll('p')].find((p) => p.textContent.includes('tap')).firstChild;
    const i = n.data.indexOf('tap');
    const range = document.createRange();
    range.setStart(n, i + 1);
    range.setEnd(n, i + 2);
    const b = range.getBoundingClientRect();
    return { x: b.left + 1, y: b.top + b.height / 2 };
  });
  await A.mouse.click(word.x, word.y);
  await wait(400);
  if (await A.evaluate(() => document.getElementById('reading').hidden || !document.getElementById('editor').hidden)) throw new Error('a click on the page should stay on the page');
  await A.mouse.click(word.x, word.y, { count: 2 });
  await wait(300);
  const selected = await A.evaluate(() => ({ text: getSelection().toString().trim(), page: !document.getElementById('reading').hidden }));
  if (!selected.page || !selected.text.includes('tap')) throw new Error(`a double click on a word: selected, on the page: ${JSON.stringify(selected)}`);
  await A.evaluate(() => getSelection().removeAllRanges());
  // Back to Preview: the task's box, toggled in the note, the page redrawn.
  await setView(A, 'preview');
  await A.click('#reading input[type=checkbox]');
  await until(A, () => document.getElementById('editor').noteText().includes('[x] Rain jacket'));
  await until(A, () => [...document.querySelectorAll('#reading input[type=checkbox]')].every((b) => b.checked));
  // The note changed (as from another device): the page follows.
  await A.evaluate(() => { const y = document.getElementById('editor').noteYText(); y.insert(y.length, '\n\nAdded elsewhere'); });
  await until(A, () => document.getElementById('reading').textContent.includes('Added elsewhere'));
  if (!mobile(A)) {
    // Keys: Ctrl+/ switches, both ways; on the page, E edits.
    const ctrlSlash = async () => {
      await A.keyboard.down('Control');
      await A.keyboard.press('/');
      await A.keyboard.up('Control');
    };
    // (Round Edit, Split and Preview, from Preview.)
    await ctrlSlash();
    await until(A, () => document.getElementById('note-body').dataset.view === 'edit');
    await until(A, EDITOR_READY);
    await ctrlSlash();
    await until(A, () => document.getElementById('note-body').dataset.view === 'split' && !document.getElementById('reading').hidden && !document.getElementById('editor').hidden);
    await ctrlSlash();
    await until(A, () => !document.getElementById('reading').hidden && document.getElementById('editor').hidden);
    await A.keyboard.press('e');
    await until(A, EDITOR_READY);
    // A computer keeps Preview on: another note opens in it; back to Edit, in the editor.
    await setView(A, 'preview');
    await openNote(A, 'Reading list', { edit: false });
    if (!(await shown('reading'))) throw new Error('on a computer, Preview should stay on for the next note');
    await setView(A, 'edit');
    await openNote(A, 'Packing', { edit: false });
    if (await shown('reading')) throw new Error('back to Edit: the next note in the editor');
  } else {
    // A phone: every note opens as a page, whichever was used last (a tap edits; below, too).
    await openNote(A, 'Reading list', { edit: false });
    if (!(await shown('reading'))) throw new Error('on a phone, a note should open as a page');
  }

  // A long note: places kept to 2 px, both ways, all through it.
  await backToList(A);
  await newBlankNote(A);
  const parts = ['# Long read'];
  for (let i = 1; i <= 120; i++) {
    if (i % 15 === 1) parts.push(`## Section ${i}`);
    const words = 'words that wrap across the line on a phone and on a computer alike, '.repeat(1 + (i % 4)).trim();
    if (i % 20 === 7) parts.push(`- [ ] Q${i}x a task with ${words}\n- a plain item`);
    else if (i % 25 === 12) parts.push(`| Q${i}x | b |\n|---|---|\n| c | d |`);
    else if (i % 30 === 18) parts.push(`\`\`\`\nQ${i}x code line\nsecond line\n\`\`\``);
    else parts.push(`Q${i}x ${words}`);
  }
  await A.evaluate((t) => { const y = document.getElementById('editor').noteYText(); y.delete(0, y.length); y.insert(0, t); }, parts.join('\n\n'));
  await until(A, () => document.getElementById('editor').noteText().includes('Q120x'));
  await probes();
  const misses = [];
  const check = async (m, how) => {
    const from = await A.evaluate(() => window.probe.view());
    if (!(await A.evaluate((mm) => window.probe.place(mm, -4), m))) return misses.push(`${m}: couldn't be put at the top (${from})`);
    const before = await A.evaluate((mm) => window.probe.top(mm), m);
    await setView(A, from === 'edit' ? 'preview' : 'edit');
    await wait(200);
    const after = await A.evaluate((mm) => window.probe.top(mm), m);
    if (after == null || Math.abs(after - before) > 2) misses.push(`${m} ${how}: ${before?.toFixed(1)} → ${after?.toFixed(1)}`);
  };
  await A.evaluate(() => document.activeElement?.blur());
  // Plain paragraphs are the same size in both (#306): as many lines, as far apart: from a
  // paragraph's first character to its last, the same height on the page as in the editor.
  {
    const spans = async () => A.evaluate((ms) => {
      const e = document.getElementById('editor'), text = e.noteText(), page = document.getElementById('reading');
      const out = {};
      for (const m of ms) {
        const start = text.indexOf(m), end = text.indexOf('\n', start) - 1;
        if (page.hidden) out[m] = e.screenTop(end) - e.screenTop(start);
        else {
          const node = [...page.querySelectorAll('p')].find((p) => p.textContent.startsWith(m)).firstChild;
          const at = (i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); return r.getClientRects()[0].top; };
          out[m] = at(node.length - 1) - at(0);
        }
      }
      return out;
    }, ['Q33x', 'Q35x', 'Q50x']);
    const sized = [];
    for (const m of ['Q33x', 'Q35x', 'Q50x']) {
      await A.evaluate((mm) => window.probe.place(mm, 40), m);
      const inEditor = (await spans())[m];
      await setView(A, 'preview');
      await A.evaluate((mm) => window.probe.place(mm, 40), m);
      const onPage = (await spans())[m];
      await setView(A, 'edit');
      if (inEditor == null || onPage == null || inEditor < 20 || Math.abs(inEditor - onPage) > 2) sized.push(`${m}: ${inEditor?.toFixed(1)} px in the editor, ${onPage?.toFixed(1)} on the page`);
    }
    if (sized.length) throw new Error(`a paragraph should be the same size in both:\n  ${sized.join('\n  ')}`);
  }
  await A.evaluate(() => document.activeElement?.blur());
  for (const m of ['Q16x', 'Q33x', 'Q47x', 'Q62x', 'Q78x', 'Q92x', 'Q105x']) {
    await check(m, 'editor → page'); // (from the editor)
    await check(m, 'page → editor'); // (and back)
  }
  for (const m of ['Q12x', 'Q18x']) { // (a table's cell, a code block's line)
    await check(m, 'editor → page');
    await check(m, 'page → editor');
  }
  // Typing: the cursor's line is the place, wherever it is on screen.
  await A.evaluate(() => window.probe.place('Q55x', 200));
  const box = await A.evaluate(() => {
    const ta = document.querySelector('#editor textarea');
    const e = document.getElementById('editor');
    const at = e.noteText().indexOf('Q55x');
    if (ta) {
      const r = ta.getBoundingClientRect();
      return { x: r.left + parseFloat(getComputedStyle(ta).paddingLeft) + 2, y: r.top + e.screenTop(at) + 8 };
    }
    const c = document.querySelector('#editor .cm-content').cmTile.view.coordsAtPos(at);
    return { x: c.left + 2, y: (c.top + c.bottom) / 2 };
  });
  await A.mouse.click(box.x, box.y);
  await wait(200);
  const typing = await A.evaluate(() => ({ top: window.probe.top('Q55x'), focused: Boolean(document.activeElement?.closest('#editor')) }));
  await setView(A, 'preview');
  await wait(200);
  const typed = await A.evaluate(() => window.probe.top('Q55x'));
  if (!typing.focused || Math.abs(typed - typing.top) > 2) misses.push(`the cursor's line: ${typing.top?.toFixed(1)} → ${typed?.toFixed(1)} (focused ${typing.focused})`);
  // Others' edits above: the page doesn't move.
  await A.evaluate(() => window.probe.place('Q52x', -4));
  const still = await A.evaluate(() => window.probe.top('Q52x'));
  await A.evaluate(() => { const y = document.getElementById('editor').noteYText(); y.insert(0, 'Inserted elsewhere\n\n'.repeat(25)); });
  await until(A, () => document.getElementById('reading').textContent.includes('Inserted elsewhere'));
  await wait(100);
  const moved = await A.evaluate(() => window.probe.top('Q52x'));
  if (Math.abs(moved - still) > 2) misses.push(`others' edits above moved the page: ${still.toFixed(1)} → ${moved.toFixed(1)}`);
  // A click on a word far down: the page as it was, nothing moving (#538).
  await A.evaluate(() => window.probe.place('Q71x', 150));
  const far = await A.evaluate(() => {
    const r = document.getElementById('reading');
    const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf('Q71x');
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i + 3);
      range.setEnd(n, i + 4);
      const b = range.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2, top: window.probe.top('Q71x') };
    }
    return null;
  });
  await A.mouse.click(far.x, far.y);
  await wait(300);
  const stayed = await A.evaluate(() => ({ page: !document.getElementById('reading').hidden, top: window.probe.top('Q71x') }));
  if (!stayed.page || Math.abs(stayed.top - far.top) > 2) misses.push(`a click on Q71x: the page should stay as it was: ${JSON.stringify({ far: far.top, ...stayed })}`);
  if (misses.length) throw new Error(`places not kept:\n  ${misses.join('\n  ')}`);
  // On a phone a note opens as a page (a new one excepted, above: you're about to type), the
  // keyboard down; a tap on it stays there (#538), and the bar's ✎ Edit is the editor.
  if (mobile(A)) {
    await openNote(A, 'Packing', { edit: false });
    const opened = await A.evaluate(() => ({ page: !document.getElementById('reading').hidden, editor: !document.getElementById('editor').hidden,
      focus: document.activeElement?.closest?.('#editor') ? 'editor' : document.activeElement?.tagName }));
    if (!opened.page || opened.editor || opened.focus === 'editor') throw new Error(`on a phone, a note opens as a page: ${JSON.stringify(opened)}`);
    const below = await A.evaluate(() => {
      const r = document.getElementById('reading'), box = r.getBoundingClientRect();
      const last = [...r.children].filter((c) => !c.classList.contains('layer')).at(-1).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: Math.min(box.bottom - 10, last.bottom + 60) };
    });
    await A.touchscreen.tap(below.x, below.y);
    await wait(400);
    const tapped = await A.evaluate(() => ({ page: !document.getElementById('reading').hidden, button: document.getElementById('note-preview').getAttribute('aria-label'),
      pencil: getComputedStyle(document.querySelector('#note-preview .pencil')).display !== 'none' }));
    if (!tapped.page || tapped.button !== 'Edit' || !tapped.pencil) throw new Error(`a tap on the page: still the page, the bar's button Edit: ${JSON.stringify(tapped)}`);
    await A.click('#note-preview');
    await until(A, EDITOR_READY, undefined, 5000).catch(() => { throw new Error('Edit, from the page: the editor'); });
    if ((await A.$eval('#note-preview', (b) => b.getAttribute('aria-label'))) !== 'Preview') throw new Error('in the editor, the bar\'s button is Preview');
  }
  await backToList(A);
}
