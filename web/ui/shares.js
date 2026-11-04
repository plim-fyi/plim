// Shared notes (#70, #259): what's done with a note's share, with no dialog of its own: sharing a
// note (and replacing or stopping its links), moving its text between its private doc and its
// share, people's and connections' own links (holders, #369), notes shared with you, and your
// name in shared notes (your profile). The Share dialog is ui/share-dialog.js (#521); upkeep
// (connections-keep.js), Recently deleted and the rest build on this. The rest of the app it
// needs comes through init().
import * as Y from '../vendor/yjs.mjs';
import { b64, sha256, unb64 } from '../core/crypto.js';
import { ApiError } from '../core/api.js';
import { signedRequest } from '../core/signed.js';
import { ACTION } from '../core/sig.js';
import { DocSync, openBlob } from '../core/sync.js';
import { now as clockNow } from '../core/clock.js';
import { ShareDocSync } from '../core/sharesync.js';
import { renderChips } from '../core/presence.js';
import { fallbackName } from '../core/names.js';
import { copyVersions } from '../core/history.js';
import {
  holderKeys, LINK_FRAGMENT, newHolderId, newHolderSecret, newShareId, newShareSeed, parseHolderLink, parseShareLink, readKeys, resolveHolder, sealHeldKeys,
  sealShareBlob, shareKeys,
} from '../core/share.js';
import { isPurged } from '../core/trash.js';
import { $, notesMap, showToast, state } from './shared.js';
import { noteReach } from './reach.js';

// From app.js (init): the server, the editor, opening a note, Settings' sections and a note's
// title, and dropping a deleted note's unsent edits.
let api, editor, openNote, renderSettingsNav, updateMeta, dropOutbox;
export function init(deps) {
  ({ api, editor, openNote, renderSettingsNav, updateMeta, dropOutbox } = deps);
}

// A shared note's index entry has `share`: { id, seed, role: 'owner' }. Its
// text then lives in the share (/api/shares/{id}), sealed with the share's
// keys, not in the private doc (which is removed when it's shared).

const shareKeyCache = new Map(); // share id → Promise of its keys

/** The note's share, or null. */
export const shareOf = (id) => notesMap().get(id)?.get('share') ?? null;

/** The note (id) that has this share, if any. */
export function noteWithShare(shareId) {
  for (const [id, m] of notesMap().entries()) if (m.get('share')?.id === shareId) return id;
  return null;
}

// A note of yours shared: `share.holders` (#369), the people with a link of their own, each
// `{ id, secret, role: 'edit' | 'read', label, created }`: their rows on the server hold the
// share's keys sealed to their secrets, and follow the note when its links are replaced.
// A note shared with you through such a link: `share: { id, holder: { id, secret }, role: 'member' }`.

const holderCache = new Map(); // holder id → Promise of { shareId, keys }

/**
 * The keys a link of your own gives (#369): its holder's row says which share the note is in
 * now (its links may have been replaced since) and holds the keys; the list follows.
 */
function keysForHolder(share) {
  const h = share.holder;
  if (!holderCache.has(h.id)) {
    const p = resolveHolder(api, { holderId: h.id, secret: unb64(h.secret) }).then((r) => {
      for (const m of notesMap().values()) {
        const s = m.get('share');
        if (s?.holder?.id === h.id && s.id !== r.shareId) m.set('share', { ...s, id: r.shareId });
      }
      return { shareId: r.shareId, keys: r.keys };
    });
    holderCache.set(h.id, p);
    p.catch(() => holderCache.get(h.id) === p && holderCache.delete(h.id));
  }
  return holderCache.get(h.id).then((r) => r.keys);
}

/** The note (id) shared with you through this holder, if any. */
function noteWithHolder(holderId) {
  for (const [id, m] of notesMap().entries()) if (m.get('share')?.holder?.id === holderId) return id;
  return null;
}

export function keysFor(share) {
  if (share.holder) return keysForHolder(share);
  if (!shareKeyCache.has(share.id)) {
    const keys = share.seed ? shareKeys(unb64(share.seed)) : readKeys(unb64(share.encKey), share.pubkey ? unb64(share.pubkey) : null);
    shareKeyCache.set(share.id, keys);
    // (Not kept if they fail to load: the next try loads them again.)
    keys.catch(() => shareKeyCache.get(share.id) === keys && shareKeyCache.delete(share.id));
  }
  return shareKeyCache.get(share.id);
}

/** The sync for a note: its own doc, or its share. */
export async function syncFor(id) {
  let share = shareOf(id);
  if (!share) return new DocSync(state.ctx, id);
  const keys = await keysFor(share);
  share = shareOf(id); // (through a link of your own, the share may have changed, #369)
  return new ShareDocSync(state.ctx, { id: share.id, keys }, new Y.Doc(), { onGone: () => shareGone(id) });
}

/** Where the note's text lives now: its own doc ID, or "share:<id>". */
const homeOf = (id) => (shareOf(id) ? `share:${shareOf(id).id}` : id);

/** The note's whole text as one update (saved edits first), from wherever it lives. */
async function noteState(id) {
  if (state.note?.id === id) {
    await state.note.sync.flush();
    return Y.encodeStateAsUpdate(state.note.sync.ydoc);
  }
  const s = await syncFor(id);
  await s.load();
  const content = Y.encodeStateAsUpdate(s.ydoc);
  s.close();
  return content;
}

// Deleting a note or a share on the server, and closing or reopening a note to writes: signed
// with the account's key (account.js signedRequest, #144).
export const deleteShare = (shareId) => signedRequest(state.ctx, 'DELETE', `/shares/${shareId}`, ACTION.deleteShare, shareId);
export const deleteDoc = (docId) => signedRequest(state.ctx, 'DELETE', `/docs/${docId}`, ACTION.deleteDoc, docId);
/** A note's home on the server deleted: its private doc, or its share ("share:<id>"). */
const deleteHome = (docId) => (docId.startsWith('share:') ? deleteShare(docId.slice(6)) : deleteDoc(docId));
/** A private note closed to writes (`what`: "close") or open to them again ("reopen"). */
const closeOrReopen = (docId, what) =>
  signedRequest(state.ctx, 'POST', `/docs/${docId}/${what}`, what === 'close' ? ACTION.closeDoc : ACTION.reopenDoc, docId);

/** Remove a note's old home on the server and on this device (after it moved). */
async function removeHome(docId) {
  await deleteHome(docId).catch((e) => console.warn('could not remove', docId, e));
  await dropOutbox(docId);
  state.ctx.cache.delete(docId).catch(() => {});
}

/**
 * Turn off a share's links for good (deleting it): unlike removeHome, it must
 * have worked before the note moves on, or the old links would keep working
 * while the dialog says they don't. (Already gone counts as done.)
 */
async function deleteShareOrThrow(shareId) {
  try {
    await deleteShare(shareId);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      throw Object.assign(new Error('Couldn’t turn off the current links, so nothing changed. Try again.'), { cause: err });
    }
  }
  await dropOutbox(`share:${shareId}`); // what this device holds of it
  state.ctx.cache.delete(`share:${shareId}`).catch(() => {});
}

/**
 * Share a note (or replace its links): a new share with the note's text,
 * the index pointing at it, then the old home removed (the private doc, or
 * the previous share, whose links stop working).
 */
export async function createShare(id) {
  if (state.note?.id === id) editor.freeze(); // nothing typed now may land in the old home
  const fromPrivate = !homeOf(id).startsWith('share:');
  let closed = false;
  try {
    // A private note: its doc is closed to writes first, then its final text read (with
    // anything other devices sent before that). What they send after is refused, kept
    // on their side, and moved into the share once they hear (#119, moveUnsent).
    if (fromPrivate) {
      if (state.note?.id === id) await state.note.sync.flush(); // (this device's own edits go in first)
      await closeOrReopen(id, 'close');
      closed = true;
      if (state.note?.id === id) await state.note.sync.pull();
    }
    const content = await noteState(id);
    const shareId = newShareId();
    const seed = newShareSeed();
    const keys = await shareKeys(seed);
    await api.post('/shares', {
      share_id: shareId,
      pubkey: b64(keys.pubkey),
      read_hash: b64(await sha256(keys.readToken)),
      update: await sealShareBlob(keys, shareId, 'update', content),
    });
    shareKeyCache.set(shareId, Promise.resolve(keys));
    // Its history comes along (before the old home goes).
    const dest = new ShareDocSync(state.ctx, { id: shareId, keys }, new Y.Doc());
    await carryHistory(await syncFor(id), dest);
    dest.close();
    const old = homeOf(id);
    // Replacing links: the old ones stop working first, for sure, or nothing changes.
    // (A new share left behind holds the same text and nobody has its links.)
    if (old.startsWith('share:')) {
      await deleteShareOrThrow(old.slice(6)).catch(async (err) => {
        await deleteShare(shareId).catch(() => {});
        throw err;
      });
    }
    const holders = shareOf(id)?.holders ?? [];
    const via = shareOf(id)?.via;
    notesMap().get(id).set('share', { id: shareId, seed: b64(seed), role: 'owner', ...(holders.length && { holders }), ...(via && { via }) });
    closed = false; // (it's the share's now)
    await followHome(); // the open note switches to the share
    if (!old.startsWith('share:')) await removeHome(old); // the private copy
    // People's own links follow the note (#369): their rows re-sealed to the new share. (One
    // that fails is told, and fixed by replacing the links again; the old share is gone either way.)
    const failed = [];
    for (const h of holders) {
      const hk = await holderKeys(unb64(h.secret));
      const held = h.role === 'edit' ? { mode: 'edit', seed } : { mode: 'read', encRaw: keys.encRaw, pubkey: keys.pubkey };
      await api.request('PUT', `/holders/${h.id}`, { share_id: shareId, ...(await sealHeldKeys(hk, h.id, shareId, held)) }).catch((err) => {
        console.warn('could not re-seal a holder', h.id, err);
        failed.push(h.label || 'someone');
      });
    }
    if (failed.length) throw new Error(`The links were replaced, but ${failed.join(', ')}’s link couldn’t follow. Replace the links again to fix it.`);
  } finally {
    // Not shared after all: the private doc takes writes again.
    if (closed) await closeOrReopen(id, 'reopen').catch((e) => console.warn('could not reopen', id, e));
    if (state.note?.id === id) editor.unfreeze();
  }
}

/**
 * A note's history follows it to a new home (copyVersions, keeping each
 * version's time). A failure only loses history, so it doesn't stop the move.
 */
async function carryHistory(from, to) {
  await copyVersions(from, to).catch((e) => console.warn('could not bring the note’s history along', e));
  from.close(); // (`to` is the caller's)
}

/** Stop sharing: the text back in a private doc; the links stop working. */
export async function stopSharing(id) {
  if (state.note?.id === id) editor.freeze();
  try {
    const content = await noteState(id);
    const old = homeOf(id);
    await closeOrReopen(id, 'reopen'); // (closed when it was shared: #119)
    const priv = new DocSync(state.ctx, id, new Y.Doc());
    Y.applyUpdate(priv.ydoc, content); // a local edit: saved to the private doc
    await priv.flush();
    if (await priv.hasPending()) throw new Error('couldn’t save the note');
    await carryHistory(await syncFor(id), priv); // its history comes back too
    priv.close();
    // The links stop working first, for sure, or the note stays shared. (A private
    // copy left behind holds the same text: trying again merges into it.)
    await deleteShareOrThrow(old.slice(6));
    const holders = shareOf(id)?.holders ?? [];
    notesMap().get(id).delete('share');
    await followHome();
    // People's own links (#369): their rows go too (pointing at a share that's gone, they'd only say so).
    for (const h of holders) await deleteHolder(h.id).catch((e) => console.warn('could not remove a holder', h.id, e));
  } finally {
    if (state.note?.id === id) editor.unfreeze();
  }
}

/**
 * Stop sharing with people: their links stop working. With apps holding it too (#369), the
 * people's own links go and the note gets new keys (the apps' rows follow, createShare), and it's
 * shared only for the apps again; with none, it's private again (stopSharing).
 */
export async function stopSharingWithPeople(id) {
  const share = shareOf(id);
  const apps = (share?.holders ?? []).filter((h) => h.connection);
  if (!apps.length) return stopSharing(id);
  for (const h of (share.holders ?? []).filter((x) => !x.connection)) await deleteHolder(h.id);
  notesMap().get(id).set('share', { ...shareOf(id), holders: apps, via: apps[0].connection });
  await createShare(id);
}

// ---- links for people (#369) ----

export const deleteHolder = (holderId) =>
  signedRequest(state.ctx, 'DELETE', `/holders/${holderId}`, ACTION.deleteHolder, holderId).catch((err) => {
    if (!(err instanceof ApiError && err.status === 404)) throw err; // (already gone counts as done)
  });

/** A link of their own for `label`: a holder with the share's keys sealed to it, kept in the note's entry. */
export async function addHolder(id, label, role) {
  const share = shareOf(id);
  const keys = await keysFor(share);
  const secret = newHolderSecret();
  const hid = newHolderId();
  const hk = await holderKeys(secret);
  const held = role === 'edit' ? { mode: 'edit', seed: unb64(share.seed) } : { mode: 'read', encRaw: keys.encRaw, pubkey: keys.pubkey };
  await api.post('/holders', { holder_id: hid, share_id: share.id, token_hash: b64(await sha256(hk.token)), ...(await sealHeldKeys(hk, hid, share.id, held)) });
  // (A person's link: the note is shared for people now, not only for an app, #369.)
  const { via: _app, ...kept } = share;
  notesMap().get(id).set('share', { ...kept, holders: [...(share.holders ?? []), { id: hid, secret: b64(secret), role, label, created: clockNow() }] });
}

/**
 * A connection's holder of a note (#369, ui/connections.js): the note shared first if it was
 * private (then `share.via` says it was for this connection: private again when it goes), a
 * holder registered with the share's keys sealed to the secret `secretFor` the holder's id gives.
 */
export async function addConnectionHolder(id, { connection, label, role, secretFor }) {
  if (!shareOf(id)) {
    await createShare(id);
    notesMap().get(id).set('share', { ...shareOf(id), via: connection });
  }
  const share = shareOf(id);
  const keys = await keysFor(share);
  let hid = newHolderId();
  let secret = await secretFor(hid);
  const hk = await holderKeys(secret);
  const held = role === 'edit' ? { mode: 'edit', seed: unb64(share.seed) } : { mode: 'read', encRaw: keys.encRaw, pubkey: keys.pubkey };
  const made = await api.post('/holders', {
    holder_id: hid, share_id: share.id, token_hash: b64(await sha256(hk.token)), connection_id: connection, ...(await sealHeldKeys(hk, hid, share.id, held)),
  });
  // Another of your devices made it first (one holder per connection and note): that one's ours
  // too, its secret derived from its id; sealed again with this role in case it differs.
  const existing = made?.holder_id && made.holder_id !== hid;
  if (existing) {
    hid = made.holder_id;
    secret = await secretFor(hid);
  }
  const now = clockNow();
  const others = (shareOf(id).holders ?? []).filter((h) => h.id !== hid);
  notesMap().get(id).set('share', { ...shareOf(id), holders: [...others, { id: hid, secret: b64(secret), role, label, connection, created: now }] });
  if (existing) await resealHolder(id, hid, role);
  return hid;
}

/** A holder's row sealed again with what it may do now (`role`: 'edit' | 'read'). */
export async function resealHolder(id, hid, role) {
  const share = shareOf(id);
  const h = (share.holders ?? []).find((x) => x.id === hid);
  if (!h) return;
  const keys = await keysFor(share);
  const hk = await holderKeys(unb64(h.secret));
  const held = role === 'edit' ? { mode: 'edit', seed: unb64(share.seed) } : { mode: 'read', encRaw: keys.encRaw, pubkey: keys.pubkey };
  await api.request('PUT', `/holders/${hid}`, { share_id: share.id, ...(await sealHeldKeys(hk, hid, share.id, held)) });
  notesMap().get(id).set('share', { ...share, holders: share.holders.map((x) => (x.id === hid ? { ...x, role } : x)) });
}

/**
 * A link taken back: its holder's row goes (its link stops at once), then the note gets new
 * keys (createShare: the others' rows follow), so what the link could still open goes too.
 */
export async function removeHolder(id, hid) {
  await deleteHolder(hid);
  const share = shareOf(id);
  notesMap().get(id).set('share', { ...share, holders: (share.holders ?? []).filter((h) => h.id !== hid) });
  await createShare(id);
}


/**
 * Edits this device still holds for a note's private doc that takes no more
 * writes (#119): if the note was shared since, they go into the share (made
 * from that doc, so they apply as they are) and sync like typing there; if it
 * was deleted for good, they're dropped. Not known yet here: kept, for later.
 */
const moving = new Set();
export async function moveUnsent(id) {
  if (moving.has(id) || !state.index) return;
  const m = notesMap().get(id);
  if (!m) return;
  if (m.get('purged')) return dropOutbox(id);
  if (!m.get('share')?.seed && !m.get('share')?.holder) return; // (not shared, as far as this device knows yet; or view-only)
  const pending = await state.ctx.outbox.list(id);
  if (!pending.length) return;
  moving.add(id);
  try {
    const merged = Y.mergeUpdates(await Promise.all(pending.map(({ record }) => openBlob(state.ctx, id, 'outbox', record))));
    // Through a copy of the share of its own, loaded first: the edits build on its text, and
    // applied to a doc still loading (the open note, just reopened there) they'd wait for that
    // text and then arrive with it, as the server's, and never be uploaded. The open note gets
    // them back from the server like anyone's edits.
    const to = await syncFor(id);
    await to.load();
    Y.applyUpdate(to.ydoc, merged); // a local edit there: saved to the share's outbox, then uploaded
    await to.flush();
    const kept = await to.hasPending();
    to.close();
    if (kept) throw new Error('the share didn’t take them yet');
    await state.ctx.outbox.remove(pending.map((r) => r.id));
    console.info(`moved ${pending.length} unsent edits of a note into its share`);
  } catch (e) {
    console.warn('could not move unsent edits into the shared note; kept for next time', e);
  } finally {
    moving.delete(id);
  }
}

/** Notes this device knows are shared: one newly so might have edits here to move (moveUnsent). */
const knownShared = new Set();
export function checkNewlyShared() {
  for (const [id, m] of notesMap().entries()) {
    if (m.get('share') && !knownShared.has(id)) {
      knownShared.add(id);
      moveUnsent(id);
    }
  }
}

/** The open note's home changed (shared, unshared, links replaced — maybe on another device): reopen it there. */
export async function followHome() {
  const n = state.note;
  if (n && n.sync.docId !== homeOf(n.id) && !isPurged(notesMap(), n.id)) await openNote(n.id, { reopen: true });
}

// ---- who else is here ----

/** Your name in shared notes: in the encrypted index, so all your devices use it. */
export const profile = () => state.index.ydoc.getMap('profile');

export const yourName = () => profile().get('name') || fallbackName();

/** The others in the open shared note, as chips in its header. */
export const renderPresence = (people) => renderChips($('presence'), people);

$('settings-name').addEventListener('change', (e) => {
  const name = e.target.value.replace(/\s+/g, ' ').trim().slice(0, 40);
  e.target.value = name;
  if (name) profile().set('name', name);
  else profile().delete('name');
  state.note?.presence?.setName(yourName());
  renderSettingsNav();
});

// ---- notes shared with you ----

/**
 * A shared note's link opened here, with a vault on this device: the note's address with
 * the key after the `#` (/n/<id>#k=…, #299), or "Add to my notes" on a shared note's page,
 * which brings you here with #add-share=<id>.<the link's fragment> (still only in the
 * fragment). Once the vault is open, the note opens if it's in your list already (yours, or
 * added before: found by its share); else it joins your list as
 * `share: { id, seed | encKey + pubkey, role: 'member' }`, under the address's id, and opens.
 * Returns whether there was one.
 */
export function addSharedFromLink() {
  // A link of someone's own (#369), or "Add to my notes" from one (#add-holder=<id>.<secret>):
  // its holder's row says where the note is; the holder is kept, and follows the note's share.
  let held = location.hash.startsWith('#h=') ? parseHolderLink(location.pathname, location.hash) : null;
  const added = held ? null : location.hash.match(/^#add-holder=([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/);
  if (added) held = parseHolderLink(`/s/${added[1]}`, `#h=${added[1]}.${added[2]}`);
  if (held) {
    history.replaceState(null, '', location.pathname);
    addHeld(held);
    return true;
  }
  let link = null;
  if (location.hash.startsWith('#k=')) link = parseShareLink(location.pathname, location.hash);
  else {
    const m = location.hash.match(/^#add-share=([0-9a-f]{32})\.(.*)$/);
    if (m && LINK_FRAGMENT.test(m[2])) link = parseShareLink(`/s/${m[1]}`, `#${m[2]}`);
  }
  if (!link) return false;
  history.replaceState(null, '', location.pathname); // the key shouldn't linger in the address bar
  // Ask: a link from anyone can bring you here, and whoever shared the note
  // sees everything written in it, so it mustn't join your notes unasked.
  let id = noteWithShare(link.shareId);
  if (!id || isPurged(notesMap(), id) || notesMap().get(id).get('deleted')) {
    if (!confirm('Add this shared note to your notes?\n\nWhoever shared it, and anyone else with its link, can see what you write in it.')) {
      if (location.pathname !== '/') history.replaceState(null, '', '/'); // (not a note of yours: not its address either)
      return false;
    }
    // The same address for everyone in the note: the link's id, unless a note of yours has it.
    id = link.noteId && !notesMap().get(link.noteId) ? link.noteId : crypto.randomUUID();
    const now = clockNow();
    const secret = b64(link.secret);
    const share = link.mode === 'edit'
      ? { id: link.shareId, seed: secret, role: 'member' }
      : { id: link.shareId, encKey: secret, ...(link.pubkey && { pubkey: b64(link.pubkey) }), role: 'member' };
    notesMap().set(id, new Y.Map([['title', ''], ['created', now], ['updated', now], ['deleted', false], ['share', share]]));
    showToast('Added to your notes');
  }
  // Its title comes from its text (shared notes are titled by whoever opens them).
  openNote(id, { replace: true }).then(() => state.note?.id === id && updateMeta(id), () => {});
  return true;
}

/** A link of your own, opened here (#369): the note it opens now joins your list (asked first), and opens. */
async function addHeld(held) {
  const notYours = () => location.pathname !== '/' && history.replaceState(null, '', '/');
  let r;
  try {
    r = await resolveHolder(api, held);
  } catch (err) {
    showToast(err instanceof ApiError && err.status === 410 ? 'This link was turned off.' : err instanceof ApiError && err.status === 404 ? 'This link doesn’t work.' : 'Couldn’t open this link.');
    return notYours();
  }
  let id = noteWithShare(r.shareId) ?? noteWithHolder(held.holderId);
  if (!id || isPurged(notesMap(), id) || notesMap().get(id).get('deleted')) {
    if (!confirm('Add this shared note to your notes?\n\nWhoever shared it, and anyone else with its link, can see what you write in it.')) return notYours();
    id = held.noteId && !notesMap().get(held.noteId) ? held.noteId : crypto.randomUUID();
    const now = clockNow();
    holderCache.set(held.holderId, Promise.resolve({ shareId: r.shareId, keys: r.keys }));
    const share = { id: r.shareId, holder: { id: held.holderId, secret: b64(held.secret) }, role: 'member' };
    notesMap().set(id, new Y.Map([['title', ''], ['created', now], ['updated', now], ['deleted', false], ['share', share]]));
    showToast('Added to your notes');
  }
  openNote(id, { replace: true }).then(() => state.note?.id === id && updateMeta(id), () => {});
}

/** A shared note's link stopped working (live). For notes shared with you: say so, and stop editing. */
function shareGone(id) {
  const share = shareOf(id);
  if (share?.role !== 'member') return; // yours: the index says where it went
  if (state.note?.id === id) editor.freeze();
  showToast('This shared note was turned off by whoever shared it.');
}


/** Where a note lives (#484, #514): 'ai', shared with agents; else only yours. */
export const placeOf = (id) => notesMap().get(id)?.get('place');

/** Shared only so an app could reach it (#369): no link of anyone's given out (as far as Plim knows). */
export const appsOnly = (share) => Boolean(share?.via) && !(share.holders ?? []).some((h) => !h.connection);

/**
 * Who a note is shared with, as its bar and its menu say it: `people` (a link of anyone's given
 * out: the sharing light), and `apps`, those that reach it as it's shared with agents (reach.js noteReach,
 * each with its role). Only apps: their badge, not the light.
 */
export function sharedWith(id) {
  const share = shareOf(id);
  return { people: Boolean(share) && !appsOnly(share), apps: noteReach(placeOf(id)) };
}

