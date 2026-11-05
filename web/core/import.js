// Import (g87d): files from elsewhere as notes, made on this device and encrypted as any note is;
// the server only sees new notes. Markdown and text files, picked one by one, as a folder, or in
// a zip (Plim's own export, an Obsidian vault, Bear's Markdown export). What happens to a file:
//
// - Its text: UTF-8, without a byte-order mark, with \n line ends.
// - Its title: its block's; else its first line, when that's a heading or the file's own name (the
//   line moves into the block, as toFrontmatter moves it); else the file's name, the text whole.
//   A file without a block: its `#tags` its tags, as toFrontmatter reads them.
// - Its folders: a tag (`Work/Clients/acme.md` → `work/clients`), with a folder every file is in
//   (the folder picked, a zip's top folder) left out.
// - Export's fields (core/export.js): `created` and `updated` become the note's dates in the list,
//   and leave the text; `id` says which note it was (one that's here already is skipped, so
//   importing twice makes no copies), and leaves the text with `shared`. A note in an export's
//   `deleted/` folder goes back to Recently deleted.
// - Skipped: an empty file, one too big for a note, hidden files and folders (`.obsidian/`,
//   `__MACOSX/`), anything but .md, .markdown and .txt.
import { bodyOf, noteTags, noteTitle, parseBlock, readField, readFrontmatter, setFields, setTags, setTitle, toFrontmatter } from './frontmatter.js';
import { tagName, tagsIn } from './tags.js';
import { titleFromLine } from './title.js';

const te = new TextEncoder();
const NOTE_FILE = /\.(md|markdown|txt)$/i;

/** A file's bytes as a note's text: UTF-8 (a bad byte as U+FFFD), no byte-order mark, \n line ends. */
export function decodeText(bytes) {
  return new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Whether a path is a file to import: a note's extension, nothing hidden on its way. */
export function isNoteFile(path) {
  const parts = String(path).split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p.startsWith('.') || p === '__MACOSX')) return false;
  return NOTE_FILE.test(parts.at(-1));
}

/** The folder every one of `paths` is in (`Vault/`), or '' if they aren't all in one. */
export function commonFolder(paths) {
  const firsts = new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : null)));
  if (firsts.size !== 1 || firsts.has(null)) return '';
  return `${[...firsts][0]}/`;
}

/** A folder's name as a tag's segment: lower case, anything but letters, digits, `_` and `-` a `-`. Null if no tag can come of it. */
function segment(name) {
  const s = name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s && tagName(s) === s ? s : null;
}

/** The tag a file's folders make (`Work/Clients/acme.md` → `work/clients`), or null (no folder, or none a tag). */
export function folderTag(path) {
  const dirs = path.split('/').slice(0, -1).map(segment).filter(Boolean);
  if (!dirs.length) return null;
  const t = dirs.join('/');
  return tagName(t) === t ? t : null;
}

/** A date as a field holds it (`2026-11-02T14:03:05Z`, `2026-11-02`), as ms; null if it isn't one. */
function dateOf(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const IMAGE = /!\[[^\]]*\]\((?!https?:|data:)[^)]+\)|!\[\[[^\]]+\]\]/;

/**
 * One file as a note: { text, title, tags, created, updated, from, deleted, images } — `from` the
 * note it was (export's `id`), `deleted` from an export's `deleted/`, `images` whether it shows
 * pictures from files beside it (not brought in). `path` is from the import's top (its common
 * folder already gone); `now` the time for a note with no dates.
 */
export function noteFromFile(path, raw, now = Date.now()) {
  const name = path.split('/').at(-1).replace(NOTE_FILE, '').trim();
  let text = raw;
  if (!parseBlock(text)) {
    const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    if (/^#{1,6}\s/.test(first) || (first && titleFromLine(first) === name)) text = toFrontmatter(text);
    else text = setTags(setTitle(text, name), tagsIn(text));
  } else if (!readFrontmatter(text).title && name) text = setTitle(text, name);

  const created = dateOf(readField(text, 'created'));
  const updated = dateOf(readField(text, 'updated'));
  const from = readField(text, 'id') || null;
  const exported = from !== null; // (a file Plim's export wrote: its deleted/ is Recently deleted)
  // (A date that isn't one stays in the text, as another app's field.)
  text = setFields(text, {
    ...(created !== null && { created: null }), ...(updated !== null && { updated: null }), id: null, shared: null,
  });
  const folder = folderTag(path);
  if (folder) text = setTags(text, [...(readFrontmatter(text).tags ?? []), folder]);

  const c = Math.min(created ?? updated ?? now, now);
  return {
    text,
    title: noteTitle(text),
    tags: noteTags(text),
    created: c,
    updated: Math.max(Math.min(updated ?? c, now), c),
    from,
    deleted: exported && /^deleted\//.test(path),
    images: IMAGE.test(bodyOf(text)),
  };
}

/**
 * What an import of `files` ([{ path, bytes }]) would do: { notes: [{ path, ...noteFromFile }],
 * skipped: [{ path, why }] ('empty', 'too large', 'not a note'), already: [path] (notes here
 * already: `isHere(id)`), images: how many notes show pictures not brought in, bytes: their
 * text's size }. `maxBytes`: the largest note's text.
 */
export function planImport(files, { isHere = () => false, maxBytes = Infinity, now = Date.now() } = {}) {
  const out = { notes: [], skipped: [], already: [], images: 0, bytes: 0 };
  const wanted = files.filter((f) => {
    if (isNoteFile(f.path)) return true;
    if (!f.path.split('/').some((p) => p.startsWith('.') || p === '__MACOSX')) out.skipped.push({ path: f.path, why: 'not a note' });
    return false;
  });
  const top = commonFolder(wanted.map((f) => f.path));
  for (const f of wanted) {
    const path = f.path.slice(top.length);
    const raw = decodeText(f.bytes);
    if (!raw.trim()) {
      out.skipped.push({ path: f.path, why: 'empty' });
      continue;
    }
    const n = noteFromFile(path, raw, now);
    if (n.from && isHere(n.from)) {
      out.already.push(f.path);
      continue;
    }
    const size = te.encode(n.text).length;
    if (size > maxBytes) {
      out.skipped.push({ path: f.path, why: 'too large' });
      continue;
    }
    out.notes.push({ path: f.path, ...n });
    out.bytes += size;
    if (n.images) out.images++;
  }
  return out;
}

// ---- a zip, read: its files (stored or deflated), from its central directory ----

/** A deflated entry's bytes, inflated (the browser's own DecompressionStream, Node's too). */
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Whether `bytes` start as a zip does. */
export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * A zip's files as [{ path, bytes }], those `want(path)` takes (all, by default; folders never).
 * Stored and deflated entries; a zip64 or encrypted one, or another method, throws.
 */
export async function unzip(bytes, want = () => true) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip');
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 isn’t supported');
  const utf8 = new TextDecoder('utf-8');
  const latin = new TextDecoder('latin1');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('a damaged zip');
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLen);
    // (Names in UTF-8 when flagged so; macOS's and most tools' are UTF-8 unflagged too.)
    let path = flags & 0x0800 ? utf8.decode(nameBytes) : new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
    if (!(flags & 0x0800) && path.includes('\uFFFD')) path = latin.decode(nameBytes);
    path = path.replace(/\\/g, '/').replace(/^\/+/, '');
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/') || !want(path)) continue;
    if (flags & 1) throw new Error('an encrypted zip');
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.push({ path, bytes: data });
    else if (method === 8) out.push({ path, bytes: await inflate(data) });
    else throw new Error(`zip method ${method} isn’t supported`);
  }
  return out;
}
