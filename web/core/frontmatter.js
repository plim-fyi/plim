// A note's frontmatter (#584): a YAML block at its very start, between two `---` lines, holding
// its title and its tags:
//
//   ---
//   title: Leg day
//   tags: [gym, gym/legs]
//   ---
//
// Only what Plim needs of YAML is read: `key: value` lines, a value plain, "double-" or
// 'single-quoted', or a list (written on one line, `[a, b]`; a `- a` list under the key, as other
// tools write it, read too). Other lines are kept as they are, never rewritten. Setting a field
// edits only its line: made if it's missing, gone when it's emptied (and the block with it, if
// nothing is left). The terminal client does the same (crates/plim-cli/src/frontmatter.rs, line
// for line); web/tests/fixtures/frontmatter.json holds the cases both pass.
import { byCodePoints, tagLine, tagName, tagsIn } from './tags.js';
import { titleFromLine } from './title.js';

const FENCE = /^---[ \t]*$/;
const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*)|[ \t]*)$/;
const ITEM = /^[ \t]*-(?:[ \t]+(.*)|[ \t]*)$/;

/**
 * The note's block, or null if it has none: { end, fields } — `end` the offset just past its
 * closing `---` line (and that line's break), `fields` each key's lines [{ key, value, from, to,
 * items }] in order (`from`–`to`: line indexes in the block, its first line 0 after the opening
 * fence; `items`: a `- a` list's, else null).
 */
export function parseBlock(text) {
  if (!/^---[ \t]*(\n|$)/.test(text)) return null;
  const lines = text.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  let end = 0;
  for (let i = 0; i <= close; i++) end += lines[i].length + 1;
  end = Math.min(end, text.length);
  const inner = lines.slice(1, close);
  const fields = [];
  for (let i = 0; i < inner.length; i++) {
    const m = inner[i].match(KEY);
    if (m) {
      fields.push({ key: m[1], value: (m[2] ?? '').trim(), from: i, to: i + 1, items: null });
      continue;
    }
    const item = inner[i].match(ITEM);
    const last = fields.at(-1);
    if (item && last && last.to === i && last.value === '') {
      (last.items ??= []).push(scalar((item[1] ?? '').trim()));
      last.to = i + 1;
    }
  }
  return { end, fields, inner };
}

/** A plain or quoted scalar's text: "a \"b\"" is `a "b"`; 'it''s' is `it's`; a plain one without a ` #comment`. */
function scalar(v) {
  if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') {
    return v.slice(1, -1).replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  }
  if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") return v.slice(1, -1).replaceAll("''", "'");
  return v.replace(/[ \t]+#.*$/, '').trim();
}

/** A one-line list's items: `[a, "b, c", 'd']` → a, b, c, d. Null if `v` isn't one. */
function flowList(v) {
  if (!(v.startsWith('[') && v.endsWith(']'))) return null;
  const out = [];
  let cur = '';
  let quote = null;
  const body = v.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < body.length) cur += body[++i];
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s !== '').map(scalar);
}

/** A field's value as a list: a one-line list, a `- a` list, or a single value ("gym, legs" two). */
function listOf(f) {
  if (f.items) return f.items;
  if (f.value === '') return [];
  return flowList(f.value) ?? scalar(f.value).split(/[\s,]+/).filter(Boolean);
}

/** The note's title and tags as its block has them: { title, tags } (each null without a block or that field). */
export function readFrontmatter(text) {
  const b = parseBlock(text);
  if (!b) return { title: null, tags: null };
  const title = b.fields.find((f) => f.key === 'title');
  const tags = b.fields.find((f) => f.key === 'tags');
  const t = title && !title.items ? scalar(title.value).trim() : '';
  return { title: t || null, tags: tags ? tagsFrom(listOf(tags)) : null };
}

/** Tag names, as written in a list ("#Gym", "gym/legs"): each as kept, once, in order; any that isn't a tag left out. */
function tagsFrom(items) {
  const out = [];
  for (const it of items) {
    const n = tagName(it);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The note's text after its block (all of it, without one). */
export const bodyOf = (text) => text.slice(parseBlock(text)?.end ?? 0);

/** Where the note's text after its block starts (0 without one). */
export const bodyStart = (text) => parseBlock(text)?.end ?? 0;

// YAML that a plain scalar can't be: these first, or these anywhere.
const PLAIN_FIRST = /^[^\s\-?:,[\]{}#&*!|>'"%@`]/;
const RESERVED = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;

/** `s` as a YAML scalar: plain where that reads back as `s`, else double-quoted. In a list (`flow`), no `, [ ] { }` plain. */
export function yamlScalar(s, flow = false) {
  const plain = s !== '' && PLAIN_FIRST.test(s) && !/[ \t]$/.test(s) && !s.includes(': ') && !s.endsWith(':')
    && !s.includes(' #') && !/[\n"\\]/.test(s) && !RESERVED.test(s) && !(flow && /[,[\]{}]/.test(s));
  return plain ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * `text` with its block's `key` set to `value` (a YAML value as written, null: none): its line
 * replaced in place, or made (a title first, anything else last; the block made, if there's
 * none), or taken out (and the block, if that leaves it empty).
 */
function setField(text, key, value) {
  const b = parseBlock(text);
  if (!b) {
    if (value === null) return text;
    return `---\n${key}: ${value}\n---\n${text}`;
  }
  const inner = [...b.inner];
  const f = b.fields.find((x) => x.key === key);
  if (f) {
    if (value === null) inner.splice(f.from, f.to - f.from);
    else inner.splice(f.from, f.to - f.from, `${key}: ${value}`);
  } else if (value !== null) {
    if (key === 'title') inner.unshift(`${key}: ${value}`);
    else inner.push(`${key}: ${value}`);
  } else return text;
  const rest = text.slice(b.end);
  if (!inner.some((l) => l.trim() !== '')) return rest;
  // (The closing fence's line break: kept as it was; none if the text ended there.)
  const closed = text.slice(0, b.end).endsWith('\n') ? '---\n' : '---';
  return `---\n${inner.join('\n')}\n${closed}${rest}`;
}

/** `text` with each of `fields` set, `{ key: value }`: a YAML value as written, or null to take it out (export.js). */
export function setFields(text, fields) {
  return Object.entries(fields).reduce((t, [key, value]) => setField(t, key, value), text);
}

/** `text` with its title `title` (empty: no title field). */
export function setTitle(text, title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return setField(text, 'title', t ? yamlScalar(t) : null);
}

/** `text` with its tags `tags` (each as tagName takes it, once, in this order; none: no tags field), on one line. */
export function setTags(text, tags) {
  const names = tagsFrom(tags);
  return setField(text, 'tags', names.length ? `[${names.map((t) => yamlScalar(t, true)).join(', ')}]` : null);
}

/** `text` with `tag` among its tags, after the others; null if it has it already (or it isn't a tag). */
export function addTag(text, tag) {
  const n = tagName(tag);
  const have = readFrontmatter(text).tags ?? [];
  if (!n || have.includes(n)) return null;
  return setTags(text, [...have, n]);
}

/** `text` without `tag` among its tags; null if it isn't there. */
export function removeTag(text, tag) {
  const n = tagName(tag) ?? String(tag).toLowerCase();
  const have = readFrontmatter(text).tags ?? [];
  if (!have.includes(n)) return null;
  return setTags(text, have.filter((t) => t !== n));
}

/** A note's title: its block's, else its first non-empty line after the block, without its marks. */
export function noteTitle(text) {
  const { title } = readFrontmatter(text);
  if (title) return title;
  const line = bodyOf(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return titleFromLine(line);
}

/** A note's tags (for the index: sorted, each once): its block's; without a block, none. */
export function noteTags(text) {
  return [...(readFrontmatter(text).tags ?? [])].sort(byCodePoints);
}

/**
 * A note as it was before frontmatter (#582), moved into a block: its first non-empty line its
 * title (out of the text), the lines of only tags right under it out too, and every tag it had
 * (`#word`s anywhere, as tagsIn reads them) its tags; a `#word` in a sentence stays, as text. A
 * note that has a block already, or nothing to move: as it is.
 */
export function toFrontmatter(text) {
  if (parseBlock(text)) return text;
  const tags = tagsIn(text);
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim() !== '');
  if (i < 0) return text;
  const title = titleFromLine(lines[i].trim());
  let j = i + 1;
  while (j < lines.length && tagLine(lines[j])) j++;
  while (j < lines.length && lines[j].trim() === '' && j < lines.length - 1) j++; // (the blank line after them)
  const body = lines.slice(j).join('\n');
  return setTags(setTitle(body, title), tags);
}

/**
 * `text` without a second copy of its block right after the first (two devices moving the same
 * note at once, #582: both blocks merge in), or null if it has none.
 */
export function withoutRepeatedBlock(text) {
  const end = bodyStart(text);
  if (!end) return null;
  const first = text.slice(0, end);
  const rest = text.slice(end);
  const again = bodyStart(rest);
  if (!again) return null;
  const second = rest.slice(0, again);
  // (The same block, or the same but for where its last line ends.)
  return second.replace(/\n?$/, '\n') === first.replace(/\n?$/, '\n') ? first + rest.slice(again) : null;
}

/** How much of a note's start its title is read from (a block longer than this: its first line). */
export const TITLE_HEAD = 16384;

/** Whether your notes have been moved to frontmatter (#582): the index's mark, which `plim` reads too. */
export const movedToFrontmatter = (indexDoc) => indexDoc.getMap('format').get('frontmatter') === true;
