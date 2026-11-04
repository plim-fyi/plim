// Searching notes (#24): on this device, over the notes' text (the server can't read it, so it
// can't search it). A search is words; a note matches when every word is in it, as part of a
// word or whole, whatever its case or accents ("cafe" finds "Café"). What matched is kept as
// ranges of the note's own text, for the list's lines and for the note's highlights.

/**
 * `s` folded for matching: lower case, accents off. `map[i]` is where folded character `i`
 * came from in `s` (`map[folded.length]` is `s.length`), so a match can be put back on `s`.
 */
export function fold(s) {
  let text = '';
  const map = [];
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    text += f;
    i += ch.length;
  }
  map.push(s.length);
  return { text, map };
}

/** A search's words, folded, each once (longest first: a shorter one inside it adds nothing). */
export function queryWords(q) {
  const words = [...new Set(fold(q ?? '').text.split(/\s+/).filter(Boolean))];
  return words.sort((a, b) => b.length - a.length);
}

/**
 * Where `words` are in `s`: ranges of `s` (`[from, to)`), in order, those that touch joined.
 * `folded`: fold(s), when it's already made.
 */
export function findAll(s, words, folded = fold(s)) {
  const { text, map } = folded;
  const hits = [];
  for (const w of words) {
    for (let at = text.indexOf(w); at !== -1; at = text.indexOf(w, at + w.length)) hits.push([map[at], map[at + w.length]]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else out.push([...h]);
  }
  return out;
}

const LINE_MAX = 140; // (a line longer than this is cut down around its first match)

/**
 * A note that has every word, as the list shows it: how many places matched, whether its title
 * has every word, and its first `lines` lines with a match (each cut to about LINE_MAX, the
 * match in sight, its ranges on what's shown). Null when a word isn't in it.
 */
export function matchNote(title, text, words, { lines = 2 } = {}) {
  if (!words.length) return null;
  const folded = fold(text);
  const ft = fold(title ?? '').text;
  if (!words.every((w) => folded.text.includes(w) || ft.includes(w))) return null;
  const ranges = findAll(text, words, folded);
  const shown = [];
  let lineStart = 0, titleLine = true;
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length;
    if (shown.length < lines && line.trim()) {
      const inLine = ranges.filter(([a, b]) => a < lineEnd && b > lineStart).map(([a, b]) => [Math.max(a, lineStart) - lineStart, Math.min(b, lineEnd) - lineStart]);
      if (inLine.length && !titleLine) shown.push(cut(line, inLine)); // (not the first line: that's the title, shown already)
      titleLine = false;
    }
    lineStart = lineEnd + 1;
  }
  // A match in the title alone: the title's line is all there is to show.
  return { count: ranges.length, inTitle: words.every((w) => ft.includes(w)), lines: shown };
}

/** A line cut down to about LINE_MAX around its first match, its ranges moved with it ("…" where cut). */
function cut(line, ranges) {
  const trimmed = line.trimStart();
  let off = line.length - trimmed.length;
  let text = trimmed.trimEnd();
  if (text.length > LINE_MAX) {
    const first = ranges[0][0] - off;
    const start = Math.max(0, Math.min(first - 30, text.length - LINE_MAX));
    const piece = text.slice(start, start + LINE_MAX);
    text = (start > 0 ? '…' : '') + piece + (start + LINE_MAX < text.length ? '…' : '');
    off += start - (start > 0 ? 1 : 0);
  }
  const shift = ranges.map(([a, b]) => [a - off, b - off]).filter(([a, b]) => b > 0 && a < text.length).map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)]);
  return { text, ranges: shift };
}

/** Results in order: those with every word in the title first, then as they came (the list's order). */
export const ranked = (results) => [...results.filter((r) => r.match.inTitle), ...results.filter((r) => !r.match.inTitle)];
