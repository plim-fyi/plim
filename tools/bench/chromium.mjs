// A bench page (index.html or editor.html) in headless Chromium as an iPhone (as web.mjs's ios
// profile), with tools/screenshots' puppeteer: node tools/bench/chromium.mjs [editor|index] [port]
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// (puppeteer-core is tools/screenshots' dependency.)
const puppeteer = (await import(pathToFileURL(createRequire(new URL('../screenshots/', import.meta.url)).resolve('puppeteer-core')))).default;

const page_ = process.argv[2] ?? 'editor';
const PORT = process.argv[3] ?? 3980;
const CHROME = process.env.CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/tools/bench/${page_}.html`);
  await page.waitForSelector('#out[data-done]', { timeout: 300_000 });
  console.error(await page.$eval('#status', (e) => e.textContent));
  console.log(await page.$eval('#out', (e) => e.textContent));
} finally {
  await browser.close();
}
