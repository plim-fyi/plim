import { backToList, mobile, newBlankNote, openHistory, openNote, rowMenu, s, typeAtEnd, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 12b: History. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow12b(shared) {
  const { A } = shared;
  // 12b. History (#60): edit a note in two goes (versions here every 2 s), look back, restore, undo.
  {
    const noteText = () => A.evaluate(() => document.getElementById('editor').noteText());
    // The chosen version's text as History shows it: its lines, less those it removed (marked, struck through).
    const shownText = () => A.evaluate(() => [...document.querySelectorAll('#history-diff .line:not(del)')].map((e) => e.textContent).join('\n'));
    // No versions yet (#358): a small dialog round its message, from the first frame; not the big one
    // empty. (A phone: a screen of its own, as ever.)
    {
      await newBlankNote(A);
      await typeAtEnd(A, 'Nothing earlier');
      await A.evaluate(() => {
        const seen = (window.historyFrames = []);
        const frame = () => {
          const d = document.getElementById('history-dialog');
          if (d.open) seen.push({ w: d.offsetWidth, h: d.offsetHeight });
          if (seen.length < 40) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await openHistory(A);
      await until(A, () => document.getElementById('history-message').textContent.startsWith('No earlier versions yet'), undefined, 10000);
      await wait(400);
      const sizes = await A.evaluate(() => window.historyFrames);
      const ws = [...new Set(sizes.map((s) => s.w))], hs = [...new Set(sizes.map((s) => s.h))];
      if (!mobile(A) && (ws.length !== 1 || hs.length !== 1 || ws[0] > 500 || hs[0] > 320)) throw new Error(`History with no versions: a small dialog, the same size throughout: widths ${ws}, heights ${hs}`);
      await s(A, '16-history-0-none');
      await A.keyboard.press('Escape');
      await wait(300);
    }
    await openNote(A, 'Groceries');
    const original = await noteText();
    await typeAtEnd(A, '\n- version one');
    await wait(2500);
    await typeAtEnd(A, '\n- version two');
    await wait(2500);
    await typeAtEnd(A, '\n- version three');
    await wait(1500);
    // Opening doesn't jump or blink: every frame for 3 s, the dialog's height, where the version's text
    // starts and how visible it is; over a connection like the real one (each request ~120 ms).
    await A.emulateNetworkConditions({ download: 5e6, upload: 5e6, latency: 120 });
    await A.evaluate(() => {
      const seen = (window.historyFrames = []);
      const end = performance.now() + 3000;
      const frame = () => {
        const d = document.getElementById('history-dialog');
        if (d.open) {
          const pane = [document.getElementById('history-diff')].find((e) => !e.hidden && e.offsetParent);
          const r = d.getBoundingClientRect();
          const scale = r.height / d.offsetHeight; // (the open animation scales it: measure without that)
          const message = document.getElementById('history-message');
          // How visible the version's text is: its opacity times its parents' (the dialog's included).
          let opacity = null;
          if (pane) {
            opacity = 1;
            for (let e = pane; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
          }
          seen.push({ height: d.offsetHeight, text: pane ? Math.round((pane.getBoundingClientRect().top - r.top) / scale) : null,
            loading: !message.hidden && message.textContent === 'Loading…', opacity });
        }
        if (performance.now() < end) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await openHistory(A);
    await until(A, () => document.querySelector('#history-dialog').open && document.querySelectorAll('#history-list button').length >= 2, undefined, 15000)
      .catch(async (e) => {
        const why = await A.evaluate(() => ({ open: document.querySelector('#history-dialog').open, hidden: document.getElementById('note-history').hidden,
          message: document.getElementById('history-message').textContent, items: [...document.querySelectorAll('#history-list li')].map((l) => l.textContent) }));
        throw new Error(`History should list 2+ versions: ${JSON.stringify(why)} (${e.message})`);
      });
    await until(A, () => document.getElementById('history-diff').textContent.includes('version two') && !document.getElementById('history-copy').disabled);
    await wait(3000);
    await A.emulateNetworkConditions(null);
    {
      const frames = await A.evaluate(() => window.historyFrames);
      const heights = [...new Set(frames.map((f) => f.height))];
      const tops = [...new Set(frames.map((f) => f.text).filter((t) => t !== null))];
      if (Math.max(...heights) - Math.min(...heights) > 3 || Math.max(...tops) - Math.min(...tops) > 3) {
        throw new Error(`History jumps while it opens: heights ${heights.join(', ')}; text starts at ${tops.join(', ')}`);
      }
      // Here the versions arrive in under 300 ms: no "Loading…" flashes up first.
      const loading = frames.filter((f) => f.loading).length;
      if (loading) throw new Error(`History showed "Loading…" for ${loading} frames before a quick load`);
      // It fades in once: the text never gets fainter again on the way (stacked fades blink).
      const seen = frames.map((f) => f.opacity).filter((o) => o !== null);
      const dips = seen.filter((o, i) => i && o < seen[i - 1] - 0.02).length;
      if (dips) throw new Error(`History's text blinks while it opens (${dips} dips): ${seen.map((o) => o.toFixed(2)).join(' ')}`);
    }
    // What each version changed (#340): every row its time, its lines added and removed, and the change in words
    // (once all are loaded); Now on top, as the note is; the oldest, the first kept.
    await until(A, () => [...document.querySelectorAll('#history-list button')].every((b) => b.dataset.done || b.dataset.id === 'now'), undefined, 15000);
    const sums = await A.evaluate(() => [...document.querySelectorAll('#history-list button')].map((b) => ({
      time: b.querySelector('.history-time').textContent, sum: b.querySelector('.history-sum').textContent, what: b.querySelector('.history-what').textContent })));
    if (sums[0].time !== 'Now' || sums[0].what !== 'Your note as it is' || sums.at(-1).what !== 'The first version kept'
      || !sums.some((r) => r.sum === '+1' && /^Added “version (one|two|three)”$/.test(r.what))) {
      throw new Error(`History rows: ${JSON.stringify(sums)}`);
    }
    // Rows are whole buttons, one under another, that don't run out of the list.
    const listFits = await A.evaluate(() => [...document.querySelectorAll('#history-list .history-what')].every((e) => e.scrollWidth <= e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis'));
    if (!listFits) throw new Error('a History row’s summary runs out of its row');
    // A version that added typed lines (which ones depends on timing): only added lines marked, in the whole note.
    await until(A, () => {
      const diffs = () => [...document.querySelectorAll('#history-diff ins, #history-diff del')].map((e) => e.tagName + e.textContent);
      const d = diffs();
      if (d.length && d.every((x) => /^INS- version (one|two|three)$/.test(x))) return true;
      const rows = [...document.querySelectorAll('#history-list button')];
      const at = rows.findIndex((b) => b.getAttribute('aria-current') === 'true');
      rows[(at + 1) % rows.length].click();
      return false;
    }, undefined, 15000).catch(async (e) => {
      const seen = [];
      for (const b of await A.$$('#history-list button')) {
        await b.evaluate((el) => el.click());
        await wait(500);
        seen.push(await A.evaluate((el) => ({ row: el.textContent, diff: [...document.querySelectorAll('#history-diff ins, #history-diff del')].map((x) => x.tagName + x.textContent) }), b));
      }
      throw new Error(`no version only adds typed lines: ${JSON.stringify(seen, null, 1)} (${e.message})`);
    });
    // (On a phone: open the selected one, the dialog may still be on the list.)
    await A.evaluate(() => document.querySelector('#history-list button[aria-current="true"]').click());
    await until(A, () => !document.getElementById('history-restore').disabled && !document.getElementById('history-restore').hidden);
    // The version (no Changes/Text to choose): what it changed said in words, Restore in reach. (A
    // short note: nothing to fold, so the whole of it, #547.)
    const view = await A.evaluate(() => {
      const r = document.getElementById('history-restore').getBoundingClientRect();
      return { since: document.getElementById('history-since').textContent, fold: document.querySelector('#history-diff .fold')?.textContent ?? null,
        hide: document.getElementById('history-fold').hidden ? null : document.getElementById('history-fold').textContent,
        restore: { bottom: r.bottom, height: r.height, inView: r.bottom <= innerHeight && r.top >= 0 },
        hint: document.getElementById('history-hint').textContent };
    });
    if (!/^\d+ lines? added since (Today|Yesterday)/.test(view.since) || (view.fold !== null) !== (view.hide !== null) || !view.restore.inView
      || !view.hint.startsWith('Restoring keeps what you have now')) throw new Error(`History's version: ${JSON.stringify(view)}`);
    if (mobile(A) && view.restore.height < 44) throw new Error(`Restore is too small to tap on a phone: ${view.restore.height}px`);
    if (view.fold === null && !/^Groceries\n[^]*- version (one|two|three)$/.test(await shownText())) throw new Error(`History should show the whole version: ${JSON.stringify(await shownText())}`);
    await s(A, '16-history-1-versions');
    if (mobile(A)) {
      // A screen of its own: the whole screen, ‹ Versions back to the list (History's title gives way to it).
      const phone = await A.evaluate(() => {
        const d = document.getElementById('history-dialog').getBoundingClientRect();
        return { full: Math.abs(d.width - innerWidth) < 2 && Math.abs(d.height - innerHeight) < 2,
          back: Boolean(document.getElementById('history-back').offsetParent), title: Boolean(document.getElementById('history-title').offsetParent) };
      });
      if (!phone.full || !phone.back || phone.title) throw new Error(`History on a phone: ${JSON.stringify(phone)}`);
      await A.click('#history-back');
      await until(A, () => !document.getElementById('history-dialog').classList.contains('previewing') && document.querySelector('#history-list button').offsetParent);
      await s(A, '16-history-4-list');
    } else {
      // Up and down move through the versions.
      const at = () => A.evaluate(() => [...document.querySelectorAll('#history-list button')].findIndex((b) => b.getAttribute('aria-current') === 'true'));
      const from = await at();
      await A.focus('#history-list button[aria-current="true"]');
      await A.keyboard.press(from ? 'ArrowUp' : 'ArrowDown');
      await until(A, (i) => document.querySelectorAll('#history-list button')[i]?.getAttribute('aria-current') === 'true', from ? from - 1 : from + 1);
      // Now: the note as it is; nothing to restore.
      await A.click('#history-list button[data-id="now"]');
      await until(A, () => document.getElementById('history-when').textContent === 'Now' && document.getElementById('history-restore').hidden
        && document.getElementById('history-since').textContent.startsWith('Your note as it is'));
    }
    // The oldest: the note as it was before this session's edits. (On a phone the dialog opens on the list.)
    const buttons = await A.$$('#history-list button');
    await buttons[buttons.length - 1].click();
    await until(A, () => !document.getElementById('history-restore').disabled && document.getElementById('history-since').textContent === 'The first version Plim kept of this note');
    if ((await shownText()) !== original) throw new Error(`the oldest version should read as the note did: ${JSON.stringify(await shownText())}`);
    await A.click('#history-restore');
    await until(A, (t) => document.getElementById('editor').noteText() === t, original);
    await until(A, () => !document.querySelector('#toast').hidden && document.getElementById('toast-text').textContent.startsWith('Restored the version from'));
    await s(A, '16-history-2-restored');
    // Undo puts the edits back; and the note as it was before the Restore is a version too.
    await A.click('#toast-action');
    await until(A, () => document.getElementById('editor').noteText().includes('version three'));
    await wait(1000);
    // (Not a count: it can share its 2 s period with the version saved after "version three", same text.)
    await openHistory(A);
    // A saved version (not Now) has it (clicked in the page, one after another: the list renders as it loads).
    await until(A, () => {
      const rows = [...document.querySelectorAll('#history-list button:not([data-id="now"])')];
      const at = rows.findIndex((b) => b.getAttribute('aria-current') === 'true');
      if (at >= 0 && !document.getElementById('history-copy').disabled && document.getElementById('history-diff').textContent.includes('version three')) return true;
      rows[(at + 1) % rows.length]?.click();
      return false;
    }, undefined, 15000);
    await A.keyboard.press('Escape');
    await wait(300);
    // Only the changes (#547, as GitHub shows a diff): a long note with a line changed in its middle,
    // the change and 3 lines either side, the rest folded ("Show N unchanged lines", each opening in
    // place); the bar's button shows the whole note, and only the changes again.
    {
      await newBlankNote(A);
      await A.cdp.send('Input.insertText', { text: `Long list\n${Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n')}` });
      await wait(2500);
      // (Opened again, a session of its own: its first edit keeps the note as it was, Line 11 in it.)
      await openNote(A, 'Groceries');
      await openNote(A, 'Long list');
      await A.evaluate(() => { const y = document.getElementById('editor').noteYText(); const at = y.toString().indexOf('Line 11'); y.delete(at, 'Line 11'.length); y.insert(at, 'Line eleven'); });
      await wait(2500);
      await openHistory(A);
      // (The version with that change, whichever it is: clicked through, as the list renders.)
      await until(A, () => {
        const rows = [...document.querySelectorAll('#history-list button')];
        const at = rows.findIndex((b) => b.getAttribute('aria-current') === 'true');
        if (at >= 0 && [...document.querySelectorAll('#history-diff ins')].some((e) => e.textContent === 'Line eleven')) return true;
        rows[(at + 1) % rows.length]?.click();
        return false;
      }, undefined, 15000).catch(() => { throw new Error('History: no version with "Line eleven" added'); });
      const lines = () => A.evaluate(() => ({
        rows: [...document.getElementById('history-diff').children].map((e) => (e.classList.contains('fold') ? `[${e.textContent}]` : e.textContent)),
        button: document.getElementById('history-fold').hidden ? null : document.getElementById('history-fold').textContent,
      }));
      const v = await lines();
      if (v.rows.join('|') !== '[Show 8 unchanged lines]|Line 8|Line 9|Line 10|Line 11|Line eleven|Line 12|Line 13|Line 14|[Show 6 unchanged lines]' || v.button !== 'Show the whole note') {
        throw new Error(`History: only the changes, 3 lines either side, the rest folded: ${JSON.stringify(v)}`);
      }
      if (mobile(A) && (await A.$eval('#history-diff .fold', (b) => b.offsetHeight)) < 44) throw new Error('a fold is too small to tap on a phone');
      await s(A, '16-history-3-folded');
      await A.click('#history-diff .fold');
      await until(A, () => document.getElementById('history-diff').textContent.startsWith('Long list') && document.querySelectorAll('#history-diff .fold').length === 1)
        .catch(async () => { throw new Error(`a fold, opened: its lines in place: ${JSON.stringify(await lines())}`); });
      await A.click('#history-fold');
      await until(A, () => !document.querySelector('#history-diff .fold') && document.getElementById('history-fold').textContent === 'Only the changes'
        && document.getElementById('history-diff').textContent.includes('Line 20'));
      await A.click('#history-fold');
      await until(A, () => document.querySelectorAll('#history-diff .fold').length === 2 && document.getElementById('history-fold').textContent === 'Show the whole note');
      await A.keyboard.press('Escape');
      await wait(300);
      // (The note out of the way of the flows after this one.)
      await backToList(A);
      const id = await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].find((li) => li.querySelector('.title').textContent === 'Long list').dataset.id);
      await rowMenu(A, `#note-list li[data-id="${id}"]`);
      await A.click('#note-menu-delete');
      await until(A, () => !document.querySelector('#toast').hidden);
      await A.evaluate(() => (document.getElementById('toast').hidden = true));
      await openNote(A, 'Groceries');
    }
    // Offline: History says it needs a connection.
    await A.setOfflineMode(true);
    await openHistory(A);
    await until(A, () => document.getElementById('history-message').textContent === 'History needs a connection.', undefined, 15000);
    await A.keyboard.press('Escape');
    await A.setOfflineMode(false);
    await wait(500);
    // Forget history (asked first): a note's earlier versions deleted for good, on every device; the
    // note stays as it is. (A note of its own: the phrase change, flow 6, checks the others' versions.)
    await newBlankNote(A);
    await typeAtEnd(A, 'Forgetful\n\n- first');
    await wait(2500);
    await typeAtEnd(A, '\n- second');
    await wait(2500);
    await typeAtEnd(A, '\n- third');
    await wait(2500);
    await openHistory(A);
    await until(A, () => document.querySelectorAll('#history-list button:not([data-id="now"])').length >= 1, undefined, 15000);
    const kept = await A.evaluate(() => document.getElementById('editor').noteText());
    await A.click('#history-forget'); // (the confirm box is accepted)
    await until(A, () => document.getElementById('history-message').textContent.startsWith('History forgotten'), undefined, 15000)
      .catch(async () => { throw new Error(`Forget history: ${await A.evaluate(() => document.getElementById('history-message').textContent || document.getElementById('toast-text').textContent)}`); });
    await s(A, '16-history-5-forgotten');
    await A.keyboard.press('Escape');
    await wait(300);
    if ((await A.evaluate(() => document.getElementById('editor').noteText())) !== kept) throw new Error('forgetting its history should leave the note as it is');
    await openHistory(A);
    await until(A, () => document.getElementById('history-message').textContent.startsWith('No earlier versions yet'), undefined, 15000)
      .catch(async () => { throw new Error(`after forgetting, History: ${await A.evaluate(() => document.getElementById('history-message').textContent)}`); });
    await A.keyboard.press('Escape');
    await wait(300);
    // A long history (every version is kept): the newest 60 listed, then a row for the rest; a
    // version's text is loaded only once its row is in sight. (70 saved here, a minute apart.)
    await A.evaluate(async () => {
      const base = [...document.scripts].find((x) => /app\.js$/.test(x.src)).src;
      const [{ state }, { saveVersion, nowSecs }] = await Promise.all([import(new URL('ui/shared.js', base)), import(new URL('core/history.js', base))]);
      const now = nowSecs();
      for (let i = 70; i >= 1; i--) await saveVersion(state.note.sync, `Forgetful\n\n- line ${i}`, now - i * 60);
    });
    await openHistory(A);
    await until(A, () => document.querySelectorAll('#history-list button[data-id]:not([data-id="now"])').length > 0, undefined, 15000);
    await wait(1500);
    const page = await A.evaluate(() => ({
      rows: document.querySelectorAll('#history-list button[data-id]:not([data-id="now"])').length,
      more: document.querySelector('#history-list .history-more')?.textContent ?? null,
      loaded: document.querySelectorAll('#history-list button[data-id][data-done]').length,
    }));
    if (page.rows !== 60 || page.more !== 'Show earlier versions (10 more)' || page.loaded >= 40) throw new Error(`a long history: 60 listed, a row for the rest, only those in sight loaded: ${JSON.stringify(page)}`);
    await A.click('#history-list .history-more');
    await until(A, () => document.querySelectorAll('#history-list button[data-id]:not([data-id="now"])').length === 70 && !document.querySelector('#history-list .history-more'), undefined, 5000)
      .catch(async () => { throw new Error(`Show earlier versions: ${await A.evaluate(() => document.querySelectorAll('#history-list button[data-id]').length)} rows`); });
    await A.keyboard.press('Escape');
    await wait(300);
  }
}
