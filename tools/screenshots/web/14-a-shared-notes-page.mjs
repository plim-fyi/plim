import { backToList, browser, closeSettings, guestAdd, guestMenu, intoEditor, mobile, openHistory, openNote, openSettings, pageSeed, PROFILES, rowMenu, s, seedRandomness, setView, titleClear, typeAtEnd, typeText, unlockWithPasskey, until, waitView, watchShiftsOn } from './harness.mjs';
import { wait } from '../server.mjs';
// To play a server forging an edit (#77).
import { b64, encrypt } from '../../../web/core/crypto.js';
import { guestPath, keysFromLink, parseShareLink } from '../../../web/core/share.js';
import { shareAad } from '../../../web/core/sig.js';
import { NAMES } from '../../../web/core/names.js';
import * as Y from '../../../web/vendor/yjs.mjs';

/** Flow 14: A shared note's page. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow14(shared) {
  const { A, B, C, profile } = shared;
  // 14. Shared-note links (#70, 2c): a guest without an account, a view-only guest, "Add to my notes"
  {
    const title = 'Reading list';
    // A shares it and takes both links.
    await A.bringToFront();
    await backToList(A);
    const nid = await A.evaluate((t) => [...document.querySelectorAll('#note-list li:not(.trashed)')].find((li) => li.querySelector('.title')?.textContent === t)?.dataset.id, title);
    await rowMenu(A, `#note-list li[data-id="${nid}"]`);
    await A.click('#note-menu-share');
    await until(A, () => document.querySelector('#share-dialog').open);
    await A.click('#share-create');
    await until(A, () => !document.querySelector('#share-on').hidden, undefined, 20000);
    const edit = await A.$eval('#share-edit-link', (e) => e.value);
    const view = await A.$eval('#share-read-link', (e) => e.value);
    await A.keyboard.press('Escape');
    await openNote(A, title);
    const guestText = (p) => p.evaluate(() => document.getElementById('editor').noteText?.() ?? '');
    const guestPage = async (link, setup, device = 'A guest') => {
      const p = await (await browser.createBrowserContext()).newPage();
      await p.evaluateOnNewDocument(seedRandomness, pageSeed(profile));
      p.device = device;
      await watchShiftsOn(p);
      await p.setViewport(PROFILES[profile].viewport);
      await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      p.profile = profile;
      p.errors = [];
      p.on('pageerror', (e) => p.errors.push(`${e.message} (${(e.stack ?? '').split('\n').slice(1, 3).join(' | ').trim()})`));
      p.on('console', (m) => /isn't signed|forged/i.test(m.text()) && (p.consoleForged = (p.consoleForged ?? 0) + 1));
      await setup?.(p);
      await p.goto(link);
      // A link on the note's address (#299) opens the app's page, which sends a browser with no vault on to the note's page for guests.
      if (new globalThis.URL(link).pathname.startsWith('/n/')) {
        for (const deadline = Date.now() + 15000; ; await wait(100)) {
          if (await p.evaluate(() => location.pathname.startsWith('/s/') && document.readyState === 'complete').catch(() => false)) break;
          if (Date.now() > deadline) throw new Error(`a guest at ${link} should be sent to the note's page: at ${p.url()}`);
        }
      }
      return p;
    };
    // The same share as a link from before #299 gives it (/s/<share id>#…): the guest page's own address.
    const legacy = (link) => {
      const u = new globalThis.URL(link);
      return `${u.origin}${guestPath(parseShareLink(u.pathname, u.hash), u.hash)}`;
    };

    // A guest with the edit link: no account, reads and edits, both ways, live.
    // Alone in the note, the owner already has the "who's here" row: when the first
    // guest turns up, the text doesn't move (and the same on the guest's page).
    const editorTop = (p) => p.evaluate(() => Math.round(document.getElementById('editor').getBoundingClientRect().top));
    await until(A, () => document.getElementById('note-share').classList.contains('shared'));
    // Its status light: green while live, grey while not (a private note's Share has none).
    {
      // (On a phone it's on the ⋯ that holds Share.)
      const light = () => A.evaluate((phone) => {
        const b = document.getElementById(phone ? 'note-more' : 'note-share');
        const s = getComputedStyle(b, phone ? '::before' : '::after'); // (its dot)
        return { content: s.content, color: s.backgroundColor, ok: getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() };
      }, mobile(A));
      await until(A, () => document.documentElement.dataset.live === 'on', undefined, 15000);
      await wait(400); // (its colour fades in)
      const live = await light();
      const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
      if (live.content === 'none' || live.color !== rgb(live.ok)) throw new Error(`the Shared light should be green while live: ${JSON.stringify(live)}`);
      await A.evaluate(() => (document.documentElement.dataset.live = 'off'));
      await wait(400);
      if ((await light()).color === live.color) throw new Error('the Shared light should go grey while not live');
      await A.evaluate(() => (document.documentElement.dataset.live = 'on'));
    }
    // The bar's buttons are plain icons: no square until the pointer is on one (desktop: a phone has only ⋯).
    if (!mobile(A)) {
      await A.mouse.move(5, 5);
      await A.evaluate(() => document.activeElement?.blur());
      const square = (id) => A.$eval(id, (b) => {
        const s = getComputedStyle(b);
        const clear = (c) => c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
        return !(clear(s.backgroundColor) && clear(s.borderTopColor) && s.backgroundImage === 'none');
      });
      for (const id of ['#note-history', '#note-share', '#note-more']) {
        if (await square(id)) throw new Error(`${id} should show no square at rest`);
      }
      await A.hover('#note-share');
      if (!(await square('#note-share'))) throw new Error('#note-share should show its square on hover');
      if (await square('#note-more')) throw new Error('#note-more should stay plain while Share is hovered');
      await A.mouse.move(5, 5);
      // …and close together, as one group.
      const gaps = await A.evaluate(() => {
        const [h, s, m] = ['note-history', 'note-share', 'note-more'].map((id) => document.getElementById(id).getBoundingClientRect());
        return [s.left - h.right, m.left - s.right];
      });
      if (gaps.some((g) => g < 2 || g > 6)) throw new Error(`the bar's icons should be about 4px apart: ${gaps}`);
      // …and the same size.
      const sizes = await A.evaluate(() => ['note-history', 'note-share', 'note-more'].map((id) => document.querySelector(`#${id} .icon`).getBoundingClientRect().width));
      if (new Set(sizes).size !== 1) throw new Error(`the bar's icons should be the same size: ${sizes}`);
    }
    const ownerTop = await editorTop(A);
    const G = await guestPage(edit, undefined, 'A guest, with an edit link');
    await until(G, () => document.getElementById('editor').noteText?.().includes('Overstory'), undefined, 20000);
    const guestTop = await editorTop(G);
    await until(A, () => document.querySelector('#presence span[data-client]'), undefined, 15000);
    await until(G, () => document.querySelector('#presence span[data-client]'), undefined, 15000);
    await wait(400); // (the chips' animations)
    const moved = { owner: (await editorTop(A)) - ownerTop, guest: (await editorTop(G)) - guestTop };
    if (moved.owner || moved.guest) throw new Error(`presence: the text moved when someone arrived (px): ${JSON.stringify(moved)}`);
    // On a phone, the bar: a chevron back, the title (centred in the room the others' initials
    // leave it, never under them, #318), others as initials, and one ⋯ that holds who's here,
    // History and Share (with its state).
    if (mobile(A)) {
      const bar = await A.evaluate(() => {
        const head = document.querySelector('.editor-head').getBoundingClientRect();
        const t = document.getElementById('note-title').getBoundingClientRect();
        const chip = document.querySelector('#presence span[data-client]').getBoundingClientRect();
        const shown = (id) => document.getElementById(id).getClientRects().length > 0;
        return { back: document.getElementById('btn-back').textContent.trim(), clear: t.right <= chip.left + 1, centred: getComputedStyle(document.getElementById('note-title')).textAlign === 'center',
          round: Math.abs(chip.width - chip.height) < 1, history: shown('note-history'), share: shown('note-share') };
      });
      if (bar.back || !bar.clear || !bar.centred || !bar.round || bar.history || bar.share) throw new Error(`the phone's note bar: ${JSON.stringify(bar)}`);
      // …flat: no line under it, no shadow, and no fade even with its text scrolled.
      const flat = await A.evaluate(async () => {
        document.querySelector('.editor-pane').classList.add('scrolled');
        await new Promise((r) => setTimeout(r, 300));
        const h = getComputedStyle(document.querySelector('.editor-head'));
        const fade = getComputedStyle(document.querySelector('#editor .cm-scroller, #editor textarea')).maskImage;
        document.querySelector('.editor-pane').classList.remove('scrolled');
        return [h.borderBottomWidth, h.boxShadow, fade];
      });
      if (flat[0] !== '0px' || flat[1] !== 'none' || flat[2] !== 'none') throw new Error(`a phone's note bar should be flat: ${flat}`);
      await A.click('#note-more');
      await until(A, () => !document.getElementById('note-menu').hidden);
      const menu = await A.evaluate(() => ({ people: document.getElementById('note-menu-people').textContent,
        history: !document.getElementById('note-menu-history').hidden, share: document.getElementById('note-menu-share').textContent.replace(/\s+/g, ' ').trim() }));
      if (!/ is here$/.test(menu.people) || !menu.history || menu.share !== 'SharedLive') throw new Error(`the phone's ⋯ menu: ${JSON.stringify(menu)}`);
      await s(A, '15-cursors-0-phone-menu');
      await A.keyboard.press('Escape');
    }
    // Switching between a private note and the shared one, either way: in every frame
    // the text starts at the same height, and the empty editor's "Start typing…" never shows.
    for (const to of ['Lisbon trip', title]) {
      await A.evaluate(() => {
        window.switchFrames = [];
        const end = performance.now() + 1500;
        const tick = () => {
          const ed = document.getElementById('editor');
          if (ed.offsetParent) {
            window.switchFrames.push({ top: Math.round(ed.getBoundingClientRect().top), hint: Boolean(ed.querySelector('.cm-placeholder')) });
          }
          if (performance.now() < end) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await openNote(A, to);
      await wait(1600);
      const frames = await A.evaluate(() => window.switchFrames);
      const tops = [...new Set(frames.map((f) => f.top))];
      if (tops.length !== 1 || frames.some((f) => f.hint)) {
        throw new Error(`switching to "${to}": the text moved or "Start typing" showed: tops ${tops}, placeholder in ${frames.filter((f) => f.hint).length} frames`);
      }
      const button = await A.evaluate(() => [document.getElementById('note-share').getAttribute('aria-label'),
        getComputedStyle(document.getElementById('note-share'), '::after').content, getComputedStyle(document.getElementById('note-more'), '::before').content]);
      const shared = to === title;
      const dot = mobile(A) ? button[2] : button[1]; // (a phone's light is on ⋯)
      if (button[0].startsWith('Shared') !== shared || shared === (dot === 'none')) throw new Error(`"${to}": the bar's button is ${JSON.stringify(button)}`);
    }
    if ((await G.$eval('#guest-mode', (e) => e.textContent)) !== 'You can edit') throw new Error('edit link: wrong mode');
    // The same status light as the app's Shared button: green once live.
    await until(G, () => document.documentElement.dataset.live === 'on', undefined, 15000);
    await wait(400);
    const guestLight = await G.evaluate(() => [getComputedStyle(document.getElementById('guest-more'), '::before').backgroundColor,
      getComputedStyle(document.documentElement).getPropertyValue('--ok').trim()]);
    {
      const n = parseInt(guestLight[1].slice(1), 16);
      if (guestLight[0] !== `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`) throw new Error(`the guest page's light should be green while live: ${guestLight}`);
    }
    // Titles go into browser history: none of the note's text in it (it's in the page's header only).
    if ((await G.title()) !== 'Shared note — Plim') throw new Error(`guest page title: ${await G.title()}`);
    await titleClear(G, '14-guest-1-edit');
    await s(G, '14-guest-1-edit');
    // The header, like the app's note bar: the note's title, no line beneath, one row; on a phone
    // the logo alone, the title centred (in the room others' initials leave it, #318), and Add to my notes in ⋯.
    {
      const head = await G.evaluate(() => {
        const h = document.querySelector('.guest-head');
        const r = h.getBoundingClientRect();
        const t = document.getElementById('guest-title').getBoundingClientRect();
        const shown = (el) => el.getClientRects().length > 0;
        return { title: document.getElementById('guest-title').textContent, line: getComputedStyle(h).borderBottomWidth, height: r.height,
          off: Math.abs((t.left + t.right) / 2 - (r.left + r.right) / 2), name: shown(h.querySelector('.brand-name')), add: shown(document.getElementById('guest-add')),
          others: Boolean(document.querySelector('#presence:not([hidden]) span')) };
      });
      const top = mobile(G) ? 47 : 0; // (the notch)
      const ok = head.title === title && head.line === '0px' && head.height - top < 64
        && (mobile(G) ? (head.off < 2 || head.others) && !head.name && !head.add : head.name && head.add);
      if (!ok) throw new Error(`the shared note's header: ${JSON.stringify(head)}`);
      // An edit link opens in the editor, with Preview in the bar (#302); on a phone, as a page,
      // the bar's button offering Edit (#538).
      {
        const page = await G.evaluate((phone) => ({ editor: !document.getElementById('editor').hidden, reading: !document.getElementById('reading').hidden,
          preview: !document.getElementById(phone ? 'note-preview' : 'note-mode').hidden }), mobile(G));
        if (!page.preview || (mobile(G) ? page.editor || !page.reading : !page.editor)) throw new Error(`the shared note, with an edit link: ${mobile(G) ? 'a page, with Preview' : 'the editor, with Preview'}: ${JSON.stringify(page)}`);
      }
      // "More" is ⋮ on desktop and ⋯ on a phone, as in the app (#197).
      const dots = await G.evaluate(() => [...document.querySelectorAll('#guest-more svg')].filter((e) => e.getClientRects().length).map((e) => e.getAttribute('class')));
      const appDots = await A.evaluate(() => [...document.querySelectorAll('#note-more svg')].filter((e) => e.getClientRects().length).map((e) => e.getAttribute('class')));
      const want = mobile(G) ? 'icon dots-across' : 'icon dots-down';
      if (dots.join() !== want || appDots.join() !== want) throw new Error(`"more" should be ${want} here: shared page ${dots}, app ${appDots}`);
      await guestMenu(G);
      const menu = await G.evaluate(() => getComputedStyle(document.getElementById('guest-mode'), '::after').content + ' ' + document.getElementById('guest-mode').textContent);
      if (!menu.includes('You can edit') || !menu.includes('Live')) throw new Error(`the shared note's ⋯: ${menu}`);
      await G.keyboard.press('Escape');
    }
    // The note scrolls across the whole window (the wheel works anywhere), under a header as wide.
    {
      const box = await G.evaluate(() => ({ window: innerWidth, // (the editor, or Preview, whichever shows; a phone's editor: its textarea)
        scroller: (document.getElementById('reading').hidden ? document.querySelector('#editor .cm-scroller, #editor textarea') : document.getElementById('reading')).getBoundingClientRect().width,
        head: document.querySelector('.guest-head').getBoundingClientRect().width }));
      if (box.window - box.scroller > 20 || box.window - box.head > 1) throw new Error(`The guest page's note should span the window: ${JSON.stringify(box)}`);
    }
    await G.bringToFront();
    await intoEditor(G);
    await G.keyboard.down('Control');
    await G.keyboard.press('End');
    await G.keyboard.up('Control');
    await typeText(G, '\n- (added by a guest)');
    await until(A, () => document.getElementById('editor').noteText().includes('added by a guest'), undefined, 10000);
    await A.bringToFront();
    await typeAtEnd(A, '\n- (owner, live)');
    await until(G, () => document.getElementById('editor').noteText().includes('owner, live'), undefined, 10000);

    // View only: sees live edits, can't type.
    const V = await guestPage(view, undefined, 'A guest, with a view link');
    await until(V, () => document.getElementById('editor').noteText?.().includes('added by a guest'), undefined, 20000);
    // A view link opens in Preview (#302), its boxes not tickable.
    {
      const page = await V.evaluate(() => ({ reading: !document.getElementById('reading').hidden, rows: document.querySelectorAll('#reading li').length,
        boxes: [...document.querySelectorAll('#reading input[type=checkbox]')].every((b) => b.disabled) }));
      if (!page.reading || !page.rows || !page.boxes) throw new Error(`a view link should open in Preview: ${JSON.stringify(page)}`);
    }
    const viewOnly = await V.evaluate(() => [document.querySelector('#guest-mode').textContent,
      document.querySelector('#editor .cm-content')?.getAttribute('contenteditable') ?? String(!document.querySelector('#editor textarea').readOnly)]);
    if (viewOnly[0] !== 'View only' || viewOnly[1] !== 'false') throw new Error(`view link: ${viewOnly}`);
    // (Said by the title too, on desktop.)
    if (!mobile(V) && !(await V.$eval('#guest-view-only', (e) => e.getClientRects().length > 0))) throw new Error('view link: no "View only" by the title');
    // Its markdown can be shown, not edited: "Markdown", not "Edit" (#322); an edit link's says Edit.
    if (!mobile(V)) {
      const label = async (p) => p.$eval('#note-mode [data-mode="edit"]', (b) => b.textContent);
      const labels = { view: await label(V), edit: await label(G) };
      if (labels.view !== 'Markdown' || labels.edit !== 'Edit') throw new Error(`the source view's label: ${JSON.stringify(labels)}`);
    }
    await A.bringToFront();
    await typeAtEnd(A, '\n- (seen by the viewer)');
    await until(V, () => document.getElementById('editor').noteText().includes('seen by the viewer'), undefined, 10000);
    await titleClear(V, '14-guest-2-view');
    await s(V, '14-guest-2-view');

    // #77: a server that serves an edit no edit link signed (what it could make with a view link: encrypted, unsigned).
    // The viewer ignores it, and says so.
    {
      const link = parseShareLink(new globalThis.URL(view).pathname, new globalThis.URL(view).hash);
      const keys = await keysFromLink(link);
      const doc = new Y.Doc();
      doc.getText('body').insert(0, 'FORGED ');
      const { nonce, ciphertext } = await encrypt(keys.encKey, Y.encodeStateAsUpdate(doc), shareAad(link.shareId, 'update'));
      const F = await guestPage(view, async (p) => {
        await p.setRequestInterception(true);
        p.on('request', async (req) => {
          if (!req.url().includes(`/api/shares/${link.shareId}/doc`)) return req.continue();
          const r = await (await fetch(req.url(), { headers: req.headers() })).json();
          p.docRequests = `${p.docRequests ?? ''} ${new globalThis.URL(req.url()).search || '(none)'}→head ${r.head} seqs ${r.updates.map((u) => u.seq)} snapshot ${r.snapshot?.covers_seq ?? '-'}`;
          r.updates.push({ seq: r.head + 1, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: r.updates[0]?.sig ?? '' });
          r.head += 1;
          req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
        });
      }, 'A guest, with a view link, sent a forged edit');
      await until(F, () => !document.getElementById('forged-banner').hidden, undefined, 20000).catch(async () => {
        const seen = await F.evaluate(() => ({ url: location.pathname, text: document.getElementById('editor').noteText?.().slice(0, 60), message: document.getElementById('guest-message-title').textContent, view: document.getElementById('note-body').dataset.view }));
        throw new Error(`the viewer should say an edit was forged: ${JSON.stringify(seen)}; errors ${JSON.stringify(F.errors)}; requests to the doc ${F.docRequests ?? "?"}; forged warnings ${F.consoleForged ?? 0}`);
      });
      await until(F, () => document.getElementById('editor').noteText?.().includes('seen by the viewer'), undefined, 20000);
      if ((await guestText(F)).includes('FORGED')) throw new Error(`forged edit applied: ${await guestText(F)}`);
      await titleClear(F, '14-guest-4-forged');
    await s(F, '14-guest-4-forged');
      await F.browserContext().close();
    }

    // 15. Live cursors and names (#70, phase 3)
    {
      // Names: A in Settings (account-wide), the guests on the page.
      await A.bringToFront();
      await openSettings(A, 'profile');
      await A.click('#settings-name', { count: 3 });
      await A.type('#settings-name', 'Ada');
      await A.keyboard.press('Tab'); // "change"
      await closeSettings(A);
      for (const [p, name] of [[G, 'Grace'], [V, 'Victor']]) {
        await p.bringToFront();
        await guestMenu(p);
        await p.click('#guest-name', { count: 3 });
        await p.type('#guest-name', name);
        await p.keyboard.press('Enter');
        await p.keyboard.press('Tab');
      }
      const chips = (p) => p.$$eval('#presence span', (e) => e.map((c) => c.textContent));
      const hasChips = (p, want) => until(p, (want) => want.every((w) => [...document.querySelectorAll('#presence span')].some((c) => c.textContent === w)), want, 15000)
        .catch(async () => { throw new Error(`presence chips: want ${want}, have ${await chips(p)}`); });
      await openNote(A, title);
      await hasChips(A, ['Grace', 'Victor (viewing)']);
      await hasChips(G, ['Ada', 'Victor (viewing)']);
      // Grace selects a phrase: Ada sees it, with her name, in her colour (CSP-safe: not an inline style).
      // (Not on a phone, #290: a textarea draws nobody's cursor; the chips are the presence there.)
      if (!mobile(A)) {
      await G.bringToFront();
      await G.evaluate(() => {
        const content = document.querySelector('#editor .cm-content');
        content.focus();
        const range = document.createRange();
        const walk = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        let text = walk.nextNode();
        while (text && !text.textContent.includes('Piranesi')) text = walk.nextNode();
        range.setStart(text, text.textContent.indexOf('Piranesi'));
        range.setEnd(text, text.textContent.indexOf('Piranesi') + 'Piranesi'.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      // (Her name label can be from where her cursor was before: on desktop, wait for the selection itself.)
      await until(A, (phone) => [...document.querySelectorAll('#editor .cm-ySelectionInfo')].some((e) => e.textContent === 'Grace')
        && (phone || document.querySelector('#editor .cm-ySelection')), mobile(G), 10000);
      const coloured = await A.evaluate(() => {
        const caret = [...document.querySelectorAll('#editor .cm-ySelectionCaret')].find((c) => c.textContent.includes('Grace'));
        const sel = document.querySelector('#editor .cm-ySelection');
        return { caret: getComputedStyle(caret).backgroundColor, selection: sel && getComputedStyle(sel).backgroundColor, inline: caret.getAttribute('style') };
      });
      // (The emulated phone collapses a selection set from script, so only its caret is sure to show.)
      const clear = (c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c);
      if (clear(coloured.caret) || (coloured.selection && clear(coloured.selection)) || coloured.inline || (!mobile(G) && !coloured.selection)) {
        throw new Error(`Grace's cursor isn't coloured: ${JSON.stringify(coloured)}`);
      }
      // Its dot sits centred on top of the bar, and the name tag starts where the bar does.
      const placed = await A.evaluate(() => {
        const caret = [...document.querySelectorAll('#editor .cm-ySelectionCaret')].find((c) => c.textContent.includes('Grace'));
        const [bar, dot, tag] = [caret, caret.querySelector('.cm-ySelectionCaretDot'), caret.querySelector('.cm-ySelectionInfo')].map((e) => e.getBoundingClientRect());
        const line = caret.closest('.cm-line').getBoundingClientRect();
        return { dx: dot.x + dot.width / 2 - (bar.x + bar.width / 2), dy: dot.y + dot.height / 2 - bar.y, tag: tag.x - bar.x,
          // The bar is the line's height, on it (not shorter, not poking above or below).
          top: bar.y - line.y, height: bar.height - Math.min(line.height, parseFloat(getComputedStyle(caret.closest('.cm-line')).lineHeight) || line.height) };
      });
      if (Object.values(placed).some((d) => Math.abs(d) > 1)) throw new Error(`Grace's cursor dot, name tag or bar is off (px): ${JSON.stringify(placed)}`);
      // Chips are kept as people move their cursors (only arriving and leaving animate).
      await A.evaluate(() => ([...document.querySelectorAll('#presence span')].find((c) => c.textContent === 'Grace').kept = true));
      await G.bringToFront();
      for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
        await G.keyboard.press(key);
        await wait(150);
      }
      await wait(500);
      await A.bringToFront();
      const kept = await A.evaluate(() => [...document.querySelectorAll('#presence span')].find((c) => c.textContent === 'Grace')?.kept === true);
      if (!kept) throw new Error('presence: Grace’s chip was redrawn when she moved her cursor (it would replay its animation)');
      await A.bringToFront();
      // Name tags show after a cursor moves, and on hover: on for the picture.
      await A.evaluate(() => document.querySelectorAll('.cm-ySelectionInfo').forEach((e) => (e.style.opacity = '1')));
      await s(A, '15-cursors-1-others');
      }
      // Someone leaving disappears at once (a goodbye, not the 30 s timeout).
      const W = await guestPage(edit);
      await until(W, () => document.getElementById('editor').noteText?.().includes('Overstory'), undefined, 20000);
      // No name given: a character from Middle-earth, the one in their name box.
      const wName = await W.$eval('#guest-name', (e) => e.placeholder);
      if (!NAMES.includes(wName)) throw new Error(`a guest without a name is "${wName}"`);
      await hasChips(A, [wName]);
      // Arriving: their chip grows in. Leaving: it fades out, then goes.
      const arrived = await A.evaluate((n) => getComputedStyle([...document.querySelectorAll('#presence span')].find((c) => c.textContent === n)).animationName, wName);
      if (arrived !== 'chip-in') throw new Error(`presence: an arriving chip should animate in, has "${arrived}"`);
      await A.evaluate((n) => {
        window.fadedOut = false;
        new MutationObserver(() => {
          if ([...document.querySelectorAll('#presence span.leaving')].some((c) => c.textContent === n)) window.fadedOut = true;
        }).observe(document.getElementById('presence'), { subtree: true, attributes: true, attributeFilter: ['class'] });
      }, wName);
      await W.goto('about:blank');
      const t0 = Date.now();
      await until(A, (n) => ![...document.querySelectorAll('#presence span')].some((c) => c.textContent === n), wName, 5000);
      console.log(`  presence: a guest leaving disappeared after ${Date.now() - t0} ms (fading out)`);
      if (!(await A.evaluate(() => window.fadedOut))) throw new Error('presence: a leaving chip should fade out before it goes');
      await W.browserContext().close();

      // The owner opens another note and comes back: gone for the others meanwhile, then there once (not twice).
      const adas = () => G.evaluate(() => [...document.querySelectorAll('#presence span')].filter((c) => c.textContent === 'Ada').length);
      await openNote(A, 'Lisbon trip');
      const left = await until(G, () => ![...document.querySelectorAll('#presence span')].some((c) => c.textContent === 'Ada'), undefined, 5000)
        .then(() => true, () => false);
      if (!left) throw new Error('presence: Ada opened another note, but Grace still sees her in this one');
      await openNote(A, title);
      await hasChips(G, ['Ada']);
      await wait(1500);
      if ((await adas()) !== 1) throw new Error(`presence: after Ada came back, Grace sees ${await adas()} of her`);

      // Grace goes Back and then Forward to the note (the browser may restore the page as it was,
      // without reloading it): Ada sees her leave, then come back.
      await G.evaluate(() => (window.beforeBack = true));
      await G.goto('about:blank');
      await until(A, () => ![...document.querySelectorAll('#presence span')].some((c) => c.textContent === 'Grace'), undefined, 5000);
      await G.goBack();
      const restored = await G.evaluate(() => window.beforeBack === true); // the same page, not a reload
      const back = await until(A, () => [...document.querySelectorAll('#presence span')].some((c) => c.textContent === 'Grace'), undefined, 10000)
        .then(() => true, () => false);
      console.log(`  presence: Back and Forward ${restored ? 'restored the page as it was' : 'reloaded the page'}`);
      if (!back) throw new Error(`presence: after Back and Forward (${restored ? 'restored' : 'reloaded'}), Ada doesn't see Grace`);
      // The same for Ada, in the app. (Reloaded, it would be locked: only a restored page is checked.)
      await A.evaluate(() => (window.beforeBack = true));
      await A.goto('about:blank');
      await until(G, () => ![...document.querySelectorAll('#presence span')].some((c) => c.textContent === 'Ada'), undefined, 5000);
      await A.goBack();
      if (await A.evaluate(() => window.beforeBack === true)) {
        const seen = await until(G, () => [...document.querySelectorAll('#presence span')].some((c) => c.textContent === 'Ada'), undefined, 10000)
          .then(() => true, () => false);
        if (!seen) throw new Error('presence: after Back and Forward in the app, Grace doesn’t see Ada');
        console.log('  presence: the app, too, restored by Back and Forward: Ada is back for Grace');
      } else {
        console.log('  presence: the app was reloaded by Back and Forward (not restored): unlocking');
        await unlockWithPasskey(A);
        await openNote(A, title);
      }
    }

    // History in a shared note (#60): someone with the edit link wipes the text; the
    // owner brings it back from History, and the guest sees it back too.
    {
      await wait(2500); // (a version is due: they're kept every 2 s here)
      await G.bringToFront();
      await intoEditor(G);
      await G.keyboard.down('Control');
      await G.keyboard.press('a');
      await G.keyboard.up('Control');
      await G.keyboard.press('Backspace');
      await until(A, () => !document.getElementById('editor').noteText().includes('Overstory'), undefined, 10000);
      await A.bringToFront();
      await openHistory(A);
      await until(A, () => document.querySelector('#history-dialog').open && document.querySelectorAll('#history-list button').length >= 1, undefined, 15000);
      // The note as it was just before the wipe (kept by the owner's app as the wipe arrived).
      let found = false;
      for (const b of await A.$$('#history-list button:not([data-id="now"])')) {
        await b.click();
        await until(A, () => !document.getElementById('history-restore').disabled, undefined, 10000);
        if ((await A.$eval('#history-diff', (e) => [...e.querySelectorAll('.line:not(del)')].map((l) => l.textContent).join('\n'))).includes('seen by the viewer')) {
          found = true;
          break;
        }
        if (mobile(A)) await A.click('#history-back');
      }
      if (!found) throw new Error('History should have the shared note as it was just before it was wiped');
      await A.click('#history-restore');
      for (const p of [A, G]) await until(p, () => document.getElementById('editor').noteText().includes('seen by the viewer'), undefined, 10000);
    }

    // A link missing its key explains itself (on the guest page; the note's address alone is the app's).
    const bad = await guestPage(legacy(edit).split('#')[0]);
    await until(bad, () => document.querySelector('#guest-message-title').textContent === 'This link is incomplete');

    // C (a Plim user, another account) opens a link from before #299 as a guest, and adds the note to their notes.
    await C.bringToFront();
    await C.goto(legacy(edit));
    await until(C, () => document.getElementById('editor').noteText?.().includes('Overstory'), undefined, 20000);
    const asked = [];
    C.on('dialog', (d) => asked.push(d.message())); // (accepted by the handler every page has)
    await guestAdd(C);
    await waitView(C, 'view-locked', 20000); // the app, locked: unlock, then the note is added
    await unlockWithPasskey(C);
    await until(C, (t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), title, 20000);
    // A link can bring anyone here: a note joins your list only when you say so.
    if (!asked.some((m) => m.startsWith('Add this shared note to your notes?'))) throw new Error(`no confirmation before adding: ${asked}`);
    await until(C, () => document.getElementById('editor').noteText().includes('seen by the viewer'), undefined, 20000);
    if (await C.evaluate(() => location.hash)) throw new Error('the key should leave the address bar once added');
    await typeAtEnd(C, '\n- (from C’s own list)');
    await until(A, () => document.getElementById('editor').noteText().includes('C’s own list'), undefined, 10000);
    // The link on the note's address (#299), opened where a vault is: the app, locked; unlocked, the note
    // itself, no question asked (it's in the list already: here A's other device, the owner's), its address in the bar.
    await B.bringToFront();
    const askedB = [];
    B.on('dialog', (d) => askedB.push(d.message()));
    await B.goto(edit);
    await waitView(B, 'view-locked', 20000);
    await unlockWithPasskey(B);
    await until(B, () => document.getElementById('editor').noteText?.().includes('seen by the viewer'), undefined, 20000)
      .catch(() => { throw new Error("the owner's other device should open the note from its link"); });
    if (askedB.length) throw new Error(`a note of yours needs no adding: ${askedB}`);
    const bAt = await B.evaluate(() => location.pathname + location.hash);
    if (bAt !== `/n/${nid}`) throw new Error(`the note's address, without the key, should be in the bar: ${bAt}`);

    // A task in a shared note (#138): a tick is an edit like any other, and a view link can't make one.
    await A.bringToFront();
    await typeAtEnd(A, '\n- [ ] (a task for everyone)');
    await until(G, () => document.getElementById('editor').noteText().includes('(a task for everyone)'), undefined, 10000);
    // The guest page shows the markdown as it is, after a reload too.
    await G.bringToFront();
    await G.reload();
    await until(G, () => document.getElementById('editor').noteText?.().includes('- [ ] (a task for everyone)'), undefined, 20000);
    // The owner ticks it: on a phone from Preview (#302), on a computer with Ctrl+Enter on its line.
    await A.bringToFront();
    if (mobile(A)) {
      await setView(A, 'preview');
      await (await A.waitForSelector('#reading input[type=checkbox]:not(:checked)')).click();
      await until(A, () => document.getElementById('editor').noteText().includes('- [x] (a task for everyone)'), undefined, 10000);
      await setView(A, 'edit');
    } else {
      await A.evaluate(() => {
        const v = document.querySelector('#editor .cm-content').cmTile.view;
        v.focus();
        v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('(a task for everyone)') } });
      });
      await A.keyboard.down('Control');
      await A.keyboard.press('Enter');
      await A.keyboard.up('Control');
    }
    await until(G, () => document.getElementById('editor').noteText().includes('- [x] (a task for everyone)'), undefined, 10000);
    // A view link sees it ticked, but can't change it (Ctrl+Enter there is nothing).
    await V.bringToFront();
    await until(V, () => document.getElementById('editor').noteText().includes('- [x] (a task for everyone)'), undefined, 10000);
    if (!mobile(V)) {
      await V.evaluate(() => {
        const v = document.querySelector('#editor .cm-content').cmTile.view;
        v.focus();
        v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('(a task for everyone)') } });
      });
      await V.keyboard.down('Control');
      await V.keyboard.press('Enter');
      await V.keyboard.up('Control');
    }
    await wait(500);
    if (!(await guestText(V)).includes('- [x] (a task for everyone)')) throw new Error('a view link changed a task');
    await G.bringToFront();
    // Someone else's cursor shows where it is in the markdown: the guest's, between "**".
    // (Not on a phone, #290: a textarea draws nobody's cursor, and the guest's own is one too.)
    if (!mobile(A)) {
      await G.evaluate(() => {
        const v = document.querySelector('#editor .cm-content').cmTile.view;
        const at = v.state.doc.length;
        v.focus();
        v.dispatch({ changes: { from: at, insert: '\n**Bold** idea' }, selection: { anchor: at + 2 } });
      });
      await A.bringToFront();
      await until(A, () => [...document.querySelectorAll('#editor .cm-line')].find((l) => l.textContent.replace(/\*/g, '').includes('Bold idea'))?.querySelector('.cm-ySelectionCaret'), undefined, 10000)
        .catch(() => { throw new Error("a guest's cursor inside a hidden mark should still show"); });
    }

    // A replaces the links: both guests are told the link was turned off.
    await A.bringToFront();
    await backToList(A);
    await rowMenu(A, `#note-list li[data-id="${nid}"]`);
    await A.click('#note-menu-share');
    await until(A, () => document.querySelector('#share-dialog').open && !document.querySelector('#share-on').hidden);
    await A.click('#share-replace');
    await until(A, (old) => document.querySelector('#share-edit-link').value !== old, edit, 20000);
    await A.keyboard.press('Escape');
    for (const p of [G, V]) await until(p, () => document.querySelector('#guest-message-title').textContent === 'This link was turned off', undefined, 15000);
    await s(G, '14-guest-3-turned-off');
    const guestErrors = [G, V, bad].flatMap((p) => p.errors);
    if (guestErrors.length) throw new Error(`guest page errors:\n${guestErrors.join('\n')}`);
    for (const p of [G, V, bad]) await p.browserContext().close();
    await backToList(A);
  }
}
