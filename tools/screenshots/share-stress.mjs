// Shared notes under load and without a network (#70; ported from the spike's
// S6, S10 and S12):
//
//   cargo build --release -p plim-server && cd tools/screenshots && node share-stress.mjs
//
// 1. Six people (the owner and five guests with the edit link) type at once: everyone ends with the same text.
// 2. A guest goes offline, reopens the link offline, and edits; the owner edits too. Back online, both edits are everywhere.
// 3. A guest pastes more than a megabyte (more than clients assume until they know the server's limit): it saves and arrives.
// 4. A paste bigger than the server takes says so, and isn't retried over and over.
//
// The server's blob limit is 2 MiB here, so (3) and (4) stay quick. Takes about a minute.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createVault, editable, newNote } from './drive.mjs';
import { TestServer, wait } from './server.mjs';
// To play someone with a view link sending junk as their presence.
import { b64, encrypt } from '../../web/core/crypto.js';
import { keysFromLink, parseShareLink, readTokenHex } from '../../web/core/share.js';
import { shareAad } from '../../web/core/sig.js';
import { Awareness, encodeAwarenessUpdate } from '../../web/vendor/codemirror.mjs';
import * as Y from '../../web/vendor/yjs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const PORT = 3985;
const MAX_BLOB = 2 * 1024 * 1024;

const results = [];
const record = (name, ok, detail = {}) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
};

// PLIM_URL=https://… runs it against a deployed server instead (through its
// proxy, e.g. Cloudflare). It makes a throwaway vault there, and deletes its
// note for good at the end.
const REMOTE = process.env.PLIM_URL?.replace(/\/$/, '');
const dataDir = mkdtempSync(join(tmpdir(), 'plim-share-'));
const server = REMOTE
  ? { url: REMOTE, start: async () => {}, stop: async () => {} }
  : new TestServer({ root: ROOT, dataDir, port: PORT, env: { PLIM_MAX_BLOB_BYTES: String(MAX_BLOB) } });
await server.start();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const pages = [];
const track = (p, name) => {
  p.name = name;
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  pages.push(p);
  return p;
};
const text = (p) => p.evaluate(() => document.getElementById('editor').noteText?.() ?? '');
const status = (p) => p.$eval('#guest-status', (e) => e.textContent);

/** Wait until every page shows the same text, which passes `ok`; returns it (or null after `ms`). */
async function converge(ps, ok, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const texts = await Promise.all(ps.map(text));
    if (texts.every((t) => t === texts[0]) && ok(texts[0])) return texts[0];
    await wait(250);
  }
  return null;
}

/** Type at the end of the note. */
async function typeAtEnd(p, s, delay = 0) {
  await p.click('#editor .cm-content');
  await p.keyboard.down('Control');
  await p.keyboard.press('End');
  await p.keyboard.up('Control');
  await p.keyboard.type(s, { delay });
}

try {
  // The owner: a vault with the 12 words, a note, and its edit link.
  const owner = track(await browser.newPage(), 'owner');
  await owner.setViewport({ width: 1280, height: 800 });
  await owner.goto(server.url);
  await createVault(owner);
  await newNote(owner, 'Team notes\n');
  await owner.waitForFunction(() => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === 'Team notes'));
  await owner.click('#note-list li:not(.trashed) > button', { button: 'right' }); // (its menu)
  await owner.click('#note-menu-share');
  await owner.waitForFunction(() => document.querySelector('#share-dialog').open);
  await owner.click('#share-create');
  await owner.waitForFunction(() => !document.querySelector('#share-on').hidden, { timeout: 20000 });
  const edit = await owner.$eval('#share-edit-link', (e) => e.value);
  const view = await owner.$eval('#share-read-link', (e) => e.value);
  const crashes = [];
  owner.on('console', (m) => m.text().includes('plugin crashed') && crashes.push(m.text()));
  await owner.keyboard.press('Escape');
  await editable(owner);

  const guest = async (name) => {
    const p = track(await (await browser.createBrowserContext()).newPage(), name);
    await p.setViewport({ width: 1000, height: 700 });
    await p.goto(edit);
    await p.waitForFunction(() => document.getElementById('editor').noteText?.().includes('Team notes'), { timeout: 20000 });
    return p;
  };
  const guests = [];
  for (let i = 1; i <= 5; i++) guests.push(await guest(`guest ${i}`));
  const everyone = [owner, ...guests];

  // 1. Six people typing at once.
  {
    const t0 = Date.now();
    await Promise.all(everyone.map((p, i) => typeAtEnd(p, ` <${i}:${'x'.repeat(30)}>`, 10)));
    const all = await converge(everyone, (t) => everyone.every((_, i) => t.includes(`<${i}:${'x'.repeat(30)}>`)));
    record('six people typing at once end with the same text', all !== null, { ms: Date.now() - t0 });
  }

  // 1b. Someone with only a view link sends junk as their presence (straight to the server):
  // the others' editors keep working, and so do real cursors.
  {
    const link = parseShareLink(new URL(view).pathname, new URL(view).hash);
    const keys = await keysFromLink(link);
    const doc = `share:${link.shareId}`;
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/live`);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    ws.send(JSON.stringify({ guest: true }));
    await wait(200);
    ws.send(JSON.stringify({ sub: doc, after: 0, token: readTokenHex(keys) }));
    await wait(500);
    const junk = [
      { user: { name: 'Bad cursor', color: 'c1' }, cursor: { anchor: { item: 5 }, head: 'nope' } },
      { user: { name: 'No anchor', color: 'c2' }, cursor: { anchor: null, head: { type: { client: 1 } } } },
      { user: { name: '<img src=x onerror=alert(1)>', color: '" onmouseover="alert(1)' } },
      { user: 'not an object' },
      { user: { name: 'x'.repeat(3000), color: 'c3' } },
    ];
    for (const state of junk) {
      const aw = new Awareness(new Y.Doc());
      aw.setLocalState(state);
      const { nonce, ciphertext } = await encrypt(keys.encKey, encodeAwarenessUpdate(aw, [aw.clientID]), shareAad(link.shareId, 'presence'));
      aw.destroy();
      ws.send(JSON.stringify({ presence: doc, data: b64(new Uint8Array([...nonce, ...ciphertext])) }));
      await wait(250);
    }
    ws.send(JSON.stringify({ presence: doc, data: b64(new Uint8Array(40)) })); // doesn't even decrypt
    await wait(1000);
    // A real guest moves their cursor: the owner still sees it.
    await guests[2].click('#editor .cm-content');
    await guests[2].keyboard.press('Home');
    const caret = await owner.waitForFunction(() => document.querySelectorAll('#editor .cm-ySelectionCaret').length > 0, { timeout: 10000 })
      .then(() => true, () => false);
    const chips = await owner.$$eval('#presence span', (e) => e.map((c) => c.textContent));
    const ok = caret && !crashes.length && chips.every((c) => c.length <= 40) && !(await owner.$('img[src="x"]'));
    record('junk presence from a view link breaks nothing; real cursors still show', ok, { caret, crashes, longestChip: Math.max(...chips.map((c) => c.length)) });
    ws.close();
  }

  // 2. A guest offline: reopens the link without a network (this device's copy), edits, comes back.
  {
    const g = guests[0];
    await wait(1500); // the offline copy is written shortly after a change
    await g.setOfflineMode(true);
    await g.reload().catch(() => {});
    const opened = await g.waitForFunction(() => document.getElementById('editor').noteText?.().includes('<1:'), { timeout: 15000 })
      .then(() => true, () => false);
    record('a guest reopens the link offline, from this device’s copy', opened, { title: await g.title(), message: await g.$eval('#guest-message-title', (e) => e.textContent).catch(() => '') });
    if (opened) {
      await typeAtEnd(g, '\n[guest, offline]');
      await wait(800);
      const st = await status(g);
      record('…edits offline, and is told they’re kept', /Offline/.test(st), { status: st });
      await typeAtEnd(owner, '\n[owner, meanwhile]');
      await g.setOfflineMode(false);
      const t0 = Date.now();
      const merged = await converge([owner, g, guests[1]], (t) => t.includes('[guest, offline]') && t.includes('[owner, meanwhile]'), 60000);
      record('…and back online, both edits are everywhere', merged !== null, { ms: Date.now() - t0 });
    }
  }

  // 3. A guest pastes 1.5 MB: more than the 1 MiB clients assume, less than this server's 2 MiB.
  const g = guests[1];
  const posts = [];
  g.on('response', (r) => r.request().method() === 'POST' && r.url().includes('/updates') && posts.push(r.status()));
  {
    const before = (await text(owner)).length;
    await g.click('#editor .cm-content');
    await g.keyboard.press('End');
    await g.keyboard.sendCharacter(`\n${'p'.repeat(1_500_000)}`); // one input, like a paste
    const t0 = Date.now();
    const arrived = await owner.waitForFunction((n) => document.getElementById('editor').noteText().length >= n, { timeout: 30000, polling: 250 }, before + 1_500_000)
      .then(() => true, () => false);
    await wait(1000);
    record('a guest’s 1.5 MB paste saves and reaches the others', arrived, { ms: Date.now() - t0, status: await status(g), uploads: posts });
  }

  // 3b. A long note now: the mouse wheel over the text scrolls it, on a guest's page.
  {
    const r = guests[3];
    await r.bringToFront();
    await r.waitForFunction(() => document.getElementById('editor').noteText().length > 1_000_000, { timeout: 30000 });
    const scrolled = () => r.evaluate(() => document.querySelector('#editor .cm-scroller').scrollTop + document.scrollingElement.scrollTop);
    const box = await (await r.$('#editor .cm-content')).boundingBox();
    await r.mouse.move(box.x + 50, Math.min(box.y + 200, 600));
    const before = await scrolled();
    await r.mouse.wheel({ deltaY: 600 });
    await wait(500);
    const after = await scrolled();
    record('the mouse wheel scrolls a long note on the guest page', after > before, { before, after });
  }

  // 4. Bigger than the server takes in one blob: said, not retried.
  {
    posts.length = 0;
    const limit = Number(await g.evaluate(() => localStorage.getItem('tiro-max-blob-bytes'))) || MAX_BLOB; // what the server said
    await g.keyboard.sendCharacter('q'.repeat(limit + 500_000));
    await wait(8000);
    const st = await status(g);
    record('a paste bigger than the server takes says so, and isn’t retried', /too large/.test(st) && posts.length <= 1, { status: st, uploads: posts });
  }

  const errors = pages.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`));
  record('no page errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  // On a deployed server: delete the note for good (and with it the share and its links).
  const owner = pages.find((p) => p.name === 'owner');
  if (REMOTE && owner) {
    try {
      await owner.bringToFront();
      await owner.keyboard.press('Escape');
      await owner.click('#note-list li:not(.trashed) > button', { button: 'right' });
      await owner.click('#note-menu-delete');
      await wait(600);
      await owner.click('#btn-trash'); // (in the sidebar, above the notes)
      await owner.waitForSelector('#trash-list li.trashed .trash-actions .danger');
      await owner.click('#trash-list li.trashed .trash-actions .danger'); // the confirm box is accepted
      await owner.waitForFunction(() => !document.querySelector('#trash-list li.trashed'), { timeout: 20000 });
      console.log('cleanup: the test note was deleted for good');
    } catch (err) {
      console.log(`cleanup FAILED, delete the "Team notes" note by hand: ${err.message}`);
    }
  }
  await browser.close();
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
