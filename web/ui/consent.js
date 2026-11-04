// The consent page, /connect (#369): the connector sent the person here to say yes to an app
// connecting; saying yes makes the connection (its keys, its list note, its record in the index)
// and hands its secret back to the connector. It sees the notes shared with agents (#514), where the
// notes it makes go, and nothing else.
import * as Y from '../vendor/yjs.mjs';
import { b64, b64url, sha256 } from '../core/crypto.js';
import { isOffline } from '../core/api.js';
import { now as clockNow } from '../core/clock.js';
import { connectionKeys, newConnectionId, newConnectionSecret } from '../core/connection.js';
import { holderKeys, newShareId, newShareSeed, sealHeldKeys, sealShareBlob, shareKeys } from '../core/share.js';
import { connectionsMap, holdGrants, pastKey } from './connections-keep.js';
import { $, setError, showToast, state } from './shared.js';

/** An app asking to connect (/connect), while it's pending: { auth, name, ret, to }. */
let connect = null;

// From app.js (init): the server.
let api;
export function init(deps) {
  ({ api } = deps);
}

// ---- the consent page: /connect ----

/**
 * The connector sent the person here (#369): `/connect?auth=…&name=…&return=…`. Shown once the
 * vault is open (app.js enterNotes). Returns the request, or null if this isn't one.
 */
export function connectRequest() {
  if (location.pathname !== '/connect') return null;
  const q = new URLSearchParams(location.search);
  const auth = q.get('auth');
  const ret = q.get('return');
  if (!auth || !ret) return null;
  // (Kept while it's pending: the page leaves for the connector once the person says yes, so
  // nothing else that works on the notes, like keepGrants, starts meanwhile.)
  const to = (q.get('to') || '').toLowerCase().slice(0, 253);
  connect = { auth, name: (q.get('name') || 'Claude').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Claude', ret, to };
  holdGrants(true);
  return connect;
}

/**
 * Where the person goes back to, as the connector checked it (the app's name is its own say):
 * Claude's website, an app on this computer, or somewhere else, said plainly (#369).
 */
function destination(to) {
  if (!to) return { text: '', warn: '' };
  if (/^(.+\.)?claude\.(ai|com)$/.test(to)) return { text: `You’ll go back to ${to}.`, warn: '' };
  if (to === 'localhost' || to === '127.0.0.1' || to === '::1') return { text: 'You’ll go back to an app on this computer.', warn: '' };
  return { text: '', warn: `It will send you back to ${to}, not Claude’s website. Connect only if you started this yourself and trust ${to}.` };
}

export async function showConsent(req) {
  history.replaceState(null, '', '/'); // (the request is in memory now)
  let account = null;
  try {
    account = await api.request('GET', '/account');
  } catch {
    /* said below */
  }
  const connector = account?.connector_url?.replace(/\/$/, '');
  if (!connector || !(req.ret === connector || req.ret.startsWith(`${connector}/`))) {
    connect = null;
    holdGrants(false);
    showToast(account ? 'This Plim has no connector set up for that app.' : 'Connecting needs a connection to the server.');
    return;
  }
  connect = req;
  $('connect-who').textContent = req.name;
  $('connect-title').textContent = `Connect ${req.name} to your notes?`;
  const dest = destination(req.to);
  $('connect-to').textContent = dest.text;
  $('connect-unknown').textContent = dest.warn;
  $('connect-unknown').hidden = !dest.warn;
  // (A name of its own when you have one called the same: "Claude, this computer", to tell them apart, #390.)
  const taken = [...connectionsMap().values()].some((c) => pastKey(c.name) === pastKey(req.name));
  const where = req.to === 'localhost' || req.to === '127.0.0.1' || req.to === '::1' ? 'this computer' : req.to;
  $('connect-name').value = taken && where ? `${req.name}, ${where}`.slice(0, 60) : req.name;
  setError('connect-error');
  $('connect-dialog').showModal();
}

$('connect-go').addEventListener('click', async (e) => {
  const button = e.currentTarget; // (null once the handler has awaited)
  const req = connect;
  if (!req) return;
  const name = $('connect-name').value.replace(/\s+/g, ' ').trim().slice(0, 60) || req.name;
  button.disabled = true;
  setError('connect-error');
  try {
    const { id, secret } = await createConnection(name, { from: req.to });
    await state.index.flush(); // (the connection in your note list on the server, before the page leaves: your other devices see it)
    // Handed to the connector in the fragment of its page: never sent to a server as part of a request.
    // With where you were told you'd go back to: the connector refuses if that isn't so (#403).
    const frag = new URLSearchParams({ auth: req.auth, connection: id, secret: b64url(secret), to: req.to });
    location.href = `${req.ret}#${frag}`; // (connect stays, and the passes held: the page is leaving)
  } catch (err) {
    setError('connect-error', isOffline(err) ? 'Connecting needs a connection.' : err);
    button.disabled = false;
  }
});
$('connect-dialog').addEventListener('close', () => {
  if ($('connect-go').disabled) return; // (not while leaving for the connector)
  connect = null; // (cancelled)
  holdGrants(false);
});

/**
 * A connection, made: registered with the key it signs with; its list note, a share of its own
 * with a holder for it (edit); kept in the index. It sees the notes shared with agents (#514).
 * Returns its id and secret.
 */
async function createConnection(name, { from = '' } = {}) {
  const secret = newConnectionSecret();
  const keys = await connectionKeys(secret);
  const id = newConnectionId();
  await api.post('/connections', { connection_id: id, name, pubkey: b64(keys.pubkey) });
  const listId = newShareId();
  const listSeed = newShareSeed();
  const listKeys = await shareKeys(listSeed);
  const doc = new Y.Doc();
  doc.getMap('notes');
  doc.getArray('activity');
  doc.getMap('info').set('name', name);
  doc.getMap('info').set('notebook', true); // (what connectors from before #514 read)
  await api.post('/shares', {
    share_id: listId,
    pubkey: b64(listKeys.pubkey),
    read_hash: b64(await sha256(listKeys.readToken)),
    update: await sealShareBlob(listKeys, listId, 'update', Y.encodeStateAsUpdate(doc)),
  });
  const hk = await holderKeys(keys.listHolderSecret);
  await api.post('/holders', {
    holder_id: keys.listHolderId,
    share_id: listId,
    token_hash: b64(await sha256(hk.token)),
    connection_id: id,
    ...(await sealHeldKeys(hk, keys.listHolderId, listId, { mode: 'edit', seed: listSeed })),
  });
  connectionsMap().set(id, { name, secret: b64(secret), listShareId: listId, listSeed: b64(listSeed), created: clockNow(), ...(from && { from }) });
  holdGrants(true); // (the page is about to leave for the connector; the next unlock keeps its notes in step)
  return { id, secret };
}
