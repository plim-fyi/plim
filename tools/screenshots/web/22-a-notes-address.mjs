import { backToList, mobile, openNote, rowMenu, s, server, startServer, stopServer, unlockWithPasskey, until, waitView } from './harness.mjs';

/** Flow 22: A note's address. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow22(shared) {
  const { A } = shared;
  // 22. Every note has an address (#299): /n/<id> in the bar while it's open, opening the note
  // again after a lock or a reload; Back and Forward move between notes (and the list, on a
  // phone); Copy link, in a row's menu and the note's ⋮, copies it; an address that opens no
  // note of yours says so, your notes still there; a bookmarked note opens with no connection
  // (the service worker serves the app for /n/*).
  await A.bringToFront();
  await openNote(A, 'Groceries', { edit: false });
  const openId = () => A.evaluate(() => document.querySelector('#note-list li > button[aria-current="true"]')?.closest('li').dataset.id ?? null);
  const id = await openId();
  if (!id) throw new Error('the open note should be marked in the list');
  const path = () => A.evaluate(() => location.pathname);
  if ((await path()) !== `/n/${id}`) throw new Error(`the address should be the note's: ${await path()}`);
  /** The page at `want.path`, with the note `want.id` open (or none, and the list on a phone). */
  const at = (want) => until(A, (w) => {
    const open = document.querySelector('#note-list li > button[aria-current="true"]')?.closest('li').dataset.id ?? null;
    const shown = !document.getElementById('reading').hidden || !document.getElementById('editor').hidden;
    return location.pathname === w.path && (w.id ? open === w.id && shown : !open && !document.querySelector('.notes').classList.contains('editing'));
  }, want, 15000).catch(async () => {
    const got = await A.evaluate(() => ({
      path: location.pathname, open: document.querySelector('#note-list li > button[aria-current="true"]')?.closest('li').dataset.id ?? null,
      reading: !document.getElementById('reading').hidden, editor: !document.getElementById('editor').hidden, editing: document.querySelector('.notes').classList.contains('editing'),
      empty: document.getElementById('empty-text').textContent, listed: document.querySelectorAll('#note-list li[data-id]').length, offline: !document.getElementById('offline-bar').hidden,
    }));
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  });

  // Copy link (the row's menu; the note's ⋮ has it too): the address goes to the clipboard.
  await A.evaluate(() => { navigator.clipboard.writeText = (t) => { window.copied = t; return Promise.resolve(); }; });
  await backToList(A);
  await rowMenu(A, `#note-list li[data-id="${id}"]`);
  await A.click('#note-menu-link');
  await until(A, () => window.copied, undefined, 5000).catch(() => { throw new Error('Copy link should copy'); });
  const copied = await A.evaluate(() => window.copied);
  const origin = await A.evaluate(() => location.origin);
  if (copied !== `${origin}/n/${id}`) throw new Error(`Copy link copied ${copied}`);
  await until(A, () => document.getElementById('toast-text').textContent === 'Link copied');
  await s(A, '22-address-1-copied');

  // The address, opened afresh: locked, then the note (the address is kept through the unlock).
  await A.goto(`${server.url}/n/${id}`);
  await waitView(A, 'view-locked');
  await unlockWithPasskey(A);
  await at({ path: `/n/${id}`, id });
  // Another note, then Back and Forward: the address and the note follow each other (on a
  // phone, through the list: Back from a note is a step too).
  await openNote(A, 'Packing', { edit: false });
  const packing = await openId();
  await A.goBack();
  if (mobile(A)) {
    await at({ path: '/', id: null });
    await A.goBack();
  }
  await at({ path: `/n/${id}`, id });
  await A.goForward();
  if (mobile(A)) await at({ path: '/', id: null });
  else await at({ path: `/n/${packing}`, id: packing });

  // An address that opens no note of yours (deleted, someone else's, mistyped: all the same): said so, the notes still there.
  await A.goto(`${server.url}/n/0d4c6f2e-1b7a-4c3d-9e8f-123456789abc`);
  await waitView(A, 'view-locked');
  await unlockWithPasskey(A);
  await until(A, () => !document.getElementById('empty').hidden && document.getElementById('empty-text').textContent.includes('no note of yours'), undefined, 15000)
    .catch(() => { throw new Error('an address that opens no note of yours should say so'); });
  if (!(await A.evaluate(() => document.querySelectorAll('#note-list li[data-id]').length))) throw new Error('your notes should still be listed');
  if (await A.evaluate(() => document.getElementById('empty-reload').hidden === false)) throw new Error('nothing to reload for');
  await s(A, '22-address-2-not-yours');
  await backToList(A);
  await A.evaluate(() => document.getElementById('notes-more').hidden || document.getElementById('notes-more').click()); // (the whole list: the page was reloaded)
  await openNote(A, 'Groceries', { edit: false });
  await at({ path: `/n/${id}`, id });

  // With no connection, a bookmarked note still opens: the app from the service worker, the note from this device's copy.
  await stopServer();
  await A.goto(`${server.url}/n/${id}`);
  await waitView(A, 'view-locked');
  await until(A, () => !document.querySelector('#locked-offline').hidden, undefined, 10000);
  await unlockWithPasskey(A);
  await at({ path: `/n/${id}`, id });
  if (!(await A.evaluate(() => document.getElementById('editor').noteText().includes('Groceries')))) throw new Error("the note's text should be there offline");
  await s(A, '22-address-3-offline');
  await startServer();
  await until(A, () => document.querySelector('#offline-bar').hidden, undefined, 30000);
  await backToList(A);
}
