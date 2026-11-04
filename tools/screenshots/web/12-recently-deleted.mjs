import { accountMenu, backToList, closeSettings, mobile, openNote, openSettings, row, rowMenu, s, server, until } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Flow 12: Recently deleted. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow12(shared) {
  const { A } = shared;
  let { pid, acct, forever, keptRows } = shared;
  try {
    // 12. Trash: delete with Undo, Recently deleted, Delete forever (removes it from the server)
    await backToList(A);
    pid = await A.evaluate(() => [...document.querySelectorAll('#note-list li')]
      .find((li) => li.querySelector('.title')?.textContent === 'Project ideas').dataset.id);
    // A row's menu: right-click (on a phone, a long press).
    await rowMenu(A, row(pid));
    if (!(await A.$eval('#note-menu-share', (e) => !e.hidden))) throw new Error('a row\u2019s menu should offer Share…');
    await s(A, '03-notes-4-row-menu');
    await A.click('#note-menu-delete');
    await until(A, () => !document.querySelector('#toast').hidden);
    await s(A, '12-trash-1-undo');
    await A.click('#toast-action');
    await until(A, (sel) => document.querySelector(sel), row(pid));
    await wait(400); // restored at the top: let the rows finish sliding before clicking one
    // This time from the open note: the ⋮ in its bar (no Share there: it's beside it; on a phone, it's in there).
    await openNote(A, 'Project ideas');
    await A.click('#note-more');
    await until(A, (phone) => !document.getElementById('note-menu').hidden && document.getElementById('note-menu-share').hidden !== phone, mobile(A));
    await A.click('#note-menu-delete');
    await wait(400); // (the rows below slide up)
    await backToList(A);
    // Recently deleted: above the notes, with the count beside it.
    await until(A, () => document.getElementById('trash-count').textContent === '1' && !document.getElementById('trash-count').hidden);
    await A.evaluate(() => (document.querySelector('#toast').hidden = true));
    await accountMenu(A);
    // Your menu: a gear for Settings, then a line, then Log out with its icon (not red: nothing is lost).
    acct = await A.evaluate(() => {
      const out = document.getElementById('btn-logout');
      return { icons: ['btn-settings', 'btn-logout'].map((id) => document.querySelector(`#${id} svg.icon`)?.getBoundingClientRect().width ?? 0),
        line: Boolean(document.querySelector('#account-menu .menu-sep + #btn-logout')),
        red: getComputedStyle(out).color === getComputedStyle(document.querySelector('#note-menu-delete')).color };
    });
    if (acct.icons.some((w) => w < 10) || !acct.line || acct.red) throw new Error(`your menu's icons: ${JSON.stringify(acct)}`);
    await s(A, '03-notes-5-account-menu');
    await A.keyboard.press('Escape');
    // A click outside a dialog closes it, as Escape does (#175); a click on its padding, or a drag
    // that starts inside it, doesn't; with Delete account over Settings, only the top one closes.
    {
      const isOpen = (id) => A.$eval(`#${id}`, (d) => d.open);
      /** A point on the backdrop: above the dialog, or below it (null: the dialog fills the screen). */
      const outsidePoint = (id) => A.$eval(`#${id}`, (d) => {
        const r = d.getBoundingClientRect();
        if (r.top > 12) return { x: r.left + r.width / 2, y: r.top / 2 };
        if (innerHeight - r.bottom > 12) return { x: r.left + r.width / 2, y: (r.bottom + innerHeight) / 2 };
        return null;
      });
      const clickOutside = async (id) => {
        const pt = await outsidePoint(id);
        if (!pt) throw new Error(`#${id} fills the screen: no outside to click`);
        await A.mouse.click(pt.x, pt.y);
        await wait(300);
      };
      await openSettings(A, 'account');
      const corner = await A.$eval('#settings', (d) => { const r = d.getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; });
      await A.mouse.click(corner.x, corner.y); // (its padding)
      await wait(300);
      if (!(await isOpen('settings'))) throw new Error('a click on a dialog\'s padding closed it');
      const from = await A.$eval('#settings-delete', (b) => { const r = b.getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; });
      const to = await outsidePoint('settings');
      if (to) {
        await A.mouse.move(from.x, from.y);
        await A.mouse.down();
        await A.mouse.move(to.x, to.y, { steps: 5 });
        await A.mouse.up();
        await wait(300);
        if (!(await isOpen('settings'))) throw new Error('a drag from inside Settings to outside it closed it');
      }
      await A.click('#settings-delete');
      await until(A, () => document.querySelector('#delete-dialog').open);
      await clickOutside('delete-dialog');
      if ((await isOpen('delete-dialog')) || !(await isOpen('settings'))) throw new Error('a click outside Delete account should close it, and only it');
      if (to) {
        await clickOutside('settings');
        if (await isOpen('settings')) throw new Error('a click outside Settings should close it');
      } else {
        await closeSettings(A);
      }
    }
    // Recently deleted (#190): a place, in the notes' place in the sidebar (All notes back); the
    // deleted note shown in the note's place as a page, read-only, with Restore and Delete forever.
    // A computer shows the newest on the way in; a phone lists them, and a tap shows one.
    const trashShown = (id) => A.evaluate((id) => !document.getElementById('trash-view').hidden
      && document.querySelector(`#trash-list li[data-id="${id}"] button, #trash-forever li[data-id="${id}"] button`)?.getAttribute('aria-current') === 'true', id);
    const showTrashed = async (id, shot) => {
      await A.click(mobile(A) ? '#btn-trash-foot' : '#btn-trash'); // (a phone: at the end of the list, #539)
      await until(A, (sel) => document.getElementById('view-notes').classList.contains('trash-mode') && document.querySelector(sel), `#trash-list li[data-id="${id}"], #trash-forever li[data-id="${id}"]`);
      if (mobile(A)) {
        if (!(await A.evaluate(() => document.getElementById('trash-view').hidden))) throw new Error('on a phone, Recently deleted should open on its list');
        if (shot) await s(A, shot);
        await A.click(`#trash-list li[data-id="${id}"] button, #trash-forever li[data-id="${id}"] button`);
      }
      for (let i = 0; i < 50 && !(await trashShown(id)); i++) await wait(100);
      if (!(await trashShown(id))) throw new Error('the deleted note should be shown');
    };
    await showTrashed(pid, '12-trash-4-list');
    await until(A, () => document.querySelector('#trash-page').textContent.includes('offline mode'));
    const trashView = await A.evaluate(() => {
      const r = document.getElementById('trash-restore').getBoundingClientRect();
      const shown = (id) => Boolean(document.getElementById(id).offsetParent);
      return { title: document.getElementById('note-title').textContent, when: document.getElementById('trash-when').textContent,
        label: document.getElementById('notes-label').textContent, allNotes: shown('tag-clear'), notes: shown('note-list'),
        editor: shown('editor') || shown('reading'), menu: shown('note-more'), page: document.getElementById('trash-page').textContent,
        editable: Boolean(document.querySelector('#trash-page [contenteditable="true"], #trash-page input:not([disabled])')),
        restore: { h: r.height, inView: r.top >= 0 && r.bottom <= innerHeight }, purge: shown('trash-purge') };
    });
    if (trashView.title !== 'Project ideas' || !/^Deleted .+ · deleted for good in 30 days\. Restore it to edit it\.$/.test(trashView.when) || trashView.label !== 'Recently deleted'
      || (!trashView.allNotes && !mobile(A)) || trashView.notes || trashView.editor || trashView.menu || !trashView.page.startsWith('Project ideas') || trashView.editable
      || !trashView.restore.inView || !trashView.purge || (mobile(A) && trashView.restore.h < 44)) {
      throw new Error(`Recently deleted, a note shown: ${JSON.stringify(trashView)}`);
    }
    await s(A, '12-trash-2-recently-deleted');
    // Restore: back in your notes (a toast, with Open), gone from here, which says it's empty.
    await A.click('#trash-restore');
    await until(A, (sel) => !document.querySelector(sel) && document.getElementById('toast-text').textContent === 'Restored “Project ideas”'
      && document.getElementById('toast-action').textContent === 'Open', `#trash-list li[data-id="${pid}"]`);
    if (!(await A.$eval('#trash-count', (e) => e.hidden))) throw new Error('the count should be gone with nothing deleted');
    await until(A, () => document.querySelector('#trash-list .list-empty')?.textContent === 'Nothing in Recently deleted');
    if (!mobile(A)) await until(A, () => document.getElementById('trash-message-title').textContent === 'Nothing in Recently deleted');
    // All notes: back to your notes, the restored one among them.
    await A.click('#tag-clear');
    await until(A, (sel) => !document.getElementById('view-notes').classList.contains('trash-mode') && document.querySelector(sel)
      && document.getElementById('trash-view').hidden && document.getElementById('notes-label').textContent === 'Notes', row(pid));
    // Delete it again, and this time delete it forever (no "are you sure": it can be undone).
    await rowMenu(A, row(pid));
    await A.click('#note-menu-delete');
    await wait(400);
    await A.evaluate(() => (document.querySelector('#toast').hidden = true));
    await backToList(A);
    await showTrashed(pid);
    await A.click('#trash-purge');
    await until(A, (sel) => !document.querySelector(sel) && document.getElementById('toast-text').textContent === 'Deleted “Project ideas” forever', `#trash-list li[data-id="${pid}"]`);
    {
      const db = new DatabaseSync(server.db);
      const left = db.prepare('SELECT (SELECT COUNT(*) FROM updates WHERE doc_id = ?1) + (SELECT COUNT(*) FROM snapshots WHERE doc_id = ?1) AS n').get(pid).n;
      db.close();
      if (left) throw new Error(`"Delete forever" left ${left} rows of the note on the server`);
    }
    keptRows = () => {
      const db = new DatabaseSync(server.db);
      const n = db.prepare('SELECT (SELECT COUNT(*) FROM updates WHERE doc_id = ?1) + (SELECT COUNT(*) FROM snapshots WHERE doc_id = ?1) AS n').get(pid).n;
      db.close();
      return n;
    };
    // Undo: back in Recently deleted, its data on the server again.
    await A.click('#toast-action');
    await until(A, (sel) => document.querySelector(sel), `#trash-list li[data-id="${pid}"]`, 15000);
    if (!keptRows()) throw new Error('Undo after "Delete forever" should bring its data back to the server');
    // Deleted forever, the server keeps it 30 days (#253): under "Deleted forever", with Restore only
    // (its text isn't here any more, and the pane says so); Restore brings it back, with its text.
    // (Still in Recently deleted: a phone on its list, a computer showing it again.)
    if (mobile(A)) await A.click(`#trash-list li[data-id="${pid}"] button`);
    else {
      for (let i = 0; i < 50 && !(await trashShown(pid)); i++) await wait(100);
      if (!(await trashShown(pid))) await A.click(`#trash-list li[data-id="${pid}"] button`);
    }
    await until(A, (id) => document.querySelector(`#trash-list li[data-id="${id}"] button`)?.getAttribute('aria-current') === 'true' && !document.getElementById('trash-purge').disabled, pid);
    await A.click('#trash-purge');
    forever = `#trash-forever li[data-id="${pid}"]`;
    await until(A, (sel) => document.querySelector(sel) && !document.getElementById('trash-forever-section').hidden, forever);
    if (keptRows()) throw new Error('deleted forever, the note is still on the server');
    await A.click(`${forever} button`);
    await until(A, () => document.getElementById('trash-message-title').textContent === 'Its text is no longer on this device'
      && document.getElementById('trash-purge').hidden && !document.getElementById('trash-restore').hidden);
    // (A toast that's up stays clear of a phone's Restore bar.)
    const clear = await A.evaluate(() => document.getElementById('toast').hidden
      || document.getElementById('toast').getBoundingClientRect().bottom <= document.querySelector('.trash-actions').getBoundingClientRect().top + 1
      || document.querySelector('.trash-actions').getBoundingClientRect().bottom <= document.getElementById('toast').getBoundingClientRect().top);
    if (!clear) throw new Error('the toast covers Restore');
    await s(A, '12-trash-3-deleted-forever');
    await A.click('#trash-restore');
    await until(A, (sel) => !document.querySelector(sel) && document.getElementById('toast-text').textContent === 'Restored “Project ideas”', forever);
    if (!keptRows()) throw new Error('a note restored from "Deleted forever" has nothing on the server');
    // Open, from its toast: your notes, the note open with its text.
    await A.click('#toast-action');
    await until(A, () => !document.getElementById('view-notes').classList.contains('trash-mode') && document.getElementById('editor').noteText?.().includes('offline mode'));
    await backToList(A);
    // Deleted forever again, for what follows.
    await rowMenu(A, row(pid));
    await A.click('#note-menu-delete');
    await wait(400);
    await A.evaluate(() => (document.querySelector('#toast').hidden = true));
    await backToList(A);
    await showTrashed(pid);
    await A.click('#trash-purge');
    await until(A, (sel) => !document.querySelector(sel), `#trash-list li[data-id="${pid}"]`);
    if (keptRows()) throw new Error('deleted forever again, the note is still on the server');
    if (mobile(A)) await until(A, () => document.getElementById('trash-view').hidden);
    await A.click('#tag-clear');
    await until(A, () => !document.getElementById('view-notes').classList.contains('trash-mode'));
    await wait(300);
  } finally {
    Object.assign(shared, { pid, acct, forever, keptRows });
  }
}
