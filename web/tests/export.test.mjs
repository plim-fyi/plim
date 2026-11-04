// Export (#47, core/export.js): file names, a note's file, and the zip, read back as unzip would.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { crc32, exportText, exportTitle, fileBase, filePaths, isoTime, zipFiles, zipName } from '../core/export.js';
import { here, test } from './lib.mjs';

const F = JSON.parse(readFileSync(new URL('fixtures/export.json', here)));

test('export: file names from titles, safe everywhere (the shared cases)', () => {
  for (const [title, want] of F.base) assert.equal(fileBase(title), want, JSON.stringify(title));
  // (At most 120 bytes of UTF-8, cut between characters, never inside one.)
  for (const [title] of F.base) assert.ok(new TextEncoder().encode(fileBase(title)).length <= 120);
});

test('export: two notes with one name, the older keeps it; Recently deleted in deleted/ (the shared cases)', () => {
  for (const [notes, want] of F.paths) assert.deepEqual(Object.fromEntries(filePaths(notes)), want);
});

test('export: a note\'s file, its text with created, updated and id in its frontmatter (the shared cases)', () => {
  for (const [text, meta, want] of F.text) assert.equal(exportText(text, meta), want, JSON.stringify(text));
  assert.equal(isoTime(0), null);
  assert.equal(exportTitle('---\ntitle: From the block\n---\nbody', 'From the list'), 'From the block');
  assert.equal(exportTitle('', 'From the list'), 'From the list');
});

test('export: CRC-32 as zip has it', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // (the standard check value)
  assert.equal(crc32(new Uint8Array()), 0);
});

/** A zip read back: its entries as unzip lists them, from the central directory. */
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(at, true), 0x02014b50, 'central entry');
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true);
    const time = v.getUint16(at + 12, true), date = v.getUint16(at + 14, true);
    const crc = v.getUint32(at + 16, true), size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true), offset = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assert.equal(v.getUint32(offset, true), 0x04034b50, 'local header');
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const raw = bytes.subarray(start, start + v.getUint32(offset + 18, true));
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(crc32(data), crc, `${name}: its CRC`);
    out.push({ name, utf8: Boolean(flags & 0x0800), method, size, text: new TextDecoder().decode(data), time, date });
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

test('export: the zip holds each file as it is, its name in UTF-8, its time the note\'s', () => {
  const when = new Date(2026, 10, 2, 14, 3, 6).getTime(); // (local time, as a zip keeps it)
  const zip = zipFiles([
    { path: 'Leg day.md', text: '---\ntags: [gym]\n---\nsquat', time: when },
    { path: 'deleted/Café.md', text: 'é', time: when },
    { path: 'Empty.md', text: '', time: when },
  ]);
  const got = unzip(zip);
  assert.deepEqual(got.map((e) => [e.name, e.text, e.utf8, e.method]), [
    ['Leg day.md', '---\ntags: [gym]\n---\nsquat', true, 0],
    ['deleted/Café.md', 'é', true, 0],
    ['Empty.md', '', true, 0],
  ]);
  assert.equal(got[1].size, 2); // (é in UTF-8)
  // DOS time: 14:03:06, 2 November 2026.
  assert.equal(got[0].time, (14 << 11) | (3 << 5) | 3);
  assert.equal(got[0].date, ((2026 - 1980) << 9) | (11 << 5) | 2);
  assert.equal(unzip(zipFiles([])).length, 0);
});

test('export: the zip\'s name, by this device\'s date', () => {
  assert.equal(zipName(new Date(2026, 10, 2, 23, 59).getTime()), 'plim-notes-2026-11-02.zip');
});
