// Deleted notes ("Recently deleted"): rules on the note index's entries.
//
// Deleting a note marks its index entry `deleted` with `deletedAt`; it can be
// restored until it's emptied — by "Delete forever" or after TRASH_DAYS. Then
// the note's data is removed from the server and the entry is kept only as a
// `purged` marker, so a device with unsent edits for it drops them instead of
// uploading them again. The server keeps that data TRASH_DAYS more (#253): the
// marker keeps what it takes to restore it until then (markPurged).
//
// A deletion also notes the `updated` it saw (`deletedSeen`). If the merged
// entry's `updated` is later, the note was edited where the deletion wasn't
// seen (another device, offline): it comes back rather than hiding those
// edits (#54, reviveEdited). Any device can tell, from the index alone.

import { now as clockNow } from './clock.js';

export const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;

export function deleteNote(notes, id, now = clockNow()) {
  const m = notes.get(id);
  if (!m || m.get('deleted')) return;
  m.doc.transact(() => {
    m.set('deleted', true);
    m.set('deletedAt', now);
    m.set('deletedSeen', m.get('updated') ?? 0);
  });
}

/** Back in the list: at the top, as if just edited, so it's easy to find. */
export function restoreNote(notes, id, now = clockNow()) {
  const m = notes.get(id);
  if (!m || !m.get('deleted') || m.get('purged')) return;
  m.doc.transact(() => {
    m.set('deleted', false);
    m.delete('deletedAt');
    m.delete('deletedSeen');
    m.set('updated', now);
  });
}

/**
 * Deleted notes edited since (where the deletion wasn't seen): back in the
 * list, as they are. Deletions from before deletedSeen existed are left be.
 * Returns the notes brought back ({id, title}).
 */
export function reviveEdited(notes) {
  const back = [];
  notes.forEach((m, id) => {
    const seen = m.get('deletedSeen');
    if (m.get('deleted') && !m.get('purged') && typeof seen === 'number' && (m.get('updated') ?? 0) > seen) back.push({ id, title: m.get('title') || '' });
  });
  if (back.length) {
    notes.doc.transact(() => back.forEach(({ id }) => {
      const m = notes.get(id);
      m.set('deleted', false);
      m.delete('deletedAt');
      m.delete('deletedSeen');
    }));
  }
  return back;
}

/**
 * Emptied ("Delete forever"). The server keeps the note's data TRASH_DAYS more, so it can be
 * restored (#253): until then the marker keeps its title, when (`purgedAt`), and where it
 * lived if that was a share (`purgedShare`: its link's key, to read it again). Then those go
 * too (forgetPurged), and the marker holds nothing about the note.
 */
export function markPurged(notes, id, now = clockNow()) {
  const m = notes.get(id);
  if (!m) return;
  m.doc.transact(() => {
    const share = m.get('share');
    m.set('deleted', true);
    m.set('purged', true);
    m.set('purgedAt', now);
    if (share) m.set('purgedShare', share);
    m.delete('share');
    m.delete('deletedAt');
    m.delete('deletedSeen');
  });
}

export const isPurged = (notes, id) => Boolean(notes.get(id)?.get('purged'));

/** Notes deleted forever that can still be restored, most recently first: { id, title, purgedAt, share }. */
export function purgedRestorable(notes, now = clockNow()) {
  const out = [];
  notes.forEach((m, id) => {
    const at = m.get('purgedAt');
    if (m.get('purged') && typeof at === 'number' && now - at < TRASH_DAYS * DAY_MS) {
      out.push({ id, title: m.get('title') || '', purgedAt: at, share: m.get('purgedShare') ?? null });
    }
  });
  return out.sort((a, b) => b.purgedAt - a.purgedAt);
}

/** A note deleted forever, back in the list (its data back on the server first): at the top. */
export function restorePurged(notes, id, now = clockNow()) {
  const m = notes.get(id);
  if (!m || !m.get('purged')) return;
  m.doc.transact(() => {
    const share = m.get('purgedShare');
    if (share) m.set('share', share);
    for (const key of ['purged', 'purgedAt', 'purgedShare']) m.delete(key);
    m.set('deleted', false);
    m.set('updated', now);
  });
}

/** Deleted forever more than TRASH_DAYS ago: the marker keeps nothing about the note. Returns how many. */
export function forgetPurged(notes, now = clockNow()) {
  const old = [];
  notes.forEach((m, id) => {
    const at = m.get('purgedAt');
    if (m.get('purged') && typeof at === 'number' && now - at >= TRASH_DAYS * DAY_MS) old.push(id);
  });
  if (old.length) {
    notes.doc.transact(() => old.forEach((id) => {
      const m = notes.get(id);
      m.set('title', '');
      m.delete('purgedAt');
      m.delete('purgedShare');
    }));
  }
  return old.length;
}

/** Deleted, restorable notes, most recently deleted first. */
export function trashed(notes) {
  const out = [];
  notes.forEach((m, id) => {
    if (m.get('deleted') && !m.get('purged')) out.push({ id, title: m.get('title') || '', deletedAt: m.get('deletedAt') ?? 0 });
  });
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Days left before a deleted note is emptied (at least 0). */
export const daysLeft = (deletedAt, now = clockNow()) =>
  Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS));

/** Deleted notes whose time is up. */
export const expired = (notes, now = clockNow()) =>
  trashed(notes).filter((n) => n.deletedAt && now - n.deletedAt >= TRASH_DAYS * DAY_MS).map((n) => n.id);

/**
 * Notes deleted before there was a trash (or by a client that doesn't set
 * `deletedAt`): start their 30 days now. Returns how many it dated.
 */
export function dateUndated(notes, now = clockNow()) {
  const undated = trashed(notes).filter((n) => !n.deletedAt);
  if (undated.length) notes.doc.transact(() => undated.forEach((n) => notes.get(n.id).set('deletedAt', now)));
  return undated.length;
}
