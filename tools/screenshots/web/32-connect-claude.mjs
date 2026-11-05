import { backToList, closeSettings, connector, freshAuthMinute, mobile, openHistory, openNote, openSettings, pickView, s, server, setView, titleClear, unlockWithPasskey, until, URL, waitView } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Flow 32: Connect Claude. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow32(shared) {
  const { A } = shared;
  // 32. Connect Claude (#369): Claude (an MCP client; this script here) registers with the connector, the
  // real `plim mcp --http`, and sends the person to it, which sends them on to /connect; the consent page;
  // a connection seeing the notes shared with agents (#514), its secret handed to the connector, a code back
  // to Claude, tokens; Settings → Connections; a note shared with agents (shared with it, as a holder of the
  // connection's, its list saying which); Claude reads it and makes a note, shared with agents, which the
  // app takes in; the note no longer shared; Disconnect: Claude is cut off, the note it made stays; the
  // one-time switch from tag grants.
  const { createHash, randomBytes: rnd } = await import('node:crypto');
  const redirectUri = `${connector.url}/client-done`; // (where Claude gets its code; nothing serves it: stubbed below)
  const reg = await (await fetch(`${connector.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri] }) })).json();
  const verifier = rnd(32).toString('base64url');
  const authz = `${connector.url}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'st1' })}`;
  const sent = await fetch(authz, { redirect: 'manual' });
  const consentUrl = sent.headers.get('location');
  if (sent.status !== 303 || !consentUrl?.startsWith(`${URL}connect?`)) throw new Error(`the connector should send the person to the consent page: ${sent.status} ${consentUrl}`);
  await A.bringToFront();
  await backToList(A);
  // The person's browser goes through /authorize itself (as Claude sends it), which binds the attempt
  // to this browser (a cookie /complete needs): the consent link passed on to another completes nothing.
  await A.goto(authz);
  await until(A, () => location.pathname === '/connect', undefined, 10000);
  await unlockWithPasskey(A);
  await until(A, () => document.querySelector('#connect-dialog').open, undefined, 20000);
  // It sees what you share with agents (#514), and nothing else.
  const keeps = await A.$eval('#connect-notebook .setting-title', (e) => e.textContent);
  if (keeps !== 'It sees what you share with agents') throw new Error(`the consent page should say what it sees: "${keeps}"`);
  // Where it sends you back to, as the connector checked it: here, the stand-in Claude on this machine.
  const back1 = await A.evaluate(() => ({ to: document.getElementById('connect-to').textContent, warn: document.getElementById('connect-unknown').hidden, title: document.getElementById('connect-title').textContent }));
  if (!/an app on this computer/.test(back1.to) || !back1.warn || back1.title !== 'Connect Claude to your notes?') throw new Error(`the consent page's destination: ${JSON.stringify(back1)}`);
  await s(A, '32-connect-1-consent');
  // Connect: the connection made, its secret handed to the connector in the fragment of its page, which
  // hands it on (same origin, never in a URL a server sees) and sends the person back to Claude with a code.
  await A.setRequestInterception(true);
  let frag;
  const onReq = (req) => {
    if (req.url() === `${connector.url}/complete` && req.method() === 'POST') frag = JSON.parse(req.postData());
    if (req.url().startsWith(redirectUri)) return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>client</title>back in Claude' });
    req.continue();
  };
  A.on('request', onReq);
  await A.click('#connect-go');
  await until(A, () => document.title === 'client', undefined, 30000);
  const back = await A.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  A.off('request', onReq);
  await A.setRequestInterception(false);
  if (!frag || !/^[0-9a-f]{32}$/.test(frag.connection) || !/^[A-Za-z0-9_-]{43}$/.test(frag.secret)) throw new Error(`handed to the connector: ${JSON.stringify(frag)}`);
  if (!back.code || back.state !== 'st1') throw new Error(`back in Claude with: ${JSON.stringify(back)}`);
  // Claude's tokens (the code, with the verifier of its challenge), and its tools.
  const tok = await (await fetch(`${connector.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirectUri }) })).json();
  if (tok.token_type !== 'Bearer' || !tok.refresh_token) throw new Error(`tokens: ${JSON.stringify(tok)}`);
  // One conversation (#505): initialized once, its Mcp-Session-Id sent back with each call, as claude.ai does.
  let mcpSession = null;
  const claude = async (name, args = {}) => {
    const post = (body, headers = {}) => fetch(`${connector.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!mcpSession) {
      mcpSession = (await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).headers.get('mcp-session-id');
      if (!mcpSession) throw new Error('the connector should hand a session its id at initialize');
    }
    const r = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-session-id': mcpSession })).json();
    return { error: r.result?.isError ?? true, text: r.result?.content?.[0]?.text ?? JSON.stringify(r) };
  };
  // What the connector will do with the secret: its list note, through the connection's own holder.
  const listed = () => A.evaluate(async (secretB64url) => {
    const [c, sh, cr, Y] = await Promise.all([import('/core/connection.js'), import('/core/share.js'), import('/core/crypto.js'), import('/vendor/yjs.mjs')]);
    const secret = cr.unb64(secretB64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (secretB64url.length % 4)) % 4));
    const k = await c.connectionKeys(secret);
    const hk = await sh.holderKeys(k.listHolderSecret);
    const r = await fetch(`/api/holders/${k.listHolderId}`, { headers: { 'x-holder-token': sh.holderTokenHex(hk) } });
    if (!r.ok) return { status: r.status };
    const row = await r.json();
    const held = await sh.openHeldKeys(hk, k.listHolderId, row.share_id, row);
    const keys = await sh.keysFromHeld(held);
    const d = await (await fetch(`/api/shares/${row.share_id}/doc`, { headers: { 'x-share-token': sh.readTokenHex(keys) } })).json();
    const doc = new Y.Doc();
    if (d.snapshot) Y.applyUpdate(doc, await sh.openShareBlob(keys, row.share_id, 'snapshot', d.snapshot));
    for (const u of d.updates) Y.applyUpdate(doc, await sh.openShareBlob(keys, row.share_id, 'update', u));
    const notes = [...doc.getMap('notes').values()];
    // Each note's holder opens too, with the secret derived for it.
    const opened = [];
    for (const [hid, e] of doc.getMap('notes').entries()) {
      const nk = await sh.holderKeys(await c.connectionHolderSecret(secret, hid));
      const nr = await fetch(`/api/holders/${hid}`, { headers: { 'x-holder-token': sh.holderTokenHex(nk) } });
      opened.push(nr.ok ? e.role : nr.status);
    }
    return { status: 200, mode: held.mode, info: doc.getMap('info').toJSON(), titles: notes.map((n) => n.title).sort(), roles: notes.map((n) => n.role), opened };
  }, frag.secret);
  // Back in the app (the list is read from its origin): Settings → Connections lists it; its page: what it sees.
  await A.goto(URL);
  await unlockWithPasskey(A);
  const empty = await listed();
  if (empty.status !== 200 || empty.mode !== 'edit' || empty.info.name !== 'Claude' || empty.info.notebook !== true || 'ownTag' in empty.info || empty.titles.length) throw new Error(`the connection's list, new: ${JSON.stringify(empty)}`);
  const nothing = await claude('list_notes');
  if (nothing.error || !/^No notes that you can see/.test(nothing.text)) throw new Error(`Claude, before any note is shared with agents: ${JSON.stringify(nothing)}`);
  await openSettings(A, 'connections');
  // The list: a row each (its badge, where it's from); "+ Connect an app" folds the steps away.
  await until(A, () => document.querySelectorAll('#connections-list .connection-row').length === 1, undefined, 20000);
  const listRow = await A.evaluate(() => ({ badge: Boolean(document.querySelector('#connections-list .connection-row .connection-badge')), sub: document.querySelector('#connections-list .connection-row .setting-sub').textContent, steps: !document.getElementById('connections-none').hidden, more: !document.getElementById('connect-another').hidden }));
  if (!listRow.badge || !/^This computer/.test(listRow.sub) || /notebook|#/.test(listRow.sub) || listRow.steps || !listRow.more) throw new Error(`the connections list: ${JSON.stringify(listRow)}`);
  await s(A, '32-connect-1b-list');
  await A.click('#connections-list .connection-row');
  await until(A, () => !document.getElementById('connection-page').hidden && /^No notes yet\. Turn on Agents in a note’s Share/.test(document.getElementById('connection-sees').textContent))
    .catch(async () => { throw new Error(`its page should say what it sees: "${await A.$eval('#connection-sees', (e) => e.textContent)}"`); });
  await s(A, '32-connect-2-connection');
  await closeSettings(A);
  // A note shared with agents, or no longer (#514): its row's menu, Share…, the Agents switch.
  const share = async (title, label) => {
    const on = label === 'Share with agents';
    await A.evaluate((t) => [...document.querySelectorAll('#note-list li[data-id]')].find((li) => li.querySelector('.title')?.textContent === t)
      .querySelector('button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 })), title);
    await until(A, () => !document.getElementById('note-menu').hidden && !document.getElementById('note-menu-share').hidden);
    await A.evaluate(() => document.getElementById('note-menu-share').click());
    await until(A, () => document.getElementById('share-dialog').open && !document.getElementById('share-agents').hidden);
    if ((await A.$eval('#share-agents-on', (e) => e.checked)) === on) throw new Error(`"${title}": Agents should be ${on ? 'off' : 'on'} before`);
    await A.click('#share-agents-on');
    await until(A, (on) => document.getElementById('share-agents-on').checked === on
      && document.getElementById('share-agents-sub').textContent.startsWith(on ? 'Claude' : 'Off'), on, 5000)
      .catch(async () => { throw new Error(`"${title}": the switch ${on ? 'on' : 'off'}: "${await A.$eval('#share-agents-sub', (e) => e.textContent)}"`); });
    await A.evaluate(() => document.getElementById('share-dialog').close());
  };
  // "Training 2026" shared with agents: shared with it (a holder of the connection's), listed for it.
  const sharedRows = () => A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].filter((li) => li.querySelector('[data-shared]')).length);
  const sharedBefore = await sharedRows();
  const gymNotes = 1; // (the notes shared with agents)
  await share('Training 2026', 'Share with agents');
  await until(A, (n) => [...document.querySelectorAll('#note-list li[data-id]')].filter((li) => li.querySelector('[data-shared]')).length >= n, sharedBefore + 1, 60000)
    .catch(async () => { throw new Error(`"Training 2026" should show as shared: ${await sharedRows()} rows are (${sharedBefore} before)`); });
  // (The row shows shared once its holder is made; the list is saved after: wait for it.)
  let given = await listed();
  for (let i = 0; i < 40 && (given.titles.length < gymNotes || given.roles.some((r) => r !== 'edit')); i++) {
    await wait(250);
    given = await listed();
  }
  if (given.titles.join() !== 'Training 2026' || given.roles.some((r) => r !== 'edit') || given.opened.some((o) => o !== 'edit')) throw new Error(`the connection's list with "Training 2026" shared with agents: ${JSON.stringify(given)}`);
  await openSettings(A, 'connections');
  await until(A, () => !document.getElementById('connection-page').hidden || document.querySelectorAll('#connections-list .connection-row').length === 1, undefined, 20000);
  await A.evaluate(() => document.getElementById('connection-page').hidden && document.querySelector('#connections-list .connection-row').click()); // (or still on its page)
  await until(A, () => !document.getElementById('connection-page').hidden);
  {
    // (Two devices keep the connection in step: a holder made twice is dropped on the next pass.)
    const count = () => {
      const db = new DatabaseSync(server.db);
      const n = db.prepare('SELECT COUNT(*) AS n FROM holders WHERE connection_id = ?').get(frag.connection).n;
      db.close();
      return n;
    };
    let holders = count();
    for (let i = 0; i < 40 && holders !== gymNotes + 1; i++) {
      await wait(250);
      holders = count();
    }
    if (holders !== gymNotes + 1) throw new Error(`holders of the connection's: ${holders} (want ${gymNotes} notes + its list)`);
  }
  // Claude reads the note (through its holder), and makes a note of its own (a share of yours,
  // signed with the connection's key, listed with its seed). The app takes the note in when the
  // connection's page is opened again, gives the connection a holder for it, and shows what Claude did.
  const seen = await claude('read_note', { note: 'Training 2026' });
  if (seen.error || !seen.text.startsWith('Training 2026 · ')) throw new Error(`Claude reading a note shared with agents: ${JSON.stringify(seen)}`);
  const hidden = await claude('read_note', { note: 'Leg day' });
  if (!hidden.error) throw new Error(`Claude shouldn't read a #gym note not shared with agents: ${JSON.stringify(hidden)}`);
  const made = await claude('create_note', { text: 'From Claude\n\n- made over the web' });
  if (made.error || !made.text.startsWith('Created "From Claude", shared with agents: ')) throw new Error(`Claude making a note: ${JSON.stringify(made)}`);
  await A.evaluate(() => document.getElementById('connection-back').click()); // (a phone's button; the desktop has the nav)
  await until(A, () => !document.getElementById('connections-list-view').hidden && document.querySelector('#connections-list .connection-row'));
  await wait(300); // (the list is drawn again once the server says when it was last used)
  await A.evaluate(() => document.querySelector('#connections-list .connection-row').click());
  await until(A, () => !document.getElementById('connection-page').hidden);
  await until(A, () => [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.textContent.includes('From Claude') && li.querySelector('[data-shared]')), undefined, 30000)
    .catch(() => { throw new Error('the note Claude made should be among your notes, shared with it'); });
  await until(A, () => document.getElementById('connection-status').textContent === '' && [...document.querySelectorAll('#connection-activity .activity-what')].some((e) => /^Created "From Claude"/.test(e.textContent)), undefined, 30000)
    .catch(async () => { throw new Error(`the connection's activity: ${await A.evaluate(() => [...document.querySelectorAll('#connection-activity .activity-what')].map((e) => e.textContent).join(' | '))}`); });
  await wait(500);
  {
    // (Two devices keep the connection in step: a holder made twice is dropped on the next pass.)
    const count = () => {
      const db = new DatabaseSync(server.db);
      const n = db.prepare('SELECT COUNT(*) AS n FROM holders WHERE connection_id = ?').get(frag.connection).n;
      db.close();
      return n;
    };
    let holders = count();
    for (let i = 0; i < 40 && holders !== gymNotes + 2; i++) {
      await wait(250);
      holders = count();
    }
    if (holders !== gymNotes + 2) throw new Error(`holders of the connection's with the note it made: ${holders} (want ${gymNotes} + 1 notes + its list)`);
  }
  const withMade = await listed();
  if (withMade.titles.length !== gymNotes + 1 || !withMade.titles.includes('From Claude') || withMade.opened.some((o) => o !== 'edit')) throw new Error(`the connection's list with the note it made: ${JSON.stringify(withMade)}`);
  const again = await claude('read_note', { note: 'From Claude' });
  if (again.error || !again.text.includes('- made over the web')) throw new Error(`Claude reading the note it made, now through its holder: ${JSON.stringify(again)}`);
  // (Its row: Claude's letter, at its top right, as it's shared with agents, #514; and written by it, #564.)
  if (!(await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.querySelector('.title')?.textContent === 'From Claude'
    && [...li.querySelectorAll('.row-marks .reach-badge')].map((b) => b.dataset.i).join() === 'C' && li.querySelector('.row-marks .reach').getAttribute('aria-label') === 'Shared with agents: Claude. Written in by Claude')))) {
    throw new Error('the note Claude made should be shared with agents: Claude\'s letter on its row');
  }
  await s(A, '32-connect-3-shared');
  // Tags share nothing (#514): no mark on a tag, in the chips, the rows' tags, or Preview.
  {
    const badges = await A.evaluate(() => document.querySelectorAll('#tag-chips .reach-badge, #subtag-chips .reach-badge, #note-list .row-tags .reach-badge').length);
    if (badges) throw new Error(`no marks on tags: ${badges}`);
    await closeSettings(A);
    await openNote(A, 'Training 2026', { edit: false });
    await setView(A, 'preview');
    if (await A.evaluate(() => document.querySelector('.reading .tag .reach-badge'))) throw new Error('a tag in Preview should carry no mark');
    await s(A, '32-connect-5-badges');
    // The note's bar: a "Shared with agents" pill with Claude's letter, which opens Share (and, as
    // the note isn't shared with people, stands for Share: no sharing light, no Share beside it).
    // On a phone, the pill's letters; its ⋯ menu: Share…, "Shared with agents" under it, no Live.
    const bar = () => A.evaluate(() => {
      const b = document.getElementById(matchMedia('(max-width: 720px)').matches ? 'note-more' : 'note-share');
      const pill = document.getElementById('note-agents');
      return { light: b.classList.contains('shared'), pill: Boolean(pill.offsetParent), marks: [...pill.querySelectorAll('.reach-badge')].map((m) => m.dataset.i).join(),
        words: getComputedStyle(pill.querySelector('.pill-words')).display !== 'none', share: document.getElementById('note-share').getClientRects().length > 0, title: pill.title };
    });
    {
      const b = await bar();
      if (b.light || !b.pill || b.marks !== 'C' || b.share || b.words === mobile(A) || b.title !== 'Shared with agents: Claude. Claude reads and writes it. Share…') {
        throw new Error(`a note only Claude has: the agents' pill, not the light: ${JSON.stringify(b)}`);
      }
      // A long title gives way to the pill, an ellipsis before it, never under it (a phone's bar).
      const kept = await A.$eval('#note-title', (t) => t.textContent);
      await A.$eval('#note-title', (t) => (t.textContent = 'Training 2026, the whole year of squats, deadlifts and bench'));
      await titleClear(A, 'a long title beside the agents\' pill');
      await A.$eval('#note-title', (t, k) => (t.textContent = k), kept);
      if (mobile(A)) {
        await A.click('#note-more');
        await until(A, () => !document.getElementById('note-menu').hidden);
        const m = await A.evaluate(() => ({
          label: document.getElementById('note-menu-share-label').textContent, sub: document.getElementById('note-menu-share-sub').textContent,
          subShown: !document.getElementById('note-menu-share-sub').hidden, live: !document.getElementById('note-menu-live').hidden,
          move: Boolean(document.getElementById('note-menu-move')),
        }));
        if (m.label !== 'Share…' || m.sub !== 'Shared with agents' || !m.subShown || m.live || m.move) throw new Error(`the ⋯ menu of a note only Claude has: ${JSON.stringify(m)}`);
        await s(A, '32-connect-5b-menu');
        await A.keyboard.press('Escape');
      }
    }
    // The pill: its Share dialog. Agents first, on, Claude's letter, who can do what; no one under
    // "Who has this note"; the note's links held back (nobody has them yet), "Create links" and
    // "A link for someone…" instead, and nothing to replace or stop. A note shared only for agents
    // isn't "Shared" in the list.
    await A.click('#note-agents');
    await until(A, () => document.getElementById('share-dialog').open && !document.getElementById('share-agents').hidden);
    const who = await A.evaluate(() => ({
      on: document.getElementById('share-agents-on').checked, sub: document.getElementById('share-agents-sub').textContent,
      marks: [...document.querySelectorAll('#share-agents-marks .reach-badge')].map((m) => m.dataset.i).join(),
      people: !document.getElementById('share-who').hidden,
      held: !document.getElementById('share-links-off').hidden && document.getElementById('share-links').hidden,
      stop: !document.getElementById('share-stop').hidden || !document.getElementById('share-replace').hidden,
    }));
    if (!who.on || who.sub !== 'Claude can read and edit this note.' || who.marks !== 'C' || who.people || !who.held || who.stop) throw new Error(`the Share dialog on a note only Claude has: ${JSON.stringify(who)}`);
    const label = await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].find((li) => li.querySelector('.title')?.textContent === 'Training 2026')?.querySelector('.when').textContent);
    if (/Shared/.test(label ?? '')) throw new Error(`a note shared only for Claude shows as Shared: "${label}"`);
    await s(A, '32-connect-6-share');
    // Create links: the ones it has, shown (nothing new made). Then "Stop sharing with people": their
    // links stop and the note gets new keys, but Claude keeps it (its row follows), and the links are
    // held back again.
    await A.click('#share-show-links');
    await until(A, () => !document.getElementById('share-links').hidden && !document.getElementById('share-stop').hidden);
    const peopleLink = await A.$eval('#share-edit-link', (e) => e.value);
    // (Its links handed out: people now, so the light, and Share beside the pill again.)
    await until(A, () => document.getElementById('note-share').classList.contains('shared'), undefined, 10000)
      .catch(async () => { throw new Error(`links handed out: the sharing light: ${JSON.stringify(await bar())}`); });
    {
      const b = await bar();
      if (!b.light || !b.pill || (!mobile(A) && !b.share)) throw new Error(`people and Claude: the light, and the pill: ${JSON.stringify(b)}`);
    }
    if ((await A.$eval('#share-stop', (e) => e.textContent)) !== 'Stop sharing with people') throw new Error('shared with agents too, the button says it stops sharing with people');
    await A.evaluate(() => document.getElementById('share-stop').click()); // (the confirm box is accepted)
    await until(A, () => !document.getElementById('share-links-off').hidden && !document.getElementById('share-dialog').dataset.busy, undefined, 30000)
      .catch(async () => { throw new Error(`after stopping sharing with people: ${await A.evaluate(() => document.getElementById('share-error').textContent)}`); });
    const after = await A.evaluate(() => ({ people: !document.getElementById('share-who').hidden, on: document.getElementById('share-agents-on').checked }));
    const stillReads = await claude('read_note', { note: 'Training 2026' });
    const gone = await A.evaluate(async (link) => {
      const s = await import('/core/share.js');
      const u = new URL(link);
      const p = s.parseShareLink(u.pathname, u.hash);
      const keys = await s.shareKeys(p.secret);
      return (await fetch(`/api/shares/${p.shareId}`, { headers: { 'x-share-token': s.readTokenHex(keys) } })).status;
    }, peopleLink);
    if (after.people || !after.on || stillReads.error || gone !== 404) throw new Error(`stop sharing with people: ${JSON.stringify(after)}; Claude reads: ${stillReads.text.slice(0, 80)}; the old link answers ${gone}`);
    await A.evaluate(() => document.getElementById('share-dialog').close());
    await until(A, () => !document.getElementById('note-share').classList.contains('shared') && !document.getElementById('note-agents').hidden, undefined, 10000)
      .catch(async () => { throw new Error(`no people again: the pill alone: ${JSON.stringify(await bar())}`); });
    // Claude writes in the note open here (#389): its lines marked on the page (and in the
    // editor, on a computer), its chip in the bar, its badge on History's latest; the list says
    // "by Claude" once the connection's activity is read.
    // (Still on its page, after its keys were replaced above: a note opened again keeps its mode.)
    if (!(await A.evaluate(() => !document.getElementById('reading').hidden))) throw new Error('the note should stay on its page after stopping sharing with people');
    // (What's still to be typed in, each frame, #480: the text under the highlight.)
    await A.evaluate(() => {
      window.__arriving = [];
      window.__sampling = true;
      const tick = () => {
        const h = CSS.highlights.get('arriving');
        if (h?.size) window.__arriving.push([...h].map((r) => r.toString()).join(''));
        if (window.__sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const wrote = await claude('append_to_note', { note: 'Training 2026', text: '- Bench 3×8 @ 60 kg' });
    if (wrote.error) throw new Error(`Claude adding to a note: ${wrote.text}`);
    await until(A, () => [...document.querySelectorAll('.reading .app-edit-start')].some((e) => e.dataset.app === 'C' && /Bench/.test(e.textContent) && /Added by Claude/.test(e.title)), undefined, 20000)
      .catch(async () => { throw new Error(`Claude's lines should be marked on the page: ${await A.evaluate(() => `${document.querySelector('.reading')?.textContent.slice(0, 300)} | marks: ${[...document.querySelectorAll('.reading .app-edit, .reading .app-edit-start')].map((e) => `${e.className}:${e.dataset.app}:${e.title}`).join(';')}`)}`); });
    // Its line typed in (#480): left to right over several frames, less of it hidden each time, then all shown.
    await wait(1500);
    const typedIn = await A.evaluate(() => { window.__sampling = false; const f = window.__arriving; return { frames: f.length, first: f[0], last: f.at(-1), shrinks: f.every((t, i) => !i || t.length <= f[i - 1].length), now: CSS.highlights.get('arriving')?.size ?? 0 }; });
    if (!(typedIn.frames >= 5 && /Bench 3×8/.test(typedIn.first) && typedIn.last.length < typedIn.first.length && typedIn.shrinks && !typedIn.now)) throw new Error(`Claude's line should be typed in, then shown whole: ${JSON.stringify(typedIn)}`);
    if (!(await A.evaluate(() => !document.getElementById('app-here').hidden && document.getElementById('app-here').dataset.initial === 'C'))) throw new Error('Claude\'s chip should be in the note\'s bar');
    // A long title gives way to the chip (#482: on a phone it ran under it), as to others' initials.
    const shortTitle = await A.evaluate(() => { const t = document.getElementById('note-title'); const was = t.textContent; t.textContent = 'Training 2026: the whole year, week by week, with every lift'; return was; });
    await titleClear(A, 'a long title beside Claude\'s chip');
    await A.evaluate((t) => (document.getElementById('note-title').textContent = t), shortTitle);
    await s(A, '32-connect-7-claude-wrote');
    if (!mobile(A)) {
      await setView(A, 'edit');
      await until(A, () => [...document.querySelectorAll('#editor .cm-line.app-edit-start')].some((l) => /Bench/.test(l.textContent)), undefined, 10000)
        .catch(async () => { throw new Error(`Claude's line should be marked in the editor: ${JSON.stringify(await A.evaluate(() => [...document.querySelectorAll('#editor .cm-line')].map((l) => [l.className, l.textContent.slice(0, 30)])))}`); });
      await s(A, '32-connect-8-claude-in-editor');
      await setView(A, 'preview');
    }
    // Claude edits it (#74): a piece replaced each time, the note kept as a version before each
    // edit, so History has every step; four in a row, minutes apart at most, fold into one row
    // (#470) that opens to show them, the version before the last edit as it was.
    for (const [from, to] of [['- Bench 3×8 @ 60 kg', '- Bench 3×8 @ 62.5 kg'], ['62.5 kg', '65 kg'], ['Squat · 135 lb', 'Squat · 140 lb'], ['140 lb', '145 lb']]) {
      const edited = await claude('edit_note', { note: 'Training 2026', old_text: from, new_text: to });
      if (edited.error || !edited.text.startsWith('Edited "Training 2026"')) throw new Error(`Claude editing a note: ${edited.text}`);
      await wait(1100); // (a second apart: versions are timed to the second)
    }
    const bad = await claude('edit_note', { note: 'Training 2026', old_text: 'Deadlift', new_text: 'Deadlift 3×5' });
    if (!bad.error || !/isn’t in the note|isn't in the note/.test(bad.text)) throw new Error(`an edit of text not in the note should say so: ${JSON.stringify(bad)}`);
    await until(A, () => /Squat · 145 lb/.test(document.getElementById('reading').textContent) && /65 kg/.test(document.getElementById('reading').textContent), undefined, 20000)
      .catch(async () => { throw new Error(`Claude's edits should reach the open note: ${await A.evaluate(() => document.getElementById('reading').textContent.slice(0, 200))}`); });
    // Its marks on the page: one badge for a run of its blocks, at the first (#471): the Squat line
    // it edited starts one; the Bench item it wrote right under it carries on the run, no badge of
    // its own (a list item's text is first in its item, which used to count as a start).
    const marks = await A.evaluate(() => [...document.querySelectorAll('#reading [data-from]')]
      .filter((e) => /Squat · 145|Bench 3×8/.test(e.textContent) && !e.querySelector('[data-from]'))
      .map((e) => `${e.textContent.slice(0, 12)}:${e.classList.contains('app-edit') ? 'marked' : '-'}:${e.classList.contains('app-edit-start') ? 'badge' : '-'}`));
    if (!/^Squat · 145.*:marked:badge,.*Bench 3×8.*:marked:-$/.test(marks.join())) throw new Error(`one badge per run of Claude's blocks: ${JSON.stringify(marks)}`);
    // And one bar for it (#477), from the paragraph's top to the list item's bottom, in the gutter
    // left of the text column (not out in the list's indent, beside the item), the blocks untinted.
    const run = await A.evaluate(() => {
      const [squat, bench] = [...document.querySelectorAll('#reading .app-edit')].filter((e) => /Squat · 145|Bench 3×8/.test(e.textContent)).map((e) => e.getBoundingClientRect());
      const column = document.querySelector('#reading > :not(.layer)').getBoundingClientRect().left;
      const bars = [...document.querySelectorAll('#reading .app-run')].map((b) => ({ app: b.dataset.app, r: b.getBoundingClientRect() }));
      const bar = bars.find((b) => b.r.top <= squat.top + 1 && b.r.bottom >= squat.bottom);
      // (Its fade done: a block just edited lights up, which isn't the mark.)
      const tints = [...document.querySelectorAll('#reading .app-edit')].map((e) => (e.getAnimations().forEach((a) => a.finish()), getComputedStyle(e).backgroundColor)).filter((c) => c !== 'rgba(0, 0, 0, 0)');
      return { app: bar?.app, covers: Boolean(bar && bar.r.bottom >= bench.bottom - 1), gutter: bar ? Math.round(column - bar.r.right) : null, bars: bars.length, tints };
    });
    if (run.app !== 'C' || !run.covers || !(run.gutter > 4 && run.gutter < 16) || run.tints.length) throw new Error(`one bar in the gutter for a run of Claude's blocks, no tint: ${JSON.stringify(run)}`);
    await openHistory(A);
    await until(A, () => document.querySelector('#history-list .history-row-top .reach-badge'), undefined, 20000)
      .catch(() => { throw new Error('History should mark a version with Claude\'s changes'); });
    // Now: nothing since Claude's last change was kept (each kept after it's made, timed so).
    const now = await A.evaluate(() => document.querySelector('#history-list button[data-id="now"] .history-by').textContent);
    if (now) throw new Error(`Now should credit nobody, Claude's last change being the newest version: ${JSON.stringify(now)}`);
    // Folded by its session (#505): "Claude · amber fox · 5 versions", the session's two words.
    const burst = await A.evaluate(() => document.querySelector('#history-list .history-burst-head .history-time')?.textContent ?? null);
    const session = /^Claude · ([a-z]+ [a-z]+) · [3-9] versions$/.exec(burst ?? '')?.[1];
    if (!session) throw new Error(`Claude's edits in a row should fold into one row in History, named by its session: ${JSON.stringify(burst)} (rows: ${await A.evaluate(() => [...document.querySelectorAll('#history-list button')].map((b) => b.textContent.slice(0, 40)).join(' | '))})`);
    // (Open: it opened itself if the version shown first, the newest, is in it.)
    await A.evaluate(() => { const h = document.querySelector('#history-list .history-burst-head'); if (h.getAttribute('aria-expanded') !== 'true') h.click(); });
    await until(A, () => !document.querySelector('#history-list .history-burst-rows').hidden && document.querySelector('#history-list .history-burst-rows button[data-id]'));
    // Each of its versions says who made it, once read: Claude, that session (by the version itself).
    await until(A, (who) => [...document.querySelectorAll('#history-list .history-burst-rows button[data-id]')].every((b) => b.getAttribute('aria-description') === `By Claude · ${who}` && b.querySelector('.history-by').textContent === `Claude · ${who}`), session, 10000)
      .catch(async () => { throw new Error(`each version of the burst should say it's Claude · ${session}: ${await A.evaluate(() => JSON.stringify([...document.querySelectorAll('#history-list .history-burst-rows button[data-id]')].map((b) => [b.getAttribute('aria-description'), b.querySelector('.history-by').textContent])))}`); });
    await s(A, '32-connect-7b-history-edits');
    // The newest version: the note as Claude's last edit left it (145 lb, from 140): each change kept after it's made.
    await A.evaluate(() => document.querySelector('#history-list button[data-id]:not([data-id="now"])').click());
    await until(A, () => /Squat · 140 lb/.test(document.getElementById('history-diff').textContent) && /Squat · 145 lb/.test(document.getElementById('history-diff').textContent), undefined, 10000)
      .catch(async () => { throw new Error(`Claude's last edit, 140 lb to 145: ${await A.evaluate(() => document.getElementById('history-diff').textContent.slice(0, 200))}`); });
    await A.evaluate(() => document.getElementById('history-dialog').close());
    await openSettings(A, 'connections');
    await until(A, () => !document.getElementById('connection-page').hidden || document.querySelectorAll('#connections-list .connection-row').length === 1, undefined, 20000);
    await A.evaluate(() => document.getElementById('connection-page').hidden && document.querySelector('#connections-list .connection-row').click()); // (or still on its page)
    await until(A, () => !document.getElementById('connection-page').hidden);
    await until(A, () => [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.querySelector('.title')?.textContent === 'Training 2026' && /by Claude/.test(li.querySelector('.when').textContent)), undefined, 30000)
      .catch(async () => { throw new Error(`the list should say Claude edited "Training 2026" last: ${await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id] .when')].map((e) => e.textContent).join(' | '))}`); });
    await until(A, () => document.getElementById('connection-status').textContent === '', undefined, 60000);
    await closeSettings(A);
  }
  // "Training 2026" no longer shared with agents: it gets new keys and is private again (shared only
  // for it); the list keeps the note Claude made (shared with agents).
  await backToList(A);
  await share('Training 2026', 'Stop sharing with agents');
  await until(A, () => ![...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.querySelector('.title')?.textContent === 'Training 2026' && li.querySelector('[data-shared]')), undefined, 60000)
    .catch(() => { throw new Error('"Training 2026" should be private again'); });
  let taken = await listed();
  for (let i = 0; i < 40 && taken.titles.join() !== 'From Claude'; i++) {
    await wait(250);
    taken = await listed();
  }
  if (taken.status !== 200 || taken.titles.join() !== 'From Claude') throw new Error(`the connection's list after "Training 2026" was no longer shared: ${JSON.stringify(taken)}`);
  const less = await claude('list_notes');
  if (less.error || less.text.includes('Training 2026') || !less.text.includes('From Claude')) throw new Error(`Claude after "Training 2026" was no longer shared: ${JSON.stringify(less)}`);
  // On the server too: the connection's holders are its list's and the note it made's, nothing
  // else. (With two devices signed in, flows 13 and 14 first: neither left one behind, #466.)
  const db = () => new DatabaseSync(server.db);
  const holdersOf = () => {
    const d = db();
    const n = d.prepare('SELECT COUNT(*) AS n FROM holders WHERE connection_id = ?').get(frag.connection).n;
    d.close();
    return n;
  };
  {
    let n = holdersOf();
    for (let i = 0; i < 120 && n !== 2; i++) {
      await wait(250);
      n = holdersOf();
    }
    if (n !== 2) throw new Error(`after #gym was taken away, the connection's holders: ${n} (want its list's and the note it made's)`);
  }
  // A holder of its left on a share no note uses (#465: before #464, two devices sharing the same
  // note at once each made a share; the index kept one): found and deleted, its share too, once
  // it's old enough. (Put in the server's database here, an hour old; a page looks for them on its
  // first pass, so A is opened again.) The connection's own holders stay.
  const stray = { share: 'deadbeef'.repeat(4), holder: 'feedface'.repeat(4) };
  {
    const d = db();
    const owner = d.prepare('SELECT owner_account FROM connections WHERE connection_id = ?').get(frag.connection).owner_account;
    const old = Math.floor(Date.now() / 1000) - 3600;
    d.prepare('INSERT INTO shares (share_id, owner_account, pubkey, read_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(stray.share, owner, Buffer.alloc(32), Buffer.alloc(32), old);
    d.prepare('INSERT INTO holders (holder_id, owner_account, share_id, role, token_hash, nonce, ciphertext, created_at, connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(stray.holder, owner, stray.share, 'edit', Buffer.alloc(32, 1), Buffer.alloc(12), Buffer.alloc(16), old, frag.connection);
    d.close();
  }
  await A.reload();
  await waitView(A, 'view-locked');
  await unlockWithPasskey(A);
  const strayLeft = () => {
    const d = db();
    const r = { holder: d.prepare('SELECT COUNT(*) AS n FROM holders WHERE holder_id = ?').get(stray.holder).n, share: d.prepare('SELECT COUNT(*) AS n FROM shares WHERE share_id = ?').get(stray.share).n };
    d.close();
    return r;
  };
  {
    let left = strayLeft();
    for (let i = 0; i < 120 && (left.holder || left.share); i++) {
      await wait(250);
      left = strayLeft();
    }
    if (left.holder || left.share || holdersOf() !== 2) throw new Error(`the stray holder and its share should be gone, the connection's own kept: ${JSON.stringify(left)}, ${holdersOf()} holders`);
  }
  await openSettings(A, 'connections');
  await until(A, () => document.querySelectorAll('#connections-list .connection-row').length === 1, undefined, 20000);
  await A.evaluate(() => document.querySelector('#connections-list .connection-row').click());
  await until(A, () => !document.getElementById('connection-page').hidden);
  // Where it came from, said (#390): the stand-in Claude is on this machine.
  const meta = await A.$eval('#connection-meta', (e) => e.textContent);
  if (!/^From an app on this computer · connected/.test(meta)) throw new Error(`the connection's page should say where it came from: "${meta}"`);
  // Shared with agents (#514): Claude makes a note with a topic, which the app takes in there (its
  // row, its topics, no badges); a note of yours shared reaches Claude, no longer shared it doesn't.
  {
    const reopen = async () => {
      await A.evaluate(() => document.getElementById('connection-back').click());
      await until(A, () => !document.getElementById('connections-list-view').hidden && document.querySelector('#connections-list .connection-row'));
      await A.evaluate(() => document.querySelector('#connections-list .connection-row').click());
      await until(A, () => !document.getElementById('connection-page').hidden);
    };
    const settled = () => until(A, () => document.getElementById('connection-status').textContent === '', undefined, 60000);
    await settled();
    // (In its list, for the connectors from before #514: it keeps the notebook.)
    const info = (await listed()).info;
    if (info?.notebook !== true || 'tags' in info || 'ownTag' in info) throw new Error(`its list's info: ${JSON.stringify(info)}`);
    const grants = await claude('list_grants');
    if (!grants.text.includes('You can read and edit the notes the user shares with agents') || !grants.text.includes('Tags only sort notes')) throw new Error(`what Claude is told it may do: ${grants.text}`);
    const kept = await claude('create_note', { text: 'Knee\n#health/knee\n\n- MRI on the 3rd' });
    if (kept.error || !kept.text.startsWith('Created "Knee", shared with agents: ')) throw new Error(`Claude making a note with a topic: ${JSON.stringify(kept)}`);
    await reopen(); // (opening its page looks at its list: the note comes in)
    await until(A, () => !document.getElementById(matchMedia('(max-width: 720px)').matches ? 'view-switch' : 'view-connected').hidden
      && [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.querySelector('.title')?.textContent === 'Knee' && li.querySelector('.row-marks .reach-badge')?.dataset.i === 'C'), undefined, 30000)
      .catch(async () => { throw new Error(`the note Claude made should be there, shared with agents: ${await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].map((li) => li.textContent).join(' | '))}`); });
    if (!/^2 notes\./.test(await A.$eval('#connection-sees', (e) => e.textContent))) throw new Error('its page should count the notes shared with agents ("From Claude" and "Knee")');
    await settled();
    await closeSettings(A);
    // The view (#539, #552): "Connected" in the sidebar (a phone: in the switch at the top), Claude's
    // letter on it. In it: the notes shared with agents (From Claude, Knee) and the notes an agent
    // wrote in (Training 2026, no longer shared, that Claude wrote in above), each with Claude's
    // letter; what's in it, said; their tags as chips (no marks on them). Notes: every note again.
    const view = await A.evaluate(() => {
      const b = matchMedia('(max-width: 720px)').matches ? document.querySelector('#view-switch [data-view="connected"]') : document.getElementById('view-connected');
      return { marks: [...b.querySelectorAll('.reach-badge')].map((m) => m.dataset.i).join(), words: b.textContent.trim() };
    });
    if (view.marks !== 'C' || view.words !== 'Agents') throw new Error(`the Agents view: ${JSON.stringify(view)}`);
    await pickView(A, 'connected');
    const picked = await A.evaluate(() => ({
      rows: [...document.querySelectorAll('#note-list li[data-id]')].map((li) => `${li.querySelector('.title').textContent}:${[...li.querySelectorAll('.row-marks .reach-badge')].map((m) => m.dataset.i).join('')}`),
      about: document.getElementById('notes-about').textContent,
      topics: [...document.querySelectorAll('#tag-chips .tag-chip')].map((b) => b.dataset.tag), badges: document.querySelectorAll('#tag-chips .reach-badge').length,
    }));
    if ([...picked.rows].sort().join() !== 'From Claude:C,Knee:C,Training 2026:C' || picked.about !== 'Notes shared with agents, which Claude reads and edits, and notes an agent or a script wrote in.'
      || picked.badges) {
      throw new Error(`the Connected view, picked: ${JSON.stringify(picked)}`);
    }
    // Who writes (#564): a row for Claude, the notes it wrote in, all within 7 days, its last just
    // now; picked, only its notes (pressed, ruled); again, every one. Not in Notes.
    const writers = () => A.evaluate(() => ({
      shown: !document.getElementById('writers').hidden,
      rows: [...document.querySelectorAll('#writers-rows tr')].map((tr) => [tr.querySelector('.reach-badge').dataset.name, ...[...tr.querySelectorAll('td')].map((td) => td.textContent)].join(' ')),
      pressed: [...document.querySelectorAll('#writers-rows .writer-pick')].map((b) => b.getAttribute('aria-pressed')).join(),
      notes: [...document.querySelectorAll('#note-list li[data-id] .title')].map((t) => t.textContent).sort().join(),
    }));
    {
      const w = await writers();
      if (!w.shown || w.rows.length !== 1 || !/^Claude (\d+) \1 (now|\dm)$/.test(w.rows[0]) || w.pressed !== 'false') throw new Error(`who writes, in Connected: ${JSON.stringify(w)}`);
      await A.click('#writers-rows .writer-pick');
      await until(A, () => document.querySelector('#writers-rows .writer-pick').getAttribute('aria-pressed') === 'true');
      const p = await writers();
      if (!p.notes.includes('Training 2026') || !p.notes.includes('Knee')) throw new Error(`Claude's notes, picked: ${JSON.stringify(p)}`);
      if (Number(w.rows[0].split(' ')[1]) !== p.notes.split(',').length) throw new Error(`picked, as many notes as its row says: ${JSON.stringify({ w, p })}`);
      await s(A, '32-connect-7c-who-writes');
      await A.click('#writers-rows .writer-pick');
      await until(A, () => document.querySelector('#writers-rows .writer-pick').getAttribute('aria-pressed') === 'false');
      if ((await writers()).notes !== w.notes) throw new Error('unpicked: every Connected note again');
    }
    await s(A, '32-connect-7-notebook');
    await pickView(A, 'notes');
    if ((await writers()).shown) throw new Error('who writes is Connected\'s, not in Notes');
    // A note of yours shared, from its Share: Claude reads it; no longer shared, it doesn't.
    const reads = async (title) => !(await claude('read_note', { note: title })).error;
    const until_ = async (fn, what) => {
      for (let i = 0; i < 120; i++) if (await fn()) return;
      else await new Promise((r) => setTimeout(r, 250));
      throw new Error(what);
    };
    if (await reads('Leg day')) throw new Error('Claude shouldn\'t read "Leg day" yet');
    await share('Leg day', 'Share with agents');
    await until_(() => reads('Leg day'), '"Leg day" shared with agents: Claude should read it');
    await until(A, () => [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.querySelector('.title')?.textContent === 'Leg day' && li.querySelector('.row-marks')));
    await share('Leg day', 'Stop sharing with agents');
    await until_(async () => !(await reads('Leg day')), '"Leg day" no longer shared: Claude shouldn\'t read it');
    await openSettings(A, 'connections');
    await until(A, () => !document.getElementById('connection-page').hidden || document.querySelectorAll('#connections-list .connection-row').length === 1, undefined, 20000);
    await A.evaluate(() => document.getElementById('connection-page').hidden && document.querySelector('#connections-list .connection-row').click());
    await until(A, () => !document.getElementById('connection-page').hidden);
    await settled();
  }
  // Disconnect: the connection gone from the list at once, Claude cut off (#494: it lingered, its
  // Disconnect faded, while the rest was done, and the one button stayed off for other connections);
  // then, in the background, its list and its rows go; the note it made stays yours.
  await A.click('#connection-disconnect'); // (the confirm box is accepted)
  await until(A, () => !document.getElementById('connections-list-view').hidden && document.querySelectorAll('#connections-list .connection-row').length === 0, undefined, 30000);
  if (await A.$eval('#connection-disconnect', (b) => b.disabled)) throw new Error('Disconnect should be on again once it is done, for the next connection (#494)');
  const off = await claude('list_notes');
  if (!off.error || !/turned off/.test(off.text)) throw new Error(`Claude after Disconnect: ${JSON.stringify(off)}`);
  if (!(await A.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.textContent.includes('From Claude'))))) throw new Error('the note Claude made should stay among your notes');
  {
    const rows = () => {
      const db = new DatabaseSync(server.db);
      const n = db.prepare('SELECT (SELECT COUNT(*) FROM connections) + (SELECT COUNT(*) FROM holders WHERE connection_id IS NOT NULL) AS n').get().n;
      db.close();
      return n;
    };
    let gone = await listed();
    for (let i = 0; i < 60 && ((gone.status !== 410 && gone.status !== 404) || rows()); i++) {
      await new Promise((r) => setTimeout(r, 500));
      gone = await listed();
    }
    if (gone.status !== 410 && gone.status !== 404) throw new Error(`after Disconnect, the connection's list answers ${gone.status}`);
    if (rows()) throw new Error(`after Disconnect, ${rows()} rows of the connection's are left`);
  }
  await s(A, '32-connect-4-disconnected');
  await closeSettings(A);
  // The switch (#514), once: a connection from before, given #gym, in your index; the next unlock lists
  // the #gym notes not shared with agents, ticked. Only "Leg day" left ticked: it's shared with agents,
  // the rest stay yours, and the connection's tags go. (Taken out again after: a stand-in.)
  await A.evaluate(async () => {
    const { state } = await import(new URL('ui/shared.js', document.querySelector('script[type=module]').src)); // (the app's own: its address may be under a note's)
    state.index.ydoc.getMap('connections').set('0ld0ld00'.repeat(4), { name: 'Old Claude', secret: 'A'.repeat(43) + '=', listShareId: '0'.repeat(32), listSeed: 'A'.repeat(43) + '=', tags: { gym: 'write' }, ownTag: 'claude/old', notebook: true, created: 1 });
    await state.index.flush();
  });
  await freshAuthMinute(); // (unlocking again after this flow's signed requests: the next minute's allowance)
  await A.reload();
  await waitView(A, 'view-locked');
  await unlockWithPasskey(A);
  await until(A, () => document.getElementById('agents-switch-dialog').open, undefined, 20000)
    .catch(() => { throw new Error('the switch should be asked about, once, with a connection given tags'); });
  const asked = await A.evaluate(() => ({
    who: document.getElementById('agents-switch-who').textContent,
    rows: [...document.querySelectorAll('#agents-switch-list .pick-row')].map((li) => `${li.querySelector('.setting-title').textContent} ${li.querySelector('.tag-name').textContent}:${li.querySelector('input').checked}`),
    go: document.getElementById('agents-switch-go').textContent,
  }));
  if (!/^Old Claude reached these \d+ notes through tags\. Keep sharing them\?$/.test(asked.who) || !asked.rows.includes('Leg day #gym/legs:true') || !asked.rows.includes('Training 2026 #gym:true') || asked.go !== 'Share these with agents') {
    throw new Error(`the switch: ${JSON.stringify(asked)}`);
  }
  await s(A, '32-connect-9-switch');
  const after = await A.evaluate(async () => {
    for (const b of document.querySelectorAll('#agents-switch-list input')) if (b.closest('.pick-row').querySelector('.setting-title').textContent !== 'Leg day') b.click();
    const go = document.getElementById('agents-switch-go').textContent;
    document.getElementById('agents-switch-go').click();
    const { state } = await import(new URL('ui/shared.js', document.querySelector('script[type=module]').src)); // (the app's own: its address may be under a note's)
    const conns = state.index.ydoc.getMap('connections');
    const notes = state.index.ydoc.getMap('notes');
    const place = (t) => [...notes.values()].find((m) => m.get('title') === t)?.get('place') ?? null;
    const old = conns.get('0ld0ld00'.repeat(4));
    const r = { go, open: document.getElementById('agents-switch-dialog').open, record: Object.keys(old).sort().join(), leg: place('Leg day'), training: place('Training 2026') };
    // (The stand-in out again, before upkeep looks at it; "Leg day" yours again.)
    conns.delete('0ld0ld00'.repeat(4));
    [...notes.values()].find((m) => m.get('title') === 'Leg day').delete('place');
    return r;
  });
  if (after.go !== 'Share 1 note with agents' || after.open || after.record !== 'created,listSeed,listShareId,name,secret' || after.leg !== 'ai' || after.training !== null) throw new Error(`after the switch: ${JSON.stringify(after)}`);
}
