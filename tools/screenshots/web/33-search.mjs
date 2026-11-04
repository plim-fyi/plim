import { backToList, freshAuthMinute, mobile, newPage, s, until, URL } from './harness.mjs';
import { openVault } from '../drive.mjs';
import { wait } from '../server.mjs';

/** Flow 33: Search. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow33(shared) {
  const { A, profile } = shared;
  // 33. Search (#24): the field under New note. Every word has to be in a note, whatever its case
  // or accents; the list is the notes that have them, each with its lines that matched; Recently deleted
  // and the order step aside (the chips stay: what's searched, #514). A result opens at its first match, every match marked, with a bar
  // to go through them. On a device that has none of the notes yet, they're fetched to be searched.
  await A.bringToFront();
  await backToList(A);
  const list = (p) => p.evaluate(() => ({
    rows: [...document.querySelectorAll('#note-list li[data-id]')].map((li) => ({
      title: li.querySelector('.title').textContent,
      lines: [...li.querySelectorAll('.row-line')].map((l) => l.textContent),
      marks: [...li.querySelectorAll('.row-line mark')].map((m) => m.textContent),
    })),
    summary: document.getElementById('search-summary').hidden ? null : document.getElementById('search-summary').textContent,
    deleted: ['btn-trash', 'btn-trash-foot'].some((id) => document.getElementById(id).getClientRects().length > 0),
    sort: document.getElementById('notes-sort').getClientRects().length > 0,
  }));
  const search = async (p, q) => {
    await p.click('#search-input', { count: 3 });
    await p.keyboard.press('Backspace');
    if (q) await p.type('#search-input', q);
    // (Until every note has been searched: the line under the field stops saying "Searching…".)
    await until(p, () => !document.getElementById('search-summary').textContent.startsWith('Searching'), undefined, 20000);
  };
  // Two words, one without its accent: the notes with both (Lisbon trip among them), both marked
  // in each; Groceries, with neither, not there.
  await search(A, 'pasteis TRAM');
  let l = await list(A);
  const both = (r) => r.marks.some((m) => /^pastéis$/i.test(m)) && r.marks.some((m) => /^tram$/i.test(m));
  if (!l.rows.some((r) => r.title === 'Lisbon trip') || !l.rows.every(both) || l.rows.some((r) => r.title === 'Groceries')) {
    throw new Error(`"pasteis TRAM": the notes with both, both marked: ${JSON.stringify(l)}`);
  }
  if (l.deleted || l.sort || !l.summary.startsWith(`${l.rows.length} note`)) throw new Error(`while searching: no Recently deleted or order, and how many: ${JSON.stringify(l)}`);
  if (await A.evaluate(() => ['btn-trash', 'btn-trash-foot'].some((id) => document.getElementById(id).getClientRects().length > 0))) throw new Error('while searching: Recently deleted steps aside');
  // One word: every note with it, each with its line that has it (not its title).
  await search(A, 'tram');
  l = await list(A);
  const lisbon = l.rows.find((r) => r.title === 'Lisbon trip');
  if (!lisbon || l.rows.some((r) => !r.marks.length && !/tram/i.test(r.title)) || !/^\d+ notes?( · \d+ matches)?$/.test(l.summary)) {
    throw new Error(`"tram": the notes with it, each with its lines: ${JSON.stringify(l)}`);
  }
  await s(A, '33-search-1-results');
  // A result opened: at its first match, every match marked, "1 of n"; the next one, "2 of n".
  const marks = (p) => p.evaluate(() => {
    const bar = document.getElementById('find-bar');
    const page = !document.getElementById('reading').hidden;
    return {
      bar: !bar.hidden && bar.getClientRects().length > 0, count: document.getElementById('find-count').textContent,
      // (In the editor: its marks; on the page: the highlights, CSS's own.)
      marked: page ? (CSS.highlights.get('find')?.size ?? 0) + (CSS.highlights.get('find-current')?.size ?? 0) : document.querySelectorAll('#editor .cm-find').length,
      current: page ? CSS.highlights.get('find-current')?.size ?? 0 : document.querySelectorAll('#editor .cm-find-current').length,
      page,
    };
  });
  // (The results, every frame from the click on: they stay as they were, in their order, while the
  // note opens; none leaves the list for a moment, none moves.)
  await A.evaluate(() => {
    window.__orders = [];
    window.__sampling = true;
    const tick = () => {
      window.__orders.push([...document.querySelectorAll('#note-list li[data-id] .title')].map((e) => e.textContent).join(' | '));
      if (window.__sampling) requestAnimationFrame(tick);
    };
    tick();
  });
  await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] > button')].find((b) => b.querySelector('.title').textContent === 'Lisbon trip').click());
  await until(A, () => !document.getElementById('find-bar').hidden, undefined, 10000)
    .catch(async () => { throw new Error(`a result opened: its matches' bar: ${JSON.stringify(await marks(A))}`); });
  await wait(2000);
  if (!mobile(A)) {
    const orders = await A.evaluate(() => { window.__sampling = false; return [...new Set(window.__orders)]; });
    if (orders.length !== 1) throw new Error(`the results moved as one was opened:\n  ${orders.join('\n  ')}`);
    // And among many: one from the middle, opened, stays where it was, and so do the others (it
    // isn't edited by being opened, so it doesn't go to the top).
    await search(A, 'e');
    const before = await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] .title')].map((e) => e.textContent));
    if (before.length < 4) throw new Error(`"e" should find most notes: ${before}`);
    await A.evaluate(() => {
      window.__orders = [];
      window.__sampling = true;
      const tick = () => {
        window.__orders.push([...document.querySelectorAll('#note-list li[data-id] .title')].map((e) => e.textContent).join(' | '));
        if (window.__sampling) requestAnimationFrame(tick);
      };
      tick();
    });
    await A.evaluate((i) => document.querySelectorAll('#note-list li[data-id] > button')[i].click(), Math.floor(before.length / 2));
    await wait(2500);
    const many = await A.evaluate(() => { window.__sampling = false; return [...new Set(window.__orders)]; });
    if (many.length !== 1) throw new Error(`the results moved as one from the middle was opened:\n  ${many.join('\n  ')}`);
    // (Back to "tram" and Lisbon trip, as the rest of this flow expects.)
    await search(A, 'tram');
    await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] > button')].find((b) => b.querySelector('.title').textContent === 'Lisbon trip').click());
    await until(A, () => !document.getElementById('find-bar').hidden, undefined, 10000);
  }
  let m = await marks(A);
  if (!m.bar || m.count !== '1 of 1' || m.marked !== 1 || m.current !== 1) throw new Error(`Lisbon trip, opened from "tram": ${JSON.stringify(m)}`);
  if (mobile(A) && !m.page) throw new Error('on a phone, a result opens as a page, where its matches can be marked');
  // A word with more than one match in it: the next, and back round.
  await A.click('#search-input', { count: 3 }).catch(() => {});
  if (mobile(A)) {
    // (On a phone the list is behind the note: the words changed from the list, the note opened again.)
    await backToList(A);
  }
  await search(A, 'sa');
  if (mobile(A)) await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] > button')].find((b) => b.querySelector('.title').textContent === 'Lisbon trip').click());
  await until(A, () => /^1 of [2-9]/.test(document.getElementById('find-count').textContent), undefined, 10000)
    .catch(async () => { throw new Error(`"sa" in Lisbon trip (Santa, Saturday): more than one: ${JSON.stringify(await marks(A))}`); });
  await A.click('#find-next');
  m = await marks(A);
  if (!m.count.startsWith('2 of ') || m.current !== 1) throw new Error(`the next match: ${JSON.stringify(m)}`);
  await s(A, '33-search-2-in-note');
  await A.click('#find-close');
  m = await marks(A);
  if (m.bar || m.marked) throw new Error(`the bar closed: nothing marked: ${JSON.stringify(m)}`);
  // Nothing found: says so, with why for more than one word.
  await backToList(A);
  await search(A, 'tram zzzqqq');
  l = await list(A);
  if (l.rows.length || !/^No notes with “tram zzzqqq” \(every word/.test(l.summary)) throw new Error(`nothing found: ${JSON.stringify(l)}`);
  // Esc: the search over, every note back, the order too.
  await A.click('#search-input');
  await A.keyboard.press('Escape');
  l = await list(A);
  if (l.summary !== null || !l.sort || l.rows.length < 5 || l.rows.some((r) => r.lines.length)) throw new Error(`Esc: all notes again: ${JSON.stringify(l)}`);
  if (!(await A.evaluate(() => ['btn-trash', 'btn-trash-foot'].some((id) => document.getElementById(id).getClientRects().length > 0)))) throw new Error('Esc: Recently deleted back');
  // Enter in the field: a phone's Search key puts the keyboard away, the results staying (no note
  // opened: a tap does that); a computer's Enter opens the first result.
  await backToList(A);
  await search(A, 'tram');
  const firstResult = await A.evaluate(() => document.querySelector('#note-list li[data-id] .title')?.textContent);
  await A.focus('#search-input');
  await A.keyboard.press('Enter');
  await wait(500);
  const entered = await A.evaluate(() => ({ editing: document.querySelector('.notes').classList.contains('editing'), focused: document.activeElement?.id === 'search-input',
    rows: document.querySelectorAll('#note-list li[data-id]').length, query: document.getElementById('search-input').value, title: document.getElementById('note-title').textContent }));
  if (mobile(A) ? entered.editing || entered.focused || !entered.rows || entered.query !== 'tram' : entered.title !== firstResult) {
    throw new Error(`Enter in the search field (${mobile(A) ? 'a phone: the keyboard away, the results staying' : 'a computer: the first result opened'}): ${JSON.stringify({ firstResult, ...entered })}`);
  }
  await backToList(A);
  await A.click('#search-input', { count: 3 });
  await A.keyboard.press('Backspace');
  await A.keyboard.press('Escape');
  // A device with none of the notes on it yet: they're fetched to be searched.
  const E = await newPage(profile, { device: 'Device E' });
  try {
    await E.goto(URL);
    await freshAuthMinute(); // (a new device signs in: after flow 32's signed requests, the next minute's allowance)
    await openVault(E, shared.newWords ?? shared.words);
    await search(E, 'pasteis');
    l = await list(E);
    if (!l.rows.some((r) => r.title === 'Lisbon trip' && r.marks.includes('Pastéis'))) throw new Error(`a new device: its notes fetched to be searched: ${JSON.stringify(l)}`);
    await wait(300);
    if (E.errors.length) throw new Error(`Device E: ${E.errors.join('; ')}`);
  } finally {
    await E.browserContext().close();
  }
}
