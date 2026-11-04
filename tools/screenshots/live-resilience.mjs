// Live sync under conditions the screenshot flows don't create (#70, phase 1):
//
//   cargo build --release -p plim-server && cd tools/screenshots && node live-resilience.mjs
//
// The page reaches the server through a small TCP proxy that can freeze its
// open connections: they stay open but carry nothing, as when a tunnel or
// proxy drops a WebSocket without telling the browser. Takes ~4 minutes.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import puppeteer from 'puppeteer-core';
import { createVault, newNote, openVault } from './drive.mjs';
import { TestServer, wait } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const PORT = 3983;
const PROXY_PORT = 3984;

/** A TCP proxy to the server; freeze() makes the connections open so far go silent (new ones still work). */
function proxy() {
  const open = new Set();
  const srv = net.createServer((client) => {
    const upstream = net.connect(PORT, '127.0.0.1');
    const pair = { client, upstream, frozen: false };
    open.add(pair);
    client.on('data', (d) => !pair.frozen && upstream.write(d));
    upstream.on('data', (d) => !pair.frozen && client.write(d));
    const end = () => {
      open.delete(pair);
      if (!pair.frozen) {
        client.destroy();
        upstream.destroy();
      }
    };
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  srv.listen(PROXY_PORT);
  return {
    // Frozen pairs never close or forward again, from either side's point of view.
    freeze: () => open.forEach((p) => (p.frozen = true)),
    close: () => srv.close(),
  };
}

const results = [];
const record = (name, ok, detail = {}) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
};

const dataDir = mkdtempSync(join(tmpdir(), 'plim-live-'));
const server = new TestServer({ root: ROOT, dataDir, port: PORT });
await server.start();
const px = proxy();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
try {
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(`http://localhost:${PROXY_PORT}/`);
  // A vault with the 12 words (no passkey needed here).
  const words = await createVault(p);
  await p.waitForFunction(() => document.documentElement.dataset.live === 'on', { timeout: 20000 });
  const live = () => p.evaluate(() => document.documentElement.dataset.live);

  // 1. The session expires (15 minutes): asked for a fresh token, the socket stays up.
  {
    const db = new DatabaseSync(server.db);
    db.prepare('UPDATE sessions SET expires_at = 0').run();
    db.close();
    let off = 0;
    for (let i = 0; i < 70; i++) {
      await wait(1000);
      if ((await live()) !== 'on') off++;
    }
    record('session expiry: the live connection stays up', off === 0, { secondsOff: off });
  }

  // A second device (straight to the server), to check edits really are pushed.
  const other = await (await browser.createBrowserContext()).newPage();
  await other.goto(`http://localhost:${PORT}/`);
  await openVault(other, words);
  /** A new note on the other device shows up in the page's list within `ms` (only a push is that fast while live: polling is every 60 s). */
  async function pushArrives(title, ms) {
    await newNote(other, title);
    const t0 = Date.now();
    return p.waitForFunction((t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), { timeout: ms, polling: 100 }, title)
      .then(() => Date.now() - t0, () => null);
  }
  record('baseline: a new note on another device is pushed', (await pushArrives('Before', 5000)) !== null);

  // 1b. While live, no polling goes out (#261): the index isn't pulled over HTTP for a minute.
  {
    const pulls = () => p.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/docs/index?')).length);
    await p.evaluate(() => performance.setResourceTimingBufferSize(10_000));
    const before = await pulls();
    await wait(65_000);
    const during = (await pulls()) - before;
    record('no polling while live (65 s)', during === 0, { pulls: during });
  }

  // 2. The connection dies silently (frozen by the proxy): the page notices, reconnects, and pushes work again.
  {
    px.freeze();
    const t0 = Date.now();
    const noticed = await p.waitForFunction(() => document.documentElement.dataset.live === 'off', { timeout: 120000, polling: 500 }).then(() => true, () => false);
    const noticedS = Math.round((Date.now() - t0) / 1000);
    record('a silently dead connection is noticed', noticed, { afterS: noticedS });
    const back = await p.waitForFunction(() => document.documentElement.dataset.live === 'on', { timeout: 60000, polling: 500 }).then(() => true, () => false);
    record('…and replaced', back, { afterS: Math.round((Date.now() - t0) / 1000) });
    const ms = await pushArrives('After', 5000);
    record('…and pushes arrive again', ms !== null, { ms });
  }
  record('no page errors', errors.length === 0, { errors: errors.slice(0, 3) });
} finally {
  await browser.close();
  px.close();
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
