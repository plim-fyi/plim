import { backToList, closeSettings, mobile, newBlankNote, openSettings, s, setSplit, setView, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 23: Split. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow23(shared) {
  const { A } = shared;
  if (mobile(A)) return; // (Split is a computer's: two columns need the room)
  // 23. Split (#302): the markdown and the page side by side, scrolling together. Measured every
  // frame through a fling of the wheel, each way: where each side's top edge is in the note
  // (between which paragraphs, and how far), the two the same; the follower never turning back.
  // The ends pinned together; typing, the cursor's block level with its line, tinted; a click
  // on the page puts the cursor there and moves neither side; others' edits above move neither.
  await A.bringToFront();
  await backToList(A);
  await newBlankNote(A);
  const parts = ['# Split read'];
  for (let i = 1; i <= 100; i++) {
    if (i % 12 === 1) parts.push(`## Section ${i}`);
    const words = 'words that wrap across the line in a column of the window, '.repeat(1 + (i % 5)).trim();
    if (i % 20 === 7) parts.push(`- [ ] P${i}x a task with ${words}\n- a plain item`);
    else if (i % 25 === 12) parts.push(`| P${i}x | b |\n|---|---|\n| c | d |\n| e | f |`);
    else if (i % 30 === 18) parts.push(`\`\`\`\nP${i}x code line\nsecond line\nthird line\n\`\`\``);
    else parts.push(`P${i}x ${words}`);
  }
  await A.evaluate((t) => { const y = document.getElementById('editor').noteYText(); y.delete(0, y.length); y.insert(0, t); }, parts.join('\n\n'));
  await until(A, () => document.getElementById('editor').noteText().includes('P100x'));
  // Split is off unless turned on (Settings → This device): no Split in the bar; turned on, there.
  const splitButton = () => A.evaluate(() => !document.querySelector('#note-mode [data-mode="split"]').hidden);
  await setView(A, 'edit');
  await setSplit(A, false); // (as a device starts: the flows before this one turned it on)
  if (await splitButton()) throw new Error('Split should be off until it is turned on in Settings');
  await openSettings(A, 'editor');
  if (await A.$eval('#settings-split', (b) => b.checked)) throw new Error('Settings: Split view should start off');
  await s(A, '23-split-0-setting');
  await A.click('#settings-split');
  await closeSettings(A);
  await until(A, () => !document.querySelector('#note-mode [data-mode="split"]').hidden, undefined, 3000)
    .catch(() => { throw new Error('Split turned on: its button in the bar'); });
  await setView(A, 'split');
  await wait(400);
  const both = await A.evaluate(() => ({ editor: !document.getElementById('editor').hidden, page: !document.getElementById('reading').hidden,
    widths: [document.getElementById('editor').getBoundingClientRect().width, document.getElementById('reading').getBoundingClientRect().width].map(Math.round) }));
  if (!both.editor || !both.page || Math.abs(both.widths[0] - both.widths[1]) > 2) throw new Error(`Split: both sides, as wide: ${JSON.stringify(both)}`);
  // From the top: the cursor at the start (switching to Split focuses the editor, which shows its
  // cursor: after the text put in, that was the end), both sides at their first line.
  await A.evaluate(() => {
    const v = document.querySelector('#editor .cm-content').cmTile.view;
    v.dispatch({ selection: { anchor: 0 } });
    v.contentDOM.blur();
    v.scrollDOM.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); // (the editor leads)
    v.scrollDOM.scrollTop = 0;
  });
  await wait(400);
  if (await A.evaluate(() => document.querySelector('#editor .cm-scroller').scrollTop || document.getElementById('reading').scrollTop)) throw new Error('Split: both sides should be at the top to start');
  await s(A, '23-split-1');

  // The sampler, in the page: each frame, where each side's top edge is in the note, by the
  // matching points (#302): where each block of the page starts (its first character), on each side.
  await A.evaluate(() => {
    const e = document.getElementById('editor');
    const page = document.getElementById('reading');
    const marks = [...page.querySelectorAll('[data-from]')]
      .filter((el) => el.tagName !== 'INPUT' && ![...el.querySelectorAll('[data-from]')].some((d) => d.tagName !== 'INPUT'))
      .map((el) => ({ pos: Number(el.dataset.from), node: document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() }))
      .filter((m) => m.node?.length);
    const pageTops = () => {
      const edge = page.getBoundingClientRect().top;
      return marks.map(({ node }) => {
        const r = document.createRange();
        r.setStart(node, 0);
        r.setEnd(node, 1);
        return r.getClientRects()[0].top - edge;
      });
    };
    const editorTops = () => marks.map(({ pos }) => e.screenTop(pos));
    // Between which markers the top edge is, and how far: 3.25 is a quarter of the way from the 4th to the 5th.
    const where = (tops) => {
      for (let i = 0; i + 1 < tops.length; i++) {
        if (tops[i] != null && tops[i + 1] != null && tops[i] <= 0 && tops[i + 1] > 0) return { at: i - tops[i] / (tops[i + 1] - tops[i]), gap: tops[i + 1] - tops[i] };
      }
      return null;
    };
    window.sampler = {
      start(follower) {
        this.frames = [];
        this.on = true;
        const scroller = () => (follower === 'page' ? page : document.querySelector('#editor .cm-scroller'));
        // (Measured as each frame was drawn: after its animation frame callbacks, the sync among them.)
        const tick = () => {
          if (!this.on) return;
          setTimeout(() => {
            const ed = where(editorTops()), pg = where(pageTops());
            // (The follower's place, as seen: where its top edge is in the note. Not its scrollTop: CodeMirror
            // changes that as it measures lines above the view, keeping what shows where it is.)
            this.frames.push({ ed, pg, follower: (follower === 'page' ? pg : ed)?.at ?? null });
          }, 0);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      stop() {
        this.on = false;
        // Each frame: how far apart the two are, in the follower's pixels; and turns back in the follower's scrolling.
        let worst = 0, n = 0, turns = 0, dir = 0;
        for (let k = 0; k < this.frames.length; k++) {
          const { ed, pg, follower } = this.frames[k];
          if (ed && pg) {
            n++;
            worst = Math.max(worst, Math.abs(ed.at - pg.at) * Math.min(ed.gap, pg.gap));
          }
          const prev = this.frames[k - 1]?.follower;
          if (prev != null && follower != null && Math.abs(follower - prev) > 0.002) {
            const d = Math.sign(follower - prev);
            if (dir && d !== dir) turns++;
            dir = d;
          }
        }
        // (The frames furthest apart, to say what happened.)
        const far = this.frames.filter((f) => f.ed && f.pg && Math.abs(f.ed.at - f.pg.at) * Math.min(f.ed.gap, f.pg.gap) > 2);
        const apart = far.slice(0, 4).map((f) => `editor ${f.ed.at.toFixed(2)} page ${f.pg.at.toFixed(2)}`);
        // The worst of the rest: a JavaScript-kept follower can be a frame behind when the browser
        // scrolls the leader before the page's code runs (under load, at a fling's start): one such frame is let by.
        const rest = this.frames.filter((f) => f.ed && f.pg).map((f) => Math.abs(f.ed.at - f.pg.at) * Math.min(f.ed.gap, f.pg.gap)).sort((a, b) => b - a).slice(1);
        return { frames: this.frames.length, measured: n, worst: Math.round(worst * 10) / 10, rest: Math.round((rest[0] ?? 0) * 10) / 10, far: far.length, turns, apart };
      },
    };
  });
  const fling = async (side, dy, steps) => {
    const box = await A.evaluate((s) => {
      const r = (s === 'page' ? document.getElementById('reading') : document.querySelector('#editor .cm-scroller')).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, side);
    await A.mouse.move(box.x, box.y);
    await A.evaluate((s) => window.sampler.start(s === 'page' ? 'editor' : 'page'), side);
    for (let i = 0; i < steps; i++) {
      await A.mouse.wheel({ deltaY: dy });
      await wait(16);
    }
    await wait(300);
    return A.evaluate(() => window.sampler.stop());
  };
  const report = [];
  const misses = [];
  for (const [side, dy] of [['editor', 70], ['editor', -45], ['page', 80], ['page', -55]]) {
    const r = await fling(side, dy, 50);
    report.push(`${side} ${dy > 0 ? 'down' : 'up'}: ${r.measured}/${r.frames} frames, ${r.far} over 2 px apart (worst ${r.worst}, the rest within ${r.rest}), ${r.turns} turns`);
    if (r.measured < 20 || r.far > 1 || r.rest > 2 || r.turns) {
      // (Where the two sides are, and how far each can scroll: to say what happened.)
      const panes = await A.evaluate(() => [document.querySelector('#editor .cm-scroller'), document.getElementById('reading')].map((e) => {
        const b = e.getBoundingClientRect();
        return `top ${Math.round(b.top)} height ${Math.round(b.height)} scroll ${Math.round(e.scrollTop)}/${e.scrollHeight - e.clientHeight}`;
      }));
      misses.push(`${report.at(-1)} (${r.apart.join('; ')}) [editor ${panes[0]}; page ${panes[1]}]`);
    }
  }
  console.log(`  split: ${report.join('; ')}`);
  // The ends: the leader at its end, the follower at its own.
  for (const side of ['editor', 'page']) {
    const ends = await A.evaluate(async (s) => {
      const ed = document.querySelector('#editor .cm-scroller'), page = document.getElementById('reading');
      const [L, F] = s === 'page' ? [page, ed] : [ed, page];
      L.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      L.scrollTop = L.scrollHeight;
      await new Promise((r) => setTimeout(r, 300));
      const bottom = Math.abs(F.scrollTop - (F.scrollHeight - F.clientHeight)) < 2;
      L.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 300));
      return { bottom, top: F.scrollTop === 0 };
    }, side);
    if (!ends.bottom || !ends.top) misses.push(`${side} leading, the ends: ${JSON.stringify(ends)}`);
  }
  // Typing: the cursor's block on the page level with its line, tinted.
  await A.evaluate(() => {
    const v = document.querySelector('#editor .cm-content').cmTile.view;
    v.focus();
    const at = v.state.doc.toString().indexOf('P41x');
    v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  });
  await A.keyboard.type('typed ');
  await wait(500);
  const typing = await A.evaluate(() => {
    const e = document.getElementById('editor');
    const pos = e.cursorPos();
    const tinted = document.querySelector('#reading .cursor-block');
    const page = document.getElementById('reading');
    const w = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    let top = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf('typed P41x');
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + 6);
      r.setEnd(n, i + 7);
      top = r.getClientRects()[0].top - page.getBoundingClientRect().top;
    }
    return { line: e.screenTop(pos), page: top, tinted: tinted?.textContent.includes('typed P41x') ?? false };
  });
  if (typing.page == null || Math.abs(typing.page - typing.line) > 2 || !typing.tinted) misses.push(`typing: the cursor's line at ${typing.line?.toFixed(1)}, its block on the page at ${typing.page?.toFixed(1)}, tinted ${typing.tinted}`);
  await s(A, '23-split-2-typing');
  // A click on the page: the cursor there; neither side moves.
  const before = await A.evaluate(() => [document.querySelector('#editor .cm-scroller').scrollTop, document.getElementById('reading').scrollTop]);
  const target = await A.evaluate(() => {
    const page = document.getElementById('reading');
    const w = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    const box = page.getBoundingClientRect();
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const m = /P(4[2-9]|[5-9]\d)x/.exec(n.data);
      if (!m) continue;
      const r = document.createRange();
      r.setStart(n, m.index + 1);
      r.setEnd(n, m.index + 2);
      const b = r.getClientRects()[0];
      if (b.top > box.top + 20 && b.bottom < box.bottom - 20) return { m: m[0], x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  });
  if (!target) misses.push('no marker on the page to click');
  else {
    await A.mouse.click(target.x, target.y);
    await wait(400);
    const after = await A.evaluate((m) => {
      const e = document.getElementById('editor');
      return { scroll: [document.querySelector('#editor .cm-scroller').scrollTop, document.getElementById('reading').scrollTop], at: e.cursorPos() - e.noteText().indexOf(m), split: document.getElementById('note-body').dataset.view };
    }, target.m);
    if (after.split !== 'split' || after.at !== 1 || Math.abs(after.scroll[0] - before[0]) > 1 || Math.abs(after.scroll[1] - before[1]) > 1) misses.push(`a click on the page: ${JSON.stringify({ before, ...after })}`);
  }
  // Others' edits above: neither side moves.
  const still = await A.evaluate(() => {
    const e = document.getElementById('editor');
    return e.screenTop(e.noteText().indexOf('P47x'));
  });
  await A.evaluate(() => { const y = document.getElementById('editor').noteYText(); y.insert(0, 'Inserted elsewhere\n\n'.repeat(20)); });
  await until(A, () => document.getElementById('reading').textContent.includes('Inserted elsewhere'));
  await wait(400);
  const moved = await A.evaluate(() => {
    const e = document.getElementById('editor');
    return e.screenTop(e.noteText().indexOf('P47x'));
  });
  if (Math.abs(moved - still) > 2) misses.push(`others' edits above moved the editor: ${still?.toFixed(1)} → ${moved?.toFixed(1)}`);
  // Typing: the cursor's block tinted in every frame, not only in the pauses (#331: typing at a
  // paragraph's end took the tint off until the page was drawn again). Sampled each frame: which
  // block is tinted (its text's start), while a burst goes in at the end, then in the middle; the
  // cursor moved down a paragraph: the tint moves with it, never to none.
  const sample = () => A.evaluate(() => {
    window.__tint = [];
    const tick = () => {
      const t = document.querySelector('#reading .cursor-block');
      window.__tint.push(t ? t.textContent.slice(0, 12) : null);
      if (window.__run) requestAnimationFrame(tick);
    };
    window.__run = true;
    requestAnimationFrame(tick);
  });
  const sampled = () => A.evaluate(() => { window.__run = false; return window.__tint; });
  const cursorAt = (find, end) => A.evaluate((f, e) => {
    const v = document.querySelector('#editor .cm-content').cmTile.view;
    const at = v.state.doc.toString().indexOf(f);
    v.dispatch({ selection: { anchor: e ? v.state.doc.lineAt(at).to : at + f.length }, scrollIntoView: true });
    v.focus();
  }, find, end);
  for (const [where, find, end] of [['at its end', 'P43x', true], ['in its middle', 'P44x words that wrap', false]]) {
    await cursorAt(find, end);
    await wait(400);
    // (The cursor moved, by a key, a click or as here the editor's own placing: its block tinted at
    // once, before anything's typed, #554.)
    const before = await A.evaluate(() => document.querySelector('#reading .cursor-block')?.textContent.slice(0, 12) ?? null);
    if (!before?.startsWith(find.slice(0, 4))) misses.push(`the cursor moved ${where} of a paragraph: its block not tinted until typing (${before})`);
    await sample();
    await A.keyboard.type(' and more words typed at a steady pace', { delay: 35 });
    await wait(300);
    const frames = await sampled();
    const off = frames.filter((t) => !t?.startsWith(find.slice(0, 4))).length;
    if (off) misses.push(`typing ${where} of a paragraph: its block untinted in ${off} of ${frames.length} frames (${[...new Set(frames)].join(' / ')})`);
  }
  await sample();
  await A.keyboard.press('ArrowDown');
  await A.keyboard.press('ArrowDown');
  await A.keyboard.press('ArrowDown');
  await A.keyboard.press('ArrowDown');
  await wait(300);
  const moving = await sampled();
  if (moving.some((t) => t == null)) misses.push(`the cursor moved down: a frame with no block tinted (${[...new Set(moving)].join(' / ')})`);
  // A new paragraph (Enter twice, then words): the tint on it once the page is drawn again, and
  // meanwhile on the one before (never none).
  await cursorAt('P49x', true);
  await wait(300);
  await sample();
  await A.keyboard.press('Enter');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Brand new paragraph', { delay: 35 });
  await wait(500);
  const fresh = await sampled();
  if (fresh.some((t) => t == null) || !fresh.at(-1)?.startsWith('Brand new')) misses.push(`a new paragraph: the tint should end on it, never none (${[...new Set(fresh)].join(' / ')})`);
  if (misses.length) throw new Error(`Split:\n  ${misses.join('\n  ')}`);
  await setView(A, 'edit');
  await backToList(A);
}
