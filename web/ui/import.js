// Import (g87d): Settings → Account → Import notes. Files, a folder or a zip picked; what they'd
// make shown first (core/import.js planImport), then, on Import, each note made here: encrypted,
// saved to this device's outbox and uploaded, as a note typed here is. Three at a time, with the
// progress beside the button; what was left out, and why, at the end.
import { now as clockNow } from '../core/clock.js';
import { isNoteFile, isZip, planImport, unzip } from '../core/import.js';
import { DocSync } from '../core/sync.js';
import * as Y from '../vendor/yjs.mjs';
import { $, notesMap, state } from './shared.js';

const AT_ONCE = 3;
const TITLE_MAX = 200;
const ROOM = 64 * 1024; // (a note's text and what wraps it in a blob: under the server's limit by this)

let plan = null;
let running = false;

const word = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

function say(text) {
  const status = $('settings-import-status');
  status.hidden = !text;
  status.textContent = text;
}

/** Whether a note was this one before (export's `id`): it's here, or a note imported from it is. */
function isHere(id) {
  const notes = notesMap();
  const own = notes.get(id);
  if (own && !own.get('purged')) return true;
  for (const m of notes.values()) if (m.get('importedFrom') === id && !m.get('purged')) return true;
  return false;
}

/** The picked files as [{ path, bytes }]: a zip's files in place of the zip. */
async function readPicked(list) {
  const out = [];
  for (const f of list) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const path = f.webkitRelativePath || f.name;
    if (isZip(bytes)) {
      const top = path.includes('/') ? `${path.replace(/\.zip$/i, '')}/` : '';
      for (const e of await unzip(bytes, isNoteFile)) out.push({ path: top + e.path, bytes: e.bytes });
    } else out.push({ path, bytes });
  }
  return out;
}

/** Files picked: read, planned, and what they'd make shown, with Import. */
async function picked(list) {
  if (!list.length || running) return;
  plan = null;
  $('settings-import-confirm').hidden = true;
  say('Reading the files…');
  try {
    const files = await readPicked(list);
    const max = (state.ctx?.maxBlobBytes || 8 * 1024 * 1024) - ROOM;
    plan = planImport(files, { isHere, maxBytes: max, now: clockNow() });
  } catch (e) {
    console.warn('import: could not read the files', e);
    say(`Couldn’t read those files${e?.message ? ` (${e.message})` : ''}.`);
    return;
  }
  const parts = [];
  if (plan.already.length) parts.push(`${word(plan.already.length, 'note')} here already`);
  const why = (w) => plan.skipped.filter((s) => s.why === w).length;
  if (why('too large')) parts.push(`${why('too large')} too large`);
  if (why('empty')) parts.push(`${why('empty')} empty`);
  if (why('not a note')) parts.push(`${word(why('not a note'), 'file')} that ${why('not a note') === 1 ? 'isn’t' : 'aren’t'} Markdown or text`);
  const left = parts.length ? ` Left out: ${parts.join(', ')}.` : '';
  if (!plan.notes.length) {
    say(`Nothing to import.${left}`);
    plan = null;
    return;
  }
  const pics = plan.images ? ` ${word(plan.images, 'note')} ${plan.images === 1 ? 'shows' : 'show'} pictures, which stay behind: only the text comes in.` : '';
  say(`${word(plan.notes.length, 'note')} to import.${left}${pics}`);
  $('settings-import-go').textContent = `Import ${word(plan.notes.length, 'note')}`;
  $('settings-import-confirm').hidden = false;
}

/** Room left in the account for `bytes` more, as the server counts it (null: couldn't ask). */
async function roomFor(bytes) {
  try {
    const a = await state.ctx.api.get('/account');
    // (Ciphertext, base64 aside, and a snapshot of each note besides its first update: about twice.)
    return a.used_bytes + bytes * 2 + 4096 * plan.notes.length <= a.quota_bytes;
  } catch {
    return null;
  }
}

/** One note made: its text saved and uploaded, then its place in the list. 'ok', 'waiting' (on this device, not uploaded), or 'full'. */
async function makeNote(n) {
  const id = crypto.randomUUID();
  let last = null;
  const ctx = { ...state.ctx, onStatus: (docId, s) => ((last = s), state.ctx.onStatus?.(docId, s)) };
  const sync = new DocSync(ctx, id);
  sync.editedThisSession = true; // (a new note: no version of it before its text)
  try {
    sync.ydoc.getText('body').insert(0, n.text);
    await sync.flush();
    const waiting = await sync.hasPending();
    const notes = notesMap();
    state.index.ydoc.transact(() => {
      const fields = [
        ['title', n.title.slice(0, TITLE_MAX)], ['created', n.created], ['updated', n.updated], ['deleted', n.deleted],
        ['tags', n.tags],
      ];
      if (n.from) fields.push(['importedFrom', n.from]);
      if (n.deleted) fields.push(['deletedAt', clockNow()], ['deletedSeen', n.updated]);
      notes.set(id, new Y.Map(fields));
    });
    if (!waiting) return 'ok';
    return last === 'full' ? 'full' : 'waiting';
  } finally {
    sync.close();
  }
}

async function go() {
  if (!plan || running) return;
  if (state.offline || !state.index) return say('Importing needs a connection.');
  running = true;
  const todo = plan;
  plan = null;
  $('settings-import-confirm').hidden = true;
  $('settings-import').disabled = true;
  try {
    const room = await roomFor(todo.bytes);
    if (room === false) return say(`These ${word(todo.notes.length, 'note')} don’t fit in the space your account has left. Make room, or import fewer.`);
    let done = 0, waiting = 0, full = false;
    say(`Importing… 0 of ${todo.notes.length}`);
    const queue = [...todo.notes];
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
      for (let n = queue.shift(); n && !full && state.index; n = queue.shift()) {
        const r = await makeNote(n).catch((e) => (console.warn('import: a note failed', n.path, e), 'failed'));
        if (r === 'full') full = true;
        if (r === 'waiting' || r === 'full') waiting++;
        if (r !== 'failed') done++;
        say(`Importing… ${done} of ${todo.notes.length}`);
      }
    }));
    const parts = [`Imported ${word(done, 'note')}`];
    if (done < todo.notes.length) parts.push(`${todo.notes.length - done} not`);
    let text = `${parts.join(', ')}.`;
    if (full) text += ' Your account is full: the rest weren’t imported.';
    else if (waiting) text += ` ${word(waiting, 'note')} ${waiting === 1 ? 'is' : 'are'} saved on this device and will upload when they can.`;
    if (todo.already.length) text += ` ${word(todo.already.length, 'note')} ${todo.already.length === 1 ? 'was' : 'were'} here already.`;
    const skipped = todo.skipped.filter((s) => s.why !== 'not a note');
    if (skipped.length) text += ` Left out: ${skipped.map((s) => `${s.path} (${s.why})`).join(', ')}.`;
    say(text);
  } finally {
    running = false;
    $('settings-import').disabled = false;
  }
}

/** The pickers' files, then the pickers emptied (so picking the same files again still counts). */
function onPick(e) {
  const files = [...e.target.files];
  e.target.value = '';
  picked(files);
}

$('settings-import').addEventListener('click', () => $('settings-import-files').click());
$('settings-import-folder').addEventListener('click', () => $('settings-import-dir').click());
$('settings-import-files').addEventListener('change', onPick);
$('settings-import-dir').addEventListener('change', onPick);
$('settings-import-go').addEventListener('click', go);
$('settings-import-cancel').addEventListener('click', () => {
  plan = null;
  $('settings-import-confirm').hidden = true;
  say('');
});
