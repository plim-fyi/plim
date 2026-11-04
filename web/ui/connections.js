// Connections (#369): an app (Claude, through the connector) connected to your notes. It sees the
// notes you share with agents (#514), and nothing else. This is Settings → Connections; the consent
// page (/connect) is ui/consent.js, and keeping each connection's notes in step is
// ui/connections-keep.js.
//
// A connection has a secret the connector keeps for it (in the token Claude holds): from it come
// its signing key and the holder of its own list note (connection.js). Each note it's given is a
// holder of the note's share (share.js), its secret from the connection's and the holder's id;
// the note is shared first if it was private. Its list note, a share of its own, says which
// notes it has (holder id → { noteId, title, tags, role }), kept here, and what it did
// ('activity', written by the connector). This app keeps, in the encrypted index: connection id
// → { name, secret, listShareId, listSeed, created, from }.
import { ApiError, isOffline } from '../core/api.js';
import { signedRequest } from '../core/signed.js';
import { ACTION } from '../core/sig.js';
import { now as clockNow } from '../core/clock.js';
import { foldActivity } from '../core/connections-sync.js';
import { connectionBadge } from './reach.js';
import { connectionsMap, looked, nameEdited, onKeepStatus, onKept, openList, scheduleGrants } from './connections-keep.js';
import { createShare, deleteShare, stopSharing } from './shares.js';
import { $, el, flashLabel, keyed, notesMap, relTime, setError, showToast, state } from './shared.js';

/** The connection whose page Settings shows (null: the list). */
let connectionPage = null;

// From app.js (init): the server.
let api;
export function init(deps) {
  ({ api } = deps);
  // (Kept in step in the background: its page, if it's the one showing, drawn again; what a pass is doing, on it.)
  onKept((cid) => connectionPage === cid && renderConnectionPage(cid));
  onKeepStatus((cid, text) => connectionPage === cid && ($('connection-status').textContent = text));
}

/** Where a connection came from, in words: "from claude.ai", "from an app on this computer". */
function fromWords(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'from an app on this computer' : `from ${host}`;
}

// ---- Settings → Connections ----

/** The nav's second line: how many. */
export function renderConnectionsNav() {
  const n = state.index ? connectionsMap().size : 0;
  $('settings-nav-connections').textContent = n ? `${n === 1 ? '1 app' : `${n} apps`} connected` : 'None';
}


/** The list of connections, with how to connect when there's none; a tap opens one. */
/** What the server last said of each connection (when it was used): rows drawn before it answers again use it. */
let onServer = new Map();

export async function renderConnections() {
  connectionPage = null;
  // The rows at once, from this device (#442: those drawn last time showed until the server
  // answered, a disconnected one among them, then went, moving what's under them)…
  drawConnections();
  $('connection-page').hidden = true;
  $('connections-list-view').hidden = false;
  try {
    const [r, account] = await Promise.all([api.request('GET', '/connections'), api.request('GET', '/account')]);
    onServer = new Map((r.connections ?? []).map((c) => [c.connection_id, c]));
    const url = account?.connector_url?.replace(/\/$/, '');
    $('connector-address').textContent = url ? `${url}/mcp` : '';
    $('connect-howto').hidden = !url;
    $('connect-howto-none').hidden = Boolean(url);
  } catch {
    /* offline: what the index knows */
  }
  // …then again with what the server says (when each was used), if the list is still showing.
  if (connectionPage === null) drawConnections();
}

function drawConnections() {
  const entries = [...connectionsMap().entries()];
  // How to connect: always there (another app, another Claude), its address this Plim's connector's.
  $('connect-howto-title').textContent = entries.length ? 'Connect another' : 'Connect Claude';
  // A row each: its badge, its name, where it's from, what it has, when it was used; a tap opens it.
  // (Updated in place: drawn again as the server answers, the row under a tap stays the same one.)
  keyed($('connections-list'), entries, ([cid]) => cid, ([cid]) => {
    const b = el('button', 'connection-row', { type: 'button' });
    b.append(el('span', 'connection-badge-slot'), el('span', 'connection-row-words'), el('span', 'connection-row-chev', { textContent: '›', ariaHidden: 'true' }));
    b.addEventListener('click', () => renderConnectionPage(cid));
    return b;
  }, (b, [cid, c]) => {
    const used = onServer.get(cid)?.last_used_at ? `used ${relTime(onServer.get(cid).last_used_at * 1000)}` : '';
    const where = c.from ? (isLocal(c.from) ? 'This computer' : c.from) : ''; // (which Claude it is, #390)
    b.firstChild.replaceWith(connectionBadge(cid));
    b.children[1].replaceChildren(el('span', 'setting-title', { textContent: c.name }), el('span', 'setting-sub', { textContent: [where, used].filter(Boolean).join(' · ') }));
  });
  $('connections-list').hidden = !entries.length;
  $('connections-separate').hidden = !entries.length;
  // How to connect: open when there's none; behind "+ Connect an app" once there is one.
  $('connect-another').hidden = !entries.length;
  showHowTo(!entries.length);
  renderConnectionsNav();
}

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1';

function showHowTo(open) {
  $('connections-none').hidden = !open;
  $('connect-another').setAttribute('aria-expanded', String(open));
}
$('connect-another').addEventListener('click', () => showHowTo($('connections-none').hidden));

/** One connection: what it sees (the notes shared with agents, #514), what it did lately, Disconnect. */
async function renderConnectionPage(cid) {
  const c = connectionsMap().get(cid);
  if (!c) return renderConnections();
  if (connectionPage !== cid) {
    looked.delete(cid); // (opening its page looks at its list: notes the connector made come in now)
    scheduleGrants(0);
    activityAll = false;
    $('connection-activity').replaceChildren();
  }
  connectionPage = cid;
  $('connections-list-view').hidden = true;
  $('connection-page').hidden = false;
  setError('connection-error');
  $('connection-badge').replaceChildren(connectionBadge(cid));
  $('connection-name').textContent = c.name;
  const meta = [c.from ? fromWords(c.from).replace(/^from/, 'From') : '', `${c.from ? 'connected' : 'Connected'} ${relTime(c.created)}`].filter(Boolean);
  $('connection-meta').textContent = meta.join(' · ');
  // When it was last used, from the server (best effort, after the rest), on a line of its own
  // that keeps its room while it loads: added to the line above, it wrapped on a phone and
  // pushed the page down (#442). The last one heard is shown meanwhile (#436).
  const showUsed = () => {
    const known = onServer.get(cid); // (as the server last said: the list's too)
    $('connection-used').textContent = !known ? '' : known.last_used_at ? `Used ${relTime(known.last_used_at * 1000)}` : 'Not used yet';
  };
  showUsed();
  api.request('GET', '/connections').then((r) => {
    onServer = new Map((r.connections ?? []).map((x) => [x.connection_id, x]));
    if (connectionPage === cid) showUsed();
  }).catch(() => {});
  // What it sees (#514): the notes shared with agents, as every agent you connect does.
  const shared = [...notesMap().values()].filter((m) => !m.get('deleted') && m.get('place') === 'ai').length;
  $('connection-sees').textContent = !shared
    ? 'No notes yet. Turn on Agents in a note’s Share, and every agent you connect sees it.'
    : `${shared === 1 ? '1 note' : `${shared} notes`}. Every agent you connect sees them. To add one, turn on Agents in its Share.`;
  $('connection-disconnect').ariaLabel = `Disconnect ${c.name}`; // (its name is beside it: the button says just Disconnect…)
  $('connection-disconnect').disabled = disconnecting.has(cid); // (one button for every page: off only for one being disconnected, #494)
  renderActivity(c).catch(() => {});
}

/** What it did: by day, repeats folded, the last five unless all are asked for. */
const SHOWN_ACTIVITY = 5;
let activityAll = false;
async function renderActivity(c) {
  if (!$('connection-activity').childElementCount) $('connection-activity').replaceChildren(el('p', 'setting-sub', { textContent: 'Loading…' }));
  const list = await openList(c);
  let folded;
  try {
    folded = foldActivity(list.ydoc.getArray('activity').toArray(), clockNow());
  } finally {
    list.close();
  }
  if (!folded.length) {
    $('connection-activity').replaceChildren(el('p', 'setting-sub', { textContent: 'Nothing yet.' }));
    $('connection-activity-all').hidden = true;
    return;
  }
  const shown = activityAll ? folded : folded.slice(0, SHOWN_ACTIVITY);
  const MARK = { read: '○', created: '+', added: '↳', tagged: '#', other: '·' };
  const out = [];
  let day = null;
  for (const a of shown) {
    if (a.day !== day) out.push(el('div', 'activity-day', { textContent: (day = a.day) }));
    const row = el('div', 'activity-row');
    row.dataset.kind = a.kind;
    row.append(el('span', 'activity-mark', { textContent: MARK[a.kind], ariaHidden: 'true' }), el('span', 'activity-what', { textContent: a.what }), el('span', 'activity-when', { textContent: relTime(a.at) }));
    out.push(row);
  }
  $('connection-activity').replaceChildren(...out);
  $('connection-activity-all').hidden = folded.length <= SHOWN_ACTIVITY;
  $('connection-activity-all').textContent = activityAll ? 'Show fewer' : 'Show all';
}
$('connection-activity-all').addEventListener('click', () => {
  activityAll = !activityAll;
  const c = connectionsMap().get(connectionPage);
  if (c) renderActivity(c).catch(() => {});
});

$('connection-back').addEventListener('click', () => renderConnections());
$('connector-copy').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  const text = $('connector-address').textContent;
  if (!text) return;
  await navigator.clipboard?.writeText(text).catch(() => {});
  flashLabel(b, 'Copied');
});
$('connection-rename').addEventListener('click', async () => {
  const cid = connectionPage;
  const c = connectionsMap().get(cid);
  const name = prompt('Call this connection', c.name)?.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name || name === c.name) return;
  try {
    await api.request('PATCH', `/connections/${cid}`, { name });
    connectionsMap().set(cid, { ...c, name });
    // The new name everywhere it was kept: its holders' labels on your notes, and its list (what
    // the connector marks its edits with), written by this device, as grants are.
    for (const [, m] of notesMap().entries()) {
      const share = m.get('share');
      if ((share?.holders ?? []).some((h) => h.connection === cid)) m.set('share', { ...share, holders: share.holders.map((h) => (h.connection === cid ? { ...h, label: name } : h)) });
    }
    nameEdited.add(cid);
    scheduleGrants(0);
    renderConnectionPage(cid);
    renderConnectionsNav();
  } catch (err) {
    setError('connection-error', isOffline(err) ? 'Renaming needs a connection.' : err);
  }
});

/**
 * Disconnect: turned off on the server at once (its holders go with it), then each note it had
 * gets new keys (a note shared only for it is private again), its list note goes, and its record.
 */
/** Connections being disconnected now: their page's Disconnect is off; another's isn't (#494). */
const disconnecting = new Set();

$('connection-disconnect').addEventListener('click', async () => {
  const cid = connectionPage;
  const c = connectionsMap().get(cid);
  if (!c || disconnecting.has(cid)) return;
  if (!confirm(`Disconnect ${c.name}? It loses access at once, and its tokens stop working. The notes it made stay shared with agents.`)) return;
  disconnecting.add(cid);
  $('connection-disconnect').disabled = true;
  setError('connection-error');
  try {
    await signedRequest(state.ctx, 'POST', `/connections/${cid}/revoke`, ACTION.revokeConnection, cid).catch((err) => {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    });
    connectionsMap().delete(cid);
  } catch (err) {
    if (connectionPage === cid) setError('connection-error', isOffline(err) ? 'Disconnecting needs a connection.' : err);
    return;
  } finally {
    disconnecting.delete(cid);
    if (connectionPage === cid) $('connection-disconnect').disabled = false;
  }
  // Cut off: gone from the list at once (#494: it lingered, its Disconnect faded, while the rest
  // was done). The rest follows here, in the background: what it could open gets new keys, its
  // list note and its record go.
  showToast(`${c.name} was disconnected.`);
  if (connectionPage === cid) renderConnections();
  forgetDisconnected(cid, c).catch((err) => console.warn('could not finish disconnecting', cid, err));
});

/** After a disconnect: its holders gone and what they opened re-keyed (or private again), its list and record deleted. */
async function forgetDisconnected(cid, c) {
  for (const [id, m] of notesMap().entries()) {
    const share = m.get('share');
    const mine = (share?.holders ?? []).filter((h) => h.connection === cid);
    if (!mine.length) continue;
    const left = share.holders.filter((h) => h.connection !== cid);
    m.set('share', { ...share, holders: left });
    if (share.via === cid && !left.length) await stopSharing(id).catch((err) => console.warn('could not make a note private again', id, err));
    else await createShare(id).catch((err) => console.warn('could not re-key a note', id, err));
  }
  await deleteShare(c.listShareId).catch(() => {});
  await signedRequest(state.ctx, 'DELETE', `/connections/${cid}`, ACTION.deleteConnection, cid).catch(() => {});
}
