// Type / for a menu (#311): the rules both editors share (the menu itself: slashmenu.js).
//
// The `/` is always typed into the note as a real character; the menu only offers to replace it
// (and what's typed after it) with a command's text. Ignored, it changes nothing: markdown that
// uses `/` (paths, addresses, `and/or`, `</div>`) is never touched. So it opens only where a
// command is likely meant: a `/` you type at a line's start or after a space, not in code.
import { now as clockNow } from '../core/clock.js';

const pad = (n) => String(n).padStart(2, '0');

/** The local calendar day of `d`, as 2026-10-09 (not toISOString's: that's the day in UTC). */
export function isoDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The time of `d` on a 12-hour clock: 2:32 PM, 12:05 AM. */
export function clockTime(d) {
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The date and time of `d`, as a new note's first line has it and Date and time puts in: 2026-10-09 2:32 PM. */
export function stamp(d) {
  return `${isoDay(d)} ${clockTime(d)}`;
}

/** The day before `d`'s, by the calendar (a day with a clock change is 23 or 25 hours long). */
export function dayBefore(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12);
}

// What the menu offers. `text(now)` is what a pick puts in, at the moment of the pick; aliases
// are other words that find it. More can join (tasks, tables, images) as more of these.
export const COMMANDS = [
  { id: 'today', label: 'Today', aliases: ['date'], text: (d) => isoDay(d) },
  { id: 'now', label: 'Now', aliases: ['time'], text: (d) => clockTime(d) },
  { id: 'yesterday', label: 'Yesterday', aliases: [], text: (d) => isoDay(dayBefore(d)) },
  { id: 'datetime', label: 'Date and time', aliases: ['timestamp'], text: (d) => stamp(d) },
];

/** The time now, as the server's clock has it (a device's own can be wrong), in this device's time zone. */
export const localNow = () => new Date(clockNow());

/**
 * The commands what's typed after the `/` finds, best first: its name starting with it, then an
 * alias, then a later word of its name (`/t`: Today, Now, Date and time). Case doesn't matter
 * (a phone capitalises the first letter of a line). Nothing typed yet: all of them.
 */
export function matching(query, commands = COMMANDS) {
  const q = query.toLowerCase();
  const rank = (c) => {
    const label = c.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (c.aliases.some((a) => a.startsWith(q))) return 1;
    if (label.split(' ').some((_, i, words) => words.slice(i).join(' ').startsWith(q))) return 2;
    return 3;
  };
  return commands.map((c) => [rank(c), c]).filter(([r]) => r < 3).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

// What's typed after the `/` is a word or two of a command's name: no longer than this.
const QUERY_MAX = 24;

/** What's been typed after the `/` at `slash`, the cursor at `cursor`; null when that's no longer a command being typed. */
export function queryAt(text, slash, cursor) {
  if (text[slash] !== '/' || cursor <= slash || cursor - slash - 1 > QUERY_MAX) return null;
  const q = text.slice(slash + 1, cursor);
  return q.includes('\n') ? null : q;
}

// A fence's line (CommonMark): up to three spaces, then three or more backticks or tildes.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Whether `pos` is in code: a fenced block (open above it, or on a fence's own line), or an
 * inline code span open before it on its line. Indented code isn't told apart (it can't be from
 * a nested list's lines without parsing the lists): an offer there costs nothing.
 */
export function inCode(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let open = null; // the fence a block opened with, while in one
  let from = 0;
  while (from < lineStart) {
    let to = text.indexOf('\n', from);
    if (to < 0 || to > lineStart) to = lineStart;
    const m = FENCE.exec(text.slice(from, to).replace(/\r$/, ''));
    if (m) {
      if (!open) {
        if (!(m[1][0] === '`' && m[2].includes('`'))) open = m[1]; // (a backtick fence's info has no backtick)
      } else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
    }
    from = to + 1;
  }
  if (open) return true;
  const before = text.slice(lineStart, pos);
  if (FENCE.test(before)) return true;
  // Backtick runs before it on the line: a run opens a span, the next run of the same length closes it.
  let span = 0;
  for (const run of before.match(/`+/g) ?? []) {
    if (!span) span = run.length;
    else if (run.length === span) span = 0;
  }
  return span > 0;
}

/** Whether a `/` just typed at `pos` opens the menu: at a line's start or after a space, and not in code. */
export function opensAt(text, pos) {
  if (text[pos] !== '/') return false;
  if (pos > 0 && !/\s/.test(text[pos - 1])) return false;
  return !inCode(text, pos);
}

/** The text without a command being typed in it (`/tod` while the menu is open): not taken for a title. */
export function withoutCommand(text, range) {
  return range ? text.slice(0, range.from) + text.slice(range.to) : text;
}

