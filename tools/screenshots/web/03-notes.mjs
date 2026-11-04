import { backToList, mobile, newBlankNote, openNote, s, shot, typeAtEnd, until, waitStorage, writeNotes } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 3: Notes. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow3(shared) {
  const { A } = shared;
  // 3. Notes
  await writeNotes(A);
  const written = Date.now();
  await waitStorage(A);
  if (mobile(A)) {
    await backToList(A);
    await s(A, '03-notes-1-list');
    await openNote(A, 'Lisbon trip');
    await s(A, '03-notes-2-note');
  } else {
    await openNote(A, 'Lisbon trip');
    // From its top (#530): it opens where it was left, and typing it left it scrolled a few px
    // down, as many as the typing's timing made: a different picture each run, in the README's.
    await A.evaluate(() => document.querySelector('#editor .cm-scroller').scrollTo(0, 0));
    await s(A, '03-notes-1-list');
    await A.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await shot(A, 'notes-light', { dir: '.' });
    await A.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  }
  // A new note while the upload is slow (nothing says "Saving…": only problems are shown)
  await A.cdp.send('Network.enable');
  await A.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
  await backToList(A);
  await newBlankNote(A);
  await A.keyboard.type('Weekend\n\nFarmers market, then the long walk along the river.');
  await until(A, () => document.querySelector('#save-status').dataset.state === 'saving');
  await s(A, '03-notes-3-saving');
  await A.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until(A, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
  // The list's order (#344): by last edited (as always), or by date created, from the button beside its
  // label. An older note edited (its text as it was) goes to the top by last edited, not by date created.
  // (A note's edit time moves at most every 30 s while it's edited: past that since it was written.)
  await wait(Math.max(0, 31_000 - (Date.now() - written)));
  await openNote(A, 'Reading list');
  await typeAtEnd(A, ' ');
  await A.keyboard.press('Backspace');
  await until(A, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
  await wait(500);
  await backToList(A);
  const order = () => A.evaluate(() => ({
    titles: [...document.querySelectorAll('#note-list .title')].map((t) => t.textContent),
    whens: [...document.querySelectorAll('#note-list .when')].map((t) => t.textContent),
    label: document.getElementById('notes-sort-label').textContent,
  }));
  await until(A, () => document.querySelector('#note-list .title')?.textContent === 'Reading list');
  if ((await order()).label !== 'Last edited') throw new Error(`the list's order should start as Last edited: ${JSON.stringify(await order())}`);
  // A click opens it with no item ringed (the menu itself focused); the keyboard, on the order in use.
  await A.click('#notes-sort');
  await until(A, () => !document.getElementById('sort-menu').hidden && document.activeElement?.id === 'sort-menu'
    && document.getElementById('notes-sort').getAttribute('aria-expanded') === 'true');
  await A.keyboard.press('Escape');
  await until(A, () => document.getElementById('sort-menu').hidden && document.activeElement?.id === 'notes-sort');
  await A.keyboard.press('Enter');
  await until(A, () => !document.getElementById('sort-menu').hidden && document.activeElement?.dataset.sort === 'edited');
  const sizes = await A.evaluate(() => ({ button: document.getElementById('notes-sort').getBoundingClientRect().height,
    rows: [...document.querySelectorAll('#sort-menu [data-sort]')].map((b) => b.offsetHeight) })); // (offsetHeight: not mid pop-in, scaled)
  if (mobile(A) && (sizes.button < 44 || sizes.rows.some((h) => h < 48))) throw new Error(`the sort button and menu are too small to tap: ${JSON.stringify(sizes)}`);
  await shot(A, '03-notes-8-sort-menu', { via: 'the order’s button', focused: true });
  // From the keyboard: down to Date created, Enter; the menu closes, the focus back on its button.
  await A.keyboard.press('ArrowDown');
  await until(A, () => document.activeElement?.dataset.sort === 'created');
  await A.keyboard.press('Enter');
  await until(A, () => document.getElementById('sort-menu').hidden && document.activeElement?.id === 'notes-sort'
    && document.getElementById('notes-sort-label').textContent === 'Date created');
  const created = await order();
  if (created.titles[0] !== 'Weekend' || created.titles.indexOf('Reading list') < 1 || !created.whens.every((w) => w.startsWith('Created today'))) {
    throw new Error(`by date created: ${JSON.stringify(created)}`);
  }
  if ((await A.evaluate(() => localStorage.getItem('tiro-sort'))) !== 'created') throw new Error('the order should be kept on this device');
  await s(A, '03-notes-9-by-created', 'Date created');
  // And back, with a click.
  await A.click('#notes-sort');
  await until(A, () => !document.getElementById('sort-menu').hidden);
  await A.click('#sort-menu [data-sort="edited"]');
  await until(A, () => document.querySelector('#note-list .title')?.textContent === 'Reading list'
    && !document.querySelector('#note-list .when').textContent.startsWith('Created'));
  // The rows' dates go on with time (#532): "just now" becomes "5 min ago" without the list being
  // drawn again. (A row's time set 5 minutes back, then the page looked at again: said anew, at once;
  // the rest of its line, as it was.)
  const aged = await A.evaluate(() => {
    const when = document.querySelector('#note-list li[data-id] .when');
    const ago = when.querySelector('.ago');
    const before = { ago: ago.textContent, rest: when.textContent.slice(ago.textContent.length) };
    ago.dataset.at = String(Number(ago.dataset.at) - 5 * 60_000);
    document.dispatchEvent(new Event('visibilitychange'));
    return { before, ago: ago.textContent, rest: when.textContent.slice(ago.textContent.length), hidden: document.hidden };
  });
  if (aged.hidden || aged.before.ago !== 'just now' || aged.ago !== '5 min ago' || aged.rest !== aged.before.rest) throw new Error(`a row's date, 5 minutes on: ${JSON.stringify(aged)}`);
}
