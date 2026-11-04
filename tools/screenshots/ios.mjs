// Real Safari on an iOS Simulator, driven through Appium on a Mac: the
// on-screen keyboard and what it does to the page, which Chromium's iPhone
// emulation (web.mjs) can't show. Each step writes a screenshot and prints the
// layout; it fails (exit code 1) if the note's header or the cursor is out of
// sight, or the page has scrolled (#209).
//
//   (Mac)   appium --address 127.0.0.1 --port 4723   (DEVELOPER_DIR=Xcode)
//   (here)  ssh -N -L 4723:127.0.0.1:4723 -R 3980:127.0.0.1:3980 <your Mac>
//   (here)  plim-server on 127.0.0.1:3980, then: node ios.mjs
//           (DEVICE=ipad node ios.mjs: an iPad, its own flows, #332; boot its simulator first)
//
// The reverse tunnel puts the dev server at the simulator's localhost, a
// secure context, so crypto.subtle and WebAuthn are available. Env: APPIUM
// (server URL), PLIM_URL (page to open), OUT (screenshot directory); the Mac's
// own, UDID and WDA_BUILD, come from ~/.config/plim/ios.env too (mac-env.mjs).
//
// Appium can't build WebDriverAgent itself against Xcode 26.3: the project
// embeds lib_TestingInterop.dylib, which 26.3's simulator platform lacks. So
// it's built once on the Mac with that library excluded, and reused:
//
//   cd ~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
//   xcodebuild build-for-testing -project WebDriverAgent.xcodeproj \
//     -scheme WebDriverAgentRunner -destination id=$UDID -derivedDataPath ~/wda-build \
//     "WDA_XCTEST_EXCLUDED_2600=XCTest.framework XCTestCore.framework XCUIAutomation.framework XCTAutomationSupport.framework Testing.framework ResultDataPublisher.framework XCTestSupport.framework libXCTestSwiftSupport.dylib lib_TestingInterop.dylib"

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { macSetting } from './mac-env.mjs';
import { clearProfile, mapScreen, writeMap, writeProfile } from './map.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPIUM = process.env.APPIUM ?? 'http://127.0.0.1:4723';
// (/login: where a vault is made or opened; / is a short overview without one. With a vault it opens the app.)
const PLIM_URL = process.env.PLIM_URL ?? 'http://localhost:3980/login';
// DEVICE=ipad (#332): an iPad, where the note is edited in CodeMirror (as on a computer), not the
// phone's textarea; its own flows (IPAD_FLOWS), its own row on the map.
const IPAD = process.env.DEVICE === 'ipad';
// (The Mac's own: its simulators and WebDriverAgent build, from mac-env.mjs.)
const UDID = macSetting(IPAD ? 'UDID_IPAD' : 'UDID');
const WDA_BUILD = macSetting('WDA_BUILD');
const OUT = process.env.OUT ?? join(tmpdir(), 'plim-ios');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(APPIUM + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const { value } = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${value?.message ?? res.status}`);
  return value;
}

const t0 = Date.now();
const { sessionId } = await wd('POST', '/session', {
  capabilities: {
    alwaysMatch: {
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      'appium:udid': UDID,
      // Built once by hand; see the note at the top.
      'appium:usePrebuiltWDA': true,
      'appium:derivedDataPath': WDA_BUILD,
      // The on-screen keyboard, not the Mac's (which hides it).
      'appium:connectHardwareKeyboard': false,
      // An element's click is a real tap (so focusing the editor opens the keyboard).
      'appium:nativeWebTap': true,
      'appium:wdaLaunchTimeout': 600_000,
      'appium:newCommandTimeout': 300,
    },
  },
});
console.log(`session in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const s = (path) => `/session/${sessionId}${path}`;
const run = (script, ...args) => wd('POST', s('/execute/sync'), { script, args });
// Dark mode, as web.mjs's screenshots are (the simulator's own setting, kept after the run).
await run('mobile: setAppearance', { style: process.env.APPEARANCE ?? 'dark' }); // (APPEARANCE=light: the light theme)
const $ = async (css) => Object.values(await wd('POST', s('/element'), { using: 'css selector', value: css }))[0];
/** A real tap on the element (nativeWebTap). */
const tap = async (css) => wd('POST', s(`/element/${await $(css)}/click`), {});
/** A click from the page's own script: for getting somewhere, not for what's being looked at. */
const click = (css) => run('document.querySelector(arguments[0]).click()', css);

async function until(script, what, ms = 30_000, ...args) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
    if (await run(script, ...args)) return;
  }
  throw new Error(`timed out: ${what}`);
}
const shown = (css) => until(
  'const e = document.querySelector(arguments[0]); return !!e && !e.closest("[hidden]") && e.getClientRects().length > 0',
  css, 30_000, css,
);

/** `fn` in iOS's own view of the screen (Safari's controls, the keyboard), then back in the page. */
async function native(fn) {
  await wd('POST', s('/context'), { name: 'NATIVE_APP' });
  try {
    return await fn();
  } finally {
    await wd('POST', s('/context'), { name: (await wd('GET', s('/contexts'))).find((c) => c.startsWith('WEBVIEW')) });
  }
}
const webView = () => wd('POST', s('/element'), { using: '-ios class chain', value: '**/XCUIElementTypeWebView' }).then((e) => Object.values(e)[0]);

/** Typing on the on-screen keyboard, into whatever has the focus. */
async function type(text) {
  // (The focused element inside a page isn't exposed; typing into the web view goes to it.)
  await native(async () => wd('POST', s(`/element/${await webView()}/value`), { text, value: [...text] }));
}

/**
 * Where the page's top left corner is on the screen, in iOS points: measured from the note's ⋯
 * button, as the page and as iOS sees it. (The web view is the whole screen; the page starts
 * under the status bar.)
 */
let pageCorner = null;
async function corner() {
  if (pageCorner) return pageCorner;
  // (Page positions are from the layout viewport; on the screen, what shows is the visual viewport,
  // which Safari sets down a little while a textarea is focused: that offset taken off here, and at each touch.)
  const css = await run('const b = document.getElementById("note-more").getBoundingClientRect(); return { x: b.left - visualViewport.offsetLeft, y: b.top - visualViewport.offsetTop }');
  const ios = await native(async () => {
    const el = Object.values(await wd('POST', s('/element'), { using: 'accessibility id', value: 'More actions for this note' }))[0];
    return wd('GET', s(`/element/${el}/rect`));
  });
  return (pageCorner = { x: ios.x - css.x, y: ios.y - css.y });
}

/**
 * A finger on the screen, at points in the page's CSS pixels (the page isn't zoomed, so one CSS
 * pixel is one iOS point): `steps` of ['down', x, y] | ['move', x, y, ms] | ['wait', ms] | ['up'].
 * (In a note: the page's corner is found from its ⋯ button.)
 */
async function finger(...steps) {
  const box = await corner();
  const vv = await run('return [visualViewport.offsetLeft, visualViewport.offsetTop]'); // (see corner: page points, less what's scrolled off the top)
  await native(async () => {
    const at = (x, y) => ({ x: Math.round(box.x + x - vv[0]), y: Math.round(box.y + y - vv[1]) });
    const actions = steps.flatMap(([kind, ...a]) => ({
      down: [{ type: 'pointerMove', duration: 0, ...at(a[0], a[1]) }, { type: 'pointerDown', button: 0 }],
      move: [{ type: 'pointerMove', duration: a[2] ?? 0, ...at(a[0], a[1]) }],
      wait: [{ type: 'pause', duration: a[0] }],
      up: [{ type: 'pointerUp', button: 0 }],
    })[kind]);
    await wd('POST', s('/actions'), { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions }] });
  });
}
const touch = (x, y) => finger(['down', x, y], ['wait', 60], ['up']);
const longPress = (x, y, ms = 900) => finger(['down', x, y], ['wait', ms], ['up']);
const swipe = (x, from, to, ms = 250) => finger(['down', x, from], ['wait', 30], ['move', x, to, ms], ['up']);

// On a phone the note is edited in a plain textarea (#290). Where a position of its text is drawn
// comes from a mirror: a hidden element laid out as the textarea lays its text out.
const TA = '#editor textarea';
const MIRROR = `
  const ta = document.querySelector('#editor textarea');
  const mirror = (() => {
    let m = document.getElementById('__mirror');
    if (!m) { m = document.createElement('div'); m.id = '__mirror'; m.setAttribute('aria-hidden', 'true'); document.body.append(m); }
    const cs = getComputedStyle(ta);
    for (const k of ['font', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'tabSize', 'textIndent']) m.style[k] = cs[k];
    Object.assign(m.style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box', width: ta.clientWidth + 'px', pointerEvents: 'none', margin: '0', border: '0' });
    return m;
  })();
  /** The box of the text from a to b (a alone: that position), in the page, the textarea's scroll taken off. */
  const boxOf = (a, b = a) => {
    const v = ta.value;
    const span = Object.assign(document.createElement('span'), { textContent: b > a ? v.slice(a, b) : (v[a] ?? ' ') || ' ' });
    mirror.replaceChildren(document.createTextNode(v.slice(0, a)), span, document.createTextNode(v.slice(Math.max(b, a + 1))));
    const rects = span.getClientRects(), r0 = rects[0], r1 = rects[rects.length - 1];
    const t = ta.getBoundingClientRect(), m = mirror.getBoundingClientRect();
    const dx = t.left - m.left, dy = t.top - m.top - ta.scrollTop;
    const box = { left: r0.left + dx, right: (b > a ? r1.right : r0.left) + dx, top: r0.top + dy, bottom: r1.bottom + dy };
    return { ...box, x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  };
`;

/**
 * Where a word of the note is drawn (its `nth` occurrence), as { x, y } (its middle), left, right,
 * top, bottom; with `placeAt`, the textarea scrolled first so that its line is that far down the page.
 */
async function word(text, { nth = 0, placeAt } = {}) {
  const find = `${MIRROR}
    let from = -1;
    for (let i = 0; i <= arguments[1]; i++) from = ta.value.indexOf(arguments[0], from + 1);
    if (from < 0) throw new Error('not in the note: ' + arguments[0]);
  `;
  if (placeAt != null) {
    await run(`${find}
      ta.scrollTop += boxOf(from, from + arguments[0].length).top - arguments[2];
    `, text, nth, placeAt);
    await wait(300);
  }
  return run(`${find} return boxOf(from, from + arguments[0].length);`, text, nth);
}

/** The n-th line of the note (from 1): where it's drawn, as word() gives it. */
const lineBox = (n) => run(`${MIRROR}
  const lines = ta.value.split('\\n');
  const from = lines.slice(0, arguments[0] - 1).join('\\n').length + (arguments[0] > 1 ? 1 : 0);
  return boxOf(from, from + Math.max(1, lines[arguments[0] - 1].length));
`, n);

/** What's selected, in the editor and in the page. */
const selection = () => run(`
  const ta = document.querySelector('#editor textarea');
  return {
    editor: ta.value.slice(ta.selectionStart, ta.selectionEnd),
    ranges: 1,
    page: String(getSelection()),
    focus: document.activeElement?.className || document.activeElement?.tagName,
  };
`);

/** Where things are, in the page's CSS pixels: what the keyboard did to the layout. */
const layout = () => run(`
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
  ${MIRROR}
  const vv = visualViewport;
  const scroller = document.querySelector('#editor textarea');
  return {
    window: innerHeight,
    client: document.documentElement.clientHeight,
    body: Math.round(document.body.getBoundingClientRect().height),
    pageTop: Math.round(vv.pageTop),
    visible: [Math.round(vv.offsetTop), Math.round(vv.offsetTop + vv.height)],
    pageScroll: Math.round(scrollY),
    keyboardVar: document.getElementById('editor').style.getPropertyValue('--keyboard') || null,
    head: r(document.querySelector('.editor-head')),
    editor: r(document.getElementById('editor')),
    scroll: scroller && [Math.round(scroller.scrollTop), scroller.scrollHeight, scroller.clientHeight],
    // (The textarea's own box, its padding at the top (the phone's note header in it) and bottom, and a short note's mark.)
    ta: r(scroller),
    pad: scroller && [getComputedStyle(scroller).paddingTop, getComputedStyle(scroller).paddingBottom],
    short: document.getElementById('editor')?.classList.contains('short'),
    cursor: (() => { if (!scroller || document.activeElement !== scroller) return null; const c = boxOf(ta.selectionEnd); return [Math.round(c.top), Math.round(c.bottom)]; })(),
    card: r(document.querySelector('#editor .md-linkcard')),
    focus: document.activeElement?.className || document.activeElement?.tagName,
  };
`);

// ---------- the map of the screens ----------
// Each screenshot is a screen on the map of every flow (map.mjs, tools/screens-map), as "iOS Safari".
const DEVICE = IPAD ? 'iPad Pro 11-inch (M5), iOS 26.3 (simulator)' : 'iPhone 17, iOS 26.3 (simulator)';
const PROFILE = IPAD ? 'ipad' : 'safari';
// New note: in the footer on a phone; at the top of the sidebar on an iPad, as on a computer.
const NEW_NOTE = IPAD ? '#btn-new' : '#btn-new-foot';
let flowNow = null; // (the flow running: its screens go in its row on the map)
const screens = [];
/**
 * The screen as it is, saved (OUT/<name>.png) and put on the map. `via`: what was done to get
 * here, the map's arrow to it.
 */
async function capture(name, via) {
  const png = join(OUT, `${name}.png`);
  writeFileSync(png, Buffer.from(await wd('GET', s('/screenshot')), 'base64'));
  const rest = name.replace(/^[a-z]+-\d+-/, '').replace(/-/g, ' ');
  screens.push(mapScreen({ profile: PROFILE, name, png, flow: flowNow, device: DEVICE, via, title: rest.charAt(0).toUpperCase() + rest.slice(1) }));
}

/** A screenshot and the layout, with what looks wrong: the header or cursor out of sight. */
async function look(name, via, get = layout) {
  await wait(1500); // the keyboard's slide, and the editor following the cursor
  const l = await get();
  await capture(name, via);
  // (Safari's element positions are from the top of what's visible: offsetTop is already in them.)
  const [top, bottom] = [0, l.visible[1] - l.visible[0]];
  const problems = [];
  if (l.head && l.head[0] < top) problems.push(`header ${top - l.head[0]}px above the visible area`);
  if (l.cursor && (l.cursor[1] > bottom || l.cursor[0] < top)) problems.push(`cursor (${l.cursor}) outside the visible area (${l.visible})`);
  if (l.pageScroll) problems.push(`page scrolled by ${l.pageScroll}px`);
  if (l.card && (l.card[1] > bottom || l.card[0] < top)) problems.push(`link card (${l.card}) outside the visible area (${l.visible})`);
  console.log(`\n${name}:`, JSON.stringify(l));
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (problems.length) process.exitCode = 1;
  return l;
}

/** A new vault, with the recovery phrase (no passkey). */
async function createVault() {
  await click('#btn-create');
  await until('return !!document.querySelector("#phrase-words li") || !document.getElementById("passkey-alt").closest("[hidden]")', 'phrase or passkey step');
  if (!(await run('return !!document.querySelector("#phrase-words li")'))) {
    await click('#passkey-alt');
    await until('return !!document.querySelector("#phrase-words li")', 'phrase');
  }
  await run(`
    const box = document.getElementById('phrase-saved');
    box.checked = true; box.dispatchEvent(new Event('change'));
    document.getElementById('phrase-continue').click();
    const words = [...document.querySelectorAll('#phrase-words li')].map((li) => li.textContent);
    for (const input of document.querySelectorAll('#confirm-fields input')) input.value = words[input.dataset.index];
    document.getElementById('confirm-form').requestSubmit();
  `);
  await shown(NEW_NOTE);
}

/** Signed in, at the list of notes (a new vault the first time). */
async function toNotes() {
  await wd('POST', s('/url'), { url: PLIM_URL });
  await until('return document.readyState === "complete"', 'page load');
  await wait(1000);
  if (await run('return !document.getElementById("btn-create").closest("[hidden]")')) await createVault();
  else if (!IPAD && (await run('return !!document.querySelector("#editor:not([hidden]), #reading:not([hidden])")'))) await click('#btn-back');
  await shown(NEW_NOTE);
}

/** A new note holding `text`, then the keyboard put away (the note as you'd come back to it). */
async function noteWith(text) {
  await tap('#btn-new-foot');
  await wait(1000);
  await blank();
  await run(`document.execCommand('insertText', false, arguments[0])`, text);
  await run('document.querySelector("#editor textarea").scrollTop = 0; document.activeElement.blur()');
  await wait(1500);
}

/** A new note with its title and tags in its frontmatter (#584), then `body`; the keyboard put away. */
async function noteWithTags(title, tags, body = '') {
  await tap('#btn-new-foot');
  await wait(1000);
  await blank();
  await run('document.getElementById("editor").noteYText().insert(0, arguments[0])', `---\ntitle: ${title}\ntags: [${tags.join(', ')}]\n---\n${body}`);
  await run('document.activeElement?.blur()');
  await wait(1500);
}

/**
 * The layout on every frame for `ms` after `action` (a tap that opens the keyboard): what moves,
 * and when. Prints the frames where something changed; returns them all.
 */
async function frames(name, action, ms = 2000, { print = true } = {}) {
  await run(`
    const vv = visualViewport, t0 = performance.now(), out = (window.__frames = []);
    const top = (css) => { const e = document.querySelector(css); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    const ta = document.querySelector('#editor textarea');
    const tick = () => {
      out.push({
        scrollHeight: ta?.scrollHeight ?? null,
        t: Math.round(performance.now() - t0), scrollY: Math.round(scrollY), vvTop: Math.round(vv.offsetTop), vvHeight: Math.round(vv.height),
        body: Math.round(document.body.getBoundingClientRect().height), keyboard: document.documentElement.hasAttribute('data-keyboard'),
        head: top('.editor-head'), scrollTop: ta ? Math.round(ta.scrollTop) : null,
        text: top('#editor textarea'), // (where the text is drawn)
      });
      if (performance.now() - t0 < arguments[0]) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  `, ms);
  await action();
  await wait(ms + 300);
  const all = await run('return window.__frames');
  const key = ({ t, ...f }) => JSON.stringify(f);
  console.log(`\n${name}: ${all.length} frames${print ? '; the ones where something changed:' : ''}`);
  if (print) all.forEach((f, i) => { if (!i || key(f) !== key(all[i - 1])) console.log('  ', JSON.stringify(f)); });
  // The page itself never moves: no scroll, the header where it is. (Safari sets the visible
  // area a little down for a focused textarea, #290 — a constant, the header still in view, as
  // the positions here are from the visible area's top; it mustn't move once settled.)
  // (Safari also nudges the page by a few px for a frame as a textarea's keyboard finishes opening,
  // undone at once by keyboard.js: a move is one that lasts three frames.)
  const settled = all.at(-1).vvTop;
  const off = (f) => f.scrollY || f.head !== all[0].head;
  const moved = all.filter((f, i) => (i >= 2 && off(f) && off(all[i - 1]) && off(all[i - 2])) || (f.t > 800 && Math.abs(f.vvTop - settled) > 3));
  if (moved.length) {
    console.log(`  ✗ the page moved in ${moved.length} frames`);
    process.exitCode = 1;
  }
  return all;
}

/** A screenshot as things are, without waiting for them to settle (in the middle of a scroll). */
const shot = (name, via) => capture(name, via);
const SAMPLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'long-note.md'), 'utf8');
// A new note emptied of what it starts with (its date and time, #313), for a flow writing its own.
const blank = () => run('const y = document.getElementById("editor").noteYText(); y.delete(0, y.length)');
const putKeyboardAway = async () => {
  await run('document.activeElement.blur()');
  await wait(1200);
};

/** How each of the app's local stores (IndexedDB) answers a read: "ok <count>", or "stuck" after 3 s (#235). */
const idbProbe = async () => (await wd('POST', s('/timeouts'), { script: 20000 }), wd('POST', s('/execute/async'), { args: [], script: `
  const done = arguments[arguments.length - 1];
  const out = {};
  const timeout = (ms) => new Promise((r) => setTimeout(() => r('stuck'), ms));
  const read = (store) => new Promise((resolve) => {
    const req = indexedDB.open('tiro', 2); // (the app's database keeps its name from before the rename: vault.js)
    req.onblocked = () => resolve('open blocked');
    req.onerror = () => resolve('open error ' + req.error);
    req.onsuccess = () => {
      const t = req.result.transaction(store, 'readonly');
      const g = t.objectStore(store).count();
      g.onsuccess = () => resolve('ok ' + g.result);
      g.onerror = () => resolve('error ' + g.error);
    };
  });
  (async () => {
    for (const store of ['docs', 'outbox', 'kv']) out[store] = await Promise.race([read(store), timeout(3000)]);
    done(out);
  })();
` }));

/**
 * A key of the on-screen keyboard, pressed (so iOS's own typing help applies: capitals, ". ",
 * smart punctuation; type() doesn't). One on the keyboard's other page: "more" switches
 * between letters and 123.
 */
const nativeKey = (id) => native(async () => {
  for (let flip = 0; flip < 2; flip++) {
    for (const name of [id, id.toLowerCase(), id.toUpperCase()]) {
      const el = await wd('POST', s('/element'), { using: 'accessibility id', value: name }).then((e) => Object.values(e)[0], () => null);
      if (el) return wd('POST', s(`/element/${el}/click`), {});
    }
    const more = Object.values(await wd('POST', s('/element'), { using: 'accessibility id', value: 'more' }))[0];
    await wd('POST', s(`/element/${more}/click`), {});
  }
  throw new Error(`no key ${id}`);
});
const keys = async (...ks) => { for (const k of ks) await nativeKey(k); };
const lastLine = () => run('const t = document.getElementById("editor").noteText(); return t.split("\\n").at(-1)');

/**
 * The list's order (#344): the button beside the list's label opens a menu, big enough to tap,
 * on screen, no keyboard; Date created reorders the list and dates its rows "Created …", the
 * button left as it was (no highlight a touch leaves behind); and back.
 */
async function sortFlow(prefix, layout) {
  await tap('#notes-sort');
  await until('return !document.getElementById("sort-menu").hidden', 'the sort menu');
  const sizes = await run(`const r = document.getElementById("sort-menu").getBoundingClientRect();
    return { button: document.getElementById("notes-sort").offsetHeight, rows: [...document.querySelectorAll("#sort-menu [data-sort]")].map((x) => x.offsetHeight),
      onScreen: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, keyboard: document.documentElement.hasAttribute("data-keyboard") }`);
  console.log('\nthe sort menu:', JSON.stringify(sizes));
  if (sizes.button < 44 || sizes.rows.some((h) => h < 48) || !sizes.onScreen || sizes.keyboard) fail(`the sort menu: ${JSON.stringify(sizes)}`);
  await look(`${prefix}sort-1-menu`, 'tap Last edited', layout);
  await tap('#sort-menu [data-sort="created"]');
  await until(`return document.getElementById("sort-menu").hidden && document.getElementById("notes-sort-label").textContent === "Date created"
    && [...document.querySelectorAll("#note-list .when")].every((w) => w.textContent.startsWith("Created"))`, 'Date created');
  await wait(400);
  const bg = await run('return getComputedStyle(document.getElementById("notes-sort")).backgroundColor');
  if (bg !== 'rgba(0, 0, 0, 0)') fail(`the sort button stays highlighted after a tap: ${bg}`);
  await look(`${prefix}sort-2-by-created`, 'Date created', layout);
  await tap('#notes-sort');
  await until('return !document.getElementById("sort-menu").hidden', 'the sort menu again');
  await tap('#sort-menu [data-sort="edited"]');
  await until('return document.getElementById("notes-sort-label").textContent === "Last edited" && !document.querySelector("#note-list .when")?.textContent.startsWith("Created")', 'Last edited');
}

const FLOWS = {
  // Typing line after line at a note's end (#232): Safari mustn't move the view down a little with
  // each line (it did, under the status bar); the header stays at the top of what's visible.
  async lines() {
    await toNotes();
    await tap('#btn-new-foot');
    await wait(1200);
    await blank();
    await type('Line after line');
    const seen = [];
    for (let i = 1; i <= 20; i++) {
      await type(`\nline ${i}`);
      await wait(200);
      seen.push(await run('const vv = visualViewport, h = document.querySelector(".editor-head").getBoundingClientRect(); return [Math.round(vv.offsetTop), Math.round(h.top - vv.offsetTop)]'));
    }
    await look('lines-1-twenty', 'type 20 lines');
    console.log('\nline after line (view moved / header from the top):', seen.map((x) => x.join('/')).join(' '));
    // (Against the first line's: Safari sets the visible area a little down for a focused textarea, a constant.)
    const worst = Math.max(...seen.map(([moved, head]) => Math.max(Math.abs(moved - seen[0][0]), Math.abs(head - seen[0][1]))));
    if (worst > 2) {
      console.log(`  ✗ the view moved by up to ${worst}px as lines were typed`);
      process.exitCode = 1;
    }
  },

  // Typing in a dialog (#236): Settings → Profile, your name. The page doesn't scroll, and the
  // dialog fits above the keyboard: its top (and close button) in sight, the field too.
  async dialog() {
    await toNotes();
    await noteWith('Dialog check');
    await corner(); // (the page's place on the screen, from the note's ⋯, for touch())
    await click('#btn-back');
    await shown('#btn-new-foot');
    await click('#btn-account');
    await shown('#account-menu');
    await click('#btn-settings');
    await until('return document.getElementById("settings").open', 'Settings');
    await click('.settings-nav button[data-section="profile"]');
    await wait(800);
    const f = await run('const b = document.getElementById("settings-name").getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }');
    await touch(f.x, f.y);
    await type('Robin');
    await wait(1200);
    const l = await run(`const r = (css) => { const b = document.querySelector(css).getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
      const vv = visualViewport;
      return { field: r('#settings-name'), dialog: r('#settings'), close: r('#settings [aria-label="Close"]'), visible: [Math.round(vv.offsetTop), Math.round(vv.offsetTop + vv.height)], scrollY: Math.round(scrollY), focus: document.activeElement?.id };`);
    await look('dialog-1-settings-name', 'Settings → your name');
    console.log('\nSettings, typing your name:', JSON.stringify(l));
    const [top, bottom] = l.visible;
    const problems = [
      l.focus !== 'settings-name' && `the focus is on ${l.focus}`,
      l.scrollY && `the page scrolled by ${l.scrollY}px`,
      (l.close[0] < top || l.dialog[0] < top - 1) && `the dialog's top is out of sight (${l.dialog[0]}, close button ${l.close[0]}; visible from ${top})`,
      (l.field[1] > bottom || l.field[0] < top) && `the field is out of sight (${l.field}; visible ${l.visible})`,
    ].filter(Boolean);
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (problems.length) process.exitCode = 1;
  },

  // iOS's smart punctuation, key by key: off in the textarea, on purpose (#266: the markdown as it
  // is; code and marks need the plain characters, and so does "--"). The keyboard has no backtick,
  // a long press on ' does: type() puts those in.
  async typing() {
    await toNotes();
    await tap('#btn-new-foot');
    await wait(1200);
    await blank();
    await type('Typing check\n');
    await keys('-', '-', '-');
    const rule = await lastLine();
    await type('\n');
    await keys('S', 'A', 'Y', 'space', '"', 'H', 'I', '"', 'space', 'I', 'T', "'", 'S');
    const prose = await lastLine();
    await type('\nRun `print(');
    await keys('"', 'H', 'I', '"');
    await type(')`');
    const code = await lastLine();
    await type('\n```\nls ');
    await keys('-', '-', 'A', 'L', 'L');
    const fenced = await lastLine();
    await look('typing-1-marks', 'type markdown, key by key');
    console.log('\ntyped:', JSON.stringify({ rule, prose, code, fenced }));
    const problems = [
      rule !== '---' && `"- - -" gave ${JSON.stringify(rule)}, not a dividing line`,
      !/"hi" it's/i.test(prose) && `prose got smart punctuation (off on purpose, #266): ${JSON.stringify(prose)}`,
      code !== 'Run `print("hi")`' && `code got ${JSON.stringify(code)}`,
      fenced !== 'ls --all' && `a code block got ${JSON.stringify(fenced)}`,
    ].filter(Boolean);
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (problems.length) process.exitCode = 1;
  },


  // Return in a list (#290): the next item (capitalised as iOS does); on an empty item the list
  // ends there; Backspace after a marker removes it.
  // Type / for a menu (#311), on the keyboard itself: a tap in the menu keeps the keyboard (and
  // the focus); Return after a filter picks, after a bare / it's a new line; near the keyboard,
  // the menu goes over the line, all of it in sight.
  async slash() {
    await toNotes();
    await noteWith('Standup\n\nYesterday');
    const fail = (p) => { console.log(`  ✗ ${p}`); process.exitCode = 1; };
    const menu = () => run(`
      const m = document.querySelector('#editor .slash-menu');
      if (!m || m.hidden) return null;
      const r = m.getBoundingClientRect();
      return { options: [...m.querySelectorAll('.slash-label')].map((e) => e.textContent), top: Math.round(r.top), bottom: Math.round(r.bottom), above: m.classList.contains('above'), visible: Math.round(visualViewport.height) };
    `);
    const option = (n) => run(`const r = document.querySelector('#editor .slash-option:nth-child(' + arguments[0] + ')').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }`, n);
    const keyboard = () => run('return { focused: document.activeElement === document.querySelector("#editor textarea"), open: "keyboard" in document.documentElement.dataset }');
    const tail = () => run('return document.getElementById("editor").noteText().slice(-24)');
    // (Today as the app has it: by the server's clock (#58), this machine's, not the simulator's own, which can be hours off.)
    const today = ((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());
    await putKeyboardAway();
    const end = await word('Yesterday');
    await touch(end.right + 2, end.y);
    await wait(1200);
    await run('const ta = document.querySelector("#editor textarea"); ta.setSelectionRange(ta.value.length, ta.value.length)');
    await nativeKey('Return');
    await keys('/');
    await wait(600);
    let m = await menu();
    console.log('\na / typed:', JSON.stringify(m));
    if (m?.options.join() !== 'Today,Now,Yesterday,Date and time') fail(`a / on a new line should offer all four: ${JSON.stringify(m)}`);
    await look('slash-1-menu', 'type / on a new line');
    // A tap on Now: the time in, the keyboard still up, the focus still in the note.
    const now = await option(2);
    await touch(now.x, now.y);
    await wait(800);
    let k = await keyboard();
    console.log('Now tapped:', JSON.stringify({ ...k, tail: await tail(), menu: await menu() }));
    if (!k.focused || !k.open) fail(`a tap in the menu should leave the keyboard up: ${JSON.stringify(k)}`);
    if (!/\n\d{1,2}:\d\d [AP]M$/.test(await tail())) fail(`Now should put the time in: ${JSON.stringify(await tail())}`);
    if (await menu()) fail('the menu should go once Now is tapped');
    await look('slash-2-now-tapped', 'tap Now');
    // A filter, then Return: picks (Today); a bare /, then Return: a new line.
    await keys('space', '/', 'T', 'o', 'd');
    await wait(500);
    m = await menu();
    if (m?.options.join() !== 'Today') fail(`/Tod should find Today alone: ${JSON.stringify(m)} (${JSON.stringify(await tail())})`);
    await nativeKey('Return');
    await wait(600);
    if (!(await tail()).endsWith(` ${today}`)) fail(`Return after /Tod should pick Today: ${JSON.stringify(await tail())}`);
    await keys('space', '/');
    await wait(400);
    if (!(await menu())) fail('a / after a space should offer the menu');
    await nativeKey('Return');
    await wait(600);
    if (!(await tail()).endsWith(' /\n') || (await menu())) fail(`Return after a bare / should be a new line: ${JSON.stringify(await tail())}`);
    // Near the keyboard: over the line, all of it above the keyboard; a tap still picks.
    await run(`document.execCommand('insertText', false, Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\\n') + '\\n')`);
    await wait(1000);
    await keys('/');
    await wait(700);
    m = await menu();
    console.log('a / near the keyboard:', JSON.stringify(m));
    if (!m?.above || m.top < 0 || m.bottom > m.visible) fail(`near the keyboard, the menu should go over the line, in sight: ${JSON.stringify(m)}`);
    await look('slash-3-above-keyboard', 'type / on a line near the keyboard');
    const first = await option(1);
    await touch(first.x, first.y);
    await wait(800);
    k = await keyboard();
    if (!(await tail()).endsWith(`\n${today}`) || !k.focused || !k.open) fail(`Today tapped near the keyboard: ${JSON.stringify({ ...k, tail: await tail() })}`);
  },

  // The tag picker (#581), on the keyboard: + tag in a note's header, letters typed on the iPhone's
  // keyboard (a capital, as iOS may make it, too) narrow your tags; a tap on one puts it on, in the
  // note's block, the field keeping the keyboard up for the next.
  async tags() {
    await toNotes();
    await noteWithTags('Squats', ['lift', 'lift/legs']);
    await click('#btn-back');
    await shown('#btn-new-foot');
    await noteWithTags('Leg day', []);
    const fail = (p) => { console.log(`  ✗ ${p}`); process.exitCode = 1; };
    const picker = () => run(`
      if (document.getElementById('tag-picker').hidden) return null;
      return { options: [...document.querySelectorAll('#tag-picker-list li .tp-name')].map((e) => e.textContent), focused: document.activeElement?.id };
    `);
    const tags = () => run('return document.getElementById("editor").noteText().match(/^---\\n(?:.*\\n)*?tags: \\[(.*)\\]\\n/)?.[1] ?? ""');
    await tap('#note-head-add');
    await wait(800);
    await type('L');
    await wait(600);
    const p = await picker();
    console.log('\nL typed in the picker:', JSON.stringify(p));
    if (!p || p.options[0] !== '#lift' || p.focused !== 'tag-picker-input') fail(`L should offer #lift first, the picker's field focused: ${JSON.stringify(p)}`);
    await look('tags-1-suggested', 'tap + tag, type L');
    const first = await run('const r = document.querySelector("#tag-picker-list li").getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }');
    await touch(first.x, first.y);
    await wait(800);
    const k = await run('return { focused: document.activeElement?.id, open: "keyboard" in document.documentElement.dataset }');
    if ((await tags()) !== 'lift' || k.focused !== 'tag-picker-input') fail(`#lift tapped: in the block, the field still focused: ${JSON.stringify({ ...k, tags: await tags() })}`);
    await type('lift/');
    await wait(500);
    const q = await picker();
    if (q?.options[0] !== '#lift/legs') fail(`lift/ typed: #lift/legs offered: ${JSON.stringify(q)}`);
    await nativeKey('Return');
    await wait(600);
    if ((await tags()) !== 'lift, lift/legs') fail(`Return: #lift/legs on too: ${JSON.stringify(await tags())}`);
    await look('tags-2-picked', 'two tags picked');
  },

  async enter() {
    await toNotes();
    await noteWith('Shopping\n\n- Milk\n- Eggs\n  - Free range');
    const fail = (p) => { console.log(`  ✗ ${p}`); process.exitCode = 1; };
    const toEnd = () => run('const ta = document.querySelector("#editor textarea"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length)');
    const tail = () => run('const t = document.getElementById("editor").noteText().split("\\n"); return t.slice(-2)');
    // On the keyboard: Return in the list, then a letter; the next item, capitalised as iOS does.
    // (A tap at the end of the last item: a focus from a script doesn't always bring the keyboard.)
    await putKeyboardAway();
    const end = await word('Free range');
    await touch(end.right + 2, end.y);
    await wait(1200);
    await toEnd();
    await wait(300);
    await nativeKey('Return');
    await wait(600);
    await keys('E');
    await wait(500);
    const got = await tail();
    console.log('Return, then "e":', JSON.stringify(got));
    if (got[0] !== '  - Free range' || !/^ {2}- [Ee]$/.test(got[1])) fail(`Return then a letter gave ${JSON.stringify(got)}`);
    await look('enter-1-next-item', 'Return at the end of a list item, then a letter');
    if (got[1] !== '  - E') fail(`after Return, the next item wasn't capitalised: ${JSON.stringify(got[1])}`);
    // New lines not from the Return key (text with lines in it, as a text replacement brings) go
    // in as they are, no markers added.
    await run(`document.execCommand('insertText', false, 'nd\\nOne\\nTwo\\nThree')`);
    await wait(500);
    const lines = await run('return document.getElementById("editor").noteText().split("\\n").slice(-4)');
    console.log('text with new lines in it:', JSON.stringify(lines));
    if (lines.join('|') !== '  - End|One|Two|Three') fail(`text with new lines in it went in as ${JSON.stringify(lines)}`);
    // A new item, then Return on it empty: the list ends there (its marker goes).
    await nativeKey('Return');
    await wait(300);
    await keys('-', 'space', 'A');
    await wait(300);
    await nativeKey('Return');
    await wait(400);
    await nativeKey('Return');
    await wait(600);
    const ended = await tail();
    console.log('Return on an empty item:', JSON.stringify(ended));
    if (!/^- [Aa]$/.test(ended[0]) || ended[1] !== '') fail(`Return on an empty item gave ${JSON.stringify(ended)}`);
  },


  // Around the app in real Safari: the list of notes, a note, its ⋯ menu, History, Share, your menu, Settings.
  // Recently deleted (#190): the list a screen of its own; a deleted note another, to read, with
  // Restore in reach at the bottom (no keyboard); Safari's Back to the list; Restore; All notes.
  async trash() {
    await toNotes();
    await noteWith('Deleted on a phone\n\nA line to read before restoring it.');
    await tap('#note-more');
    await shown('#note-menu');
    await tap('#note-menu-delete');
    await until('return !document.getElementById("toast").hidden', 'deleted');
    await run('document.getElementById("toast").hidden = true');
    await tap('#btn-trash-foot'); // (at the end of the list, #539)
    await until('return document.getElementById("view-notes").classList.contains("trash-mode")', 'Recently deleted');
    const row = await run('const li = [...document.querySelectorAll("#trash-list li.trashed")].find((l) => l.textContent.startsWith("Deleted on a phone")); return li && `#trash-list li[data-id="${li.dataset.id}"] button`');
    if (!row) return fail('the deleted note should be in Recently deleted');
    await look('trash-1-list', 'Recently deleted');
    await tap(row);
    await until('return !document.getElementById("trash-view").hidden && document.getElementById("trash-page").textContent.includes("A line to read")', 'a deleted note');
    const fit = await run(`const r = document.getElementById("trash-restore").getBoundingClientRect();
      return { inView: r.bottom <= innerHeight && r.top > innerHeight / 2, h: Math.round(r.height), keyboard: document.documentElement.hasAttribute("data-keyboard"), focus: document.activeElement.tagName }`);
    console.log('\na deleted note:', JSON.stringify(fit));
    if (!fit.inView || fit.h < 44 || fit.keyboard) fail(`a deleted note on an iPhone: ${JSON.stringify(fit)}`);
    await look('trash-2-note', 'tap a deleted note');
    // Safari's Back: the list again, still in Recently deleted.
    await wd('POST', s('/back'), {});
    await until('return document.getElementById("trash-view").hidden && document.getElementById("view-notes").classList.contains("trash-mode")', 'Back to the list');
    await tap(row);
    await until('return !document.getElementById("trash-view").hidden', 'the deleted note again');
    await tap('#trash-restore');
    await until('return document.getElementById("toast-text").textContent === "Restored “Deleted on a phone”" && document.getElementById("trash-view").hidden', 'Restore');
    await tap('#tag-clear');
    await until('return !document.getElementById("view-notes").classList.contains("trash-mode") && [...document.querySelectorAll("#note-list .title")].some((t) => t.textContent === "Deleted on a phone")', 'All notes');
  },

  // Search (#24): the field under New note, typed on the keyboard (no zoom: 16px); the list the
  // notes with the word, whatever its accents, each with its line; a result opened as a page,
  // every match marked (WebKit's highlights), the bar at the bottom going through them.
  async search() {
    await toNotes();
    await noteWith('Café plans\n\nMeet at the café on Rua Augusta.\nThen the tram, then the CAFE again.');
    await click('#btn-back');
    await shown(NEW_NOTE);
    await tap('#search-input');
    await wait(800);
    await type('cafe');
    await until('return [...document.querySelectorAll("#note-list li[data-id]")].some((li) => li.querySelector(".title").textContent === "Café plans" && li.querySelector(".row-line mark"))', 'the results');
    const found = await run(`const li = [...document.querySelectorAll("#note-list li[data-id]")].find((l) => l.querySelector(".title").textContent === "Café plans");
      li.querySelector("button").dataset.test = "hit";
      return { lines: [...li.querySelectorAll(".row-line")].map((l) => l.textContent), marks: [...li.querySelectorAll("mark")].map((m) => m.textContent),
        summary: document.getElementById("search-summary").textContent, zoom: visualViewport.scale, fontSize: getComputedStyle(document.getElementById("search-input")).fontSize }`);
    console.log('\n"cafe" on an iPhone:', JSON.stringify(found));
    if (found.marks.join() !== 'café,CAFE' || found.zoom !== 1 || found.fontSize !== '16px') fail(`search on an iPhone: ${JSON.stringify(found)}`);
    await look('search-1-results', 'type in the search field');
    await run('document.activeElement.blur()');
    await wait(600);
    await tap('[data-test="hit"]');
    await until('return !document.getElementById("find-bar").hidden', 'the matches\' bar');
    const marked = () => run(`return { count: document.getElementById("find-count").textContent, page: !document.getElementById("reading").hidden,
      all: (CSS.highlights.get("find")?.size ?? 0) + (CSS.highlights.get("find-current")?.size ?? 0), current: CSS.highlights.get("find-current")?.size ?? 0 }`);
    let m = await marked();
    console.log('opened:', JSON.stringify(m));
    if (m.count !== '1 of 3' || !m.page || m.all !== 3 || m.current !== 1) fail(`a result opened on an iPhone: ${JSON.stringify(m)}`);
    await tap('#find-next');
    await until('return document.getElementById("find-count").textContent === "2 of 3"', 'the next match');
    await look('search-2-in-note', 'a result, its matches');
    await tap('#find-close');
    m = await marked();
    if (m.all) fail(`the bar closed: nothing marked: ${JSON.stringify(m)}`);
    await click('#btn-back');
    await shown(NEW_NOTE);
    await tap('#search-clear');
    await until('return document.getElementById("search-summary").hidden', 'the search over');
  },

  // A note's tags on its row (#350): after its date, two at most on a phone, then how many more; one line.
  async rowtags() {
    await toNotes();
    await noteWithTags('Tagged on a phone', ['gym', 'training', 'travel'], 'A line.');
    await click('#btn-back');
    await shown(NEW_NOTE);
    await until('return [...document.querySelectorAll("#note-list li")].some((li) => li.querySelector(".title").textContent === "Tagged on a phone" && li.querySelector(".row-tags"))', 'its row, with its tags');
    const row = await run(`const li = [...document.querySelectorAll("#note-list li")].find((l) => l.querySelector(".title").textContent === "Tagged on a phone"), w = li.querySelector(".when");
      return { tags: li.querySelector(".row-tags").textContent, more: li.querySelector(".row-more")?.textContent ?? "", oneLine: w.scrollHeight <= w.clientHeight + 2, sideways: document.documentElement.scrollWidth > innerWidth + 1 }`);
    console.log('\na tagged row:', JSON.stringify(row));
    if (row.tags !== '#gym #training' || row.more !== ' +1' || !row.oneLine || row.sideways) fail(`a tagged row on an iPhone: ${JSON.stringify(row)}`);
    await look('rowtags-1-list', 'its row');
    // A tag picked from the chips over the list (#514, #549): pressed, first in the row, its notes
    // alone; the chips one row (scrolling sideways in it, the page not), 44 px for a finger.
    await tap('#tag-chips .tag-chip[data-tag="training"]');
    await until('return document.querySelector(\'#tag-chips .tag-chip[data-tag="training"]\').getAttribute("aria-pressed") === "true"', '#training picked');
    const c = await run(`const shown = [...document.querySelectorAll("#chip-row .chip")].filter((b) => b.offsetParent);
      return { rows: new Set(shown.map((b) => Math.round(b.getBoundingClientRect().top))).size, low: shown.filter((b) => b.offsetHeight < 44).length,
        notes: [...document.querySelectorAll("#note-list li[data-id] .title")].map((t) => t.textContent), sideways: document.documentElement.scrollWidth > innerWidth + 1,
        first: document.querySelector("#tag-chips .tag-chip")?.dataset.tag }`);
    console.log('\nthe chips, #training picked:', JSON.stringify(c));
    if (c.rows !== 1 || c.low || c.notes.join() !== 'Tagged on a phone' || c.sideways || c.first !== 'training') fail(`a tag picked on an iPhone: ${JSON.stringify(c)}`);
    await look('rowtags-2-picked', '#training picked');
    // Tapped again (#549: no All chip): every note.
    await tap('#tag-chips .tag-chip[data-tag="training"]');
    await until('return !document.querySelector(\'#tag-chips .tag-chip[aria-pressed="true"]\')', 'every note');
  },

  // The list's order (#344), on an iPhone.
  async sort() {
    await toNotes();
    await sortFlow('');
  },

  async tour() {
    await toNotes();
    // (A new vault has no notes: a few to show.)
    if (!(await run('return document.querySelectorAll("#note-list li > button").length'))) {
      for (const text of [
        'Groceries\n\n- oat milk\n- lemons\n- sourdough',
        'Lisbon trip\n\nFlights: Thu 08:40 → Sun 19:15\n\n- [x] Book the flights\n- [ ] Tram 28 early\n- [ ] Pastéis de Belém',
        'Reading list\n\n- The Overstory\n- Piranesi\n- *A Psalm for the Wild-Built*',
      ]) {
        await noteWith(text);
        await click('#btn-back');
        await shown('#btn-new-foot');
      }
    }
    await look('tour-1-notes');
    await tap('#note-list li > button');
    await shown('#reading'); // (on a phone a note opens as a page, #302)
    await look('tour-2-note', 'tap a note');
    await tap('#note-more');
    await shown('#note-menu');
    await look('tour-3-note-menu', 'tap ⋯');
    await tap('#note-menu-history');
    await until('return document.getElementById("history-dialog").open', 'History');
    await look('tour-4-history', 'History');
    // A version (#340): a screen of its own, the whole screen; ‹ Versions back. (None yet on a new note: the message.)
    if (await run('return Boolean(document.querySelector("#history-list button[data-id]:not([data-id=\\"now\\"])"))')) {
      await tap('#history-list button[data-id]:not([data-id="now"])');
      await until('return document.getElementById("history-dialog").classList.contains("previewing") && !document.getElementById("history-copy").disabled', 'a version');
      const fits = await run(`const d = document.getElementById("history-dialog").getBoundingClientRect(), r = document.getElementById("history-copy").getBoundingClientRect();
        return Math.abs(d.height - innerHeight) < 2 && r.bottom <= innerHeight && r.height >= 44`);
      if (!fits) throw new Error('History on an iPhone: not the whole screen, or Copy out of reach');
      await look('tour-4b-history-version', 'a version');
      await tap('#history-back');
      await until('return !document.getElementById("history-dialog").classList.contains("previewing")', '‹ Versions');
    }
    await run('document.getElementById("history-dialog").close()');
    await tap('#note-more');
    await shown('#note-menu');
    await tap('#note-menu-share');
    await until('return document.getElementById("share-dialog").open', 'Share');
    await look('tour-5-share', 'Share');
    await run('document.getElementById("share-dialog").close()');
    await click('#btn-back');
    await shown('#btn-new-foot');
    await tap('#btn-account');
    await shown('#account-menu');
    await look('tour-6-account-menu', 'tap your name');
    await tap('#btn-settings');
    await until('return document.getElementById("settings").open', 'Settings');
    await look('tour-7-settings', 'Settings');
    // A section scrolled to its end (#361): its header still at the top, ‹ Settings and × tappable.
    await tap('.settings-nav button[data-section="security"]');
    await until('return document.getElementById("settings").dataset.level === "page"', 'Sign-in & security');
    // (Longer than the screen whatever the section holds: a new vault's fits on an iPhone, #449.)
    const head = await run(`const d = document.getElementById("settings");
      const pad = Object.assign(document.createElement("div"), { id: "test-pad" });
      pad.style.height = "150vh";
      document.querySelector('#settings section[data-section="security"]').append(pad);
      d.scrollTop = d.scrollHeight;
      const at = (e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)); };
      const back = document.getElementById("settings-back");
      return { scrolled: d.scrollTop > 0, top: Math.round(document.querySelector("#settings .settings-head").getBoundingClientRect().top),
        backTop: Math.round(back.getBoundingClientRect().top), back: at(back), close: at(document.querySelector('#settings .settings-head [value=close]')) }`);
    console.log("\nSettings' header, scrolled:", JSON.stringify(head));
    if (!head.scrolled || head.top !== 0 || !head.back || !head.close) fail(`Settings' header on an iPhone, scrolled: ${JSON.stringify(head)}`);
    await look('tour-8-settings-scrolled', 'Sign-in & security, scrolled');
    await run('document.getElementById("test-pad")?.remove(); document.getElementById("settings").close()');
  },

  // The keyboard while writing (#209): a new note, typing, the end of a long note, tapping near its top.
  async keyboard() {
    await toNotes();
    await look('keyboard-1-notes');

    // New note: tapping it should open the keyboard, with the cursor after its date (#313).
    await tap('#btn-new-foot');
    await look('keyboard-2-new-note');
    await blank();

    await type('Keyboard check\nA first line, typed on the keyboard.');
    await look('keyboard-3-typed');

    // A note longer than the screen, then typing at its end: the line being typed stays above the keyboard.
    await run(`document.execCommand('insertText', false, '\\n' + Array.from({ length: 40 }, (_, i) => 'Line ' + (i + 1) + ' of a long note.').join('\\n'))`);
    await look('keyboard-4-long-note');
    await type('\nTyping at the end');
    await look('keyboard-5-typing-at-end');

    // Tapping near the top of the long note, with the keyboard still open.
    await run('document.querySelector("#editor textarea").scrollTop = 0');
    { const l = await lineBox(3); await touch(l.x, l.y); }
    await look('keyboard-6-tap-near-top');
    await type(' (edited)');
    await look('keyboard-7-typed-near-top');
  },

  // Tapping into a note with the keyboard put away: how it opens, frame by frame.
  async tap() {
    await toNotes();
    await noteWith('Tap check\n' + Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note.`).join('\n'));
    await frames('tap-near-top', async () => { const l = await lineBox(4); await touch(l.x, l.y); });
    await look('tap-1-near-top');
    await run('document.activeElement.blur()');
    await wait(1500);
    await frames('tap-low', async () => { const l = await lineBox(18); await touch(l.x, l.y); });
    await look('tap-2-low');  },


  // A long note with a bit of everything (long-note.md): scrolling it with a finger, then tapping
  // into each kind of line with the keyboard away, and typing there.
  async long() {
    await toNotes();
    await noteWith(SAMPLE);
    await look('long-1-top');
    for (let i = 1; i <= 3; i++) {
      await swipe(200, 600, 150, 150);
      await shot(`long-2-swipe-${i}-moving`);
      await look(`long-2-swipe-${i}`);
    }
    // [a word on the line, what kind of line, how far down the page it is when tapped]
    const targets = [
      ['platform 4', 'paragraph-low', 600],
      ['dining car', 'paragraph-middle', 330],
      ['Rain jacket', 'task', 560],
      ['Croissant', 'table', 420],
      ['greet', 'code', 620],
      ['remembered', 'quote', 250],
      ['Took the ferry', 'numbered', 560], // (lower, Safari's toolbar is over the page)
      ['Day three', 'heading', 300],
      ['the last ferry', 'quote-low', 680],
    ];
    for (const [text, name, y] of targets) {
      await putKeyboardAway();
      const w = await word(text, { placeAt: y });
      const lineOf = `${MIRROR} const v = ta.value, i = v.indexOf(arguments[0]); const a = v.lastIndexOf('\\n', i - 1) + 1; let b = v.indexOf('\\n', i); if (b < 0) b = v.length;`;
      const before = await run(`${lineOf} return v.slice(a, b)`, text);
      // The tapped line's bottom (the line may wrap on past the word: it's the line that must stay above the keyboard).
      const lineBottom = await run(`${lineOf} return boxOf(a, b).bottom`, text);
      const fr = await frames(`long-tap-${name}`, () => touch(w.x, w.y));
      const opened = await look(`long-3-${name}`);
      // A line the keyboard doesn't cover isn't nudged up (#214).
      const keyboardTop = opened.visible[1] - opened.visible[0];
      if (Math.max(w.bottom, lineBottom) < keyboardTop - 16 && fr.at(-1).scrollTop !== fr[0].scrollTop) {
        console.log(`  ✗ the note scrolled ${fr.at(-1).scrollTop - fr[0].scrollTop}px for a line above the keyboard (bottom ${Math.round(Math.max(w.bottom, lineBottom))}, keyboard at ${keyboardTop})`);
        process.exitCode = 1;
      }
      await type('x');
      await look(`long-4-${name}-typed`);
      // The x went into the line tapped (its line is the same, plus an x).
      const after = await run('return document.getElementById("editor").cursorLine()');
      if (![...after].some((ch, i) => ch === 'x' && after.slice(0, i) + after.slice(i + 1) === before)) {
        console.log(`  ✗ typed into another line: ${JSON.stringify(after)}`);
        process.exitCode = 1;
      }
    }
  },

  // Editing first, Preview on demand (#302): a note opens in the editor; Preview in the bar shows
  // the page (native scrolling, a real table); switching keeps your place, to 2 px, both ways,
  // all through a long note, with nothing moving on the way; a tap on a word low on the page
  // edits there: the cursor on that word, the keyboard open, the word in sight.
  async reading() {
    const PROBE = `
      const view = () => (document.getElementById('reading').hidden ? 'edit' : 'preview');
      const top = (m) => {
        if (view() === 'edit') { const e = document.getElementById('editor'); return e.screenTop(e.noteText().indexOf(m)); }
        const r = document.getElementById('reading');
        const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf(m);
          if (i < 0) continue;
          const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 1);
          return range.getClientRects()[0].top - r.getBoundingClientRect().top;
        }
        return null;
      };
      const place = (m, y) => {
        const el = view() === 'edit' ? document.querySelector('#editor textarea') : document.getElementById('reading');
        for (let i = 0; i < 6; i++) { const t = top(m); if (t == null || Math.abs(t - y) < 0.5) break; el.scrollTop += t - y; }
        return top(m);
      };`;
    await toNotes();
    await noteWith('# Packing\n\nA paragraph.\n\n- [ ] Rain jacket\n- [x] Socks\n\n| Key | Action |\n|---|---|\n| j/k or arrows | Move through the chat list |\n| Enter | Open the selected chat |\n\nSee https://example.org/docs for the rest.');
    const opened = await run('return { editor: !document.getElementById("editor").hidden, preview: !document.getElementById("note-preview").hidden }');
    if (!opened.editor || !opened.preview) { console.log(`  ✗ a note should open in the editor, Preview in the bar: ${JSON.stringify(opened)}`); process.exitCode = 1; }
    await tap('#note-preview');
    await wait(800);
    const page = await run('const r = document.getElementById("reading"); return { hidden: r.hidden, editorHidden: document.getElementById("editor").hidden, rows: r.querySelectorAll("table tr").length, button: document.getElementById("note-preview").title }'); // (its title: Appium's tap puts the aria-label it found it by back over the app's)
    if (page.hidden || !page.editorHidden || page.rows !== 3 || page.button !== 'Edit') { console.log(`  ✗ Preview: ${JSON.stringify(page)}`); process.exitCode = 1; }
    await look('reading-1-preview', 'Preview');
    await tap('#note-preview');
    await wait(800);
    await look('reading-2-editor-again', 'Preview again: the editor');

    // A long note: places kept, both ways.
    await toNotes();
    const parts = ['# Long read'];
    for (let i = 1; i <= 90; i++) {
      if (i % 15 === 1) parts.push(`## Section ${i}`);
      const words = 'words that wrap across the line on a phone, '.repeat(1 + (i % 4)).trim();
      if (i % 20 === 7) parts.push(`- [ ] Q${i}x a task with ${words}\n- a plain item`);
      else if (i % 25 === 12) parts.push(`| Q${i}x | b |\n|---|---|\n| c | d |`);
      else parts.push(`Q${i}x ${words}`);
    }
    await noteWith(parts.join('\n\n'));
    const misses = [];
    for (const m of ['Q16x', 'Q33x', 'Q47x', 'Q62x', 'Q78x', 'Q12x']) {
      for (const dir of ['editor → page', 'page → editor']) {
        const before = await run(`${PROBE} return place(arguments[0], -4);`, m);
        await tap('#note-preview');
        await wait(600);
        const after = await run(`${PROBE} return top(arguments[0]);`, m);
        // (Into the editor, Edit focuses it and the keyboard opens (#538): iOS brings the cursor's
        // line, the one at the top, wholly into view, so a line a few px above the top comes down
        // by as much, within a line's height. The other way, to 2 px.)
        const ok = dir === 'page → editor' ? after != null && after >= -2 && after - before <= 24 : after != null && Math.abs(after - before) <= 2;
        if (!ok) misses.push(`${m} ${dir}: ${before?.toFixed(1)} → ${after?.toFixed(1)}`);
      }
    }
    for (const m of misses) console.log(`  ✗ ${m}`);
    if (misses.length) process.exitCode = 1;
    else console.log('  places kept: 12 switches, each within 2 px');
    // Plain paragraphs the same size in both (#306): from a paragraph's first character to its last, as tall.
    const SPAN = `
      const e = document.getElementById('editor'), text = e.noteText(), page = document.getElementById('reading'), m = arguments[0];
      const start = text.indexOf(m), end = text.indexOf('\\n', start) - 1;
      if (page.hidden) return e.screenTop(end) - e.screenTop(start);
      const node = [...page.querySelectorAll('p')].find((p) => p.textContent.startsWith(m)).firstChild;
      const at = (i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); return r.getClientRects()[0].top; };
      return at(node.length - 1) - at(0);`;
    const sizes = [];
    for (const m of ['Q33x', 'Q35x', 'Q50x']) {
      await run(`${PROBE} place(arguments[0], 60);`, m);
      const inEditor = await run(SPAN, m);
      await tap('#note-preview');
      await wait(600);
      await run(`${PROBE} place(arguments[0], 60);`, m);
      const onPage = await run(SPAN, m);
      await tap('#note-preview');
      await wait(600);
      sizes.push(`${m} ${inEditor.toFixed(1)}/${onPage.toFixed(1)}`);
      if (inEditor < 20 || Math.abs(inEditor - onPage) > 2) { console.log(`  ✗ ${m}: ${inEditor.toFixed(1)} px tall in the editor, ${onPage.toFixed(1)} on the page`); process.exitCode = 1; }
    }
    console.log(`  paragraph heights, editor/page: ${sizes.join(', ')}`);
    await look('reading-3-long-editor', 'a long note, back in the editor');

    // A tap on a word low on the page stays on the page, no keyboard (#538); the bar's Edit: the
    // editor, the keyboard up, the cursor where you were reading, in sight above the keyboard.
    await tap('#note-preview');
    await wait(800);
    await run(`${PROBE} place('Q71x', 420);`);
    const target = await run(`
      const r = document.getElementById('reading'), box = r.getBoundingClientRect();
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf('Q71x');
        if (i < 0) continue;
        const range = document.createRange(); range.setStart(n, i + 3); range.setEnd(n, i + 4);
        const b = range.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2, inView: b.top > box.top && b.bottom < box.bottom };
      }
      return null;
    `);
    if (!target?.inView) { console.log(`  ✗ Q71x should be on screen to tap: ${JSON.stringify(target)}`); process.exitCode = 1; }
    else {
      await touch(target.x, target.y);
      await wait(800);
      const stayed = await run('return { page: !document.getElementById("reading").hidden, keyboard: document.documentElement.hasAttribute("data-keyboard"), button: document.getElementById("note-preview").title }'); // (its title, as above: not the aria-label Appium's tap rewrites)
      console.log(`  tapped the x of Q71x → ${JSON.stringify(stayed)}`);
      if (!stayed.page || stayed.keyboard || stayed.button !== 'Edit') { console.log('  ✗ a tap on a word: still the page, no keyboard, the bar offering Edit'); process.exitCode = 1; }
      await look('reading-4-tap-word', 'a tap on a word: still the page');
      // (A touch at the button, as a finger: WebDriver's element tap takes a second to land, and the
      // keyboard's settling is timed from the action.)
      await frames('reading-edit', () => tapBox('const r = document.getElementById("note-preview").getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };'), 2000, { print: false });
      const after = await run(`${MIRROR}
        const head = ta.selectionEnd, c = boxOf(head), box = ta.getBoundingClientRect();
        return { line: ta.value.slice(ta.value.lastIndexOf('\\n', head - 1) + 1, ta.value.indexOf('\\n', head)).slice(0, 30), cursorY: Math.round(c.top), box: [Math.round(box.top), Math.round(box.bottom)], keyboard: document.documentElement.hasAttribute('data-keyboard'), focused: document.activeElement === ta };
      `);
      console.log(`  Edit → ${JSON.stringify(after)}`);
      if (!after.focused || !after.keyboard || after.cursorY < after.box[0] || after.cursorY > after.box[1]) {
        console.log('  ✗ Edit: the editor focused, the keyboard open, the cursor in sight');
        process.exitCode = 1;
      }
      await look('reading-5-edit', 'Edit: the editor, the keyboard open, where you were reading');
    }
  },

  // Selecting text with a finger: a long press, a press and drag, a double tap, a selection's handle.
  async select() {
    await toNotes();
    await noteWith(SAMPLE);
    const report = async (name) => {
      await wait(800);
      await shot(name);
      console.log(`\n${name}:`, JSON.stringify(await selection()));
    };

    /** The cursor put at a word (or the note's end), without focusing: where it was left. */
    const cursorAt = (text) => run(`
      const ta = document.querySelector('#editor textarea');
      const at = arguments[0] == null ? ta.value.length : ta.value.indexOf(arguments[0]);
      ta.setSelectionRange(at, at);
    `, text ?? null);
    /** The selection's end handle: just under where the selection ends. */
    const endHandle = () => run(`${MIRROR}
      const c = boxOf(ta.selectionEnd);
      return { x: c.left, y: c.bottom + 6 };
    `);
    /** The end handle dragged to just after a word: the finger as far under it as it held the handle. */
    const dragHandle = async (to) => {
      const h = await endHandle();
      await finger(['down', h.x, h.y], ['wait', 150], ['move', to.right - 1, to.bottom + 6, 700], ['wait', 150], ['up']);
    };

    // A long press on a word, the keyboard away (and the cursor left near it): the word selected.
    await cursorAt('Getting there');
    await putKeyboardAway();
    let a = await word('overnight', { placeAt: 300 });
    const remembered = () => run('return Number(localStorage.getItem("tiro-keyboard")) || 0');
    const keyboardBefore = await remembered();
    const pressed = await frames('select-long-press-near', () => longPress(a.x, a.y));
    await report('select-1-long-press');
    // The word pressed is the one selected, and the text stayed put meanwhile (#215): no room made
    // for a keyboard that doesn't come, its height kept; and no marks shown in the selection (#216).
    const selected = await selection();
    const problems = [
      selected.editor !== 'overnight' && `selected ${JSON.stringify(selected.editor)}, not "overnight"`,
      // (iOS may bring the keyboard up once the word's selected: the page following it is right. Not
      // before, for a keyboard that isn't there, and the text never moves.)
      pressed.some((f) => (f.body !== pressed[0].body && f.vvHeight === pressed[0].vvHeight) || f.scrollTop !== pressed[0].scrollTop || f.text !== pressed[0].text)
        && 'the page or the note moved under the long press',
      (await remembered()) !== keyboardBefore && `the keyboard's height went from ${keyboardBefore} to ${await remembered()}`,
    ].filter(Boolean);
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (problems.length) process.exitCode = 1;
    const fail = (p) => { console.log(`  ✗ ${p}`); process.exitCode = 1; };
    // Its end handle dragged: to the end of the line, onto the next line, over a link. The selection
    // goes with it: the long press's word isn't kept against a handle (#196). (Along the line, to
    // the word. A drag down the lines, in the simulator, ends a line or so above the finger, with
    // Plim's changes or without: only checked not to be the word again.)
    const dragged = async (to, name) => {
      await dragHandle(await word(to));
      await report(name);
      return (await selection()).editor;
    };
    const along = await dragged('from', 'select-2-handle-same-line');
    if (along !== 'overnight train** leaves at *21:40* from') fail(`the handle dragged to "from" selected ${JSON.stringify(along)}`);
    for (const [to, name] of [['Bring', 'select-3-handle-next-line'], ["operator's", 'select-4-handle-over-link']]) {
      const got = await dragged(to, name);
      if (!got.startsWith('overnight') || got === 'overnight') fail(`the handle dragged towards "${to}" left ${JSON.stringify(got)}`);
    }
    await type('REPLACED');
    await report('select-5-typed-over');

    // The same, with the cursor left at the note's end, far from the word.
    await cursorAt(null);
    await putKeyboardAway();
    a = await word('museum', { placeAt: 300 });
    await frames('select-long-press-far', () => longPress(a.x, a.y));
    await report('select-6-long-press-far');

    // With the keyboard open: a double tap on a word, and a press and drag over a few words.
    a = await word('really long', { placeAt: 250 });
    await touch(a.x, a.y);
    await wait(1200);
    await finger(['down', a.x, a.y], ['wait', 40], ['up'], ['wait', 80], ['down', a.x, a.y], ['wait', 40], ['up']);
    await report('select-7-double-tap');
    a = await word('Rain all');
    const b = await word('wrote this');
    await finger(['down', a.x, a.y], ['wait', 900], ['move', b.right - 2, b.y, 800], ['up']);
    await report('select-8-press-and-drag');

    // A long press on a word low on the screen, where the keyboard comes up: the keyboard opens
    // as the finger lifts and the text goes up, and iOS took the selection on to wherever the
    // finger then was, a line or a page further (#196). Only the word is selected. Then ten more,
    // high and low on the screen.
    const pressOn = async (w, at, name) => {
      await run('document.activeElement.blur()');
      await wait(1200);
      const p = await word(w, { placeAt: at });
      await longPress(p.x, p.y);
      await wait(1000);
      if (name) await report(name);
      const got = (await selection()).editor;
      if (got !== w) fail(`a long press on "${w}" (${at}px down) selected ${JSON.stringify(got.length > 80 ? got.slice(0, 80) + '…' : got)}`);
    };
    await pressOn('thoughts', 390, 'select-9-long-press-low');
    const ten = ['morning', 'café', 'mostly', 'paragraph', 'formatting', 'structure', 'prose', 'middle', 'accident', 'wrote'];
    for (const [i, w] of ten.entries()) await pressOn(w, i % 2 ? 390 : 250);
    // A long press inside what's selected selects nothing new, and doesn't take it further.
    {
      await run(`
        const ta = document.querySelector('#editor textarea');
        const from = ta.value.indexOf('thoughts');
        ta.setSelectionRange(from, from + 'thoughts down and not worrying'.length);
      `);
      await wait(500);
      const q = await word('worrying');
      await longPress(q.x, q.y);
      await wait(1000);
      await report('select-10-long-press-in-a-selection');
      const got = (await selection()).editor;
      if (got.length > 'thoughts down and not worrying'.length) fail(`a long press inside a selection took it on to ${JSON.stringify(got.slice(0, 80))}`);
    }
  },

  // Your own share link, opened in the same Safari tab (#235): Safari keeps the app's page for Back,
  // frozen. The shared note's page shows the note, and the app comes back: nothing waits on the
  // app's local stores (a transaction the frozen page left open held them, and both showed nothing).
  async own() {
    await toNotes();
    await noteWith('Own link check\nA second line.');
    { const l = await lineBox(2); await touch(l.right - 2, l.y); }
    await wait(1000);
    await type(' Typed just before sharing.');
    await putKeyboardAway();
    await tap('#note-more');
    await shown('#note-menu');
    await tap('#note-menu-share');
    await until('return document.getElementById("share-dialog").open', 'Share');
    await click('#share-create');
    await until('return !document.getElementById("share-on").hidden', 'links', 20000);
    const link = await run('return document.getElementById("share-edit-link").value');
    await wd('POST', s('/url'), { url: link });
    await wait(6000);
    const shared = await run('return { text: document.getElementById("editor").noteText(), live: document.documentElement.dataset.live ?? null }');
    const stores = await idbProbe();
    await capture('own-1-shared-page');
    await wd('POST', s('/url'), { url: PLIM_URL });
    await wait(6000);
    const app = await run('return [...document.querySelectorAll(".view")].find((v) => !v.hidden)?.id ?? null');
    await capture('own-2-app-again');
    console.log('\nown link:', JSON.stringify({ shared, stores, app }));
    const problems = [
      !shared.text.includes('Typed just before sharing') && `the shared note's page shows ${JSON.stringify(shared.text.slice(0, 40))}`,
      shared.live !== 'on' && 'the shared note isn\'t live',
      Object.values(stores).some((v) => !v.startsWith('ok')) && `local stores: ${JSON.stringify(stores)}`,
      !app && 'the app shows nothing',
    ].filter(Boolean);
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (problems.length) process.exitCode = 1;
  },
};

// ---------- iPad (DEVICE=ipad, #332) ----------
// The note in CodeMirror (editor.js, with editor-ios.js on touch), the sidebar beside it, Edit /
// Split / Preview in the bar: the computer's app, on a touch screen with an on-screen keyboard.

const CM = `const view = document.querySelector('#editor .cm-content').cmTile.view;`;
/** Where things are (look()'s fields), the cursor CodeMirror's. */
const cmLayout = () => run(`
  ${CM}
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
  const vv = visualViewport;
  const c = view.hasFocus ? view.coordsAtPos(view.state.selection.main.head) : null;
  return {
    window: innerHeight, visible: [Math.round(vv.offsetTop), Math.round(vv.offsetTop + vv.height)], pageScroll: Math.round(scrollY),
    keyboard: 'keyboard' in document.documentElement.dataset, focused: view.hasFocus,
    head: r(document.querySelector('.editor-head')), cursor: c && [Math.round(c.top), Math.round(c.bottom)],
    card: r(document.querySelector('#editor .md-linkcard')), menu: r(document.querySelector('#editor .slash-menu:not([hidden])')),
  };
`);
const fail = (p) => { console.log(`  ✗ ${p}`); process.exitCode = 1; };
const noteText = () => run('return document.getElementById("editor").noteText()');
/** A new note with `text` (put in as a paste would be), the cursor at its end, the keyboard up (a tap at its end). */
async function cmNote(text) {
  // (Until it's open: a tap just as the list is drawn — right after the vault is made — can miss; then again, as you would.)
  const count = () => run('return document.querySelectorAll("#note-list li[data-id]").length');
  const before = await count();
  for (let tries = 0; ; tries++) {
    await tap(NEW_NOTE);
    const opened = await until('return document.querySelectorAll("#note-list li[data-id]").length > arguments[0] && /^\\d{4}-/.test(document.getElementById("editor").noteText())', 'a new note', 5000, before).then(() => true, () => false);
    if (opened) break;
    if (tries) throw new Error('New note: no new note');
  }
  await wait(700);
  await run(`${CM} view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: arguments[0] }, selection: { anchor: arguments[0].length } })`, text);
  await wait(500);
}
/** A tap on the middle of the box `js` returns (a script giving { left, right, top, bottom }), with a real finger. */
async function tapBox(js, ...args) {
  const b = await run(js, ...args);
  if (!b) throw new Error(`nothing to tap: ${js.slice(0, 80)}`);
  await touch((b.left + b.right) / 2, (b.top + b.bottom) / 2);
}
const optionBox = (n) => `const r = document.querySelector('#editor .slash-option:nth-child(${n})')?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom };`;
const menuShown = () => run(`const m = document.querySelector('#editor .slash-menu'); return m && !m.hidden ? { label: m.getAttribute('aria-label'), options: [...m.querySelectorAll('.slash-label')].map((e) => e.textContent) } : null`);
const today = ((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());

const IPAD_FLOWS = {
  // A new note: the keyboard up, the cursor in sight under the bar; typing, Return in a list.
  async editor() {
    await toNotes();
    await tap(NEW_NOTE);
    await wait(1500);
    const l = await look('ipad-editor-1-new-note', 'New note', cmLayout);
    if (!l.focused || !l.keyboard) fail(`a new note should have the keyboard up and the focus: ${JSON.stringify(l)}`);
    if (!/^\d{4}-\d\d-\d\d \d{1,2}:\d\d [AP]M\n\n$/.test(await noteText())) fail(`a new note starts dated (#313): ${JSON.stringify(await noteText())}`);
    await type('Shopping');
    await nativeKey('Return');
    await type('- milk');
    await nativeKey('Return');
    await wait(400);
    await type('eggs');
    await wait(500);
    const lines = (await noteText()).split('\n').slice(-3);
    console.log('\ntyped a list:', JSON.stringify(lines));
    if (lines.join('|') !== 'Shopping|- milk|- eggs') fail(`Return in a list should start the next item: ${JSON.stringify(lines)}`);
    await look('ipad-editor-2-list', 'type a list, Return between items', cmLayout);
    await nativeKey('Return');
    await wait(300);
    await nativeKey('Return');
    await wait(500);
    const end = (await noteText()).split('\n').slice(-2);
    if (end.join('|') !== '- eggs|') fail(`Return on an empty item ends the list: ${JSON.stringify(end)}`);
  },

  // The / menu with the on-screen keyboard: a tap picks, the keyboard stays up. (A `#` in the text
  // offers nothing since #584: tags are the note header's, its picker.)
  async menus() {
    await toNotes();
    await cmNote('Plan ');
    await tapBox(`${CM} const c = view.coordsAtPos(view.state.doc.length); return c && { left: c.left - 2, right: c.left + 2, top: c.top, bottom: c.bottom };`);
    await wait(1200);
    await type('/');
    await wait(700);
    let m = await menuShown();
    if (m?.options.join() !== 'Today,Now,Yesterday,Date and time') fail(`a / should offer the menu: ${JSON.stringify(m)}`);
    await look('ipad-menus-1-slash', 'type /', cmLayout);
    await tapBox(optionBox(1));
    await wait(800);
    let l = await cmLayout();
    if (!(await noteText()).endsWith(`Plan ${today}`) || !l.focused || !l.keyboard || l.menu) fail(`Today tapped: ${JSON.stringify({ tail: (await noteText()).slice(-20), ...l })}`);
    await type(' #l');
    await wait(700);
    if (await menuShown()) fail('#l in the text should offer nothing (#584: tags are the header\'s)');
  },

  // Edit / Preview from the bar: the line at the top stays at the top; Split in landscape, the two
  // sides in step as the editor scrolls.
  async views() {
    await toNotes();
    await cmNote(SAMPLE);
    await run('document.activeElement.blur()');
    await wait(800);
    const topLine = () => run(`
      if (!document.getElementById('reading').hidden && document.getElementById('editor').hidden) {
        const r = document.getElementById('reading'), b = r.getBoundingClientRect();
        // (The innermost blocks: a list's item, not the list around it.)
        const el = [...r.querySelectorAll('[data-from]')].filter((e) => !e.querySelector('[data-from]')).find((e) => e.getBoundingClientRect().bottom > b.top + 4);
        return el && Number(el.dataset.from);
      }
      ${CM} return view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4).from;
    `);
    await run(`${CM} view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight / 2`);
    await wait(600);
    const before = await topLine();
    await tap('#note-mode [data-mode="preview"]');
    await wait(1000);
    const after = await topLine();
    const text = await noteText();
    const lineOf = (pos) => text.slice(0, pos).split('\n').length;
    console.log('\nEdit → Preview, the line at the top:', lineOf(before), '→', lineOf(after));
    if (Math.abs(lineOf(before) - lineOf(after)) > 3) fail(`Preview should keep your place: line ${lineOf(before)} → ${lineOf(after)}`);
    await look('ipad-views-1-preview', 'Preview', cmLayout);
    await tap('#note-mode [data-mode="edit"]');
    await wait(1200);
    // (A view chosen in the bar isn't a tap in the text: no keyboard over half the screen.)
    if ((await cmLayout()).keyboard) fail('Edit chosen in the bar should not bring up the keyboard');
    // Landscape: wide enough for Split.
    await wd('POST', s('/orientation'), { orientation: 'LANDSCAPE' });
    await wait(2500);
    const split = await run('return { width: innerWidth, enabled: !document.querySelector(\'#note-mode [data-mode="split"]\').disabled, shown: document.querySelector(\'#note-mode [data-mode="split"]\').getClientRects().length > 0 }');
    console.log('landscape:', JSON.stringify(split));
    if (split.shown) {
      await tap('#note-mode [data-mode="split"]');
      await wait(1200);
      if ((await cmLayout()).keyboard) fail('Split chosen in the bar should not bring up the keyboard');
      const both = await run('return !document.getElementById("editor").hidden && !document.getElementById("reading").hidden');
      if (!both) fail('Split should show the editor and the page');
      // The editor scrolled with a finger: the page follows (the same block at both tops, about).
      const ed = await run(`${CM} const b = view.scrollDOM.getBoundingClientRect(); return { x: (b.left + b.right) / 2, top: b.top, bottom: b.bottom }`);
      await swipe(ed.x, ed.bottom - 80, ed.top + 120, 350);
      await wait(1500);
      const tops = await run(`
        ${CM} const ed = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4).from;
        const r = document.getElementById('reading'), b = r.getBoundingClientRect();
        const el = [...r.querySelectorAll('[data-from]')].filter((e) => !e.querySelector('[data-from]')).find((e) => e.getBoundingClientRect().bottom > b.top + 4);
        return { editor: ed, page: el && Number(el.dataset.from) };`);
      console.log('Split after a swipe, the tops:', lineOf(tops.editor), lineOf(tops.page));
      if (tops.page == null || Math.abs(lineOf(tops.editor) - lineOf(tops.page)) > 6) fail(`Split: the page should follow the editor: ${JSON.stringify(tops)}`);
      await look('ipad-views-2-split', 'Split, in landscape, after a swipe', cmLayout);
      await tap('#note-mode [data-mode="edit"]');
      await wait(800);
    } else fail(`Split should be there in landscape: ${JSON.stringify(split)}`);
    await wd('POST', s('/orientation'), { orientation: 'PORTRAIT' });
    await wait(2000);
  },

  // A long press on a word selects it (iOS's selection, the editor's too).
  async select() {
    await toNotes();
    await cmNote('Selecting\n\nA sentence with a particular word in it.');
    await run('document.activeElement.blur()');
    await wait(800);
    const b = await run(`${CM} const at = view.state.doc.toString().indexOf('particular'); const a = view.coordsAtPos(at), z = view.coordsAtPos(at + 10); return { x: (a.left + z.left) / 2, y: (a.top + a.bottom) / 2 }`);
    await longPress(b.x, b.y, 900);
    await wait(1200);
    const sel = await run(`${CM} const m = view.state.selection.main; return { editor: view.state.sliceDoc(m.from, m.to), page: String(getSelection()) }`);
    console.log('\nlong press on "particular":', JSON.stringify(sel));
    if (sel.editor !== 'particular' && sel.page !== 'particular') fail(`a long press should select the word: ${JSON.stringify(sel)}`);
    await look('ipad-select-1-word', 'long-press a word', cmLayout);
  },

  // History (#340): versions beside the chosen one, as on a computer; a tap shows one, Restore in reach.
  // (The server keeps a version every 2 s for this: PLIM_VERSION_EVERY_SECS=2.)
  async history() {
    await toNotes();
    // (A new note's first version comes an interval after it's made, with the next edit: LX
    // Factory's. Tram 28 then has a version of its own, whatever the timing.)
    await cmNote('Trip\n\n- Belém Tower');
    await wait(2500);
    await run(`${CM} view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n- LX Factory' } })`);
    await wait(2500);
    await run(`${CM} view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n- Tram 28' } })`);
    await wait(2500);
    await run(`${CM} const d = view.state.doc.toString(); const at = d.indexOf('- LX Factory\\n'); view.dispatch({ changes: { from: at, to: at + 13 } })`);
    await wait(2500);
    await run('document.activeElement.blur()');
    await wait(800);
    await tap('#note-history');
    await until('return document.getElementById("history-dialog").open && document.querySelectorAll("#history-list button").length >= 3', 'History');
    await until('return [...document.querySelectorAll("#history-list button")].every((b) => b.dataset.done || b.dataset.id === "now")', 'what each changed');
    const rows = await run('return [...document.querySelectorAll("#history-list .history-what")].map((e) => e.textContent)');
    console.log('\nHistory rows:', JSON.stringify(rows));
    if (!rows.includes('Removed “LX Factory”') || !rows.includes('Added “Tram 28”')) fail(`History's rows should say what changed: ${JSON.stringify(rows)}`);
    await tap('#history-list button[data-id]:not([data-id="now"])');
    await until('return !document.getElementById("history-copy").disabled', 'a version');
    const view = await run(`const r = document.getElementById("history-restore").getBoundingClientRect(), l = document.querySelector(".history-versions").getBoundingClientRect();
      return { side: l.width > 0 && !document.getElementById("history-dialog").classList.contains("previewing"), restore: !document.getElementById("history-restore").hidden && r.bottom <= innerHeight,
        struck: getComputedStyle(document.querySelector("#history-diff del") ?? document.body).textDecorationLine }`);
    console.log('History on an iPad:', JSON.stringify(view));
    if (!view.side || !view.restore || view.struck !== 'line-through') fail(`History on an iPad: ${JSON.stringify(view)}`);
    if ((await cmLayout()).keyboard) fail('History should not bring up the keyboard');
    await look('ipad-history-1-version', 'History, a version', cmLayout);
    await run('document.getElementById("history-dialog").close()');
  },
};
IPAD_FLOWS.trash = async () => {
  // Recently deleted (#190): the list in the sidebar, the newest deleted note beside it as a page,
  // Restore and Delete forever in its bar; no keyboard.
  await toNotes();
  await cmNote('Deleted on an iPad\n\nA line to read before restoring it.');
  await run('document.activeElement.blur()');
  await wait(600);
  await tap('#note-more');
  await shown('#note-menu');
  await tap('#note-menu-delete');
  await wait(800);
  await run('document.getElementById("toast").hidden = true');
  await tap('#btn-trash');
  await until('return !document.getElementById("trash-view").hidden && document.getElementById("trash-page").textContent.includes("A line to read")', 'the newest deleted note, shown');
  const view = await run(`const side = document.querySelector(".sidebar").getBoundingClientRect(), r = document.getElementById("trash-restore").getBoundingClientRect();
    return { side: side.width > 0, restore: r.width > 0 && r.top < innerHeight / 3, title: document.getElementById("note-title").textContent }`);
  console.log('\nRecently deleted on an iPad:', JSON.stringify(view));
  if (!view.side || !view.restore || view.title !== 'Deleted on an iPad') fail(`Recently deleted on an iPad: ${JSON.stringify(view)}`);
  if ((await cmLayout()).keyboard) fail('Recently deleted should not bring up the keyboard');
  await look('ipad-trash-1-note', 'Recently deleted', cmLayout);
  await tap('#trash-restore');
  await until('return document.getElementById("toast-text").textContent === "Restored “Deleted on an iPad”"', 'Restore');
  await tap('#tag-clear');
  await until('return !document.getElementById("view-notes").classList.contains("trash-mode")', 'All notes');
};
IPAD_FLOWS.sort = async () => {
  await toNotes();
  await sortFlow('ipad-', cmLayout);
};
const IPAD_TITLES = { editor: 'Typing on an iPad', menus: 'Menus on an iPad', views: 'Edit, Preview and Split on an iPad', select: 'Selecting on an iPad', history: 'History on an iPad', trash: 'Recently deleted on an iPad', sort: 'Sorting the notes on an iPad' };

// The flows' titles on the map.
const TITLES = {
  tour: 'Around the app', keyboard: 'The keyboard in the editor', tap: 'Tapping into a note',
  long: 'A long note', select: 'Selecting text', own: 'Your own share link', typing: 'Typing markdown on the keyboard',
  lines: 'Line after line', dialog: 'Typing in a dialog', enter: 'Return in a list',
  reading: 'Preview, and keeping your place', slash: 'Type / for a menu', tags: 'The tag picker', trash: 'Recently deleted', sort: 'Sorting the notes', rowtags: 'Tags on a note’s row', search: 'Searching notes',
};

mkdirSync(OUT, { recursive: true });
const only = process.env.ONLY?.split(',');
if (!only) clearProfile(PROFILE);
try {
  for (const [name, flow] of Object.entries(IPAD ? IPAD_FLOWS : FLOWS)) {
    if (only && !only.includes(name)) continue;
    flowNow = name;
    await flow();
  }
} finally {
  await wd('DELETE', s(''));
  // (The screens taken, even if a check failed partway; a run of some flows keeps the others'.)
  writeProfile({ profile: PROFILE, label: IPAD ? 'iPad Safari' : 'iOS Safari', flows: IPAD ? IPAD_TITLES : TITLES, screens, partial: Boolean(only) });
  writeMap();
}
