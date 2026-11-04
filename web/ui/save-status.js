// The save status in the note's bar (#522: out of app.js): what the notes' syncs last said, the
// one that needs you most. Saving is the normal case (edits are kept on the device first), and
// being offline has its own bar: only problems that need you are shown.
import { $, state } from './shared.js';

const STATUS_TEXT = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Saved on this device', // the offline bar says why
  error: 'Couldn’t save — retrying',
  full: 'Storage full — changes kept on this device',
  'too-large': 'This note is too large to sync well — split it into smaller notes',
};
const PRIORITY = ['full', 'too-large', 'error', 'offline', 'saving', 'saved'];
const SHOWN = new Set(['full', 'too-large', 'error']);

/** What a note's sync says now (app.js, from its onStatus). */
export function setStatus(docId, s) {
  state.statuses.set(docId, s);
  renderStatus();
}

/** A note closed, its saving done: what it said goes (ui/note.js). */
export function forgetStatus(docId) {
  state.statuses.delete(docId);
  renderStatus();
}

function renderStatus() {
  const all = [...state.statuses.values()];
  const s = PRIORITY.find((p) => all.includes(p)) ?? 'saved';
  const el = $('save-status');
  el.dataset.state = s;
  el.textContent = STATUS_TEXT[s];
  el.hidden = !SHOWN.has(s);
}
