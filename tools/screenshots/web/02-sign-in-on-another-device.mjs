import { backToList, closeSettings, mobile, newPage, openNote, openSettings, openShare, pushedWithin, rowMenu, s, server, typeAtEnd, until, URL, LOGIN, waitStorage, waitView } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Flow 2: Sign in on another device. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow2(shared) {
  const { A, words, profile } = shared;
  let { B } = shared;
  try {
    // 2. Sign in with the 12 words (device B): "Not now" to the passkey, then add one from Settings
    B = await newPage(profile, { device: 'Device B' });
    await B.goto(LOGIN);
    await waitView(B, 'view-welcome');
    await B.click('#btn-restore');
    await waitView(B, 'view-restore');
    await B.type('#restore-input', words.join(' '));
    await s(B, '02-sign-in-1-phrase');
    await B.click('#restore-form button.primary');
    await waitView(B, 'view-passkey');
    await s(B, '02-sign-in-2-add-passkey');
    await B.click('#passkey-alt');
    await waitView(B, 'view-notes');
    await waitStorage(B);
    await s(B, '02-sign-in-3-notes');
    // Live sync: an edit on A appears on B at once (both have Groceries open).
    console.log(`  live push A → B: ${(await pushedWithin(A, B, 'Groceries', 2000)).join(', ')} ms`);
    // A goes back to another note: with Groceries open, A would get B's edit
    // pushed before the rollback scenario below deletes it from the server, and
    // would then (rightly) warn about it too.
    await openNote(A, 'Lisbon trip');
    await backToList(A);
    await backToList(B);
    await openSettings(B);
    await B.click('#settings-add-passkey');
    await until(B, () => document.querySelector('#settings-add-passkey').textContent === 'Confirm passkey');
    await s(B, '05-settings-3-add-passkey');
    await B.click('#settings-add-passkey');
    await until(B, () => document.querySelectorAll('#settings-passkey-list .setting').length === 2);
    // (On a computer the section now goes on past the pane's bottom: that edge fades, #393.)
    if (!mobile(B)) {
      await until(B, () => document.querySelector('#settings .settings-pages').dataset.more === 'below', undefined, 5000)
        .catch(async () => { throw new Error(`Settings should fade its bottom edge with more below: "${await B.evaluate(() => document.querySelector('#settings .settings-pages').dataset.more)}"`); });
    }
    await s(B, '05-settings-4-two-passkeys');
    // Rename this device's passkey (the name syncs to A, below)
    // (A click, as a person makes it: what it changes is theirs, not a layout shift, #442.)
    await (await B.evaluateHandle(() => [...document.querySelectorAll('#settings-passkey-list .setting')]
      .find((r) => r.querySelector('.setting-sub').textContent.startsWith('This device'))
      .querySelector('.setting-actions button'))).click();
    await until(B, () => document.querySelector('#settings-passkey-list input.rename'));
    await B.keyboard.down('Control');
    await B.keyboard.press('KeyA');
    await B.keyboard.up('Control');
    await B.keyboard.type('Work laptop');
    await s(B, '05-settings-5-rename');
    await B.keyboard.press('Enter');
    await until(B, () => [...document.querySelectorAll('#settings-passkey-list .setting-title')].some((t) => t.textContent === 'Work laptop'));
    await closeSettings(B);

    // A device with its clock 2 hours ahead (#58) edits a note: the time it writes is the
    // server's (this test's clock is right), not one 2 hours ahead, and it shows "just now".
    {
      const K = await newPage(profile, { device: 'A device with its clock off' });
      await K.evaluateOnNewDocument((skew) => {
        const Real = Date;
        globalThis.Date = class extends Real {
          constructor(...a) { super(...(a.length ? a : [Real.now() + skew])); }
          static now() { return Real.now() + skew; }
        };
      }, 2 * 3600_000);
      await K.goto(LOGIN);
      await waitView(K, 'view-welcome');
      await K.click('#btn-restore');
      await waitView(K, 'view-restore');
      await K.type('#restore-input', words.join(' '));
      await K.click('#restore-form button.primary');
      await waitView(K, 'view-passkey');
      await K.click('#passkey-alt');
      await waitView(K, 'view-notes');
      await openNote(K, 'Weekend');
      await typeAtEnd(K, 'x');
      await K.keyboard.press('Backspace');
      await wait(1500);
      const written = await K.evaluate(() => {
        const row = [...document.querySelectorAll('#note-list button')].find((b) => b.querySelector('.title')?.textContent === 'Weekend');
        const when = row?.querySelector('.when');
        return when && { updated: Number(when.dataset.updated), text: when.textContent };
      });
      if (!written || Math.abs(written.updated - Date.now()) > 60_000 || !written.text.startsWith('just now')) {
        throw new Error(`A device with its clock 2 hours ahead should write the server's time: ${JSON.stringify(written)}, now ${Date.now()}`);
      }
      await K.browserContext().close();
    }

    // A note deleted on one device while another, offline, edits it: it comes back on both (#54).
    {
      const title = 'Meeting notes — Q4 planning';
      const visible = (p) => p.evaluate((t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), title);
      await backToList(A);
      await openNote(B, title);
      await B.setOfflineMode(true);
      await wait(500);
      await typeAtEnd(B, ' [B, offline]');
      for (let i = 0; i < ' [B, offline]'.length; i++) await B.keyboard.press('Backspace'); // (leaves the text as it was: still edits)
      await wait(500);
      const id = await A.evaluate((t) => [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === t).dataset.id, title);
      await rowMenu(A, `#note-list li[data-id="${id}"]`);
      await A.click('#note-menu-delete');
      await until(A, (t) => ![...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), title);
      await wait(1000);
      await B.setOfflineMode(false);
      for (const p of [A, B]) {
        await until(p, (t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), title, 20000)
          .catch(async () => { throw new Error(`${p === A ? 'A' : 'B'} should have the note back: visible ${await visible(p)}`); });
      }
      const told = await Promise.all([A, B].map((p) => p.evaluate(() => !document.querySelector('#toast').hidden && document.getElementById('toast-text').textContent)));
      if (!told.some((t) => t && t.includes('was deleted on another device while it was being edited'))) throw new Error(`one of them should say why it's back: ${JSON.stringify(told)}`);
      for (const p of [A, B]) await p.evaluate(() => (document.querySelector('#toast').hidden = true));
      // B's offline edits are uploaded before the note moves on (it's shared next), and B moves off it.
      await until(B, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
      await wait(1500);
      await openNote(B, 'Lisbon trip');
      await backToList(B);
    }

    // A note shared while another device still has unsent edits to it (#119): they end up in
    // the shared note, and nothing is left of its private copy on the server.
    {
      const title = 'Weekend';
      const mark = ' [B, unsent]';
      const privRows = (id) => {
        const db = new DatabaseSync(server.db);
        const n = db.prepare('SELECT (SELECT COUNT(*) FROM updates WHERE doc_id = ?1) + (SELECT COUNT(*) FROM snapshots WHERE doc_id = ?1) AS n').get(id).n;
        db.close();
        return n;
      };
      await openNote(B, title);
      await B.setOfflineMode(true);
      await wait(500);
      await typeAtEnd(B, mark);
      await wait(500);
      await A.bringToFront();
      await backToList(A);
      const id = await A.evaluate((t) => [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === t).dataset.id, title);
      await rowMenu(A, `#note-list li[data-id="${id}"]`);
      await A.click('#note-menu-share');
      await until(A, () => document.querySelector('#share-dialog').open);
      await A.click('#share-create');
      await until(A, () => !document.querySelector('#share-on').hidden, undefined, 20000)
        .catch(async () => { throw new Error(`sharing failed: ${await A.$eval('#share-error', (e) => e.textContent)} ${A.errors.join(' | ')}`); });
      await A.keyboard.press('Escape');
      if (privRows(id)) throw new Error('after sharing, the private copy should be gone');
      // B back: its upload to the private copy is refused, and its edit moves into the share.
      await B.setOfflineMode(false);
      await wait(500); // (the dialog closing, the list marking it shared)
      await openNote(A, title);
      await until(A, (m) => document.getElementById('editor').noteText().endsWith(m), mark, 30000)
        .catch(async () => {
          const db = new DatabaseSync(server.db);
          const rows = db.prepare('SELECT share_id, COUNT(*) AS n, MAX(seq) AS seq FROM share_updates GROUP BY share_id').all();
          db.close();
          throw new Error(`B's unsent edit should reach the shared note: A ${JSON.stringify(await A.evaluate(() => document.getElementById('editor').noteText()))}, B ${JSON.stringify(await B.evaluate(() => document.getElementById('editor').noteText?.()))}, share rows ${JSON.stringify(rows)}`);
        });
      await wait(1500);
      if (privRows(id)) throw new Error(`B's late upload left ${privRows(id)} rows of the private copy on the server`);
      // Stop sharing (the private copy takes writes again): the text, B's edit too, comes back to it.
      for (let i = 0; i < mark.length; i++) await A.keyboard.press('Backspace');
      await openShare(A);
      await until(A, () => document.querySelector('#share-dialog').open && !document.querySelector('#share-on').hidden);
      await A.click('#share-stop');
      await until(A, () => !document.querySelector('#share-off').hidden, undefined, 20000);
      await A.keyboard.press('Escape');
      if (!privRows(id)) throw new Error('after stop sharing, the private copy should be back on the server');
      await openNote(B, 'Lisbon trip');
      await backToList(B);
      await backToList(A);
    }
  } finally {
    Object.assign(shared, { B });
  }
}
