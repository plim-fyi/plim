// Driving the app in a Puppeteer page: the steps every check takes, kept in one place so a
// change to the app (a new note starting with the date, a phone editing in a textarea) is
// followed once, by the flows (web/harness.mjs re-exports these) and by the standalone checks
// (recover.mjs, share-stress.mjs, live-resilience.mjs) alike (#458).
//
// Nothing happens on import: no server, no browser, no ports.

import { wait } from './server.mjs';

/** Wait until the view `id` (view-welcome, view-notes, …) shows. (Polled from here, not waited for in the page: a page that reloads meanwhile — locking does — kills a page-side wait.) */
export async function waitView(p, id, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await p.evaluate((id) => !document.getElementById(id)?.hidden, id).catch(() => false)) return;
    // (Waiting for the card to make or open a vault, at / with none here: the home page's overview
    // shows instead; its Sign in goes to /login, where the card is.)
    if (id === 'view-welcome' && (await p.evaluate(() => !document.getElementById('view-home')?.hidden).catch(() => false))) {
      await p.click('#view-home a.button:not(.primary)').catch(() => {});
    }
    await wait(100);
  }
  const showing = await p.evaluate(() => [...document.querySelectorAll('.view')].find((v) => !v.hidden)?.id).catch(() => '?');
  throw new Error(`waiting for #${id}, showing #${showing}`);
}

// The note editor: CodeMirror, or on a phone a textarea (#290). Run in the page.
/** Editable. */
export const EDITABLE = () =>
  document.querySelector('#editor .cm-content')?.getAttribute('contenteditable') === 'true' ||
  Boolean(document.querySelector('#editor textarea:not([readonly])'));
/** Editable, and the focus in it (or in its header's title: a new note's, #584). */
export const EDITOR_READY = () =>
  (document.querySelector('#editor .cm-content')?.getAttribute('contenteditable') === 'true' ||
    Boolean(document.querySelector('#editor textarea:not([readonly])'))) &&
  Boolean(document.activeElement?.closest?.('#editor, #note-head'));
export const editable = (p, timeout = 20000) => p.waitForFunction(EDITABLE, { timeout, polling: 50 });

/**
 * The note just made, emptied: a new note starts with the date and time as its title (flow 26),
 * in its frontmatter (#584): that too. The cursor in the text (not the header's title), for what's
 * typed next: a note whose first line is its title.
 */
export async function blankNote(p) {
  await p.waitForFunction(() => document.getElementById('editor').noteText() !== '', { timeout: 5000, polling: 50 });
  await p.evaluate(() => {
    const y = document.getElementById('editor').noteYText();
    y.delete(0, y.length);
    document.getElementById('editor').focusText();
  });
  await p.waitForFunction(() => document.getElementById('editor').noteText() === '' && document.getElementById('editor').cursorPos() === 0
    && Boolean(document.activeElement?.closest?.('#editor')), { timeout: 5000, polling: 50 });
}

/** A new note (from `button`), with `text` typed into it in place of the date. */
export async function newNote(p, text, { button = '#btn-new' } = {}) {
  await p.click(button);
  await editable(p);
  await blankNote(p);
  await p.keyboard.type(text);
}

// ---- a vault ----

export const phraseWords = (p) => p.$$eval('#phrase-words li', (e) => e.map((x) => x.textContent));

/** The words asked for on the confirm screen, typed (`wrong`: the second one isn't), then Confirm. */
export async function confirmWords(p, words, { wrong = false } = {}) {
  const idx = await p.$$eval('#confirm-fields input', (e) => e.map((x) => Number(x.dataset.index)));
  const inputs = await p.$$('#confirm-fields input');
  for (let i = 0; i < inputs.length; i++) {
    await inputs[i].click({ count: 3 });
    await inputs[i].type(wrong && i === 1 ? 'zebra' : words[idx[i]]);
  }
  await p.click('#confirm-form button.primary');
}

/** From the welcome screen: the 12 words, typed in. */
export async function signInWithWords(p, words) {
  await p.click('#btn-restore');
  await waitView(p, 'view-restore');
  await p.type('#restore-input', words.join(' '));
  await p.click('#restore-form button.primary');
}

/**
 * A new vault with the 12 words alone (no passkey: "Use a recovery phrase instead"), from the
 * welcome screen to its notes. Returns the words.
 */
export async function createVault(p) {
  await waitView(p, 'view-welcome');
  await p.click('#btn-create');
  await p.waitForFunction(() => !document.getElementById('view-passkey').hidden || !document.getElementById('view-phrase').hidden, { polling: 50 });
  if (await p.evaluate(() => !document.getElementById('view-passkey').hidden)) await p.click('#passkey-alt');
  await waitView(p, 'view-phrase');
  const words = await phraseWords(p);
  await p.click('#phrase-saved');
  await p.click('#phrase-continue');
  await confirmWords(p, words);
  await waitView(p, 'view-notes', 60000);
  return words;
}

/** Into the vault with its 12 words, from the welcome screen; "Not now" to a passkey. */
export async function openVault(p, words) {
  await waitView(p, 'view-welcome');
  await signInWithWords(p, words);
  await p.waitForFunction(() => !document.getElementById('view-notes').hidden || !document.getElementById('view-passkey').hidden, { timeout: 60000, polling: 50 });
  if (await p.evaluate(() => !document.getElementById('view-passkey').hidden)) await p.click('#passkey-alt');
  await waitView(p, 'view-notes', 60000);
}
