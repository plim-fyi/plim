// When the page is out of date or something breaks, it says so instead of
// going blank (#134):
//   1. a page running older files than the server's offers "Plim was updated · Reload"
//      (the app, and a shared note's page);
//   2. a script that doesn't load: "Plim couldn't start" with Reload, not a blank page;
//   3. a note that fails to open: why, where the note would be, with Reload.
//
//   cd tools/screenshots && node recover.mjs        (OUT=<dir>: with screenshots)
//
// Runs its own server on a copy of web/, so a "deploy" is a file added to it.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createVault, editable, newNote, openVault } from './drive.mjs';
import { TestServer, wait } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
const OUT = process.env.OUT; // (a folder: screenshots of each state there, to look at)
const tmp = mkdtempSync(join(tmpdir(), 'plim-recover-'));
const web = join(tmp, 'web');
cpSync(process.env.WEB_SRC ?? join(ROOT, 'web'), web, { recursive: true }); // (WEB_SRC: another copy, e.g. to check without a fix)
const server = new TestServer({ root: ROOT, dataDir: tmp, port: 3994, env: { PLIM_WEB: web } });
await server.start();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const visible = (p, sel) => p.$eval(sel, (e) => !e.hidden && e.getClientRects().length > 0).catch(() => false);
const until = (p, fn, arg, timeout = 20000) => p.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
/** A "deploy": the server's web files change, so their version does (it's rechecked every 5 s). */
const deploy = (n) => writeFileSync(join(web, `deployed-${n}.txt`), String(n));

async function newPage({ phone = false } = {}) {
  const p = await (await browser.createBrowserContext()).newPage();
  await p.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 800 });
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  return p;
}

async function openByTitle(p, title) {
  await p.waitForFunction((t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), { timeout: 20000 }, title);
  await p.evaluate((t) => [...document.querySelectorAll('#note-list li > button')].find((b) => b.querySelector('.title')?.textContent === t).click(), title);
}

try {
  // ---- A, with a private note and a shared one ----
  const a = await newPage();
  // A switch (kept across a reload) that makes shared notes' keys fail to load, for step 3.
  await a.evaluateOnNewDocument(() => {
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = (...args) => {
      if (sessionStorage.getItem('failKeys') && /shareKeys/.test(new Error().stack)) return Promise.reject(new Error('test: this note’s keys failed to load'));
      return importKey(...args);
    };
  });
  await a.goto(server.url);
  a.words = await createVault(a);
  await newNote(a, 'Private plans\nnothing shared here\n');
  await newNote(a, 'Trip plans\nshared with everyone going\n');
  await a.waitForFunction(() => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === 'Trip plans'));
  await a.click('#note-share'); // (the open note's: Trip plans)
  await a.waitForFunction(() => document.querySelector('#share-dialog').open);
  await a.click('#share-create');
  await a.waitForFunction(() => !document.querySelector('#share-on').hidden, { timeout: 20000 });
  const link = await a.$eval('#share-edit-link', (e) => e.value);
  await a.keyboard.press('Escape');
  // (Private plans edited last: it's the one that opens after the reload, not the shared one.)
  await openByTitle(a, 'Private plans');
  await editable(a);
  await a.click('#editor .cm-content');
  await a.keyboard.down('Control');
  await a.keyboard.press('End');
  await a.keyboard.up('Control');
  await a.keyboard.type('!');
  await wait(1500);

  // ---- 3. a note that fails to open ----
  // (After a reload: the shared note's keys aren't loaded yet, so opening it loads them.)
  await a.evaluate(() => sessionStorage.setItem('failKeys', '1'));
  await a.reload();
  await openVault(a, a.words);
  await openByTitle(a, 'Private plans');
  await editable(a);
  await openByTitle(a, 'Trip plans');
  const said = await until(a, () => !document.getElementById('empty-detail').hidden);
  check(said, 'a note that fails to open says so');
  check(await visible(a, '#empty-reload'), '… with Reload');
  check(/keys failed to load/.test(await a.$eval('#empty-detail', (e) => e.textContent)), '… and why');
  check(await a.$eval('#editor', (e) => e.hidden), '… instead of a blank editor');
  if (OUT) await a.screenshot({ path: join(OUT, 'note-failed.png') });
  await a.evaluate(() => sessionStorage.removeItem('failKeys'));
  await openByTitle(a, 'Private plans');
  check(await until(a, () => document.getElementById('empty-detail').hidden && !document.getElementById('editor').hidden), 'another note still opens after it');
  await openByTitle(a, 'Trip plans');
  check(await until(a, () => document.querySelector('#editor .cm-content')?.textContent.includes('shared with everyone')), '… and so does that one, once its keys load');

  // ---- 1. out of date: the app ----
  check(!(await visible(a, '#update-banner')), 'no update banner while up to date');
  deploy(1);
  check(await until(a, () => !document.getElementById('update-banner').hidden, undefined, 30000), 'the app, after a deploy: "Plim was updated"');
  if (OUT) await a.screenshot({ path: join(OUT, 'update-banner.png') });
  await Promise.all([a.waitForNavigation(), a.click('#update-reload')]);
  await wait(6000); // (a few API calls)
  check(!(await visible(a, '#update-banner')), '… gone after Reload');

  // ---- 1. out of date: a shared note's page ----
  const g = await newPage({ phone: true });
  await g.goto(link);
  await editable(g);
  check(!(await visible(g, '#update-banner')), 'shared note: no banner while up to date');
  deploy(2);
  check(await until(g, () => !document.getElementById('update-banner').hidden, undefined, 40000), 'shared note, after a deploy: "Plim was updated"');
  if (OUT) await g.screenshot({ path: join(OUT, 'guest-update-banner.png') });
  await Promise.all([g.waitForNavigation(), g.click('#update-reload')]);
  await editable(g);
  await wait(4000);
  check(!(await visible(g, '#update-banner')), '… gone after Reload');

  // ---- 2. a script that doesn't load ----
  for (const [path, what] of [['/', 'the app'], [new URL(link).pathname + new URL(link).hash, 'a shared note']]) {
    const p = await newPage();
    await p.setRequestInterception(true);
    p.on('request', (r) => (/\/v\/[0-9a-f]+\/core\/(history|sharesync)\.js$/.test(r.url()) ? r.abort() : r.continue()));
    await p.goto(server.url + path);
    check(await until(p, () => document.getElementById('fatal')?.getClientRects().length > 0), `${what}: a script that doesn't load says so`);
    const text = await p.$eval('#fatal', (e) => e.textContent).catch(() => '');
    check(/couldn’t start/.test(text) && /Reload/.test(text), `… "Plim couldn’t start" with Reload`);
    if (OUT && what === 'the app') await p.screenshot({ path: join(OUT, 'fatal.png') });
    await p.close();
  }

  // ---- …but someone else's script that fails is no reason to stop ----
  // (Cloudflare's Web Analytics adds its beacon to the page; the CSP refuses it.)
  for (const [path, what] of [['/', 'the app'], [new URL(link).pathname + new URL(link).hash, 'a shared note']]) {
    const p = await newPage();
    await p.setRequestInterception(true);
    p.on('request', async (r) => {
      if (r.resourceType() !== 'document') return r.continue();
      const res = await fetch(r.url());
      // (Early in the page: Safari reports the refused script before the page has started.)
      const beacon = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v1" crossorigin="anonymous"></script>';
      const html = (await res.text()).replace(/(<script src="[^"]*boot\.js"><\/script>)/, `$1${beacon}`);
      if (!html.includes(beacon)) throw new Error('the test page has no boot.js to put the beacon after');
      r.respond({ status: res.status, headers: Object.fromEntries(res.headers), body: html });
    });
    await p.goto(server.url + path);
    await wait(3000);
    check(!(await visible(p, '#fatal')), `${what}: another site's script failing (an injected beacon) doesn't stop it`);
    await p.close();
  }

  for (const p of [a, g]) check(!p.errors.length, `${p === a ? 'app' : 'shared note'}: no page errors (${p.errors.join('; ')})`);
} finally {
  await browser.close();
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
