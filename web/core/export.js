// Export (#47): your notes as plain Markdown files, made here from the decrypted text, never on
// the server. A whole vault as a zip (ui/export.js), one note as a file, and `plim export <dir>`
// in the terminal: the same names and the same text (tests/fixtures/export.json keeps the two in
// step).
//
// A note's file is its text as written, with three more fields in its frontmatter: `created` and
// `updated` (UTC, to the second) and `id`, so another app (Obsidian reads them, as it reads
// `tags:`) or a later import knows when it was made and which note it was; and `shared: true` for
// a note someone shared with you.
import { noteTitle, setFields, yamlScalar } from './frontmatter.js';

/** A time (ms) as the export writes it: UTC to the second, `2026-11-02T14:03:05Z`; null for none. */
export const isoTime = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/** A note's text as its file holds it. */
export function exportText(text, { created = 0, updated = 0, id = null, shared = false } = {}) {
  const at = (ms) => (isoTime(ms) ? yamlScalar(isoTime(ms)) : null);
  return setFields(String(text ?? ''), {
    created: at(created), updated: at(updated), id: id ? yamlScalar(String(id)) : null, shared: shared ? 'true' : null,
  });
}

// Names every system takes: no / \ : * ? " < > |, no control characters, no name Windows keeps
// for a device, not ending in a dot or space, at most 120 bytes of UTF-8 (a few to spare under the
// 255 most file systems allow, for " (2)" and ".md").
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_BYTES = 120;
const te = new TextEncoder();

/** A note's title as the start of a file name (without `.md`). */
export function fileBase(title) {
  let s = String(title ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:]/g, '-')
    .replace(/[*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (te.encode(s).length > MAX_BYTES) {
    const chars = [...s];
    while (chars.length && te.encode(chars.join('')).length > MAX_BYTES) chars.pop();
    s = chars.join('').replace(/[.\s]+$/, '');
  }
  if (!s) return 'Untitled';
  return RESERVED.test(s) ? `${s}_` : s;
}

/**
 * The file each note goes in: `[{ id, title, created, deleted }]` → Map id → path (`Name.md`, or
 * `deleted/Name.md` for one in Recently deleted). Two notes with the same name (letter case aside,
 * as macOS and Windows compare): the older keeps it, the next is `Name (2).md`, and so on.
 */
export function filePaths(notes) {
  const order = [...notes].sort((a, b) => (a.created || 0) - (b.created || 0) || String(a.id).localeCompare(String(b.id)));
  const taken = new Set();
  const out = new Map();
  for (const n of order) {
    const dir = n.deleted ? 'deleted/' : '';
    const base = fileBase(n.title);
    let path = `${dir}${base}.md`;
    for (let i = 2; taken.has(path.toLowerCase()); i++) path = `${dir}${base} (${i}).md`;
    taken.add(path.toLowerCase());
    out.set(n.id, path);
  }
  return out;
}

/** A note's title for its file name: its own (frontmatter, else first line), else the list's. */
export const exportTitle = (text, listTitle = '') => noteTitle(String(text ?? '')) || listTitle || '';

// ---- a zip, stored (no compression: text is small, and a stored zip needs no library) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the zip's, IEEE 802.3) of `bytes`. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A time (ms) as a zip's DOS date and time, in this device's local time (as unzip tools show it). */
function dosTime(ms) {
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Files `[{ path, text, time }]` as one zip (a Uint8Array): each stored as it is, its name in
 * UTF-8 (flagged so), its time the note's last edit.
 */
export function zipFiles(files) {
  if (files.length > 0xffff) throw new Error('too many notes for one zip');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = te.encode(f.path);
    const data = typeof f.text === 'string' ? te.encode(f.text) : f.text;
    const crc = crc32(data);
    const { time, date } = dosTime(f.time);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed: 2.0
    local.setUint16(6, 0x0800, true); // the name is UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // central directory entry
    entry.setUint16(4, 0x0314, true); // made by: Unix, 2.0 (its permissions in the external attributes)
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The zip's own name: `plim-notes-2026-11-02.zip` (this device's date). */
export function zipName(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `plim-notes-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.zip`;
}
