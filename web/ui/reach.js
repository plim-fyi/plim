// Which agents reach a note (#369, #514): every connection reaches the notes shared with agents
// (place 'ai'), and nothing else; tags share nothing. Shown as their marks (the one on their page
// in Settings → Connections) wherever a note shared with agents is: its row, the list's chip, the
// note's bar, its Share dialog. A letter only ever names an agent; never a badge on a tag.

import { appMark } from '../core/authorship.js';
import { NOTEBOOK } from '../core/connections-sync.js';
import { state } from './shared.js';

const SHOWN = 3; // marks at most: past that, the first two and "+N"

/** Your connections, in the order made: { id, name, initial, color }. */
function connections() {
  const map = state.index?.ydoc.getMap('connections');
  if (!map?.size) return [];
  return [...map.entries()]
    .sort(([, a], [, b]) => (a.created ?? 0) - (b.created ?? 0))
    // (Its mark as its marks in a note, #482: Claude's clay C, Codex's jade X.)
    .map(([id, c]) => {
      const mark = appMark(c.name || 'App');
      return { id, name: c.name || 'App', initial: mark.letter, color: mark.color, script: false };
    });
}

/** The connections that reach the notes shared with agents (#514): all of them, each to read and edit. */
export function notebookReach() {
  return connections().map((c) => ({ ...c, role: 'write' }));
}

/** The connections that reach a note in `place`: all of them if it's shared with agents (#514), else none. */
export function noteReach(place) {
  return place === NOTEBOOK ? notebookReach() : [];
}

/**
 * Writers' marks (#552): an agent's or a script's name, as the marks show it. A name that isn't a
 * known agent's (Claude, Codex…) is a script's (`--as "Gym review"`): its badge outlined (#560).
 */
export function writerMarks(names) {
  return names.map((name) => {
    const mark = appMark(name);
    return { id: null, name, initial: mark.letter, color: mark.color, script: mark.tone === 'other' };
  });
}

/** Their names: "Claude", "Claude and Codex", "Claude, Codex and Linear". */
export function agentNames(reach) {
  const names = reach.map((r) => r.name);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The words for it: "Claude reads and writes", "Claude and Linear read and write". */
export function reachWords(reach) {
  if (!reach.length) return '';
  return `${agentNames(reach)} ${reach.length === 1 ? 'reads and writes' : 'read and write'}`;
}

/** What a note shared with agents means, now: "Shared with agents: Claude and Codex". */
export function sharedWords(reach) {
  return reach.length ? `Shared with agents: ${agentNames(reach)}` : 'Shared with agents (none connected yet)';
}

/**
 * The marks for the agents that see a note shared with them (#514): each one's name in a badge
 * (#560; `compact`: its letter), up to three (more: the first two and "+N"); none connected yet,
 * the notebook. They hold no text (CSS draws it, from data-name or data-i): `label` names them for
 * screen readers.
 */
export function agentMarks(reach, { label = true, title = null, compact = false } = {}) {
  const wrap = document.createElement('span');
  wrap.className = compact ? 'reach compact' : 'reach';
  if (!reach.length) wrap.append(notebookIcon());
  const shown = reach.length > SHOWN ? reach.slice(0, SHOWN - 1) : reach;
  for (const r of shown) {
    const b = document.createElement('span');
    b.className = r.script ? 'reach-badge script' : 'reach-badge';
    b.dataset.i = r.initial;
    b.dataset.name = r.name;
    wrap.append(b);
  }
  if (reach.length > shown.length) {
    const more = document.createElement('span');
    more.className = 'reach-more';
    more.dataset.i = `+${reach.length - shown.length}`;
    wrap.append(more);
  }
  wrap.title = title ?? sharedWords(reach);
  if (label) {
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', wrap.title);
  } else wrap.setAttribute('aria-hidden', 'true');
  return wrap;
}

const SVG = 'http://www.w3.org/2000/svg';
/** The notebook (the icon of the notes shared with agents), for when no agent is connected yet. */
function notebookIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon reach-none');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M3.5 2.5h8A1.5 1.5 0 0 1 13 4v9.5H4.5a1 1 0 0 1-1-1z', 'M3.5 12.5a1 1 0 0 1 1-1H13']) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** A connection's own mark (its list row, its page): its initial on its color. */
export function connectionBadge(cid) {
  const c = connections().find((x) => x.id === cid);
  if (!c) return document.createElement('span');
  const b = document.createElement('span');
  b.className = 'reach-badge connection-badge';
  b.dataset.i = c.initial;
  b.dataset.name = c.name;
  b.setAttribute('aria-hidden', 'true');
  return b;
}
