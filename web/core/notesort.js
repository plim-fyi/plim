// The note list's order (#344): by when each note was last edited (as always), or by when it was
// made; newest first either way. Pure, so it's tested (tests/run.mjs); the menu is ui/menus.js.

export const SORTS = ['edited', 'created'];
export const SORT_NAMES = { edited: 'Last edited', created: 'Date created' };

/**
 * `notes` ({id, updated, created}) in `by`'s order, newest first. A time from the future (a device
 * with its clock ahead wrote it) counts as now, not first forever; a note without a created time
 * (none should be) counts by its last edit; ties go by id, so the order never flickers.
 */
export function sortNotes(notes, by, now) {
  const key = (n) => Math.min(by === 'created' ? n.created || n.updated || 0 : n.updated || 0, now);
  return [...notes].sort((a, b) => key(b) - key(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "Created today", "Created yesterday", "Created Oct 2" (and the year when it isn't this one). */
export function createdLabel(ts, now, locale = undefined) {
  if (!ts) return '';
  const d = new Date(Math.min(ts, now));
  const today = new Date(now);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days <= 0) return 'Created today';
  if (days === 1) return 'Created yesterday';
  const opts = d.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return `Created ${d.toLocaleDateString(locale, opts)}`;
}
