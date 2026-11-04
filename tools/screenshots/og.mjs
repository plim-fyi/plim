// The link preview image (1200×630): what iMessage, Slack and others show when
// a link to Plim is shared. web/og-image.png.
//
//   cd tools/screenshots && npm ci && npm run og
//
// Rendered by Chromium from the HTML below, in the app's dark palette.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(existsSync);
const icon = readFileSync(join(ROOT, 'web/icon.svg'), 'utf8');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    display: flex; flex-direction: column; justify-content: center; gap: 36px; padding: 0 110px; box-sizing: border-box;
    background: radial-gradient(circle at 85% 15%, #262a45 0, #141414 55%); color: #ecebe7;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .brand { display: flex; align-items: center; gap: 32px; font-size: 112px; font-weight: 700; letter-spacing: -2px; }
  .brand svg { width: 128px; height: 128px; }
  p { margin: 0; font-size: 44px; line-height: 1.35; color: #b9b6ad; }
  p strong { display: block; color: #ecebe7; font-weight: 600; }
</style></head><body>
  <div class="brand">${icon}Plim</div>
  <p><strong>Your notes, on every device.</strong> No account to create, no password to remember. Private by design.</p>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(ROOT, 'web/og-image.png') });
console.log('web/og-image.png');
await browser.close();
