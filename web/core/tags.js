// Tags (#308). Since #584 a note's tags are its frontmatter's (core/frontmatter.js); a tag's name
// (tagName) and the lists of them (tagCounts, tagsByRecent) are here. Reading `#gym` written in a
// note's text (tagsIn) is only for moving a note from before into a block, once (toFrontmatter).
// The terminal client reads them the same way (crates/plim-cli/src/tags.rs: this is it, line for
// line); web/tests/fixtures/tags.json holds the cases both pass.
//
// A tag is `#` and a name: letters, digits, `_` and `-`, in segments joined by single `/`, with
// at least one letter (`#3` isn't a tag), at most 64 characters, `_` and `-` at its end left out
// (`_#u_` is `u`). Before the `#`: a line's start, whitespace, or one of `( [ { * _ ~ " '` (so a
// URL's `#fragment`, `C#` and `&#169;` aren't tags). Not tags: a heading's `# ` (a space after
// it: no name), anything in a fenced code block, in inline code or in a link's address, and an
// escaped `\#`. (Indented code isn't told from an indented line: fence code to keep its `#`s out.)
// Tags are compared, and kept, in lower case.

const NAME_MAX = 64;
const NAME_CHAR = /^[\p{Alphabetic}\p{N}_-]$/u;
const ALPHABETIC = /\p{Alphabetic}/u;
const SPACE = /^\p{White_Space}$/u;

const nameChar = (c) => c !== undefined && NAME_CHAR.test(c);
const boundary = (prev) => prev === undefined || SPACE.test(prev) || '([{*_~"\''.includes(prev);
/** The name of a tag starting at `chars[at]` (after its `#`), and where it ends: [name or null, end]. */
function nameAt(chars, at) {
  let j = at;
  // (A "/" only between two segments: "gym/legs", not "gym/" nor "gym//legs".)
  const nests = (j) => chars[j] === '/' && j > at && chars[j - 1] !== '/' && nameChar(chars[j + 1]);
  while (j < chars.length && (nameChar(chars[j]) || nests(j))) j++;
  const end = j;
  while (j > at && (chars[j - 1] === '_' || chars[j - 1] === '-')) j--; // ("_#u_" is "u")
  const name = chars.slice(at, j).join('');
  const ok = name !== '' && j - at <= NAME_MAX && ALPHABETIC.test(name) && !name.endsWith('/');
  return [ok ? name.toLowerCase() : null, end];
}

/**
 * Where the tags are in a piece of text that isn't code (`before`: the character before it, if
 * any): [{ from, to, name }], `from`–`to` in UTF-16 units (as a string's indexes), `#` included.
 * Inline code and link addresses in it are skipped (render.js gives it text without them).
 */
export function tagRanges(text, before = undefined) {
  const chars = Array.from(text);
  // (Each character's UTF-16 offset, for ranges in the text as JavaScript indexes it.)
  const offsets = [];
  let o = 0;
  for (const c of chars) {
    offsets.push(o);
    o += c.length;
  }
  offsets.push(o);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\') {
      i += 2; // (an escaped character: "\#" isn't a tag)
      continue;
    }
    if (c === '`') {
      // Inline code: from a run of backticks to the next run as long (none: just backticks).
      let run = 0;
      while (chars[i + run] === '`') run++;
      let k = i + run, closed = null;
      while (k < chars.length) {
        if (chars[k] === '`') {
          let r = 0;
          while (chars[k + r] === '`') r++;
          if (r === run) {
            closed = k + r;
            break;
          }
          k += r;
        } else k++;
      }
      i = closed ?? i + run;
      continue;
    }
    if (c === ']' && chars[i + 1] === '(') {
      // A link's address: to its closing parenthesis.
      const p = chars.indexOf(')', i + 2);
      i = p >= 0 ? p + 1 : i + 2;
      continue;
    }
    if (c === '<') {
      // An autolink: <scheme:...>, with no space in it.
      const p = chars.indexOf('>', i + 1);
      if (p >= 0) {
        const inside = chars.slice(i + 1, p);
        if (inside.length && inside.includes(':') && !inside.some((ch) => SPACE.test(ch))) {
          i = p + 1;
          continue;
        }
      }
    }
    if (c === '#' && boundary(i > 0 ? chars[i - 1] : before)) {
      const [name, end] = nameAt(chars, i + 1);
      if (name) {
        let to = end;
        while (to > i + 1 && (chars[to - 1] === '_' || chars[to - 1] === '-')) to--;
        out.push({ from: offsets[i], to: offsets[to], name });
      }
      i = Math.max(end, i + 1);
      continue;
    }
    i++;
  }
  return out;
}

/** A fence that opens or closes a code block: [its character, how many, what follows], or null. */
function fence(line) {
  const indent = line.match(/^ */)[0].length;
  if (indent > 3) return null;
  const t = line.slice(indent);
  const c = t[0];
  if (c !== '`' && c !== '~') return null;
  let run = 0;
  while (t[run] === c) run++;
  if (run < 3) return null;
  const rest = t.slice(run);
  if (c === '`' && rest.includes('`')) return null; // (an info string can't have a backtick)
  return [c, run, rest];
}

/** Code point order (as the terminal client sorts: by UTF-8 bytes, which is the same). */
export const byCodePoints = (a, b) => {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};

/** The tags in a note's text, in lower case, each once, sorted. */
export function tagsIn(body) {
  const found = new Set();
  let open = null; // [char, run] while in a code block
  for (const line of body.split('\n')) {
    const f = fence(line);
    if (open) {
      // In a code block: until a fence of the same character, at least as long, with nothing after it.
      if (f && f[0] === open[0] && f[1] >= open[1] && !f[2].trim()) open = null;
      continue;
    }
    if (f) {
      open = [f[0], f[1]];
      continue;
    }
    for (const t of tagRanges(line)) found.add(t.name);
  }
  return [...found].sort(byCodePoints);
}

/** A tag as typed on its own ("gym", "#Gym", "gym/legs"), as it's kept; null if it isn't one. */
export function tagName(s) {
  const t = s.trim().replace(/^#/, '');
  const chars = Array.from(t);
  const [name, end] = nameAt(chars, 0);
  // (All of it: "gym legs" or "gym!" isn't a tag, nor is "gym/" or "/gym".)
  return name && end === chars.length && Array.from(name).length === chars.length ? name : null;
}

/** Whether `tag` is what's asked for (#539): `query` itself. A tag is a word: "gym" doesn't find "gym/legs". */
export const tagMatches = (tag, query) => tag === query;

/** Whether a line is a line of tags: nothing but tags, separated by spaces. */
export function tagLine(line) {
  const words = line.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => w.startsWith('#') && tagName(w) !== null);
}

/** Each tag and how many of `lists` (each a note's tags) have it (#539: a tag is a word, #gym/legs not counted for #gym): sorted. */
export function tagCounts(lists) {
  const counts = new Map();
  for (const tags of lists) for (const t of new Set(tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => byCodePoints(a, b));
}

/**
 * Each tag and how many of `notes` have it, the most recently used first: by the latest time a
 * note with it was made or edited (`created`, `updated`, ms), so a tag in use comes forward and
 * old ones drift back; the same time, by name. `notes`: [{ tags, created, updated }].
 */
export function tagsByRecent(notes) {
  const at = new Map();
  const counts = new Map();
  for (const n of notes) {
    const when = Math.max(n.updated || 0, n.created || 0);
    for (const t of new Set(n.tags)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
      if (when > (at.get(t) ?? -1)) at.set(t, when);
    }
  }
  return [...counts].sort(([a], [b]) => at.get(b) - at.get(a) || byCodePoints(a, b));
}

/**
 * A note's tags as its row in the list shows them (#350): not the tag picked in the sidebar (the
 * list is already its), the first `max` in their order, and how many more there are.
 */
export function rowTags(tags, picked = null, max = 3) {
  const shown = tags.filter((t) => t !== picked);
  return { tags: shown.slice(0, max), more: Math.max(0, shown.length - max) };
}
