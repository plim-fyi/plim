// What an app wrote in a note (#389): the connector, when Claude writes, records its editing
// session in the note itself, in the map 'authors' (Yjs client id → { name, connection, session, at }:
// session, its two words, #505, when it says), encrypted like the rest of the note. Every piece of
// text in a Yjs document keeps the client id of the session that typed it, so the app can tell
// Claude's text from yours, on any device.

/** Text an app wrote within the last day, as is shown in the margin, faded after. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

/** The note's app sessions: client id → { name, connection, session?, at } (at: ms). */
function appSessions(ydoc) {
  const out = new Map();
  for (const [id, a] of ydoc.getMap('authors').entries()) {
    const client = Number(id);
    if (Number.isSafeInteger(client) && a && typeof a.name === 'string' && typeof a.at === 'number') out.set(client, a);
  }
  return out;
}

/**
 * The stretches of `ytext` an app wrote since `since` (ms): [{ from, to, name, session, at }], in order,
 * neighbours from the same app's session run together. (Yjs's own items: each one a piece typed together,
 * with the client id of whoever typed it.)
 */
export function appRanges(ytext, since = Date.now() - RECENT_MS) {
  const sessions = appSessions(ytext.doc);
  if (!sessions.size) return [];
  const recent = new Map([...sessions].filter(([, a]) => a.at >= since));
  if (!recent.size) return [];
  const out = [];
  let pos = 0;
  for (let item = ytext._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const len = item.length;
    const a = recent.get(item.id.client);
    if (a) {
      const last = out[out.length - 1];
      if (last && last.to === pos && last.name === a.name && last.session === a.session) {
        last.to = pos + len;
        last.at = Math.max(last.at, a.at);
      } else out.push({ from: pos, to: pos + len, name: a.name, session: a.session, at: a.at });
    }
    pos += len;
  }
  // (Without the line breaks at its ends: an addition at the end starts with one, and the line
  // before it isn't the app's.)
  const text = ytext.toString();
  for (const r of out) {
    while (r.from < r.to && text[r.from] === '\n') r.from++;
    while (r.to > r.from && text[r.to - 1] === '\n') r.to--;
  }
  return out.filter((r) => r.to > r.from);
}

/** "just now", "3 min ago", "2 h ago": when an app wrote, for its mark's title. */
export function ago(at, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

// The apps we know by their product (#482), by a part of the name
// (a connection is named as its app calls itself): each its letter and colour.
const MARKS = [
  ['claude', { letter: 'C', tone: 'claude', color: 'var(--reach-1)' }],
  ['codex', { letter: 'X', tone: 'codex', color: 'var(--reach-2)' }],
  ['cursor', { letter: 'C', tone: 'cursor', color: 'var(--reach-4)' }],
  ['gemini', { letter: 'G', tone: 'gemini', color: 'var(--reach-3)' }],
  ['chatgpt', { letter: 'C', tone: 'chatgpt', color: 'var(--reach-3)' }],
  ['openai', { letter: 'C', tone: 'chatgpt', color: 'var(--reach-3)' }],
];

/**
 * An app's mark (#486): its letter, and its tone for the colour (style.css, [data-tone]). Claude a
 * clay C, Codex a jade X (its own, beside Claude's); the others we know (#482) in colours of their
 * own; another app its initial in a neutral colour, never taken for Claude's.
 */
export function appMark(name) {
  const lower = String(name ?? '').toLowerCase();
  const known = MARKS.find(([part]) => lower.includes(part));
  return known?.[1] ?? { letter: [...String(name ?? '').trim()][0]?.toUpperCase() ?? '?', tone: 'other', color: 'var(--muted)' };
}

/** When each app last wrote in the note: name (as first seen) → ms (#564). */
export function appTimes(ydoc) {
  const out = new Map();
  for (const a of appSessions(ydoc).values()) {
    const key = [...out.keys()].find((k) => k.toLowerCase() === a.name.toLowerCase()) ?? a.name;
    if (a.at > (out.get(key) ?? 0)) out.set(key, a.at);
  }
  return out;
}

/** The latest time an app wrote in the note, and its name (none: null). */
export function lastAppEdit(ydoc) {
  let best = null;
  for (const a of appSessions(ydoc).values()) if (!best || a.at > best.at) best = a;
  return best;
}

/**
 * The apps that wrote in the note between `after` and `upto` (ms), each as whoOf says ("Claude ·
 * amber fox"): for History's versions, until a version's own writer is read (#505).
 */
export function appsBetween(ydoc, after, upto) {
  const names = new Set();
  for (const a of appSessions(ydoc).values()) if (a.at > after && a.at <= upto) names.add(whoOf(a));
  return [...names];
}

/**
 * Who wrote something, in words: an app and its session's two words if it says ("Claude · amber
 * fox", #505), else the app ("Claude"). `w`: a session from the note's authors, or a version's
 * writer ({ name, session }); none, or no name: ''.
 */
export function whoOf(w) {
  if (!w || typeof w.name !== 'string' || !w.name) return '';
  return typeof w.session === 'string' && w.session ? `${w.name} · ${w.session}` : w.name;
}
