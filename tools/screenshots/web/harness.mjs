// What web.mjs's flows (web/NN-*.mjs) share: the server and browser they run against, the
// profiles, the notes they write, the helpers that drive the app (open a note, lock, Settings),
// and the screenshots (each screen on the map of the screens, framed for the README).
//
// A flow imports what it uses from here; what one flow leaves for the next (its pages, the
// recovery words) is passed in web.mjs's `shared`, not kept here.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { TestConnector, TestServer, freePort, wait } from '../server.mjs';
import { mapScreen } from '../map.mjs';
import { EDITOR_READY, blankNote, confirmWords, phraseWords, signInWithWords, waitView } from '../drive.mjs';

// (The steps that drive the app, shared with the standalone checks: ../drive.mjs, #458.)
export { EDITOR_READY, confirmWords, phraseWords, signInWithWords, waitView };

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The screenshots, on the map (not in git); the ones the README shows are also kept in
// docs/screenshots/web, the only ones in the repository: whichever README.md points at.
export const OUT = join(ROOT, 'tools/screenshots/out/png');
export const DOCS = join(ROOT, 'docs/screenshots/web');
// A note worth showing, as a page (flow 31, #352), light and dark, in a Safari window (#348) at the
// app's address: out/showcase-light.png and -dark.png, for the site about Plim (its own, apart from
// the app since /about left it).
export async function showcaseShot(raw, light) {
  await framed(raw, { path: join(OUT, `showcase-${light ? 'light' : 'dark'}.png`), light, safari: 'plim.fyi' });
}
// The same on a phone: an iPhone 16 with Safari's bars (IPHONE16_FRAME), out/showcase-phone-*.png.
// Safari's bars are the browser's, not the page's: for the shot the page is the web view's size,
// with no safe-area insets, then as it was again.
export const IPHONE16 = { width: 393, height: 852, status: 59, bar: 136 };
export async function showcasePhoneShot(p, light) {
  const was = p.viewport();
  const insets = PROFILES.ios.insets;
  await p.cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  await p.setViewport({ ...was, width: IPHONE16.width, height: IPHONE16.height - IPHONE16.status - IPHONE16.bar });
  await wait(500);
  const top = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const raw = await p.screenshot();
  await p.cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  await p.setViewport(was);
  await wait(300);
  await framed(raw, { path: join(OUT, `showcase-phone-${light ? 'light' : 'dark'}.png`), light, iphone16: { address: 'plim.fyi', top } });
}
export const IN_README = new Set([...readFileSync(join(ROOT, 'README.md'), 'utf8').matchAll(/docs\/screenshots\/web\/([\w./-]+\.png)/g)].map((m) => m[1]));
export const CHROME = process.env.CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(existsSync);
export const SHOTS = Boolean(process.env.SHOTS);
// (Each profile runs in a process of its own, on ports of its own: see main.)
// A free port each run (or PLIM_TEST_PORT): nothing left behind by an earlier run is ever reused.
export const PORT = Number(process.env.PLIM_TEST_PORT || await freePort());
export const ADMIN_PORT = process.env.PLIM_TEST_PORT ? PORT + 1 : await freePort();
export const URL = `http://localhost:${PORT}/`;
/** Where a vault is made or opened (/ is a short overview on a device without one). */
export const LOGIN = `${URL}login`;

// What each flow needs to have run before it (#263): its devices and notes. FLOWS=17,12b runs
// those with what they need, in the file's order; without FLOWS, every flow runs.
export const NEEDS = {
  1: [], 3: ['1'], 12: ['3'], '12b': ['3'], 4: ['1'], 5: ['1'], 2: ['3'], 13: ['2'], 10: ['2'], 8: ['2'],
  14: ['8'], 17: ['2'], 18: ['14'], 6: ['2'], 7: ['6'], 9: ['1'], 19: ['3'], 11: ['14', '12b'], 20: ['3'], 21: ['3'], 22: ['21'], 23: ['3'], 24: ['2'], 25: ['3'], 26: ['3'], 27: ['3'], 28: ['2'], 29: ['3'], 31: ['24'], 32: ['24'], 33: ['3'], 34: ['12'], 35: ['34'],
};
export const wantedFlows = process.env.FLOWS ? new Set() : null;
if (wantedFlows) {
  const add = (id) => {
    if (!(id in NEEDS)) throw new Error(`FLOWS=${id}: not a flow (${Object.keys(NEEDS).join(', ')})`);
    if (wantedFlows.has(id)) return;
    wantedFlows.add(id);
    NEEDS[id].forEach(add);
  };
  process.env.FLOWS.split(',').map((f) => f.trim()).filter(Boolean).forEach(add);
}
// A note worth showing (#352): a rich note, as a page (flow 31).
export const SHOWCASE = `# Lisbon, 18–21 October
#travel #lisbon

**Flights** TP 1353, Thu 07:05 → Sun 19:15
**Stay** Memmo Alfama, *the one with the rooftop pool*

## Before we go
- [x] Book the hotel
- [x] Tram 28 tickets
- [ ] Table at Cervejaria Ramiro, Friday
- [ ] Day trip to Sintra?

## Budget
| | Planned | Spent |
|---|---:|---:|
| Hotel | €540 | €540 |
| Food | €200 | €64 |
| Trips | €90 | — |

> Saudade: a longing for something you love and may not see again.

Walks and opening times: [Visit Lisboa](https://www.visitlisboa.com)
`;

/** The flow running now: what a page's layout shifts are put down to (#442). */
let flowNow = null;

/** One of the numbered flows: run, unless FLOWS is set and doesn't need it. */
export async function flow(id, fn) {
  if (wantedFlows && !wantedFlows.has(id)) return;
  const t0 = Date.now();
  flowNow = id;
  await fn();
  if (wantedFlows) console.log(`  flow ${id}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export const PROFILES = {
  desktop: { viewport: { width: 1200, height: 760, deviceScaleFactor: 2 } },
  ios: {
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  },
};

// A long note with headings, code and quotes (tools/screenshots/long-note.md), for #220.
export const SAMPLE = readFileSync(join(ROOT, 'tools/screenshots/long-note.md'), 'utf8');

export const NOTES = [
  'Reading list\n\n- The Overstory\n- Piranesi\n- A Psalm for the Wild-Built',
  'Lisbon trip\n\nFlights: Thu 08:40 → Sun 19:15\nStay: Alfama, near Miradouro de Santa Luzia\n\nTo do\n- Tram 28 early, before the crowds\n- Pastéis de Belém\n- LX Factory on Saturday\n- Day trip to Sintra?',
  'Groceries\n\n- oat milk\n- lemons\n- sourdough',
  'Project ideas\n\n- offline mode\n- note tags',
  'Meeting notes — Q4 planning\n\n- hiring\n- roadmap',
];

// ---------- server ----------

export let server;
export let connector; // (#369: the real `plim mcp --http`, for flow 32)
export let dataDir;
let connectorPort;
export const startServer = () => server.start();
export const stopServer = () => server?.stop(); // (flows stop and start the server; the connector stays up)
export const stopAll = () => Promise.all([server?.stop(), connector?.stop()]);

/** The server and the connector, on a throwaway database, for one profile's run. */
export async function startAll() {
  dataDir = mkdtempSync(join(tmpdir(), 'plim-shots-'));
  // (Notes keep a version every 2 s here, not every hour, so history fills up as the flows edit.)
  connectorPort = await freePort();
  server = new TestServer({ root: ROOT, dataDir, port: PORT, adminPort: ADMIN_PORT, env: { PLIM_VERSION_EVERY_SECS: '2' }, connectorUrl: `http://localhost:${connectorPort}` });
  await startServer();
  connector = new TestConnector({ root: ROOT, dataDir, port: connectorPort, serverUrl: server.url });
  await connector.start();
}

/** Everything a run started, stopped, and its database gone. */
export async function stopAndClean() {
  await stopAll();
  rmSync(dataDir, { recursive: true, force: true });
}

// ---------- browser helpers ----------

/**
 * The page's randomness (getRandomValues, randomUUID, Math.random) from a generator seeded with
 * `seed`, so the same flow makes the same recovery words, names and IDs every run, and so the same
 * screenshots (#222). Each page load in the tab takes the next seed: a reload mustn't make the IDs
 * made before it again. (Runs in the page, before its scripts; test pages only.)
 */
export function seedRandomness(seed) {
  let n = 0;
  try {
    n = Number(sessionStorage.getItem('plim-test-seed') ?? 0);
    sessionStorage.setItem('plim-test-seed', String(n + 1));
  } catch {}
  /** A generator (sfc32) for `name`: its own sequence, the same every run. */
  const stream = (name) => {
    let h = 1779033703;
    for (const ch of `${seed}/${n}/${name}`) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), h = (h << 13) | (h >>> 19);
    let [a, b, c, d] = [h, h ^ 0x9e3779b9, h ^ 0x85ebca6b, h ^ 0xc2b2ae35];
    const next = () => {
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return t >>> 0;
    };
    for (let i = 0; i < 12; i++) next();
    return next;
  };
  // One sequence for each file asking, and size asked for: how many nonces the uploads take, or
  // which of the name picker and Yjs asks first, depends on timing, and mustn't shift the recovery
  // words, names and IDs drawn after them.
  const streams = new Map();
  const caller = () => new Error().stack.split('\n').slice(3).find((l) => !l.includes('seedRandomness'))?.replace(/:\d+:\d+\)?$/, '') ?? '';
  const fill = (array, name = `${array.byteLength}@${caller()}`) => {
    if (!streams.has(name)) streams.set(name, stream(name));
    const next = streams.get(name);
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 255;
    return array;
  };
  crypto.getRandomValues = (array) => fill(array);
  const random = stream('Math.random');
  crypto.randomUUID = () => {
    const b = fill(new Uint8Array(16), 'uuid');
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  Math.random = () => random() / 2 ** 32;
}

/**
 * Layout shifts no input caused, on this page (#442): something moving under the finger, as a
 * background redraw did on a connection's page (#436), each with what moved and by how much.
 * newPage does it; a flow that makes a page of its own calls it before the page's first load.
 */
/**
 * Shifts on `p` for the next `ms` are what should happen, and pass: something a flow does that
 * moves the page once, on purpose (flow 26: your notes moved to frontmatter, #582, the open
 * note's header coming in). Kept to what that flow waits for.
 */
export const expectShifts = (p, ms) => (p.shiftsExpectedUntil = Date.now() + ms);

export async function watchShiftsOn(p) {
  p.shifts = [];
  made.push(p);
  await p.exposeFunction('__plimShift', (s) => p.shifts.push({ ...s, flow: flowNow, device: p.device, expected: Date.now() < (p.shiftsExpectedUntil ?? 0) }));
  if (process.env.SHIFT_CAUSES) await p.evaluateOnNewDocument(() => (globalThis.__plimShiftCauses = true));
  await p.evaluateOnNewDocument(watchShifts);
}

/** Every page watched (newPage's, and flows' own), and the layout shifts they had (#442). */
const made = [];
export const shiftsSoFar = () => made.flatMap((p) => p.shifts);

/**
 * Shifts that move something under the finger (#442): an element moving 8 px or more, with no
 * input to cause it. Two kinds are what should happen, and pass:
 * - a note's own text in the editor moving: someone else's edit above it (a shared note);
 * - the note list moving down or up in the sidebar: the chips over it appearing with a first tag,
 *   the Shared with agents view with a first note shared or an agent connected (#539: in the
 *   sidebar, moving Recently deleted; a phone's Notes | Agents switch, moving the search and the
 *   list), and a phone's Recently deleted, at the list's end, with it. (Not while the sidebar is in
 *   use: ui/taglist.js waits then.)
 * Sideways, these may move: the chips over the list as a tag comes or goes (not while the sidebar
 * is in use: ui/taglist.js waits then, flow 24 checks), people's chips as they come and go, the guest page's buttons and
 * a phone's title (the app's or a guest page's) making room for them, and an icon inside its own button (the account's
 * chevron as its name loads): the button itself stays where it is.
 */
// (And a note's header, #581: its + tag and yaml › after its tags, as the note's tags change.)
const SIDEWAYS_OK = /^#(presence|guest-add|guest-view-only|note-title|guest-title|note-head-add|note-head-yaml)$|^text in #(note|guest)-title$| in #presence$|^svg in #|^#tag-chips$| in #tag-chips$| in #note-head-tags$/;
export function shiftProblems(shifts) {
  const textInEditor = (n) => /^(div\.cm-line|text in div\.cm-line|div\.cm-cursor|span\.cm-ySelectionCaret|div\.cm-ySelectionCaretDot)\b/.test(n) && n.includes('#editor');
  const sidebarList = (n) => ['#note-list', '#notes-head', '#chips', '#chip-row', '#notes-about', '#notes-nav', '#btn-trash', '#btn-trash-foot', '#sidebar-scroll', 'div.sidebar-search in #view-notes'].includes(n) || /^li in #note-list$/.test(n); // (and the rows moving with them: kept, they're reported)
  return shifts.filter((s) => {
    if (s.expected) return false; // (a flow said so: expectShifts)
    const big = s.dy.filter((m) => Math.abs(m.dy) >= 8 || (Math.abs(m.dx) >= 8 && !SIDEWAYS_OK.test(m.node)));
    return big.length && !big.every((m) => textInEditor(m.node)) && !big.every((m) => sidebarList(m.node));
  });
}

/** (In the page.) Each layout shift without recent input, sent to the test (__plimShift). */
function watchShifts() {
  const name = (n) => {
    if (!n) return '?';
    if (n.nodeType === 3) return `text in ${name(n.parentElement)}`;
    if (n.id) return `#${n.id}`;
    const cls = typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).join('.')}` : '';
    const holder = n.parentElement?.closest('[id]');
    return `${n.tagName.toLowerCase()}${cls}${holder ? ` in #${holder.id}` : ''}`;
  };
  // (SHIFT_CAUSES=1: what changed size just before, to find what pushed things.)
  const resized = [];
  if (globalThis.__plimShiftCauses) {
    const heights = new WeakMap();
    const ro = new ResizeObserver((entries) => {
      for (const r of entries) {
        const h = Math.round(r.contentRect.height);
        const was = heights.get(r.target);
        heights.set(r.target, h);
        if (was !== undefined && was !== h) resized.push({ t: performance.now(), what: `${name(r.target)} ${was}→${h}` });
      }
      while (resized.length > 50) resized.shift();
    });
    const watch = () => document.querySelectorAll('body *').forEach((n) => n.closest('#editor .cm-content, svg') || ro.observe(n));
    addEventListener('DOMContentLoaded', () => {
      watch();
      new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
    });
  }
  // (Headless Chrome drops the emulated safe areas for a moment as tabs switch, and the page
  // moves by them and back: the harness's doing, not the app's. A probe as tall as the top
  // inset tells them apart.)
  let insetChanged = -Infinity;
  addEventListener('DOMContentLoaded', () => {
    const probe = Object.assign(document.createElement('div'), { ariaHidden: 'true' });
    probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
    document.documentElement.append(probe);
    let first = true;
    new ResizeObserver(() => (first ? (first = false) : (insetChanged = performance.now()))).observe(probe);
  });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      if (Math.abs(e.startTime - insetChanged) < 500) continue; // (the safe areas' flicker, above)
      const view = [...document.querySelectorAll('.view')].find((v) => !v.hidden)?.id ?? location.pathname;
      const dialog = [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join(',');
      globalThis.__plimShift?.({
        value: Math.round(e.value * 10000) / 10000,
        at: `${view}${dialog ? ` + ${dialog}` : ''}`,
        causes: resized.filter((r) => r.t > e.startTime - 300).map((r) => r.what),
        dy: (e.sources ?? []).map((s) => ({ node: name(s.node), dy: Math.round(s.currentRect.y - s.previousRect.y), dx: Math.round(s.currentRect.x - s.previousRect.x) })),
        moved: (e.sources ?? []).map((s) => `${name(s.node)} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}${s.previousRect.x !== s.currentRect.x ? ` (x ${Math.round(s.previousRect.x)}→${Math.round(s.currentRect.x)})` : ''}`),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

export let browser;
export const launch = async () => (browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] }));
let pages = 0; // (each page its own seed, the same every run)
/** The next page's seed (seedRandomness). */
export const pageSeed = (profile) => `${profile}/${++pages}`;
/** `device`: who's using it, as the map of the screens says (their device, a guest, the admin). */
export async function newPage(profile, { prf = true, device } = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.evaluateOnNewDocument(seedRandomness, pageSeed(profile));
  p.device = device;
  const cfg = PROFILES[profile];
  p.profile = profile;
  if (cfg.userAgent) await p.setUserAgent(cfg.userAgent);
  await p.setViewport(cfg.viewport);
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  const cdp = await p.createCDPSession();
  if (cfg.insets) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets });
  await cdp.send('WebAuthn.enable');
  ({ authenticatorId: p.authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, hasPrf: prf, automaticPresenceSimulation: true,
    },
  }));
  p.cdp = cdp;
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(`${e.message} [${p.url()}] (${(e.stack ?? '').split('\n').slice(1, 4).join(' | ').trim()})`));
  // CONSOLE=1: the pages' own console, for working out what a page did.
  if (process.env.CONSOLE) p.on('console', (m) => console.log(`  [${device ?? profile} ${m.type()}] ${m.text()}`));  // A destructive request refused for its signature (#144), even where the app only logs it
  // (removing a note's old copy after sharing it, say): the client and server disagree.
  p.on('response', (r) => {
    if (r.status() === 403 && r.url().includes('/api/')) p.errors.push(`403 ${r.request().method()} ${r.url().replace(/^\w+:\/\/[^/]+/, '')}`);
  });
  p.on('dialog', (d) => d.accept());
  await watchShiftsOn(p);
  return p;
}

export const mobile = (p) => p.profile === 'ios';
// New note: at the top of the list on desktop, in the footer on phones.
export const NEW_NOTE = (p) => (mobile(p) ? '#btn-new-foot' : '#btn-new');
/**
 * Wait until `fn` (run in the page) is true. Checked every 50 ms, not on animation frames
 * (Puppeteer's default): a tab that isn't in front gets none, and the wait would never see it.
 */
export const until = (p, fn, arg, timeout = 30000) => p.waitForFunction(fn, { timeout, polling: 50 }, arg);

/**
 * The next minute's sign-in allowance. The server lets one address ask for 60 sign-in challenges a
 * minute (server/src/auth.rs), in windows on the clock's minutes, and every page here is one
 * address; each signed request asks for one. Flow 32 makes about 50 (a holder given or taken back
 * is a signed request), so a sign-in right after it may be refused: before one, wait for a new
 * window. (Real devices each have an address of their own.)
 */
export const freshAuthMinute = () => new Promise((r) => setTimeout(r, 60000 - (Date.now() % 60000) + 500));
/** A tag picked from the chips over the list (#514, #539, #549): its chip (scrolled to, in the row). */
export async function pickTag(p, tag) {
  const chip = `#tag-chips .tag-chip[data-tag="${tag}"]`;
  await until(p, (sel) => document.querySelector(sel), chip, 10000)
    .catch(() => { throw new Error(`no #${tag} chip over the list`); });
  if (await p.evaluate((sel) => document.querySelector(sel).getAttribute('aria-pressed') !== 'true', chip)) await p.click(chip);
  await until(p, (sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', chip, 5000);
}
/** A view (#539, #552): 'notes' or 'connected', from the sidebar (a phone: the switch at the top of the list). */
export async function pickView(p, view) {
  await p.click(mobile(p) ? `#view-switch [data-view="${view}"]` : `#notes-nav .view[data-view="${view}"]`);
  await until(p, (v) => document.getElementById('notes-label').textContent === (v === 'connected' ? 'Agents' : 'Notes'), view, 5000);
}
/** All the view's notes again (#549): the tag picked tapped again (no All chip). */
export async function allNotes(p) {
  if (await p.$('#tag-chips .tag-chip[aria-pressed="true"]')) await p.click('#tag-chips .tag-chip[aria-pressed="true"]');
  await until(p, () => !document.querySelector('#tag-chips .tag-chip[aria-pressed="true"]'), undefined, 5000);
}
/** The bar's title clear of the others' chips (#318), an app's (#482) and the agents' letters (#514): never under them, an ellipsis before them. */
export async function titleClear(p, why) {
  const r = await p.evaluate(() => {
    const head = document.querySelector('.editor-head:not([hidden]), .guest-head');
    const t = head?.querySelector('.note-title')?.getBoundingClientRect();
    const chips = [...(head?.querySelectorAll('.presence span:not(.leaving), .app-here:not([hidden]), .agents-pill:not([hidden])') ?? [])].map((c) => c.getBoundingClientRect());
    if (!t || !chips.length) return null;
    return { title: [Math.round(t.left), Math.round(t.right)], chips: chips.map((c) => [Math.round(c.left), Math.round(c.right)]) };
  });
  if (r && r.chips.some(([l, rr]) => l < r.title[1] - 1 && rr > r.title[0] + 1)) throw new Error(`${why}: the title runs under the chips ${JSON.stringify(r)}`);
}
/**
 * A new note, emptied of what it starts with (its date and time, #313), for a flow that writes
 * one of its own: its first line its title. (Flow 26 checks what a new note starts with.)
 */
export async function newBlankNote(p) {
  await backToList(p);
  await p.click(NEW_NOTE(p));
  await until(p, EDITOR_READY);
  await blankNote(p);
}

// ---------- the map of the screens ----------
// Each screenshot is a screen on the map of every flow (map.mjs, tools/screens-map).
// The flows, by the number their screenshots' names start with.
export const FLOWS = {
  '01': 'Create a vault', '02': 'Sign in on another device', '03': 'Notes', '04': 'Lock and unlock', '05': 'Settings',
  '06': 'Change the recovery phrase', '07': 'Forget this device', '08': 'Offline', '09': 'A passkey without PRF',
  '10': 'Rollback warning', '11': 'Admin dashboard', '12': 'Recently deleted', '13': 'Share a note',
  '14': 'A shared note\'s page', '15': 'Others in a note', '16': 'History', '17': 'Editing markdown', '18': 'When something\'s wrong', '21': 'A note as a page', '22': 'A note\'s address', '23': 'Split', '24': 'Tags', '25': 'Type / for a menu', '26': 'A new note, dated', '27': 'The tag picker', '28': 'A shortened note, reopened', '29': 'Line breaks on the page', '31': 'A note worth showing', '32': 'Connect Claude', '33': 'Search', '34': 'Export',
};
export const LABELS = { desktop: 'Desktop', ios: 'iPhone (Chromium)' };
export const screens = [];

/** `via`: what was done to get here (the map's arrow to this screen), if it's not plain. */
/** `focused`: the focus left where it is (a menu that goes with it, #311); else blurred, for no blinking cursor. */
export async function shot(p, name, { dir = p.profile, via, focused = false } = {}) {
  if (!focused) await p.evaluate(() => document.activeElement?.blur?.());
  if (!SHOTS) return;
  await wait(350);
  // Everything at the end of its transition or animation (a hover's, a fade's), not wherever it's
  // got to as the screenshot's taken, so the same screen looks the same every run (#222).
  const settled = await p.evaluate(async () => {
    const style = Object.assign(document.createElement('style'), {
      id: 'plim-test-settled',
      textContent: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; }',
    });
    style.nonce = document.querySelector('meta[name=style-nonce]')?.content ?? '';
    document.head.append(style);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }).then(() => true, () => false);
  const path = join(OUT, dir, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const png = await p.screenshot();
  const light = dir === '.';
  if (mobile(p)) writeFileSync(path, png);
  else await framed(png, { path, title: await p.title(), light });
  const rel = dir === '.' ? `${name}.png` : `${dir}/${name}.png`;
  // The README's own (#362): in Safari, as most will see Plim: a Mac's Safari window, or an iPhone's
  // status bar and Safari's bar at the bottom, the address the real one's.
  if (IN_README.has(rel)) {
    const address = new globalThis.URL(p.url()).port === String(ADMIN_PORT) ? 'localhost' : 'plim.fyi'; // (URL here: the app's)
    if (mobile(p)) {
      // (The colour at the top of the page, as Safari tints its status bar: the first painted one up from there.)
      const top = await p.evaluate(() => {
        for (let e = document.elementFromPoint(innerWidth / 2, 2); e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (c && !/rgba\(.*,\s*0\)$|transparent/.test(c)) return c;
        }
        return getComputedStyle(document.documentElement).backgroundColor;
      });
      await framed(png, { path: join(DOCS, rel), light, iphone: { address, top } });
    } else await framed(png, { path: join(DOCS, rel), light, safari: address });
  }
  if (settled) await p.evaluate(() => document.getElementById('plim-test-settled')?.remove());
  if (dir === p.profile) {
    screens.push(mapScreen({ profile: p.profile, name, png: path, flow: name.match(/^\d\d/)?.[0] ?? null, device: p.device, via }));
  }
  console.log(`  ${dir}/${name}.png`);
}

// Desktop shots sit in a macOS-style window, like the terminal ones (tui.mjs).
export const FRAME = (img, title, light) => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 28px; background: ${light ? 'linear-gradient(135deg, #e4e2dc, #c9c6be)' : 'linear-gradient(135deg, #2a2c3c, #16171f)'}; display: inline-block; }
  .win { border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px rgb(0 0 0 / ${light ? '.25' : '.55'}), 0 0 0 1px ${light ? 'rgb(0 0 0 / .1)' : 'rgb(255 255 255 / .06)'}; }
  .bar { height: 34px; display: flex; align-items: center; padding: 0 14px; position: relative; background: ${light ? '#e9e7e2' : '#262625'}; border-bottom: 1px solid ${light ? '#d6d3cb' : '#0e0e0e'}; }
  .dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
  .title { position: absolute; left: 0; right: 0; text-align: center; color: ${light ? '#6b6860' : '#9b988f'}; font: 13px system-ui, sans-serif; }
  img { display: block; width: ${PROFILES.desktop.viewport.width}px; }
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="title">${title}</div></div><img src="data:image/png;base64,${img}"></div>`;

// The showcase screenshots (#348, flow 31) sit in a Safari window instead: its toolbar, the address in the middle;
// no backdrop (the page gives it its own shadow), its corners see-through.
export const SAFARI_ICON = (d, w = 18) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const SAFARI_FRAME = (img, address, light) => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: transparent; display: inline-block; }
  .win { border-radius: 12px; overflow: hidden; border: 1px solid ${light ? 'rgb(0 0 0 / .12)' : 'rgb(255 255 255 / .08)'}; }
  .bar { height: 52px; display: flex; align-items: center; gap: 14px; padding: 0 16px; background: ${light ? '#f6f6f6' : '#2c2c2e'};
    border-bottom: 1px solid ${light ? '#dcdcdc' : '#141414'}; color: ${light ? '#7a7a7a' : '#9a9a9e'}; font: 13px -apple-system, system-ui, sans-serif; }
  .dots { display: flex; gap: 8px; margin-right: 6px; } .dot { width: 12px; height: 12px; border-radius: 50%; }
  .nav { display: flex; gap: 14px; align-items: center; }
  .field { flex: 0 1 46%; margin: 0 auto; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 6px;
    background: ${light ? '#e9e9eb' : '#3a3a3c'}; color: ${light ? '#2c2c2e' : '#e5e5ea'}; }
  .field svg { color: ${light ? '#7a7a7a' : '#9a9a9e'}; }
  img { display: block; width: ${PROFILES.desktop.viewport.width}px; }
</style><div class="win"><div class="bar">
  <span class="dots"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></span>
  <span class="nav">${SAFARI_ICON('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>')}${SAFARI_ICON('<path d="M15 5l-7 7 7 7"/>')}${SAFARI_ICON('<path d="M9 5l7 7-7 7"/>')}</span>
  <span class="field">${address === 'localhost' ? '' : SAFARI_ICON('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 13)}${address}</span>
  <span class="nav">${SAFARI_ICON('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8"/>')}${SAFARI_ICON('<path d="M12 5v14M5 12h14"/>')}${SAFARI_ICON('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>')}</span>
</div><img src="data:image/png;base64,${img}"></div>`;

// A phone shot in the README (#362): an iPhone's screen in Safari, its status bar above (the page's own
// colour, as Safari tints it) and Safari's bar at the bottom: Back, the address, ⋯; corners rounded.
export const IPHONE_FRAME = (img, { address, top }, light) => {
  const ink = light ? '#1c1c1e' : '#f2f2f7', faint = light ? '#8e8e93' : '#98989f';
  const icon = (d, w = 22) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: transparent; display: inline-block; }
  .phone { width: ${PROFILES.ios.viewport.width}px; border-radius: 54px; overflow: hidden; background: ${top};
    box-shadow: 0 0 0 1px ${light ? 'rgb(0 0 0 / .12)' : 'rgb(255 255 255 / .1)'}; font: 600 17px -apple-system, 'SF Pro Text', system-ui, sans-serif; color: ${ink}; }
  .status { height: ${PROFILES.ios.insets.top}px; display: flex; align-items: center; justify-content: space-between; padding: 4px 30px 0 46px; box-sizing: border-box; }
  .status .right { display: flex; align-items: center; gap: 6px; }
  /* (The shot keeps room for a home-screen app's notch and home indicator: Safari's bars take it.) */
  .screen { overflow: hidden; }
  img { display: block; width: 100%; margin: -${PROFILES.ios.insets.top}px 0 -${PROFILES.ios.insets.bottom}px; }
  .bar { padding: 10px 14px 0; background: ${light ? 'rgb(249 249 249 / .96)' : 'rgb(30 30 30 / .96)'}; border-top: 0.5px solid ${light ? 'rgb(0 0 0 / .15)' : 'rgb(255 255 255 / .12)'}; }
  .row { display: flex; align-items: center; gap: 12px; color: ${faint}; }
  .field { flex: 1; height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; gap: 6px;
    background: ${light ? 'rgb(118 118 128 / .12)' : 'rgb(118 118 128 / .24)'}; color: ${ink}; font-weight: 500; font-size: 16px; }
  .home { height: 34px; display: flex; align-items: center; justify-content: center; }
  .home span { width: 134px; height: 5px; border-radius: 3px; background: ${ink}; }
</style><div class="phone">
  <div class="status"><span>9:41</span><span class="right">
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
    <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.5c2.4 0 4.6.9 6.3 2.5l1.2-1.3A10.8 10.8 0 0 0 8 .7 10.8 10.8 0 0 0 .5 3.7L1.7 5A9 9 0 0 1 8 2.5Zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.2-1.3A7.2 7.2 0 0 0 8 4.3a7.2 7.2 0 0 0-4.9 1.9l1.2 1.3c1-.9 2.3-1.4 3.7-1.4Zm0 3.6c.5 0 1 .2 1.3.5L8 11.6 6.7 10.2c.3-.3.8-.5 1.3-.5Z"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity=".45"/></svg>
  </span></div>
  <div class="screen"><img src="data:image/png;base64,${img}"></div>
  <div class="bar"><div class="row">${icon('<path d="M15 5l-7 7 7 7"/>')}<span class="field">${icon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 13)}${address}</span>${icon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>')}</div>
  <div class="home"><span></span></div></div>
</div>`;
};

export let framePage;
/**
 * An iPhone 16 (393 × 852 points) running Safari, for the site about Plim: the device's black edge,
 * the Dynamic Island in the status bar, the page, and iOS 18 Safari's bar at the bottom (the
 * address field, back, forward, share, bookmarks, tabs) over the home indicator. `top`: the page's
 * colour, under the status bar.
 */
export const IPHONE16_FRAME = (img, { address, top }, light) => {
  const ink = light ? '#1c1c1e' : '#f2f2f7', faint = light ? '#8e8e93' : '#8d8d93', tint = light ? '#007aff' : '#0a84ff';
  const icon = (d, w = 24, color = tint) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const { width, height, status, bar } = IPHONE16;
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: transparent; display: inline-block; padding: 2px; }
  .device { display: inline-block; padding: 12px; border-radius: 68px; background: #0c0c0d;
    box-shadow: inset 0 0 0 1.5px #3a3a3d, 0 0 0 1px ${light ? 'rgb(0 0 0 / .18)' : 'rgb(255 255 255 / .14)'}; }
  .screen { position: relative; width: ${width}px; height: ${height}px; border-radius: 56px; overflow: hidden; display: flex; flex-direction: column;
    background: ${top}; font: 600 17px -apple-system, 'SF Pro Text', system-ui, sans-serif; color: ${ink}; }
  .island { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 125px; height: 37px; border-radius: 19px; background: #000; }
  .status { height: ${status}px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 4px 32px 0 54px; box-sizing: border-box; }
  .status .right { display: flex; align-items: center; gap: 6px; }
  .web { flex: 1; min-height: 0; overflow: hidden; }
  .web img { display: block; width: 100%; }
  .bar { height: ${bar}px; flex: none; box-sizing: border-box; padding: 8px 0 0; background: ${light ? 'rgb(249 249 249 / .97)' : 'rgb(28 28 30 / .97)'};
    border-top: 0.5px solid ${light ? 'rgb(0 0 0 / .16)' : 'rgb(255 255 255 / .14)'}; }
  .field { height: 44px; margin: 0 12px; border-radius: 13px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
    background: ${light ? 'rgb(118 118 128 / .12)' : 'rgb(118 118 128 / .24)'}; font-weight: 500; font-size: 16px; }
  .field .aa { font-weight: 600; font-size: 15px; letter-spacing: -0.02em; width: 24px; }
  .field .address { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; }
  .tools { height: 44px; margin-top: 6px; display: flex; align-items: center; justify-content: space-around; padding: 0 8px; }
  .home { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; justify-content: center; }
  .home span { width: 139px; height: 5px; border-radius: 3px; background: ${ink}; }
</style><div class="device"><div class="screen">
  <div class="status"><span>9:41</span><span class="right">
    <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
    <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.5c2.4 0 4.6.9 6.3 2.5l1.2-1.3A10.8 10.8 0 0 0 8 .7 10.8 10.8 0 0 0 .5 3.7L1.7 5A9 9 0 0 1 8 2.5Zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.2-1.3A7.2 7.2 0 0 0 8 4.3a7.2 7.2 0 0 0-4.9 1.9l1.2 1.3c1-.9 2.3-1.4 3.7-1.4Zm0 3.6c.5 0 1 .2 1.3.5L8 11.6 6.7 10.2c.3-.3.8-.5 1.3-.5Z"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity=".45"/></svg>
  </span></div>
  <div class="island"></div>
  <div class="web"><img src="data:image/png;base64,${img}"></div>
  <div class="bar">
    <div class="field"><span class="aa">AA</span><span class="address">${icon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 12, ink)}${address}</span>${icon('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>', 18, ink)}</div>
    <div class="tools">${icon('<path d="M15 4l-8 8 8 8"/>')}${icon('<path d="M9 4l8 8-8 8"/>', 24, faint)}${icon('<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/>')}${icon('<path d="M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1z"/><path d="M12 6v14"/>')}${icon('<rect x="7" y="7" width="13" height="13" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>')}</div>
  </div>
  <div class="home"><span></span></div>
</div></div>`;
};

export async function framed(png, { path, title, light, safari = null, iphone = null, iphone16 = null }) {
  if (!framePage) {
    framePage = await browser.newPage();
    await framePage.setViewport({ width: 1400, height: 1000, deviceScaleFactor: PROFILES.desktop.viewport.deviceScaleFactor });
  }
  const b64 = Buffer.from(png).toString('base64');
  const html = iphone16 ? IPHONE16_FRAME(b64, iphone16, light) : iphone ? IPHONE_FRAME(b64, iphone, light) : safari ? SAFARI_FRAME(b64, safari, light) : FRAME(b64, title, light);
  await framePage.setContent(html, { waitUntil: 'load' });
  await (await framePage.$(iphone16 ? '.device' : iphone ? '.phone' : safari ? '.win' : 'body')).screenshot({ path, omitBackground: Boolean(safari || iphone || iphone16) });
}

/** First tap on the passkey screen: creates it; the label then asks for the confirming second tap. */
export async function passkeyFirstTap(p) {
  await p.click('#passkey-go');
  await until(p, () => document.querySelector('#passkey-go-title').textContent === 'Confirm passkey');
}
export async function unlockWithPasskey(p) {
  // (The locked screen can show a moment before its button has a box: a click then misses.)
  await until(p, () => document.getElementById('unlock-passkey')?.getClientRects().length > 0, undefined, 10000);
  await p.click('#unlock-passkey');
  await waitView(p, 'view-notes');
}
/** Your menu in the footer (Settings, Log out). */
export async function accountMenu(p) {
  if (mobile(p) && !(await p.$eval('.notes', (e) => !e.classList.contains('editing')))) await p.click('#btn-back');
  await p.click('#btn-account');
  await until(p, () => !document.getElementById('account-menu').hidden);
}
/**
 * A row's menu (Share…, Delete note): a right-click, or on a phone a long press,
 * which mustn't open the note as well.
 */
export async function rowMenu(p, rowSel) {
  const btn = await p.$(`${rowSel} > button`);
  // (Into the middle of the list first, as a person scrolls to it: one at the list's foot is half under the sidebar's footer.)
  await btn.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  if (mobile(p)) {
    const box = await btn.boundingBox();
    await p.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
    await wait(700);
    await p.touchscreen.touchEnd();
    await wait(300);
    if (await p.$eval('.notes', (e) => e.classList.contains('editing'))) throw new Error('a long press on a row opened the note too');
  } else {
    await btn.click({ button: 'right' });
  }
  await until(p, () => !document.getElementById('note-menu').hidden);
}
/** The open note's History and Share: in its bar, or on a phone in its ⋯. */
export async function noteAction(p, name) {
  if (!mobile(p)) return p.click(`#note-${name}`);
  await p.click('#note-more');
  await until(p, (id) => !document.getElementById(id).hidden && !document.getElementById('note-menu').hidden, `note-menu-${name}`);
  await p.click(`#note-menu-${name}`);
}
export const openHistory = (p) => noteAction(p, 'history');
export const openShare = (p) => noteAction(p, 'share');
/** A shared note's page: its ⋯ menu (state, your name; on phones Add to my notes). */
export async function guestMenu(p) {
  if (await p.$eval('#guest-menu', (m) => !m.hidden)) return;
  await p.click('#guest-more');
  await until(p, () => !document.getElementById('guest-menu').hidden);
}
/** A shared note's page: Add to my notes (in its bar; on a phone, in ⋯). */
export async function guestAdd(p) {
  if (!mobile(p)) return p.click('#guest-add');
  await guestMenu(p);
  await p.click('#guest-menu-add');
}
/** Settings, at a section (Sign-in & security, unless asked; null: as it opens, Profile or on a phone the list). */
export async function openSettings(p, section = 'security') {
  await accountMenu(p);
  await p.click('#btn-settings');
  await until(p, () => document.querySelector('#settings').open);
  await wait(250);
  if (!section) return;
  await p.click(`.settings-nav button[data-section="${section}"]`);
  await until(p, (n) => !document.querySelector(`.settings-section[data-section="${n}"]`).hidden
    && getComputedStyle(document.querySelector('.settings-pages')).display !== 'none', section);
}
export async function closeSettings(p) {
  await p.keyboard.press('Escape');
  await wait(200);
}
export async function backToList(p) {
  if (mobile(p) && (await p.$eval('.notes', (e) => e.classList.contains('editing')))) {
    await p.click('#btn-back');
    await wait(250);
  }
}
export async function lock(p) {
  await backToList(p);
  await accountMenu(p);
  await p.click('#btn-logout'); // (Log out: locks this device)
  await until(p, () => !document.querySelector('#view-locked').hidden || !document.querySelector('#view-welcome').hidden || !document.querySelector('#view-home').hidden);
}

/**
 * Open the note titled `title` from the list, in the editor: on a phone it opens as a page (#283),
 * and Edit is tapped (unless `edit` is false). (The list is redrawn as notes change — after a
 * server restart, say — and a click can land on a row just replaced: tried again, a few times.)
 */
export async function openNote(p, title, { edit = true } = {}) {
  await backToList(p);
  // (Run in the page: each on its own, nothing from this scope.)
  // (The note's title: its frontmatter's, else its first line without a heading's "#"s, #584.)
  const ready = (t) => document.getElementById('editor').noteTitle().startsWith(t) &&
    (document.querySelector('#editor .cm-content')?.getAttribute('contenteditable') === 'true' || Boolean(document.querySelector('#editor textarea:not([readonly])')));
  const page = () => !document.getElementById('reading').hidden;
  const pageOrReady = (t) => document.getElementById('editor').noteTitle().startsWith(t) &&
    (!document.getElementById('reading').hidden ||
      document.querySelector('#editor .cm-content')?.getAttribute('contenteditable') === 'true' || Boolean(document.querySelector('#editor textarea:not([readonly])')));
  for (let tries = 0; tries < 4; tries++) {
    let found = false;
    for (const b of await p.$$('#note-list li > button:first-child')) {
      if ((await b.evaluate((e) => e.querySelector('.title').textContent)) !== title) continue;
      found = true;
      await b.click().catch(() => {}); // (a row replaced under the click: tried again)
      const opened = await until(p, pageOrReady, title, tries < 3 ? 5000 : 30000).then(() => true, () => false);
      if (!opened) break;
      if (await p.evaluate(page)) { // (in Preview, #302: the editor, unless either is fine)
        if (!edit) return;
        await setView(p, 'edit');
        const editing = await until(p, ready, title, tries < 3 ? 5000 : 30000).then(() => true, () => false);
        if (!editing) break; // (tried again: the row, then Edit)
      }
      if (tries) console.log(`  (opening "${title}" took ${tries + 1} clicks)`);
      return;
    }
    if (!found) throw new Error(`no note "${title}"`);
    await backToList(p);
  }
  const state = await p.evaluate(() => ({ text: document.getElementById('editor').noteText().slice(0, 40), editorHidden: document.getElementById('editor').hidden, reading: !document.getElementById('reading').hidden, active: document.activeElement?.tagName }));
  throw new Error(`"${title}" didn't open in the editor: ${JSON.stringify(state)}`);
}
export async function writeNotes(p) {
  // Only one New note shows: at the top of the list, or (phones) at the footer's right, beside your account.
  await backToList(p);
  const where = await p.evaluate(() => {
    const shown = (id) => document.getElementById(id).getClientRects().length > 0;
    const foot = document.getElementById('btn-new-foot').getBoundingClientRect();
    return { top: shown('btn-new'), foot: shown('btn-new-foot'),
      rightOfAccount: foot.left >= document.getElementById('btn-account').getBoundingClientRect().right,
      inFooter: Boolean(document.getElementById('btn-new-foot').closest('.sidebar-foot')) };
  });
  const want = mobile(p) ? { top: false, foot: true, rightOfAccount: true, inFooter: true } : { top: true, foot: false };
  // (Hiding the sidebar is for desktop: no button for it on a phone.)
  if (mobile(p) && (await p.$eval('#sidebar-toggle', (b) => b.getClientRects().length > 0))) throw new Error('a phone shows the button to hide the sidebar');
  if (Object.entries(want).some(([k, v]) => where[k] !== v)) throw new Error(`New note's place: ${JSON.stringify(where)}`);
  // The app's name at the top left (#567): Plim, as written, beside its π.
  const brand = await p.evaluate(() => {
    const b = document.querySelector('.sidebar-head .brand');
    return { text: b.textContent.trim(), shown: b.innerText.trim(), logo: b.querySelector('.logo')?.getAttribute('src') };
  });
  if (brand.text !== 'Plim' || brand.shown !== 'Plim' || !brand.logo?.endsWith('icon.svg')) throw new Error(`the app's name should read Plim, beside its mark: ${JSON.stringify(brand)}`);
  for (const text of NOTES) {
    await backToList(p);
    await newBlankNote(p);
    await p.cdp.send('Input.insertText', { text }); // like a paste: one edit at the cursor
    await wait(500);
  }
  await until(p, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
}
/** The storage used, shown (not "0 B") for the screenshots: it's refreshed only every 30 s or so. */
export async function waitStorage(p) {
  if (!SHOTS) return;
  await until(p, () => !document.querySelector('#storage-text').textContent.startsWith('0 B'), undefined, 90000);
}
/**
 * Live sync: with both devices on the same note, an edit on `from` shows up on
 * `to` within `withinMs`. (Connected live, polling runs only every 60 s, so
 * that can only be a push.) Returns the times, in ms.
 */
export async function pushedWithin(from, to, title, withinMs, tries = 3) {
  await openNote(from, title);
  await openNote(to, title);
  await to.waitForFunction(() => document.documentElement.dataset.live === 'on', { timeout: 40000 });
  const times = [];
  for (let i = 0; i < tries; i++) {
    const mark = `[live ${Date.now()}]`;
    await from.bringToFront();
    const t0 = Date.now();
    await typeAtEnd(from, ` ${mark}`);
    await to.waitForFunction((m) => document.getElementById('editor').noteText().includes(m), { timeout: withinMs, polling: 25 }, mark)
      .catch(() => { throw new Error(`"${mark}" didn't reach the other device within ${withinMs} ms`); });
    times.push(Date.now() - t0);
  }
  // Take the markers out again, so the note looks like itself in later screenshots.
  const typed = await from.evaluate(() => document.getElementById('editor').noteText().match(/( \[live \d+\])+$/)?.[0].length ?? 0);
  for (let i = 0; i < typed; i++) await from.keyboard.press('Backspace');
  await to.waitForFunction(() => !document.getElementById('editor').noteText().includes('[live '), { timeout: withinMs * 3 });
  return times;
}
/** The open note's view (#302): 'edit' or 'preview', switched by the bar's control (a phone's Preview toggle, else Edit / Preview). */
/** Split turned on or off on this page's device, as Settings → Split view does. */
export async function setSplit(p, on) {
  // (Its button in the note's bar comes or goes, moving the others: what a click in Settings does.)
  expectShifts(p, 1500);
  await p.evaluate(async (v) => {
    const { setSplitEnabled, splitEnabled } = await import(new URL('ui/reading.js', document.querySelector('script[type=module]').src));
    if (splitEnabled() !== v) setSplitEnabled(v);
  }, on);
}
export async function setView(p, want) {
  const now = await p.evaluate(() => document.getElementById('note-body').dataset.view);
  if (now === want) return;
  // (Split is off unless turned on in Settings: flow 23 turns it on there; the others, here.)
  if (want === 'split') await setSplit(p, true);
  await p.click(mobile(p) ? '#note-preview' : `#note-mode [data-mode="${want}"]`);
  await until(p, (w) => document.getElementById('reading').hidden === (w === 'edit') && document.getElementById('editor').hidden === (w === 'preview'), want);
}
/** Into the editor (from Preview, if that's what shows), then a click in the text. */
export async function intoEditor(p) {
  if (await p.evaluate(() => !document.getElementById('reading').hidden)) {
    await setView(p, 'edit');
    await until(p, () => !document.getElementById('editor').hidden);
  }
  await p.click((await p.$('#editor textarea')) ? '#editor textarea' : '#editor .cm-content');
}
export async function typeAtEnd(p, text) {
  await intoEditor(p);
  await p.keyboard.down('Control');
  await p.keyboard.press('End');
  await p.keyboard.up('Control');
  await typeText(p, text);
}
/**
 * Type `text`, its line breaks inserted as text rather than pressed as Enter
 * (which, in a list, starts the next item itself: "\n- x" would give "- - x").
 */
export async function typeText(p, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) await p.evaluate(() => {
      const ta = document.querySelector('#editor textarea'); // (a phone, #290)
      if (ta) {
        ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
        return ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const v = document.querySelector('#editor .cm-content').cmTile.view;
      v.dispatch(v.state.replaceSelection('\n'));
    });
    await p.keyboard.type(lines[i]);
  }
}

/** A screenshot, with what was done to get to it. */
export const s = (p, name, via) => shot(p, name, { via });
/** A note's row in the list, or in Recently deleted. */
export const row = (id, trashedRow = false) => (trashedRow ? `#trash-list li.trashed[data-id="${id}"]` : `#note-list li[data-id="${id}"]`);

