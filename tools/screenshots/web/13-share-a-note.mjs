import { backToList, mobile, newPage, openNote, rowMenu, s, server, setView, titleClear, typeAtEnd, until, URL } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Flow 13: Share a note. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow13(shared) {
  const { A, B, profile } = shared;
  // 13. Share a note (#70): links, the note on another device, replace the links, stop sharing
  {
    const title = 'Meeting notes — Q4 planning';
    const rowOf = (p, t) => p.evaluate((t) => [...document.querySelectorAll('#note-list li:not(.trashed)')].find((li) => li.querySelector('.title')?.textContent === t)?.dataset.id, t);
    await A.bringToFront();
    await backToList(A);
    const nid = await rowOf(A, title);
    await rowMenu(A, `#note-list li[data-id="${nid}"]`);
    await until(A, () => !document.querySelector('#note-menu-share').hidden);
    await A.click('#note-menu-share');
    await until(A, () => document.querySelector('#share-dialog').open);
    await wait(250);
    await s(A, '13-share-1-dialog');
    await A.click('#share-create');
    await until(A, () => !document.querySelector('#share-on').hidden, undefined, 20000);
    const firstLink = await A.$eval('#share-edit-link', (e) => e.value);
    const readOnlyLink = await A.$eval('#share-read-link', (e) => e.value);
    // The links are the note's address with the key after the # (#299): /n/<note id>#k=<share id>.e.… and …r.…
    const noteAddress = `/n/${nid}#k=`;
    if (!firstLink.includes(`${noteAddress}`) || !/#k=[0-9a-f]{32}\.e\./.test(firstLink) || !readOnlyLink.includes(noteAddress) || !/#k=[0-9a-f]{32}\.r\./.test(readOnlyLink)) {
      throw new Error(`unexpected links: ${firstLink} ${readOnlyLink}`);
    }
    await s(A, '13-share-2-links');
    // Links for people (#369): one of their own each, behind "A link for someone…". Sam can edit, Alex
    // only view; they're listed under "Who has this note", their links (Copy link) the note's address
    // with `#h=<holder>.<secret>`, opening the note's page for a guest.
    await A.evaluate(() => { navigator.clipboard.writeText = (t) => { window.copied = t; return Promise.resolve(); }; });
    const addPerson = async (name, role) => {
      if (await A.evaluate(() => document.getElementById('share-person').hidden)) {
        // (A click, as a person makes it: the dialog growing is theirs, not a layout shift, #442.)
        await (await A.evaluateHandle(() => [...document.querySelectorAll('#share-dialog [data-someone]')].find((b) => b.offsetParent))).click();
        await until(A, () => !document.getElementById('share-person').hidden);
      }
      await A.type('#share-person-name', name);
      await A.select('#share-person-role', role);
      await A.click('#share-person-go');
      await until(A, (n) => [...document.querySelectorAll('#share-holders .share-holder-name')].some((e) => e.textContent === n) && !document.querySelector('#share-dialog').dataset.busy, name, 20000);
      if (!(await A.evaluate(() => document.getElementById('share-person').hidden && !document.getElementById('share-who').hidden))) throw new Error('a link added: the form closes, and they show under "Who has this note"');
      return A.evaluate(async (n) => {
        [...document.querySelectorAll('#share-holders .share-holder')].find((li) => li.querySelector('.share-holder-name').textContent === n).querySelector('[data-copy-holder]').click();
        await new Promise((r) => setTimeout(r, 50));
        return window.copied;
      }, name);
    };
    const samLink = await addPerson('Sam', 'edit');
    const alexLink = await addPerson('Alex', 'read');
    if (!samLink.startsWith(`${URL.replace(/\/$/, '')}/n/${nid}#h=`) || !/#h=[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(samLink) || samLink === alexLink) throw new Error(`people's links: ${samLink} ${alexLink}`);
    await s(A, '13-share-2b-people');
    const holderStatus = (link) => A.evaluate(async (link) => {
      const s = await import('/core/share.js');
      const u = new URL(link);
      const p = s.parseHolderLink(u.pathname, u.hash);
      const r = await fetch(`/api/holders/${p.holderId}`, { headers: { 'x-holder-token': s.holderTokenHex(await s.holderKeys(p.secret)) } });
      return r.status;
    }, link);
    // A guest with Sam's link: the note's page, editable; with Alex's, view only.
    const G = await newPage(profile, { device: 'Sam (a guest)' });
    await G.goto(samLink);
    await until(G, () => document.getElementById('guest-mode')?.textContent === 'You can edit' && document.getElementById('editor').noteText?.().includes('roadmap'), undefined, 20000);
    await s(G, '13-share-2c-sam');
    await G.goto(alexLink);
    await until(G, () => document.getElementById('guest-mode')?.textContent === 'View only', undefined, 20000);
    await A.keyboard.press('Escape');
    // The note now lives in its share; the private copy is gone from the server.
    {
      const db = new DatabaseSync(server.db);
      const priv = db.prepare('SELECT (SELECT COUNT(*) FROM updates WHERE doc_id = ?1) + (SELECT COUNT(*) FROM snapshots WHERE doc_id = ?1) AS n').get(nid).n;
      const shared = db.prepare('SELECT COUNT(*) AS n FROM share_updates').get().n;
      db.close();
      if (priv || !shared) throw new Error(`after sharing: ${priv} private rows (want 0), ${shared} share rows (want > 0)`);
    }
    // Device B: marked shared, opens with its text, and edits flow both ways.
    await until(B, (t) => [...document.querySelectorAll('#note-list li')].some((li) => li.querySelector('.title')?.textContent === t && li.querySelector('.when').textContent.includes('Shared')), title, 20000);
    await openNote(B, title);
    await until(B, () => document.getElementById('editor').noteText().includes('roadmap'));
    await typeAtEnd(B, '\n- budget (added on B, in the share)');
    await openNote(A, title);
    await until(A, () => document.getElementById('editor').noteText().includes('added on B'), undefined, 20000);

    // Editing together: the other device's cursor shows with its name; and what it changes
    // above the screen doesn't move what you're looking at — in the editor (CodeMirror keeps
    // the text under the eye still), and on a phone's page (#283).
    {
      const many = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the long part.`).join('\n');
      await typeAtEnd(A, `\n${many}`);
      await until(B, () => document.getElementById('editor').noteText().includes('Line 60 of'), undefined, 20000);
      await B.evaluate(() => {
        const ta = document.querySelector('#editor textarea');
        if (ta) { ta.focus(); ta.setSelectionRange(12, 12); return; }
        const v = document.querySelector('#editor .cm-content').cmTile.view; v.focus(); v.dispatch({ selection: { anchor: 12 } });
      });
      if (!mobile(A)) {
        await until(A, () => document.querySelector('#editor .cm-ySelectionCaret'), undefined, 10000).catch(() => { throw new Error("B's cursor should show on A"); });
        await A.evaluate(() => { const v = document.querySelector('#editor .cm-content').cmTile.view; v.scrollDOM.scrollTop = 0; });
        await wait(400);
        await titleClear(A, 'the owner, B in the note');
        await s(A, '13-share-3-together');
      } else {
        // A phone draws the others' cursors over its textarea (#302): B's, where B's cursor is, with B's name.
        await until(A, () => document.querySelector('#editor .peer-caret'), undefined, 10000).catch(() => { throw new Error("B's cursor should show on A's phone"); });
        await A.evaluate(() => (document.querySelector('#editor textarea').scrollTop = 0));
        await wait(300);
        const caret = await A.evaluate(() => {
          const c = document.querySelector('#editor .peer-caret'), ta = document.querySelector('#editor textarea');
          return { top: c.getBoundingClientRect().top - ta.getBoundingClientRect().top, want: document.getElementById('editor').caretTop(12) - ta.scrollTop, name: c.textContent };
        });
        if (Math.abs(caret.top - caret.want) > 2 || !caret.name) throw new Error(`B's cursor on A's phone: ${JSON.stringify(caret)}`);
        await s(A, '13-share-3-together');
      }
      // In Preview (#302): B as a marker beside the block B's cursor is in, following it; a block B
      // changes lights up. (And in Split, on a computer: the marker on the page, the cursor in the editor.)
      {
        await setView(A, 'preview');
        const markIn = (text) => A.evaluate((t) => {
          const m = document.querySelector('#reading .peer');
          if (!m) return 'no marker';
          const block = [...document.querySelectorAll('#reading [data-from]')].find((b) => b.textContent.includes(t) && !b.querySelector('[data-from]'));
          const mt = m.getBoundingClientRect().top, b = block.getBoundingClientRect();
          return mt >= b.top - 2 && mt <= b.bottom ? 'ok' : `the marker at ${Math.round(mt)}, the block ${Math.round(b.top)}–${Math.round(b.bottom)}`;
        }, text);
        await until(A, () => document.querySelector('#reading .peer'), undefined, 10000).catch(() => { throw new Error("B should show on A's page"); });
        const first = await markIn('Meeting notes');
        if (first !== 'ok') throw new Error(`B's marker, B's cursor in the first line: ${first}`);
        await B.bringToFront();
        await B.evaluate(() => {
          const at = document.getElementById('editor').noteText().indexOf('Line 30 of');
          const ta = document.querySelector('#editor textarea');
          if (ta) { ta.focus(); ta.setSelectionRange(at, at); ta.dispatchEvent(new Event('select')); return; }
          const v = document.querySelector('#editor .cm-content').cmTile.view; v.focus(); v.dispatch({ selection: { anchor: at } });
        });
        await B.keyboard.type('Q');
        await A.bringToFront();
        await until(A, () => document.querySelector('#reading .just-changed')?.textContent.includes('QLine 30'), undefined, 10000)
          .catch(() => { throw new Error("the block B changed should light up on A's page"); });
        await until(A, () => document.querySelector('#reading .peer'), undefined, 5000);
        const moved = await markIn('QLine 30');
        if (moved !== 'ok') throw new Error(`B's marker should follow B's cursor: ${moved}`);
        await s(A, '13-share-4-others-in-preview');
        if (!mobile(A)) {
          await setView(A, 'split');
          await until(A, () => document.querySelector('#reading .peer') && document.querySelector('#editor .cm-ySelectionCaret'), undefined, 10000)
            .catch(() => { throw new Error('in Split, B on the page and in the editor'); });
          // (Beside the text, in the margin: not where Preview's wider page had it, over the text, #320.)
          const margin = () => A.evaluate(() => {
            const m = document.querySelector('#reading .peer').getBoundingClientRect();
            const col = [...document.querySelector('#reading').children].find((c) => !c.classList.contains('layer')).getBoundingClientRect();
            return { right: Math.round(m.right), column: Math.round(col.left) };
          });
          for (const view of ['split', 'preview', 'split']) {
            await setView(A, view);
            await wait(300);
            const m = await margin();
            if (m.right > m.column) throw new Error(`in ${view}, B's marker should be left of the text: ${JSON.stringify(m)}`);
          }
        }
        await setView(A, 'edit');
        await B.bringToFront();
        await B.keyboard.press('Backspace'); // (the note as it was)
        await until(A, () => !document.getElementById('editor').noteText().includes('QLine 30'), undefined, 10000);
      }
      // The editor scrolled to its end; where its last line is drawn — or, in a textarea (#290), where
      // it's scrolled to against its height (the text under the eye stays if both move together).
      const scroller = () => document.querySelector('#editor textarea') ?? document.querySelector('#editor .cm-scroller');
      const view = (p) => p.evaluate((f) => { const s = eval(f)(); s.scrollTop = s.scrollHeight; return 0; }, scroller.toString());
      const lastLineTop = (p) => p.evaluate((f) => {
        const s = eval(f)();
        if (s.tagName === 'TEXTAREA') { const c = document.querySelector('#editor textarea'); c.setSelectionRange(c.value.length, c.value.length); return Math.round(s.scrollHeight - s.scrollTop); }
        const v = document.querySelector('#editor .cm-content').cmTile.view; return Math.round(v.coordsAtPos(v.state.doc.length)?.top ?? -1);
      }, scroller.toString());
      // (Under the first line, which is the note's title: later steps find the note by it.)
      const insertAbove = (tag) => A.evaluate((tag) => { const y = document.getElementById('editor').noteYText(); const at = y.toString().indexOf('\n'); y.insert(at, '\n' + Array.from({ length: 10 }, (_, i) => `${tag} ${i + 1}`).join('\n')); }, tag);
      await view(B);
      await wait(400);
      const before = await lastLineTop(B);
      await insertAbove('Above');
      await until(B, () => document.getElementById('editor').noteText().includes('\nAbove 10\n'), undefined, 10000);
      await wait(500);
      const after = await lastLineTop(B);
      if (before < 0 || Math.abs(after - before) > 2) throw new Error(`B's editor moved when A inserted lines above the screen: the last line was at ${before}px, now ${after}px`);
      {
        // In Preview (#302): scrolled to its end, the last paragraph stays put as lines arrive above.
        await setView(B, 'preview');
        await B.evaluate(() => { const r = document.getElementById('reading'); r.scrollTop = r.scrollHeight; });
        await wait(300);
        const lastParaTop = () => B.evaluate(() => Math.round([...document.querySelectorAll('#reading p')].at(-1).getBoundingClientRect().top));
        const pBefore = await lastParaTop();
        await insertAbove('Higher');
        await until(B, () => document.getElementById('reading').textContent.includes('Higher 10'), undefined, 10000);
        await wait(500);
        const pAfter = await lastParaTop();
        if (Math.abs(pAfter - pBefore) > 2) throw new Error(`B's page moved when A inserted lines above the screen: the last paragraph was at ${pBefore}px, now ${pAfter}px`);
        await setView(B, 'edit');
      }
    }

    // Replace the links: new ones work, the old one doesn't.
    const status = (link) => A.evaluate(async (link) => {
      const s = await import('/core/share.js');
      const u = new URL(link);
      const parsed = s.parseShareLink(u.pathname, u.hash);
      const keys = await s.keysFromLink(parsed);
      const r = await fetch(`/api/shares/${parsed.shareId}`, { headers: { 'x-share-token': s.readTokenHex(keys) } });
      return r.status;
    }, link);
    await backToList(A);
    await rowMenu(A, `#note-list li[data-id="${nid}"]`);
    await A.click('#note-menu-share');
    await until(A, () => document.querySelector('#share-dialog').open && !document.querySelector('#share-on').hidden);
    // If turning the old links off fails (here: a 502 from a proxy), nothing changes, and the dialog says so.
    const failNextShareDelete = async (p) => {
      await p.setRequestInterception(true);
      const handler = (req) => {
        if (req.method() !== 'DELETE' || !req.url().includes('/api/shares/')) return req.continue();
        p.off('request', handler);
        req.respond({ status: 502, contentType: 'text/html', body: 'Bad gateway' });
        p.setRequestInterception(false).catch(() => {});
      };
      p.on('request', handler);
    };
    for (const [button, what] of [['#share-replace', 'replacing'], ['#share-stop', 'stopping']]) {
      await failNextShareDelete(A);
      await A.click(button); // the confirm box is accepted
      await until(A, () => document.getElementById('share-error').textContent.includes('Couldn’t turn off the current links'), undefined, 20000);
      const still = await A.$eval('#share-edit-link', (e) => e.value);
      if (still !== firstLink || (await status(firstLink)) !== 200) throw new Error(`a failed ${what}: the links should be unchanged and still working`);
    }
    await A.click('#share-replace'); // the confirm box is accepted
    await until(A, (old) => document.querySelector('#share-edit-link').value !== old, firstLink, 20000);
    const newLink = await A.$eval('#share-edit-link', (e) => e.value);
    if ((await status(firstLink)) !== 404 || (await status(newLink)) !== 200) throw new Error('replaced links: the old one should be gone, the new one working');
    await until(A, () => document.getElementById('editor').noteText().includes('added on B'));
    // People's own links follow the note (#369): Sam's and Alex's still open it, in the new share.
    if ((await holderStatus(samLink)) !== 200 || (await holderStatus(alexLink)) !== 200) throw new Error("replaced links: people's own links should keep working");
    await G.goto(samLink);
    await until(G, () => document.getElementById('guest-mode')?.textContent === 'You can edit' && document.getElementById('editor').noteText?.().includes('added on B'), undefined, 20000);
    // Alex's link taken back: it stops, Sam's keeps working, and the plain links are replaced again.
    await A.evaluate(() => [...document.querySelectorAll('#share-holders .share-holder')].find((li) => li.querySelector('.share-holder-name').textContent === 'Alex').querySelector('[data-remove]').click()); // (the confirm box is accepted)
    await until(A, (old) => document.querySelector('#share-edit-link').value !== old && !document.querySelector('#share-dialog').dataset.busy, newLink, 20000);
    const thirdLink = await A.$eval('#share-edit-link', (e) => e.value);
    const left = await A.evaluate(() => [...document.querySelectorAll('#share-holders .share-holder-name')].map((e) => e.textContent));
    if (left.join() !== 'Sam' || (await holderStatus(alexLink)) !== 404 || (await holderStatus(samLink)) !== 200 || (await status(newLink)) !== 404 || (await status(thirdLink)) !== 200) {
      throw new Error(`taking Alex's link back: ${left} left; Alex ${await holderStatus(alexLink)}, Sam ${await holderStatus(samLink)}, the plain link before ${await status(newLink)}, after ${await status(thirdLink)}`);
    }
    await G.goto(alexLink);
    await until(G, () => document.getElementById('guest-message-title')?.textContent.includes('doesn’t work'), undefined, 20000);
    await s(G, '13-share-5-link-taken-back');

    // Stop sharing: private again, text intact, nothing left of the share.
    await A.click('#share-stop');
    await until(A, () => !document.querySelector('#share-off').hidden, undefined, 20000);
    await A.keyboard.press('Escape');
    if ((await status(thirdLink)) !== 404) throw new Error('after stop sharing, the link still answers');
    if ((await holderStatus(samLink)) === 200) throw new Error("after stop sharing, Sam's link still answers");
    await G.close();
    await openNote(A, title);
    await until(A, () => document.getElementById('editor').noteText().includes('added on B'));
    await until(B, (t) => [...document.querySelectorAll('#note-list li')].some((li) => li.querySelector('.title')?.textContent === t && !li.querySelector('.when').textContent.includes('Shared')), title, 20000);
    {
      const db = new DatabaseSync(server.db);
      const left = db.prepare('SELECT (SELECT COUNT(*) FROM shares) + (SELECT COUNT(*) FROM share_updates) + (SELECT COUNT(*) FROM share_snapshots) AS n').get().n;
      db.close();
      if (left) throw new Error(`after stop sharing, ${left} share rows are left`);
    }
    await backToList(A);
    await backToList(B);
  }
}
