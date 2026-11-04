// Real Safari on a Mac (#332): safaridriver on a Mac, a WebDriver session, driving the
// app as a computer has it — CodeMirror, the sidebar, Edit / Split / Preview — in WebKit, which
// web.mjs's Chromium can't stand in for. Prints what it checks; exit code 1 if a check fails.
//
//   (Mac, once, by hand)  sudo safaridriver --enable
//   (Mac)   safaridriver -p 4444
//   (here)  ssh -N -L 4444:127.0.0.1:4444 -R 3980:127.0.0.1:3980 <your Mac>
//   (here)  plim-server on 127.0.0.1:3980, then: node safari.mjs
//
// Safari has one WebDriver session at a time and no virtual passkey: the vault is made with its
// recovery phrase; "two people" are two windows of this one browser. Env: SAFARI (driver URL),
// PLIM_URL (page to open), OUT (screenshot directory), ONLY (flows to run).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearProfile, mapScreen, writeMap, writeProfile } from './map.mjs';

const SAFARI = process.env.SAFARI ?? 'http://127.0.0.1:4444';
const PLIM_URL = process.env.PLIM_URL ?? 'http://localhost:3980/';
const OUT = process.env.OUT ?? join(tmpdir(), 'plim-mac');
const SAMPLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'long-note.md'), 'utf8');
const DEVICE = 'Safari 18.6 on macOS 15 (VM)';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(SAFARI + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const { value } = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${value?.message ?? res.status}`);
  return value;
}

const { sessionId } = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
const s = (path) => `/session/${sessionId}${path}`;
const run = (script, ...args) => wd('POST', s('/execute/sync'), { script, args });
await wd('POST', s('/window/rect'), { x: 0, y: 0, width: 1280, height: 860 });

async function until(script, what, ms = 20_000, ...args) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
    if (await run(script, ...args).catch(() => false)) return;
  }
  throw new Error(`timed out: ${what}`);
}
const $ = async (css) => Object.values(await wd('POST', s('/element'), { using: 'css selector', value: css }))[0];
/** A real click on the element (WebDriver's: the mouse moves there and presses). */
const click = async (css) => wd('POST', s(`/element/${await $(css)}/click`), {});

// Keys, as a keyboard sends them (WebDriver's key codes for the ones that aren't characters).
const KEY = { Enter: '', Escape: '', Tab: '', ArrowDown: '', ArrowUp: '', Meta: '', Shift: '', End: '' };
async function press(...keys) {
  const down = keys.map((k) => ({ type: 'keyDown', value: KEY[k] ?? k }));
  const up = [...keys].reverse().map((k) => ({ type: 'keyUp', value: KEY[k] ?? k }));
  await wd('POST', s('/actions'), { actions: [{ type: 'key', id: 'keyboard', actions: [...down, ...up] }] });
  await wd('DELETE', s('/actions'));
}
/** Typed, a key at a time ("\n" is Enter). */
async function type(text) {
  const actions = [...text].flatMap((c) => {
    const v = c === '\n' ? KEY.Enter : c;
    return [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }, { type: 'pause', duration: 25 }];
  });
  await wd('POST', s('/actions'), { actions: [{ type: 'key', id: 'keyboard', actions }] });
}

/**
 * How coloured an element is drawn (its most saturated pixel, 0–1), from a screenshot of it: a
 * ticked box is drawn in the accent, an unticked one in greys.
 */
async function saturation(css) {
  const el = Object.values(await wd('POST', s('/element'), { using: 'css selector', value: css }))[0];
  const png = join(OUT, '.element.png');
  writeFileSync(png, Buffer.from(await wd('GET', s(`/element/${el}/screenshot`)), 'base64'));
  const out = spawnSync('magick', [png, '-colorspace', 'HSL', '-channel', 'G', '-separate', '+channel', '-format', '%[fx:maxima]', 'info:'], { encoding: 'utf8' }).stdout;
  return Number(out);
}

const CM = `const view = document.querySelector('#editor .cm-content').cmTile.view;`;
const noteText = () => run('return document.getElementById("editor").noteText()');
const fail = (p) => { console.log(`  ✗ ${p}`); process.exitCode = 1; };
const ok = (p) => console.log(`  ✓ ${p}`);
/** A check that fails today, for an issue filed: said, not failed (make it a check once the issue is fixed). */
const known = (issue, p) => console.log(`  ! ${issue}: ${p}`);
const today = ((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());

// ---------- the map ----------
let flowNow = null;
const screens = [];
async function capture(name, via) {
  const png = join(OUT, `${name}.png`);
  writeFileSync(png, Buffer.from(await wd('GET', s('/screenshot')), 'base64'));
  const rest = name.replace(/^[a-z]+-\d+-/, '').replace(/-/g, ' ');
  screens.push(mapScreen({ profile: 'mac', name, png, flow: flowNow, device: DEVICE, via, title: rest.charAt(0).toUpperCase() + rest.slice(1) }));
}

// ---------- getting there ----------

let WORDS = null; // (the vault's recovery phrase, to open it again in another window)
/**
 * Opened with the recovery phrase in a window that isn't signed in: locked (a passkey's device), or
 * the welcome screen (a vault opened with its phrase alone isn't kept on the device: each window
 * opens it with the phrase).
 */
async function unlock() {
  const views = '["view-locked", "view-welcome", "view-notes"]';
  await until(`return ${views}.some((v) => !document.getElementById(v).hidden)`, 'locked, welcome, or the notes').catch(async (e) => {
    throw new Error(`${e.message} (showing ${await run('return [...document.querySelectorAll(".view")].find((v) => !v.hidden)?.id + " at " + location.pathname')})`);
  });
  if (!(await run('return document.getElementById("view-notes").hidden'))) return;
  await click((await run('return !document.getElementById("view-locked").hidden')) ? '#unlock-use-phrase' : '#btn-restore');
  await until('return !document.getElementById("view-restore").hidden', 'the phrase');
  await run('document.getElementById("restore-input").value = arguments[0]; document.getElementById("restore-form").requestSubmit();', WORDS);
  // ("Add a passkey?": Not now — Safari's driver has no passkey to make.)
  await until('return !document.getElementById("view-passkey").hidden || !document.getElementById("view-notes").hidden', 'Add a passkey?, or the notes');
  if (await run('return !document.getElementById("view-passkey").hidden')) await click('#passkey-alt');
  await until('return !document.getElementById("view-notes").hidden', 'the notes, opened').catch(async (e) => {
    throw new Error(`${e.message} (words ${JSON.stringify(WORDS)}; ${await run('return [...document.querySelectorAll(".view")].find((v) => !v.hidden)?.id + ": " + document.getElementById("restore-error").textContent')})`);
  });
}
/** Signed in, at the notes (a new vault the first time: with its recovery phrase). */
async function toNotes() {
  await wd('POST', s('/url'), { url: PLIM_URL });
  await until('return document.readyState === "complete"', 'page load');
  await wait(800);
  if (WORDS && (await run('return !document.getElementById("view-locked").hidden'))) await unlock();
  if (await run('return !document.getElementById("btn-create").closest("[hidden]")')) {
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
      window.__words = words.map((w) => w.replace(/^\\d+\\.?\\s*/, '')).join(' ');
      for (const input of document.querySelectorAll('#confirm-fields input')) input.value = words[input.dataset.index];
      document.getElementById('confirm-form').requestSubmit();
    `);
    WORDS = await run('return window.__words');
  }
  await until('return document.getElementById("btn-new").getClientRects().length > 0', 'the notes');
}

/** A new note (New note clicked), its text replaced with `text` (as a paste), the cursor at its end. */
async function note(text) {
  const before = await run('return document.querySelectorAll("#note-list li[data-id]").length');
  await click('#btn-new');
  await until('return document.querySelectorAll("#note-list li[data-id]").length > arguments[0] && /^\\d{4}-/.test(document.getElementById("editor").noteText())', 'a new note', 10_000, before);
  if (text != null) await run(`${CM} view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: arguments[0] }, selection: { anchor: arguments[0].length } }); view.focus();`, text);
  await wait(300);
}
const setView = async (mode) => {
  await click(`#note-mode [data-mode="${mode}"]`);
  await until(`return document.getElementById('note-body').dataset.view === arguments[0]`, `the ${mode} view`, 5000, mode);
  await wait(400);
};
const menu = () => run(`const m = document.querySelector('#editor .slash-menu'); return m && !m.hidden ? { label: m.getAttribute('aria-label'), options: [...m.querySelectorAll('.slash-label')].map((e) => e.textContent), active: m.querySelector('[aria-selected=true] .slash-label')?.textContent } : null`);

// ---------- the flows ----------

const FLOWS = {
  // Typing in CodeMirror: a new note dated; Return in a list; undo and redo (Cmd+Z, Cmd+Shift+Z).
  async editor() {
    await toNotes();
    await note(null);
    const t = await noteText();
    if (!/^\d{4}-\d\d-\d\d \d{1,2}:\d\d [AP]M\n\n$/.test(t)) fail(`a new note starts dated: ${JSON.stringify(t)}`);
    if (!(await run(`${CM} return view.hasFocus`))) fail('a new note should have the focus');
    await type('Shopping\n- milk\neggs');
    await wait(400);
    let lines = (await noteText()).split('\n').slice(-3);
    if (lines.join('|') !== 'Shopping|- milk|- eggs') fail(`Return in a list: ${JSON.stringify(lines)}`); else ok('Return in a list continues it');
    await wait(700); // (a pause: what's typed next is its own undo step)
    await type(' and bread');
    await wait(300);
    await press('Meta', 'z');
    await wait(300);
    if (!(await noteText()).endsWith('- eggs')) fail(`Cmd+Z should take back " and bread": ${JSON.stringify((await noteText()).slice(-20))}`); else ok('Cmd+Z undoes the last typing');
    await press('Meta', 'Shift', 'z');
    await wait(300);
    if (!(await noteText()).endsWith('- eggs and bread')) fail(`Cmd+Shift+Z should redo it: ${JSON.stringify((await noteText()).slice(-20))}`); else ok('Cmd+Shift+Z redoes it');
    await capture('mac-editor-1-list', 'type a list');
  },

  // The / menu and the tag suggestions, with the keys: ↓ Enter, Tab, Escape.
  async menus() {
    await toNotes();
    await note('Strength\n#strength #stretching');
    await note('Plan ');
    await type('/');
    await wait(400);
    let m = await menu();
    if (m?.options.join() !== 'Today,Now,Yesterday,Date and time') fail(`/ should offer the menu: ${JSON.stringify(m)}`);
    await capture('mac-menus-1-slash', 'type /');
    await press('ArrowDown');
    await press('Enter');
    await wait(300);
    if (!/Plan \d{1,2}:\d\d [AP]M$/.test(await noteText())) fail(`↓ Enter should put in Now: ${JSON.stringify((await noteText()).slice(-20))}`); else ok('/ ↓ Enter puts in the time');
    await type(' /tod');
    await press('Tab');
    await wait(300);
    if (!(await noteText()).endsWith(` ${today}`)) fail(`/tod Tab: ${JSON.stringify((await noteText()).slice(-20))}`); else ok('/tod Tab puts in the date');
    await type(' #st');
    await wait(400);
    m = await menu();
    if (m?.label !== 'Tags' || m.options.join() !== '#strength,#stretching') fail(`#st should offer both tags: ${JSON.stringify(m)}`);
    await capture('mac-menus-2-tags', 'type #st');
    await press('ArrowDown');
    await press('Enter');
    await wait(300);
    if (!(await noteText()).endsWith(' #stretching ')) fail(`↓ Enter on the tags: ${JSON.stringify((await noteText()).slice(-20))}`); else ok('#st ↓ Enter puts in #stretching');
    await type('/');
    await wait(300);
    await press('Escape');
    await wait(300);
    if (await menu()) fail('Escape should close the menu'); else ok('Escape closes the menu');
  },

  // Preview: line breaks (#317), a task's box, a table; switching keeps your place.
  async preview() {
    await toNotes();
    await note('Trip\n\nFlights: Thu 08:40\nStay: Alfama\n\n- [ ] Book the tram\n\n| Day | Plan |\n|---|---|\n| Thu | Arrive |\n| Fri | Sintra |');
    await setView('preview');
    const page = await run(`
      const r = document.getElementById('reading');
      const top = (w) => { const t = document.createTreeWalker(r, NodeFilter.SHOW_TEXT); for (let n = t.nextNode(); n; n = t.nextNode()) { const i = n.data.indexOf(w); if (i >= 0) { const g = document.createRange(); g.setStart(n, i + 1); g.setEnd(n, i + 2); return Math.round(g.getBoundingClientRect().top); } } return null; };
      return { flights: top('Flights'), stay: top('Stay'), rows: r.querySelectorAll('table tr').length, box: Boolean(r.querySelector('input[type=checkbox]')) };`);
    if (!(page.stay > page.flights + 10)) fail(`Flights / Stay on two lines: ${JSON.stringify(page)}`); else ok('a line break is a line break');
    if (page.rows !== 3 || !page.box) fail(`a table and a task's box: ${JSON.stringify(page)}`); else ok('a table, a task box');
    await click('#reading input[type=checkbox]');
    await wait(500);
    if (!(await noteText()).includes('- [x] Book the tram')) fail("ticking the box should tick the task in the note"); else ok('a box ticked on the page ticks the task');
    await wait(500); // (the page drawn again)
    const ticked = await saturation('#reading input[type=checkbox]');
    if (ticked < 0.3) known('#335', `the ticked box isn't drawn (saturation ${ticked.toFixed(2)})`); else ok(`the ticked box is drawn (saturation ${ticked.toFixed(2)})`);
    await capture('mac-preview-1-page', 'Preview');
    // A long note, scrolled down; Preview, then Edit: the line at the top stays at the top.
    await setView('edit');
    await note(SAMPLE);
    const leaf = `[...r.querySelectorAll('[data-from]')].filter((e) => !e.querySelector('[data-from]')).find((e) => e.getBoundingClientRect().bottom > b.top + 4)`;
    const topLine = () => run(`
      if (document.getElementById('editor').hidden) { const r = document.getElementById('reading'), b = r.getBoundingClientRect(); const el = ${leaf}; return el && Number(el.dataset.from); }
      ${CM} return view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4).from;`);
    await run(`${CM} view.contentDOM.blur(); view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight / 2`);
    await wait(500);
    const text = await noteText();
    const lineOf = (pos) => text.slice(0, pos).split('\n').length;
    const before = await topLine();
    await setView('preview');
    const after = await topLine();
    console.log(`  (Edit → Preview, the line at the top: ${lineOf(before)} → ${lineOf(after)})`);
    if (Math.abs(lineOf(before) - lineOf(after)) > 3) fail(`Preview should keep your place: line ${lineOf(before)} → ${lineOf(after)}`); else ok('Edit → Preview keeps your place');
    await setView('edit');
  },

  // Split: the page follows the editor as it scrolls; typing, the cursor's block tinted.
  async split() {
    await toNotes();
    await note(SAMPLE);
    await setView('split');
    const tops = () => run(`
      ${CM} const ed = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4).from;
      const r = document.getElementById('reading'), b = r.getBoundingClientRect();
      const el = [...r.querySelectorAll('[data-from]')].filter((e) => !e.querySelector('[data-from]')).find((e) => e.getBoundingClientRect().bottom > b.top + 4);
      return { editor: ed, page: el && Number(el.dataset.from) };`);
    const text = await noteText();
    const lineOf = (pos) => text.slice(0, pos).split('\n').length;
    let worst = 0;
    for (let i = 1; i <= 6; i++) {
      await run(`${CM} view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight * arguments[0] / 8`, i);
      await wait(400);
      const t = await tops();
      worst = Math.max(worst, Math.abs(lineOf(t.editor) - lineOf(t.page ?? 0)));
    }
    if (worst > 3) fail(`Split: the page should follow the editor (lines apart, at worst: ${worst})`); else ok(`Split: the page follows the editor (at worst ${worst} lines apart)`);
    await capture('mac-split-1-scrolled', 'Split, scrolled');
    // Typing at a paragraph's end: the page's block tinted in every frame (#331).
    await run(`${CM} const at = view.state.doc.toString().indexOf('Rain all morning'); const end = view.state.doc.lineAt(at).to; view.dispatch({ selection: { anchor: end }, scrollIntoView: true }); view.focus();`);
    await wait(500);
    await run(`window.__tint = []; const tick = () => { window.__tint.push(Boolean(document.querySelector('#reading .cursor-block'))); if (window.__tint.length < 240) requestAnimationFrame(tick); }; requestAnimationFrame(tick);`);
    await type(' and the rain kept on all afternoon');
    await wait(500);
    const frames = await run('return window.__tint');
    const off = frames.filter((x) => !x).length;
    if (off) fail(`typing in Split: the block's tint went off in ${off} frames (#331)`); else ok('typing in Split: the block tinted in every frame');
  },

  // Two windows on one note: an edit in one shows in the other, live.
  async windows() {
    await toNotes();
    await note('Together\n\n- first');
    const first = await wd('GET', s('/window'));
    const id = await run('return document.querySelector("#note-list li > button[aria-current=true]")?.closest("li").dataset.id');
    // (Opened by the page, as a link opened in a new window is: WebDriver's own new windows don't share the page's storage.)
    const before = await wd('GET', s('/window/handles'));
    await run('window.open(arguments[0], "_blank", "popup,width=1000,height=760")', `${PLIM_URL}n/${id}`);
    await until('return true', 'a tick');
    const second = (await wd('GET', s('/window/handles'))).find((h) => !before.includes(h));
    if (!second) throw new Error('no second window');
    await wd('POST', s('/window'), { handle: second });
    await until('return document.readyState === "complete"', 'page load');
    await unlock();
    await until('return document.getElementById("editor")?.noteText?.().includes("first")', 'the note in the second window');
    await run(`${CM} view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n- from the second window' } })`);
    await wd('POST', s('/window'), { handle: first });
    await until('return document.getElementById("editor").noteText().includes("from the second window")', 'the edit in the first window').then(() => ok('an edit in one window shows in the other'), () => fail("an edit in the second window should show in the first"));
    await capture('mac-windows-1-live', 'an edit from the other window');
    await wd('POST', s('/window'), { handle: second });
    await wd('DELETE', s('/window'));
    await wd('POST', s('/window'), { handle: first });
  },
};
const TITLES = { editor: 'Typing in Safari', menus: 'Menus in Safari', preview: 'Preview in Safari', split: 'Split in Safari', windows: 'Two windows, one note' };

mkdirSync(OUT, { recursive: true });
const only = process.env.ONLY?.split(',');
if (!only) clearProfile('mac');
try {
  for (const [name, flow] of Object.entries(FLOWS)) {
    if (only && !only.includes(name)) continue;
    flowNow = name;
    console.log(`\n${name}`);
    try {
      await flow();
    } catch (e) {
      fail(`${name}: ${e.message}`);
    }
  }
} finally {
  await wd('DELETE', s('')).catch(() => {});
  writeProfile({ profile: 'mac', label: 'Mac Safari', flows: TITLES, screens, partial: Boolean(only) });
  writeMap();
}
