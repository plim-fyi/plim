// A note's markdown as a page (#283): the editor's own parser (markdown.js: the same
// dialect, tables, tasks and strikethrough included) read into a tree of plain nodes, which
// toDOM makes into elements — never HTML text, so what a note says is never markup: HTML in
// a note is shown as the text it is, and a link is a link only with an address worth
// following. Every block carries where it is in the note (data-from, data-to), and every piece
// of text where its characters came from ({ text, from, to }, toDOM's `sources`): a tap on a word
// opens the editor at that word, a task's box toggles it, and switching between the page and the
// editor keeps the line you were looking at where it was on screen (#302).
import { SAFE_URL, markdown } from './markdown.js'; // (what may be a link: the editor's rule, the page's too, #517)
import { bodyStart } from '../core/frontmatter.js';

/** A node of the page: an element, or text. */
export const el = (tag, attrs, ...children) => ({ tag, attrs: attrs ?? {}, children: children.flat() });
/**
 * Text of the page, and the note's text it came from: `from`–`to`. Usually the same characters
 * (to - from = its length); not for an entity (`&amp;` → "&") or an indented code block's lines.
 */
export const txt = (text, from, to = from + text.length) => ({ text, from, to });
const isText = (n) => typeof n === 'string' || n.text != null;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * The note's text as a list of block nodes. Its frontmatter (#584) isn't drawn (the note's header
 * shows it): blanked, so every position after it stays where it is. A `#word` is text.
 */
export function render(text) {
  const start = bodyStart(text);
  if (start) text = text.slice(0, start).replace(/[^\n]/g, ' ') + text.slice(start);
  const tree = markdown.parser.parse(text);
  return blocks(tree.topNode, text);
}

/** The blocks under `node`: its block children, each rendered. Text outside blocks (there is none) is dropped. */
function blocks(node, text) {
  const out = [];
  for (let n = node.firstChild; n; n = n.nextSibling) {
    const b = block(n, text);
    if (b) out.push(b);
  }
  return out;
}

const ranged = (n, attrs = {}) => ({ 'data-from': String(n.from), 'data-to': String(n.to), ...attrs });

function block(n, text) {
  const { name } = n;
  if (name === 'Paragraph') return el('p', ranged(n), inline(n, text));
  const h = /^ATXHeading([1-6])$/.exec(name);
  if (h) return el(`h${h[1]}`, ranged(n), trimmed(inline(n, text)));
  if (name === 'Blockquote') return el('blockquote', ranged(n), blocks(n, text));
  if (name === 'BulletList') return el('ul', ranged(n), blocks(n, text));
  if (name === 'OrderedList') {
    const first = n.firstChild?.getChild('ListMark');
    const start = first ? parseInt(text.slice(first.from, first.to), 10) : 1;
    return el('ol', ranged(n, start !== 1 ? { start: String(start) } : {}), blocks(n, text));
  }
  if (name === 'ListItem') return listItem(n, text);
  if (name === 'FencedCode' || name === 'CodeBlock') return codeBlock(n, text);
  if (name === 'HorizontalRule') return el('hr', ranged(n));
  if (name === 'Table') return table(n, text);
  if (name === 'HTMLBlock') return el('p', ranged(n), txt(text.slice(n.from, n.to), n.from)); // (as the text it is)
  if (name === 'ListMark' || name === 'QuoteMark') return null;
  // Anything else at block level: its text, so nothing of the note goes missing.
  return el('p', ranged(n), txt(text.slice(n.from, n.to), n.from));
}

/** A list item: its blocks; a task (`- [ ] …`) gets a box, which carries the marker's place for toggling. */
function listItem(n, text) {
  const task = n.getChild('Task');
  if (!task) return el('li', ranged(n), blocks(n, text));
  const marker = task.getChild('TaskMarker');
  const done = /x/i.test(text.slice(marker.from, marker.to));
  const box = el('input', { type: 'checkbox', 'data-from': String(marker.from), 'data-to': String(marker.to), ...(done ? { checked: '' } : {}) });
  // What follows the task on the item: nested lists and more.
  const rest = [];
  for (let c = task.nextSibling; c; c = c.nextSibling) {
    const b = block(c, text);
    if (b) rest.push(b);
  }
  return el('li', ranged(n, { class: done ? 'task done' : 'task' }), el('label', {}, box, inline(task, text, marker.to)), rest);
}

function codeBlock(n, text) {
  const info = n.getChild('CodeInfo');
  const lang = info ? text.slice(info.from, info.to).trim().match(/^[\w.+-]+/)?.[0] : null;
  const parts = n.getChildren('CodeText');
  let code = parts.map((c) => text.slice(c.from, c.to)).join('');
  if (n.name === 'CodeBlock') code = code.replace(/^ {1,4}/gm, ''); // (indented: its indent isn't the code's)
  code = code.replace(/\n$/, '');
  const from = parts[0]?.from ?? n.from, to = parts.at(-1)?.to ?? n.from;
  return el('pre', ranged(n), el('code', lang ? { class: `language-${lang}` } : {}, txt(code, from, Math.max(from, to - (to > from && text[to - 1] === '\n' ? 1 : 0)))));
}

/**
 * A table row's cells, by its pipes (#352): an empty one ("| | Planned |") has no node of its own,
 * so it's null here, in its place, not dropped (the cells after it would move a column left).
 * What's outside the outer pipes is a cell only if there's text there ("a | b").
 */
function rowCells(row, text) {
  const pipes = row.getChildren('TableDelimiter').map((d) => d.from);
  const cells = row.getChildren('TableCell');
  const edges = [row.from - 1, ...pipes, row.to];
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i] + 1, to = edges[i + 1];
    const cell = cells.find((c) => c.from >= from && c.to <= to) ?? null;
    if (!cell && (i === 0 || i === edges.length - 2) && !text.slice(from, to).trim()) continue;
    out.push(cell);
  }
  return out;
}

/** A table: the header's cells as th, the rows' as td, each aligned as the "|---|" row says. */
function table(n, text) {
  const aligns = [];
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'TableDelimiter' || c.parent?.name !== 'Table') continue;
    // The "|---|" row (the delimiter that spans a whole line, not a cell's pipe).
    const row = text.slice(c.from, c.to);
    if (!/-/.test(row)) continue;
    const cells = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
    for (const cell of cells) {
      const t = cell.trim();
      aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null);
    }
    break;
  }
  const cellsOf = (row, tag) => rowCells(row, text).map((c, i) => el(tag, aligns[i] ? { class: aligns[i] } : {}, c ? inline(c, text) : []));
  const head = n.getChild('TableHeader');
  const body = n.getChildren('TableRow').map((r) => el('tr', ranged(r), cellsOf(r, 'td')));
  return el('table', ranged(n), head ? el('thead', {}, el('tr', ranged(head), cellsOf(head, 'th'))) : [], body.length ? el('tbody', {}, body) : []);
}

/**
 * The inline content of `n`, from `at` (its start, or after a task's marker): its text, with
 * emphasis, code and links as elements, marks left out, escapes and entities as the character
 * they stand for. Anything else is its text as typed (an image, an HTML tag).
 */
function inline(n, text, at = n.from, end = n.to) {
  const out = [];
  let pos = at;
  // (Text next to text, character for character the note's, is one piece: one text node on the page.)
  const push = (s, from, to = from + s.length) => {
    if (!s) return;
    const last = out[out.length - 1];
    const exact = (t) => t.to - t.from === t.text.length;
    if (last?.text != null && last.to === from && exact(last) && to - from === s.length) {
      last.text += s;
      last.to = to;
    } else out.push(txt(s, from, to));
  };
  // The note's own text from `from` to `to`, as it is (a `#word` too: tags are the frontmatter's, #584).
  const pushText = (from, to) => push(text.slice(from, to), from);
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.from < at || c.to > end) continue;
    pushText(pos, c.from);
    pos = c.to;
    const { name } = c;
    if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark' || name === 'HeaderMark' || name === 'QuoteMark' || name === 'LinkMark') {
      // Marks: not shown, nor the space after a "#" or a "> " (a quote's, inside a paragraph that runs on).
      if ((name === 'QuoteMark' || name === 'HeaderMark') && text[c.to] === ' ') pos = c.to + 1;
      continue;
    }
    if (name === 'Emphasis') out.push(el('em', {}, inline(c, text)));
    else if (name === 'StrongEmphasis') out.push(el('strong', {}, inline(c, text)));
    else if (name === 'Strikethrough') out.push(el('s', {}, inline(c, text)));
    else if (name === 'InlineCode') out.push(el('code', {}, codeSpan(c, text)));
    else if (name === 'Link') out.push(...link(c, text));
    else if (name === 'Autolink' || name === 'URL') {
      const url = name === 'URL' ? c : c.getChild('URL');
      const href = url ? text.slice(url.from, url.to) : '';
      if (SAFE_URL.test(href)) out.push(el('a', { href }, txt(href, url.from)));
      else push(text.slice(c.from, c.to), c.from);
    } else if (name === 'HardBreak') out.push(el('br', {}));
    else if (name === 'Escape') push(text.slice(c.from + 1, c.to), c.from + 1);
    else if (name === 'Entity') push(entity(text.slice(c.from, c.to)), c.from, c.to);
    else push(text.slice(c.from, c.to), c.from); // (an image, an HTML tag, anything new: as typed)
  }
  pushText(pos, end);
  return out;
}

/** A code span's text: between its backticks, one space at each end dropped (as markdown reads it). */
/** Inline content without whitespace at its ends (a heading's, which may close with "#"s). */
function trimmed(nodes) {
  const out = [...nodes];
  const first = out[0];
  if (first?.text != null) {
    const cut = first.text.length - first.text.replace(/^\s+/, '').length;
    out[0] = txt(first.text.slice(cut), first.from + cut, first.to);
  }
  const l = out.length - 1, last = out[l];
  if (last?.text != null) {
    const cut = last.text.length - last.text.replace(/\s+$/, '').length;
    out[l] = txt(last.text.slice(0, last.text.length - cut), last.from, last.to - cut);
  }
  return out.filter((x) => x.text !== '');
}

function codeSpan(c, text) {
  const marks = c.getChildren('CodeMark');
  let from = marks[0]?.to ?? c.from, to = marks[marks.length - 1]?.from ?? c.to;
  const s = text.slice(from, to);
  if (s.length > 2 && s.startsWith(' ') && s.endsWith(' ') && s.trim()) (from += 1), (to -= 1);
  return txt(text.slice(from, to), from);
}

/** A link: its text (between its "[" and "]"), to its address when that's one to follow; else the text alone. */
function link(c, text) {
  const url = c.getChild('URL');
  const href = url ? text.slice(url.from, url.to) : '';
  const marks = c.getChildren('LinkMark');
  const inner = inline(c, text, marks[0]?.to ?? c.from, marks[1]?.from ?? c.to);
  return SAFE_URL.test(href) ? [el('a', { href }, inner)] : inner;
}

function entity(s) {
  const m = /^&(#x([0-9a-f]+)|#(\d+)|(\w+));$/i.exec(s);
  if (!m) return s;
  if (m[2] || m[3]) {
    const code = m[2] ? parseInt(m[2], 16) : parseInt(m[3], 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : s;
  }
  return ENTITIES[m[4].toLowerCase()] ?? s;
}

// ---------- out ----------

/**
 * The nodes as elements, in a fragment. `sources`, if given, gets each text node made, in order,
 * with the note's text it came from: `{ node, from, to }` (ui/reading.js maps places with them).
 */
export function toDOM(nodes, doc = document, sources = null) {
  const frag = doc.createDocumentFragment();
  const add = (parent, node) => {
    if (typeof node === 'string') return parent.append(doc.createTextNode(node));
    if (node.text != null) {
      const t = doc.createTextNode(node.text);
      sources?.push({ node: t, from: node.from, to: node.to });
      return parent.append(t);
    }
    const e = doc.createElement(node.tag);
    for (const [k, v] of Object.entries(node.attrs)) e.setAttribute(k, v);
    for (const c of node.children) add(e, c);
    parent.append(e);
  };
  for (const n of nodes) add(frag, n);
  return frag;
}

const VOID = new Set(['br', 'hr', 'input']);
const escape = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/** The nodes as HTML text (for tests and tools; the page itself is built by toDOM). */
export function toHTML(nodes) {
  return nodes.map((n) => {
    if (isText(n)) return escape(n.text ?? n);
    const attrs = Object.entries(n.attrs).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escape(v)}"`)).join('');
    return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${toHTML(n.children)}</${n.tag}>`;
  }).join('');
}
