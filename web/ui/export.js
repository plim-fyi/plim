// Export (#47): every note as a Markdown file, in one zip (Settings → Account → Export all
// notes), or one note as a file (its menu → Download). Made here, from the notes as this device
// decrypts them: the server never sees them in plain text. (The names and the files' text:
// ../core/export.js, which `plim export` follows too.)
import { isOffline } from '../core/api.js';
import { exportText, exportTitle, fileBase, filePaths, zipFiles, zipName } from '../core/export.js';
import { shareOf, syncFor } from './shares.js';
import { $, notesMap, showToast, state } from './shared.js';

const AT_ONCE = 3; // (notes read at the same time, as search reads them)

/** The notes to export: all of them but those deleted for good, with what their files need. */
function exportable() {
  const out = [];
  notesMap().forEach((m, id) => {
    if (m.get('purged')) return;
    const share = shareOf(id);
    out.push({
      id, listTitle: m.get('title') || '', created: m.get('created') || 0, updated: m.get('updated') || 0,
      deleted: Boolean(m.get('deleted')), shared: Boolean(share && share.role !== 'owner'),
    });
  });
  return out;
}

/** A note's text: the open one's as it is; another's from this device's copy, brought up to date when online. Null: couldn't be read. */
async function readText(id) {
  if (state.note?.id === id && state.note.sync?.ydoc) return state.note.sync.ydoc.getText('body').toString();
  let s = null;
  try {
    s = await syncFor(id);
    const here = await s.loadLocal();
    try {
      await s.pull();
    } catch (e) {
      if (!isOffline(e) || !here) throw e;
    }
    return s.ydoc.getText('body').toString();
  } catch (e) {
    console.warn('export: could not read a note', e);
    return null;
  } finally {
    s?.close();
  }
}

/** `bytes` (or text) saved as a file named `name`, as the browser saves downloads. */
function save(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let running = false;

/** Every note in one zip, with its progress in Settings; how many it holds, and the titles it couldn't read. */
export async function exportAll() {
  if (running) return null;
  running = true;
  const button = $('settings-export'), status = $('settings-export-status');
  button.disabled = true;
  status.hidden = false;
  try {
    const notes = exportable();
    const texts = new Map();
    let done = 0;
    status.textContent = `Reading notes… 0 of ${notes.length}`;
    const queue = [...notes];
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
      for (let n = queue.shift(); n; n = queue.shift()) {
        texts.set(n.id, await readText(n.id));
        status.textContent = `Reading notes… ${++done} of ${notes.length}`;
      }
    }));
    const read = notes.filter((n) => texts.get(n.id) !== null);
    const missed = notes.filter((n) => texts.get(n.id) === null).map((n) => n.listTitle || 'Untitled');
    const paths = filePaths(read.map((n) => ({ ...n, title: exportTitle(texts.get(n.id), n.listTitle) })));
    const files = read.map((n) => ({ path: paths.get(n.id), text: exportText(texts.get(n.id), n), time: n.updated }));
    save(zipName(), zipFiles(files), 'application/zip');
    const word = (k) => `${k} ${k === 1 ? 'note' : 'notes'}`;
    status.textContent = missed.length
      ? `Exported ${read.length} of ${word(notes.length)}. Not in it (no copy on this device, and no connection): ${missed.join(', ')}.`
      : `Exported ${word(read.length)}.`;
    return { count: read.length, missed };
  } catch (e) {
    console.warn('export failed', e);
    status.textContent = 'Couldn’t export your notes. Try again.';
    return null;
  } finally {
    button.disabled = false;
    running = false;
  }
}

/** One note as a Markdown file, named for its title. */
export async function downloadNote(id) {
  const m = notesMap().get(id);
  if (!m) return;
  const text = await readText(id);
  if (text === null) return showToast('Couldn’t read this note here: it needs a connection.');
  const share = shareOf(id);
  const meta = { id, created: m.get('created') || 0, updated: m.get('updated') || 0, shared: Boolean(share && share.role !== 'owner') };
  save(`${fileBase(exportTitle(text, m.get('title') || ''))}.md`, exportText(text, meta), 'text/markdown;charset=utf-8');
}

$('settings-export').addEventListener('click', () => exportAll());
