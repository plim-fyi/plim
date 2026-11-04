// Screenshots of the terminal client (`plim`), dark terminal theme.
//
//   cargo build --release -p plim-server -p plim-cli
//   cd tools/screenshots && npm ci && npm run tui
//
// Runs `plim` inside a detached tmux session against a throwaway server,
// types into it, captures each screen with its colours (tmux capture-pane -e),
// and renders it as a terminal window in Chromium for a PNG in
// docs/screenshots/tui/. Needs tmux and nvim (for the $EDITOR flow).
// Env: PLIM_BIN, PLIM_CLI (the plim binary), CHROME.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import puppeteer from 'puppeteer-core';
import { TestServer, cleanEnv, wait } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'docs/screenshots/tui');
const CLI = process.env.PLIM_CLI ?? join(ROOT, 'target/release/plim');
const CHROME = process.env.CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find(existsSync);
const PORT = 3969;
const COLS = 104;
const ROWS = 30;
const PASSPHRASE = 'correct horse battery';
const SOCKET = `plim-shots-${process.pid}`;

// ---------- tmux ----------

// (Without the runner's PLIM_/TIRO_ settings: the pane's shell inherits the tmux server's.)
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', env: cleanEnv() });
const keys = (...k) => tmux('send-keys', '-t', 'shot', ...k);
/** Type text; newlines are sent as Enter. */
function type(text) {
  text.split('\n').forEach((part, i) => {
    if (i) keys('Enter');
    if (part) tmux('send-keys', '-t', 'shot', '-l', '--', part);
  });
}
const screenText = () => tmux('capture-pane', '-p', '-t', 'shot');

async function until(check, what, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check(screenText())) return;
    await wait(150);
  }
  throw new Error(`timed out waiting for ${what}. Screen:\n${screenText()}`);
}
const waitFor = (text, timeout) => until((s) => s.includes(text), JSON.stringify(text), timeout);

/** Run a shell command line in the pane and wait for the next prompt. */
async function shell(line, { clear = false } = {}) {
  if (clear) {
    keys('C-l');
    await wait(200);
  }
  type(line);
  keys('Enter');
  await until((s) => s.trimEnd().endsWith('$'), 'the shell prompt');
}

// ---------- ANSI → HTML ----------

// Terminal palette (Tokyo Night).
const PALETTE = [
  '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
  '#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5',
];
const FG = '#c0caf5';
const BG = '#1a1b26';

function xterm256(n) {
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    const c = n - 16;
    const v = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One captured screen (tmux capture-pane -e) as HTML lines; draws the cursor if visible. */
function toHtml(ansi, cursor) {
  const lines = ansi.replace(/\n$/, '').split('\n');
  while (lines.length < ROWS) lines.push('');
  let st = {};
  return lines
    .slice(0, ROWS)
    .map((line, y) => {
      let out = '';
      let x = 0;
      const re = /\x1b\[([0-9;:]*)m|([^\x1b]+)/g;
      let m;
      const span = (text) => {
        let fg = st.fg ?? FG;
        let bg = st.bg ?? null;
        if (st.reverse) [fg, bg] = [bg ?? BG, fg];
        const css = [`color:${st.dim ? fg + ';opacity:.6' : fg}`];
        if (bg) css.push(`background:${bg}`);
        if (st.bold) css.push('font-weight:700');
        if (st.italic) css.push('font-style:italic');
        if (st.underline) css.push('text-decoration:underline');
        return `<span style="${css.join(';')}">${esc(text)}</span>`;
      };
      while ((m = re.exec(line))) {
        if (m[1] !== undefined) {
          // Colon sub-parameters (e.g. 4:3 = curly underline) count as their main code.
          const p = m[1] === '' ? [0] : m[1].split(';').map((x) => Number(x.split(':')[0]));
          for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c === 0) st = {};
            else if (c === 1) st.bold = true;
            else if (c === 2) st.dim = true;
            else if (c === 3) st.italic = true;
            else if (c === 4) st.underline = true;
            else if (c === 7) st.reverse = true;
            else if (c === 22) st.bold = st.dim = false;
            else if (c === 23) st.italic = false;
            else if (c === 24) st.underline = false;
            else if (c === 27) st.reverse = false;
            else if (c >= 30 && c <= 37) st.fg = PALETTE[c - 30];
            else if (c >= 90 && c <= 97) st.fg = PALETTE[c - 90 + 8];
            else if (c === 39) delete st.fg;
            else if (c >= 40 && c <= 47) st.bg = PALETTE[c - 40];
            else if (c >= 100 && c <= 107) st.bg = PALETTE[c - 100 + 8];
            else if (c === 49) delete st.bg;
            else if ((c === 38 || c === 48) && p[i + 1] === 5) {
              st[c === 38 ? 'fg' : 'bg'] = xterm256(p[i + 2]);
              i += 2;
            } else if ((c === 38 || c === 48) && p[i + 1] === 2) {
              st[c === 38 ? 'fg' : 'bg'] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
              i += 4;
            }
          }
        } else {
          const chars = [...m[2]];
          if (cursor && cursor.y === y && cursor.x >= x && cursor.x < x + chars.length) {
            const at = cursor.x - x;
            out += span(chars.slice(0, at).join(''));
            out += `<span class="cursor">${esc(chars[at])}</span>`;
            out += span(chars.slice(at + 1).join(''));
          } else out += span(m[2]);
          x += chars.length;
        }
      }
      if (cursor && cursor.y === y && cursor.x >= x) out += ' '.repeat(cursor.x - x) + '<span class="cursor"> </span>';
      return out;
    })
    .join('\n');
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 28px; background: linear-gradient(135deg, #2a2c3c, #16171f); display: inline-block; }
  .win { background: ${BG}; border-radius: 12px; overflow: hidden; box-shadow: 0 18px 50px rgb(0 0 0 / .55), 0 0 0 1px rgb(255 255 255 / .06); }
  .bar { height: 34px; display: flex; align-items: center; padding: 0 14px; position: relative; background: #16161e; }
  .dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
  .title { position: absolute; left: 0; right: 0; text-align: center; color: #565f89; font: 13px system-ui, sans-serif; }
  pre { margin: 0; padding: 14px 18px 16px; width: ${COLS}ch; height: ${ROWS * 1.38}em; box-sizing: content-box; overflow: hidden; color: ${FG}; font: 15px/1.38 'JetBrainsMono Nerd Font', 'JetBrains Mono', 'DejaVu Sans Mono', monospace; }
  .cursor { background: ${FG}; color: ${BG}; }
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="title">${esc(title)}</div></div><pre>${body}</pre></div>`;

// ---------- capture ----------

let browser;
let page;
async function shot(name, { title = 'plim — ~', cursor = true } = {}) {
  await wait(400);
  const ansi = tmux('capture-pane', '-p', '-e', '-t', 'shot');
  const [cx, cy, visible] = tmux('display', '-p', '-t', 'shot', '#{cursor_x} #{cursor_y} #{cursor_flag}').trim().split(' ').map(Number);
  const html = PAGE(title, toHtml(ansi, cursor && visible ? { x: cx, y: cy } : null));
  await page.bringToFront(); // a tab in the background doesn't render (section 8 opens the web app in another)
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const el = await page.$('body');
  const path = join(OUT, `${name}.png`);
  await el.screenshot({ path });
  console.log(`  tui/${name}.png`);
}

// ---------- the flows ----------

const NOTES = [
  ['Reading list', '- The Overstory\\n- Piranesi\\n- A Psalm for the Wild-Built'],
  ['Groceries', '- oat milk\\n- lemons\\n- sourdough'],
  ['Project ideas', '- offline mode\\n- note tags'],
  ['Meeting notes — Q4 planning', '- hiring\\n- roadmap'],
  ['Lisbon trip', 'Flights: Thu 08:40 → Sun 19:15\\nStay: Alfama, near Miradouro de Santa Luzia\\n\\nTo do\\n- Tram 28 early, before the crowds\\n- Pastéis de Belém\\n- LX Factory on Saturday\\n- Day trip to Sintra?'],
];

async function run(server, home) {
  // A clean HOME and XDG dirs, so nvim and the shell use no personal config.
  const env = {
    PLIM_HOME: home, TERM: 'xterm-256color', PLIM_EDITOR: 'nvim', PATH: `${dirname(CLI)}:${process.env.PATH}`, HOME: home, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    // No desktop keychain (#360): `plim remember` keeps the passphrase in the kernel's keyring, as on a
    // server, never in the keychain of whoever runs this.
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent',
  };
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'shot', '-x', String(COLS), '-y', String(ROWS),
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'bash --noprofile --norc');
  tmux('set', '-g', 'status', 'off');
  await until((s) => s.trimEnd().endsWith('$'), 'the first prompt');
  await shell("PS1='$ '", { clear: true });
  // The pane's shell doesn't keep the PATH given to tmux: put the binary under
  // test first, or `plim` is whatever else is installed (e.g. /usr/local/bin).
  await shell(`export PATH='${dirname(CLI)}':"$PATH"`, { clear: true });
  await shell(`[ "$(command -v plim)" = '${CLI}' ] || echo WRONG""-TIRO`, { clear: true });
  if (screenText().includes('WRONG-TIRO')) throw new Error(`the pane runs another plim than ${CLI}`);
  keys('C-l');
  await wait(200);

  // 1. plim init: the 12 words, confirming three, the device passphrase
  type(`plim --server ${server.url} init`);
  keys('Enter');
  await waitFor('Press Enter');
  await shot('01-init-1-phrase', { cursor: false });
  const words = [...screenText().matchAll(/\d+\. (\w+)/g)].map((m) => m[1]);
  if (words.length !== 12) throw new Error(`expected 12 words, got ${words}`);
  keys('Enter');
  for (let i = 0; i < 3; i++) {
    await until((s) => (s.match(/Word #\d+: *$/m) || [])[0], 'a word prompt');
    const n = Number(screenText().match(/Word #(\d+): *$/m)[1]);
    type(words[n - 1]);
    if (i < 2) keys('Enter');
  }
  await shot('01-init-2-confirm');
  keys('Enter');
  await waitFor('Device passphrase:');
  type(PASSPHRASE);
  keys('Enter');
  await waitFor('Repeat it:');
  type(PASSPHRASE);
  keys('Enter');
  // (#360) Not remembered here: the steps below type it, or set PLIM_PASSPHRASE.
  await waitFor('Remember the passphrase on this machine');
  type('n');
  keys('Enter');
  await waitFor('Done. Run `plim`');
  await shot('01-init-3-done');

  // Sample notes, added from the shell (hidden: cleared before the next shot)
  await shell(`export PLIM_PASSPHRASE='${PASSPHRASE}'`, { clear: true });
  for (const [title, body] of NOTES) await shell(`printf '${title}\\n\\n${body}\\n' | plim add`);

  // 2. Scripting
  keys('C-l');
  await wait(300);
  await shell('plim add "Call the plumber about the kitchen tap"');
  await shell('plim ls');
  await shell('plim cat "Groceries"');
  await shot('02-scripting-1-commands');

  // 3. The TUI
  keys('C-l');
  type('plim');
  keys('Enter');
  await waitFor('Saved');
  await selectNote('Lisbon trip');
  keys('Enter');
  await waitFor('Tram 28');
  keys('Escape');
  await shot('03-tui-1-list', { cursor: false });
  keys('Tab');
  keys('C-End');
  type('\n- Fado night in Alfama');
  await waitFor('Fado night');
  await shot('03-tui-2-editing');
  keys('Escape');
  keys('n');
  await wait(400);
  type('Weekend\n\nFarmers market, then the long walk along the river.');
  await waitFor('long walk');
  await shot('03-tui-3-new-note');
  keys('Escape');
  keys('/');
  type('tri');
  await waitFor('/tri');
  await shot('03-tui-4-search', { cursor: false });
  keys('Escape');
  await selectNote('Project ideas');
  keys('d');
  await waitFor('Delete this note? y / n');
  await shot('03-tui-5-delete', { cursor: false });
  keys('n');

  // 4. $EDITOR (nvim): edits merge with the open note
  await selectNote('Lisbon trip');
  keys('e');
  await until((s) => s.includes('Tram 28') && !s.includes('Saved'), 'nvim');
  await wait(500);
  keys('G', 'o');
  type('- Sunset at Miradouro da Graça');
  keys('Escape');
  await shot('04-editor-1-nvim', { title: 'nvim — plim', cursor: true });
  type(':wq');
  keys('Enter');
  await waitFor('Sunset at Miradouro');
  await waitFor('Saved');
  await shot('04-editor-2-merged', { cursor: false });

  // 5. Offline: the server goes away while editing
  keys('Tab');
  keys('C-End');
  await server.stop();
  type('\n- Book the fado table (written offline)');
  await waitFor('Offline — saved on this device', 30000);
  await shot('05-offline-1-editing');
  await server.start();
  await waitFor('Saved', 40000);
  await shot('05-offline-2-back-online');
  keys('Escape');

  // 6. Rollback warning: the server loses an update this device has seen
  keys('C-q');
  await until((s) => s.trimEnd().endsWith('$'), 'the prompt after quitting');
  {
    const db = new DatabaseSync(server.db);
    const row = db.prepare("SELECT rowid AS id FROM updates WHERE doc_id != 'index' ORDER BY rowid DESC LIMIT 1").get();
    db.prepare('DELETE FROM updates WHERE rowid = ?').run(row.id);
    db.close();
  }
  keys('C-l');
  type('plim');
  keys('Enter');
  await waitFor('Saved');
  await selectNote('Lisbon trip');
  keys('Enter');
  await waitFor('Press A in the list to acknowledge', 20000);
  keys('Escape');
  await shot('06-rollback-1-warning', { cursor: false });
  keys('A');
  keys('C-q');
  await until((s) => s.trimEnd().endsWith('$'), 'the prompt after quitting');

  // 7. Sign in on another machine: plim login
  await shell('unset PLIM_PASSPHRASE && plim logout', { clear: true });
  keys('C-l');
  await wait(200);
  type(`plim --server ${server.url} login`);
  keys('Enter');
  await waitFor('Recovery phrase (12 words):');
  type(words.join(' '));
  keys('Enter');
  await waitFor('Device passphrase:');
  type(PASSPHRASE);
  keys('Enter');
  await waitFor('Repeat it:');
  type(PASSPHRASE);
  keys('Enter');
  // Remembered (#360): then a command asks for nothing, with no PLIM_PASSPHRASE.
  await waitFor('Remember the passphrase on this machine');
  keys('Enter');
  await waitFor('Signed in.');
  if (!screenText().includes("Remembered in this machine's kernel keyring")) throw new Error(`login: the passphrase should be remembered: ${screenText()}`);
  await shot('07-login-1-signed-in');
  await shell('plim ls < /dev/null; echo "ls: $?"', { clear: true });
  if (!screenText().includes('ls: 0') || screenText().includes('passphrase')) throw new Error(`with the passphrase remembered, plim ls should just work: ${screenText()}`);
  await shell('plim remember --off', { clear: true });
  if (!screenText().includes('Forgotten')) throw new Error(`plim remember --off: ${screenText()}`);
  keys('C-l');

  // 8. Shared notes (#80): shared in the web app, then read and edited here, in the share.
  const web = await browser.newPage();
  web.on('dialog', (d) => d.accept());
  await web.setViewport({ width: 1200, height: 800 });
  await web.goto(`${server.url.replace(/\/$/, '')}/login`); // (/ is a short overview; the way in is /login)
  await web.waitForFunction(() => !document.getElementById('view-welcome').hidden);
  await web.click('#btn-restore');
  await web.waitForFunction(() => !document.getElementById('view-restore').hidden);
  await web.type('#restore-input', words.join(' '));
  await web.click('#restore-form button.primary');
  await web.waitForFunction(() => !document.getElementById('view-notes').hidden || !document.getElementById('view-passkey').hidden, { timeout: 60000 });
  if (await web.evaluate(() => !document.getElementById('view-passkey').hidden)) await web.click('#passkey-alt');
  await web.waitForFunction(() => !document.getElementById('view-notes').hidden);
  const shareInWeb = async (title) => {
    await web.bringToFront(); // (screenshots bring theirs to the front: clicks stall in a background tab)
    await web.waitForFunction((t) => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === t), {}, title);
    const id = await web.evaluate((t) => [...document.querySelectorAll('#note-list li:not(.trashed)')].find((li) => li.querySelector('.title')?.textContent === t).dataset.id, title);
    await web.click(`#note-list li[data-id="${id}"] > button`, { button: 'right' }); // (its menu)
    await web.click('#note-menu-share');
    await web.waitForFunction(() => document.querySelector('#share-dialog').open);
    await web.click('#share-create');
    await web.waitForFunction(() => !document.querySelector('#share-on').hidden, { timeout: 20000 });
    await web.keyboard.press('Escape');
  };
  await shareInWeb('Groceries');
  await shell(`export PLIM_PASSPHRASE='${PASSPHRASE}'`, { clear: true });
  // (The web app saves the list a moment after the change: ask again until it's there.)
  for (let i = 0; i < 10; i++) {
    await shell('plim ls', { clear: true });
    if (/Groceries\s+\(shared\)/.test(screenText())) break;
    await wait(1000);
  }
  if (!/Groceries\s+\(shared\)/.test(screenText())) throw new Error(`plim ls doesn't mark the shared note:\n${screenText()}`);
  await shell('plim cat groceries', { clear: true });
  if (!screenText().includes('oat milk')) throw new Error(`plim cat should print the shared note from its share:\n${screenText()}`);
  keys('C-l');
  type('plim');
  keys('Enter');
  await waitFor('Shared ·');
  await selectNote('Groceries');
  keys('Enter');
  await waitFor('oat milk');
  // Typed here: saved to the share, so the web app has it.
  keys('C-End');
  type(' (from the terminal)');
  await wait(3000);
  await shot('08-shared-1-open', { cursor: false });
  await web.bringToFront();
  await web.evaluate(() => [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === 'Groceries').querySelector('button').click());
  await web.waitForFunction(() => document.getElementById('editor').noteText?.().includes('(from the terminal)'), { timeout: 20000 })
    .catch(async () => { throw new Error(`the web app should get the terminal's edit to the shared note: ${JSON.stringify(await web.evaluate(() => document.getElementById('editor').noteText?.()))}`); });
  keys('Escape');
  // Its edit link alone (#130): read and append with no account and no passphrase here, as a
  // script or an AI agent would (an empty home, no PLIM_PASSPHRASE).
  const editLink = await web.evaluate(async (t) => {
    [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === t).querySelector('button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    document.getElementById('note-menu-share').click();
    const d = document.getElementById('share-dialog');
    for (let i = 0; i < 50 && !(d.open && document.getElementById('share-edit-link').value); i++) await new Promise((r) => setTimeout(r, 100));
    const v = document.getElementById('share-edit-link').value;
    d.close();
    return v;
  }, 'Groceries');
  if (!/#k=[0-9a-f]{32}\.e\./.test(editLink)) throw new Error(`no edit link from the web app: ${editLink}`);
  await page.bringToFront();
  keys('C-q');
  await until((s) => s.trimEnd().endsWith('$'), 'the prompt after quitting');
  const bare = `env -i PATH="$PATH" HOME="$(mktemp -d)" plim`;
  await shell(`${bare} append '${editLink}' 'added by a script, with only the link'`, { clear: true });
  await shell(`${bare} cat '${editLink}'`, { clear: true });
  if (!screenText().includes('added by a script, with only the link')) throw new Error(`plim cat <link> should show the appended line:\n${screenText()}`);
  await shot('08-shared-2-link', { cursor: false });
  await web.bringToFront();
  await web.waitForFunction(() => document.getElementById('editor').noteText?.().includes('added by a script'), { timeout: 20000 })
    .catch(async () => { throw new Error(`the web app should get the line appended with the link: ${JSON.stringify(await web.evaluate(() => document.getElementById('editor').noteText?.()))}`); });
  // Share from here (#130): the links printed, the web app's guest page opens them; then stop.
  await page.bringToFront();
  await shell(`plim share 'Lisbon trip'`, { clear: true });
  const termLink = screenText().replace(/\n/g, '').match(/Can edit: (\S+?#k=[0-9a-f]{32}\.e\.[A-Za-z0-9_-]{43})/)?.[1];
  if (!termLink) throw new Error(`plim share should print the links:\n${screenText()}`);
  await shot('08-shared-3-share', { cursor: false });
  const guest = await browser.newPage();
  await guest.goto(termLink);
  // (Its title its first line, or, moved to frontmatter by the web app meanwhile, its block's: #584.)
  await guest.waitForFunction(() => /^(---\ntitle: )?Lisbon trip/.test(document.getElementById('editor')?.noteText?.() ?? ''), { timeout: 30000 })
    .catch(async () => { throw new Error(`the web app should open a link made in the terminal: ${await guest.evaluate(() => document.body.innerText.slice(0, 300))}`); });
  await guest.close();
  // A link of someone's own (#369): `plim share --for`; it opens the note with only the link, keeps
  // working when the links are replaced, and goes when sharing stops.
  await shell(`plim share 'Lisbon trip' --for Sam`, { clear: true });
  const samLink = screenText().replace(/\n/g, '').match(/Sam[^:]*: (\S+?#h=[0-9a-f]{32}\.[A-Za-z0-9_-]{43})/)?.[1];
  if (!samLink) throw new Error(`plim share --for should print Sam's link:\n${screenText()}`);
  await shell(`${bare} cat '${samLink}'`, { clear: true });
  if (!screenText().includes('Lisbon trip')) throw new Error(`plim cat with Sam's link:\n${screenText()}`);
  await shell(`plim share 'Lisbon trip' --new-links`, { clear: true });
  const termLink2 = screenText().replace(/\n/g, '').match(/Can edit: (\S+?#k=[0-9a-f]{32}\.e\.[A-Za-z0-9_-]{43})/)?.[1];
  if (!termLink2 || termLink2 === termLink) throw new Error(`--new-links should print new links:\n${screenText()}`);
  await shell(`${bare} cat '${samLink}'`, { clear: true });
  if (!screenText().includes('Lisbon trip')) throw new Error(`Sam's link should keep working after --new-links:\n${screenText()}`);
  await shell(`${bare} cat '${termLink}'`, { clear: true });
  if (!screenText().includes("doesn't work any more")) throw new Error(`the old plain link should be dead after --new-links:\n${screenText()}`);
  await shell(`plim unshare 'Lisbon trip'`, { clear: true });
  if (!screenText().includes('Stopped sharing')) throw new Error(`plim unshare:\n${screenText()}`);
  await shell(`${bare} cat '${termLink2}'`, { clear: true });
  if (!screenText().includes("doesn't work any more")) throw new Error(`a link should stop working once sharing stops:\n${screenText()}`);
  await shell(`${bare} cat '${samLink}'`, { clear: true });
  if (!/doesn't work|turned off/.test(screenText())) throw new Error(`Sam's link should stop working once sharing stops:\n${screenText()}`);
  await page.bringToFront();
  keys('C-l');
  type('plim');
  keys('Enter');
  await waitFor('Shared ·');
  // Shared on another device while it's open here: reopened in its share, with a word why.
  await selectNote('Project ideas');
  keys('Enter');
  await wait(500);
  await shareInWeb('Project ideas');
  await waitFor('This note was shared on another device', 20000);
  await page.bringToFront();
  keys('C-q');
  await until((s) => s.trimEnd().endsWith('$'), 'the prompt after quitting');

  // 9. Tags (#308): #gym in a note's text; notes found, read and tagged by tag. Run directly
  // (as a script or Claude would) and checked, then shown in the pane.
  // (Each run signs in, and the server takes 60 sign-in requests a minute from one address: this
  // flow's runs come quicker than anyone's, so on a 429 it waits for the next minute, once.)
  const plim = (args, input) => {
    const once = () => spawnSync(CLI, args, { input, encoding: 'utf8', env: { ...env, PLIM_PASSPHRASE: PASSPHRASE } });
    let r = once();
    if (r.status !== 0 && r.stderr.includes('429')) {
      execFileSync('sleep', [String(61 - (Math.floor(Date.now() / 1000) % 60))]);
      r = once();
    }
    if (r.status !== 0) throw new Error(`plim ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
    return { out: r.stdout, err: r.stderr };
  };
  const expect = (ok, what, got) => {
    if (!ok) throw new Error(`tags: ${what}\n${typeof got === 'string' ? got : JSON.stringify(got, null, 1)}`);
  };
  plim(['add'], '# Training 2026\n#gym #training\n\nFormat: date · exercise · weight × reps\n- 2026-10-08 · Squat · 135 lb × 12\n');
  plim(['add'], 'Leg day\n\nFelt strong today #gym/legs, and `#notatag` in code.\n');
  let ls = plim(['ls', '--tag', 'gym']);
  expect(/Training 2026 +#gym +#training/.test(ls.out) && !ls.out.includes('Leg day') && !ls.out.includes('Groceries'), 'ls --tag gym: Training 2026, with its tags; not Leg day (#gym/legs: a tag of its own, #539)', ls.out);
  expect(plim(['ls', '--tag', '#GYM/legs']).out.trim().split('\n').length === 1, 'ls --tag #GYM/legs: Leg day alone', plim(['ls', '--tag', 'gym/legs']).out);
  // Tagging (#584): the `tags:` line in the note's frontmatter (the web app moved its notes there),
  // made, added to, taken from, and gone; the rest of the note untouched.
  const before = plim(['cat', 'Groceries']).out;
  expect(before.startsWith('---\ntitle: Groceries\n---\n'), 'Groceries, moved to frontmatter by the web app', before);
  const tagsLine = (t) => before.replace(/^---\ntitle: Groceries\n/, `---\ntitle: Groceries\ntags: [${t}]\n`);
  let r = plim(['tag', 'Groceries', 'shopping']);
  expect(/Tagged "Groceries": #shopping · http/.test(r.err), 'tag: said, with the address', r.err);
  expect(plim(['cat', 'Groceries']).out === tagsLine('shopping'), 'tag: a tags line in the block', plim(['cat', 'Groceries']).out);
  expect(plim(['tag', 'Groceries', 'shopping']).err.includes('has #shopping already'), 'tag again: already', '');
  plim(['tag', 'Groceries', 'errands', '#Weekly']);
  expect(plim(['cat', 'Groceries']).out === tagsLine('shopping, errands, weekly'), 'tag: added to the line', plim(['cat', 'Groceries']).out);
  // …and the web app has the edit (one change to the note's text, merged as any edit is), in its header.
  await web.bringToFront();
  await web.evaluate(() => [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === 'Groceries').querySelector('button').click());
  await web.waitForFunction(() => [...document.querySelectorAll('#note-head-tags .head-tag-name')].map((b) => b.dataset.tag).join() === 'shopping,errands,weekly', { timeout: 20000 })
    .catch(async () => { throw new Error(`the web app should have the tags: ${await web.evaluate(() => document.getElementById('editor').noteText?.())}`); });
  plim(['untag', 'Groceries', 'errands']);
  expect(plim(['cat', 'Groceries']).out === tagsLine('shopping, weekly'), 'untag: off the line', plim(['cat', 'Groceries']).out);
  plim(['untag', 'Groceries', 'shopping', 'weekly']);
  expect(plim(['cat', 'Groceries']).out === before, 'untag: the line gone, the note as it was', plim(['cat', 'Groceries']).out);
  // A #word in the text is no tag: untagging it, nothing to do, and said.
  expect(plim(['untag', 'Leg day', 'notatag']).err.includes('"Leg day" isn\'t tagged #notatag'), 'untag a #word in the text: not a tag, said', '');
  // Written as someone (#542): `--as NAME`, or $PLIM_AS, marks the text as theirs, as an app's edits
  // are: "by NAME" in the list, its mark in the margin, its versions named in History.
  plim(['add', '--as', 'Claude'], 'As check\n\nfrom Claude\n');
  plim(['append', 'As check', '- and more', '--as', 'Claude']);
  const asEnv = spawnSync(CLI, ['append', 'As check', '- from a script'], { encoding: 'utf8', env: { ...env, PLIM_PASSPHRASE: PASSPHRASE, PLIM_AS: 'Backup script' } });
  expect(asEnv.status === 0, 'PLIM_AS: written as it', asEnv.stderr);
  const tooLong = spawnSync(CLI, ['append', 'As check', 'x', '--as', 'x'.repeat(41)], { encoding: 'utf8', env: { ...env, PLIM_PASSPHRASE: PASSPHRASE } });
  expect(tooLong.status !== 0 && tooLong.stderr.includes('short name'), '--as: a long name refused', tooLong.stderr);
  {
    const h = plim(['history', 'As check']);
    const all = h.out + h.err;
    expect(/Claude · [a-z]+ [a-z]+/.test(all) && /Backup script · [a-z]+ [a-z]+/.test(all), '--as: History names who wrote each version', all);
  }
  await web.bringToFront();
  await web.waitForFunction(() => [...document.querySelectorAll('#note-list li')].some((li) => li.querySelector('.title')?.textContent === 'As check' && li.querySelector('.when').textContent.includes('by Backup script')), { timeout: 20000 })
    .catch(async () => { throw new Error(`--as: the list should say "by Backup script": ${await web.evaluate(() => [...document.querySelectorAll('#note-list li')].map((li) => li.textContent).join(' | '))}`); });
  await web.evaluate(() => [...document.querySelectorAll('#note-list li')].find((li) => li.querySelector('.title')?.textContent === 'As check').querySelector('button').click());
  await web.waitForFunction(() => document.querySelectorAll('#editor .cm-line.app-edit').length >= 3, { timeout: 20000 })
    .catch(async () => { throw new Error(`--as: its lines marked in the margin: ${await web.evaluate(() => document.getElementById('editor').innerHTML.slice(0, 600))}`); });
  // …and in Connected (#552), though it isn't shared with agents: written in by Claude and a
  // script, both their letters on its row.
  await web.evaluate(() => document.querySelector('#notes-nav .view[data-view="connected"]').click());
  await web.waitForFunction(() => [...document.querySelectorAll('#note-list li[data-id]')].some((li) => li.querySelector('.title').textContent === 'As check'
    && [...li.querySelectorAll('.row-marks .reach-badge')].map((m) => m.dataset.i).sort().join('') === 'BC'), { timeout: 20000 })
    .catch(async () => { throw new Error(`--as: in Connected, with its writers' letters: ${await web.evaluate(() => [...document.querySelectorAll('#note-list li[data-id]')].map((li) => li.textContent + '[' + [...li.querySelectorAll('.reach-badge')].map((m) => m.dataset.i).join('') + ']').join(' | '))}`); });
  await web.evaluate(() => document.querySelector('#notes-nav .view[data-view="notes"]').click());
  // The bar's chip (#555): the script's, while it's the last to have written in the note, saying
  // when: its writing three hours old, still there ("Backup script, 3 h ago"); once you've typed in
  // it, gone. (The note's record of its writers aged, as if they wrote then: moving the page's
  // clock instead would lock it, as hours idle.)
  const chip = () => web.evaluate(() => ({ shown: !document.getElementById('app-here').hidden, text: document.getElementById('app-here').textContent }));
  await web.evaluate(() => {
    const doc = document.getElementById('editor').noteYText().doc;
    const authors = doc.getMap('authors');
    doc.transact(() => { for (const [k, v] of [...authors.entries()]) authors.set(k, { ...v, at: v.at - 3 * 3600e3 }); });
  });
  await web.waitForFunction(() => !document.getElementById('app-here').hidden && document.getElementById('app-here').textContent === 'Backup script, 3 h ago', { timeout: 10000 })
    .catch(async () => { throw new Error(`--as: the bar's chip, hours on: ${JSON.stringify(await chip())}`); });
  await web.evaluate(() => { const y = document.getElementById('editor').noteYText(); y.insert(y.length, ' (read)'); });
  await web.waitForFunction(() => document.getElementById('app-here').hidden, { timeout: 10000 })
    .catch(async () => { throw new Error(`--as: once you've typed in the note, no chip: ${JSON.stringify(await chip())}`); });
  // (A fresh minute of sign-ins after these: each `plim` signs in, and the editor's steps below don't wait out a 429.)
  execFileSync('sleep', [String(61 - (Math.floor(Date.now() / 1000) % 60))]);
  // History (#505): edits here keep versions as the app's do (the note as it was before a session's
  // first edit; not again within the hour), listed, read, and one put back, undoably.
  plim(['add'], 'History check\n\nfirst line\n');
  expect(plim(['history', 'History check']).err.includes('no earlier versions yet'), 'history: a new note has none', '');
  plim(['append', 'History check', 'second line']);
  plim(['append', 'History check', 'oops, not this']);
  let hist = plim(['history', 'History check']);
  expect(/^"History check": 1 version, newest first/.test(hist.out) && /^ +now +\(not kept yet\) +\+2 −0$/m.test(hist.out) && /^ +1 +\d+s ago\s/m.test(hist.out),
    'history: the note as it was before the first append kept; not again within the hour; what\'s changed since', hist.out);
  // (As added: its title in its frontmatter, #584, the vault's notes moved there by the web app.)
  const added = '---\ntitle: History check\n---\nfirst line\n';
  expect(plim(['history', 'History check', '1']).out === added, 'history <n>: that version\'s text', plim(['history', 'History check', '1']).out);
  r = plim(['restore', 'History check', '1']);
  expect(/Restored "History check" as it was .* \(version 1\)/.test(r.err) && plim(['cat', 'History check']).out.trimEnd() === added.trimEnd(), 'restore: the note as it was', r);
  hist = plim(['history', 'History check']);
  expect(/^"History check": 2 versions/.test(hist.out) && /^ +now +\(not kept yet\) +\+0 −2$/m.test(hist.out), 'restore: what it was, kept first (and now the two lines are out again)', hist.out);
  const diff = plim(['history', 'History check', '1', '--diff']).out;
  expect(/^--- version 2\n\+\+\+ version 1\n/.test(diff) && /^\+second line$/m.test(diff) && /^\+oops, not this$/m.test(diff), 'history <n> --diff: what it changed', diff);
  // plim edit: a piece replaced (there once), the whole text from stdin, or in your editor.
  const cli = (args, opts = {}) => spawnSync(CLI, args, { encoding: 'utf8', ...opts, env: { ...env, PLIM_PASSPHRASE: PASSPHRASE, ...opts.env } });
  r = plim(['edit', 'History check', '--replace', 'first line', 'first line, edited']);
  expect(/^Edited "History check": \+1 −1 · http/.test(r.err) && plim(['cat', 'History check']).out.includes('first line, edited\n'), 'edit --replace: the piece replaced, said', r.err);
  let bad = cli(['edit', 'History check', '--replace', 'not in it', 'x']);
  expect(bad.status !== 0 && /isn't in the note/.test(bad.stderr), 'edit --replace: what isn\'t there, refused', bad.stderr);
  const piped = plim(['cat', 'History check']).out.replace('edited', 'edited from a pipe');
  r = plim(['edit', 'History check', '-'], piped);
  expect(plim(['cat', 'History check']).out === piped && /\+1 −1/.test(r.err), 'edit -: the whole text from stdin, only what changed changed', { r, now: plim(['cat', 'History check']).out });
  bad = cli(['edit', 'History check', '-'], { input: '  \n' });
  expect(bad.status !== 0 && /nothing on stdin/.test(bad.stderr) && plim(['cat', 'History check']).out === piped, 'edit -: an empty pipe refused, the note kept', bad.stderr);
  r = cli(['edit', 'History check'], { env: { PLIM_EDITOR: "sed -i 's/from a pipe/in an editor/'" } });
  expect(r.status === 0 && /^Edited "History check"/m.test(r.stderr) && plim(['cat', 'History check']).out.includes('edited in an editor'), 'edit: in your editor ($PLIM_EDITOR), merged', r.stderr);
  r = cli(['edit', 'History check'], { env: { PLIM_EDITOR: 'true' } });
  expect(r.status === 0 && /No changes to "History check"/.test(r.stderr), 'edit: the editor closed without a change: nothing', r.stderr);
  expect(/isn't a tag/.test(spawnSync(CLI, ['tag', 'Groceries', 'two words'], { encoding: 'utf8', env: { ...env, PLIM_PASSPHRASE: PASSPHRASE } }).stderr), 'tag: a bad tag refused', '');
  // Reading by tag: every note, each under its title and address.
  const cat = plim(['cat', '--tag', 'gym']).out;
  expect(/^==> Training 2026 · http\S+\/n\/[0-9a-f-]{36} <==$/m.test(cat) && !/^==> Leg day · http/m.test(cat) && cat.includes('135 lb × 12') && !cat.includes('Felt strong today'), 'cat --tag gym: not #gym/legs (#539)', cat);
  // A note tagged in the app: found by tag here at once (the app keeps a note's tags in the list too, #308).
  await web.click('#btn-new');
  await web.waitForFunction(() => document.querySelector('#editor .cm-content')?.getAttribute('contenteditable') === 'true');
  // (Not its date, #313: its own title; its tags in its frontmatter, #584.)
  await web.evaluate(() => { const y = document.getElementById('editor').noteYText(); y.delete(0, y.length); y.insert(0, '---\ntitle: From the web\ntags: [fromweb, gym]\n---\n'); });
  await web.waitForFunction(() => [...document.querySelectorAll('#note-list .title')].some((e) => e.textContent === 'From the web'));
  // (Saved: the note and the list. Then once, not polling: each run signs in, and sign-ins are rate-limited.)
  await web.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // (the app uploads at once)
  await web.waitForFunction(() => document.getElementById('save-status').dataset.state === 'saved', { timeout: 20000 });
  await wait(2000);
  expect(plim(['ls']).out.includes('From the web'), 'the note made in the web app, listed here', '');
  expect(plim(['ls', '--tag', 'fromweb']).out.includes('From the web'), 'ls --tag: the app\'s note, by the tags the app kept', plim(['ls', '--tag', 'fromweb']));
  const rebuilt = plim(['tags', '--rebuild']);
  expect(/Read \d+ notes/.test(rebuilt.err), 'tags --rebuild: read every note', rebuilt.err);
  expect(plim(['ls', '--tag', 'fromweb']).out.includes('From the web'), 'ls --tag after --rebuild: still found', plim(['ls', '--tag', 'fromweb']));
  const counts = plim(['tags']);
  expect(/^#gym {2}2$/m.test(counts.out) && /^#gym\/legs {2}1$/m.test(counts.out) && /^#training {2}1$/m.test(counts.out) && !counts.err.includes('--rebuild'), 'tags: counts, each tag on its own (#539)', counts);
  // Export (#47): every note a Markdown file in a new folder, as the app's zip has them.
  {
    const out = mkdtempSync(join(tmpdir(), 'plim-export-'));
    const dir = join(out, 'notes');
    r = plim(['export', dir]);
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const made = readFileSync(join(dir, 'From the web.md'), 'utf8');
    expect(/^Exported \d+ notes to /m.test(r.err) && files.includes('Groceries.md')
      && /^---\ntitle: From the web\ntags: \[fromweb, gym\]\ncreated: \S+Z\nupdated: \S+Z\nid: [0-9a-f-]{36}\n---\n/.test(made),
    'export: a file a note, its tags, dates and id in its frontmatter', { r, files, made });
    bad = cli(['export', dir]);
    expect(bad.status !== 0 && /isn't empty/.test(bad.stderr), 'export: a folder with files in it, refused', bad.stderr);
    rmSync(out, { recursive: true, force: true });
  }
  // Shown: as you'd use them. (A fresh minute of sign-ins first: a command typed in the shell doesn't wait out a 429.)
  execFileSync('sleep', [String(61 - (Math.floor(Date.now() / 1000) % 60))]);
  await page.bringToFront();
  await shell('plim tag Groceries shopping', { clear: true });
  // The list's order (#344): Groceries, just tagged (so edited), first by last edited; not by date created.
  {
    const first = (r) => r.out.split('\n').find(Boolean) ?? '';
    const edited = plim(['ls']);
    const created = plim(['ls', '--sort', 'created']);
    expect(first(edited).includes('Groceries') && !first(created).includes('Groceries')
      && created.out.split('\n').filter(Boolean).length === edited.out.split('\n').filter(Boolean).length, 'ls --sort created: the newest made first, the same notes', { edited, created });
    const wrong = spawnSync(CLI, ['ls', '--sort', 'title'], { encoding: 'utf8', env: { ...env, PLIM_PASSPHRASE: PASSPHRASE } });
    expect(wrong.status === 2 && wrong.stderr.includes('[possible values: edited, created]'), 'ls --sort: only edited or created', wrong.stderr);
  }
  {
    // Sharing with agents (#514): said, either way. (What an agent then sees is the connector's,
    // tested in connector_tests.rs.) There's no MCP server on stdin/stdout: `plim mcp` alone
    // refuses, saying what to do instead.
    let r = plim(['share', 'Training 2026', '--agents']);
    expect(/^Shared "Training 2026" with agents/.test(r.err), 'share --agents: said', r.err);
    r = plim(['unshare', 'Training 2026', '--agents']);
    expect(/^"Training 2026" isn't shared with agents any more/.test(r.err), 'unshare --agents: said', r.err);
    const mcp = spawnSync(CLI, ['mcp'], { input: '', encoding: 'utf8', env: { ...env, PLIM_PASSPHRASE: PASSPHRASE } });
    expect(mcp.status !== 0 && mcp.stdout === '' && mcp.stderr.includes('only runs the connector now'), 'mcp: no stdio server, saying what to do instead', mcp.stderr);
  }
  await shell('plim ls --tag gym');
  await shell('plim tags');
  await shot('09-tags-1-commands');
  plim(['untag', 'Groceries', 'shopping']);
  await web.close();
}

/** Move the list selection onto a note by title (the selected row is bold and highlighted). */
async function selectNote(title) {
  keys('g');
  for (let i = 0; i < 12; i++) {
    await wait(120);
    const ansi = tmux('capture-pane', '-p', '-e', '-t', 'shot');
    const row = ansi.split('\n').find((l) => l.includes(title) && /\x1b\[[0-9;]*1[;m]/.test(l.slice(0, l.indexOf(title))));
    if (row) return;
    keys('j');
  }
  throw new Error(`couldn't select "${title}"`);
}

// ---------- main ----------

if (!CHROME) throw new Error('No Chromium found; set CHROME to its path.');
if (!existsSync(CLI)) throw new Error(`No plim binary at ${CLI}; run: cargo build --release -p plim-cli`);
const dataDir = mkdtempSync(join(tmpdir(), 'plim-tui-shots-'));
const home = join(dataDir, 'home');
mkdirSync(home);
const server = new TestServer({ root: ROOT, dataDir, port: PORT });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
console.log('\ntui');
try {
  await server.start();
  await run(server, home);
} finally {
  try {
    tmux('kill-server');
  } catch {}
  await browser.close();
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log('\ndone');
