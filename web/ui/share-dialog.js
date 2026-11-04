// The Share dialog (#70, #369, #514): whether agents see the note (a switch), its links, who has
// it (people with a link of their own), giving someone a link, replacing or stopping the links. What it does to the
// share is ui/shares.js's; this is the dialog (#521).
import { unb64 } from '../core/crypto.js';
import { ApiError, isOffline } from '../core/api.js';
import { editLink, holderLink, readLink } from '../core/share.js';
import { now as clockNow } from '../core/clock.js';
import { NOTEBOOK } from '../core/connections-sync.js';
import { $, editedHere, el, flashLabel, notesMap, relTime, setError, showToast } from './shared.js';
import { agentMarks, agentNames, notebookReach, noteReach } from './reach.js';
import { scheduleGrants } from './connections-keep.js';
import { addHolder, appsOnly, createShare, keysFor, placeOf, removeHolder, shareOf, stopSharingWithPeople } from './shares.js';

let shareNote = null; // the note whose Share dialog is open
let shareSomeone = false; // the dialog's "A link for someone…" part is showing

// From app.js (init): the server, and the note list's render.
let api, renderList;
export function init(deps) {
  ({ api, renderList } = deps);
}

/** Who has the note, in the Share dialog: the people with a link of their own (Copy link, Remove). */
function renderWho(share, people) {
  const row = (lead, name, what, ...buttons) => {
    const li = el('li', 'share-holder');
    const head = el('div', 'share-holder-head');
    const words = el('div', 'share-holder-words');
    words.append(el('span', 'share-holder-name', { textContent: name }), el('span', 'share-holder-what', { textContent: what }));
    head.append(lead, words, ...buttons);
    li.append(head);
    return li;
  };
  const button = (text, data, value) => {
    const b = el('button', 'small', { type: 'button', textContent: text });
    b.dataset[data] = value;
    return b;
  };
  const peopleRows = people.map((h) => {
    const name = h.label || 'Someone';
    const li = row(el('span', 'share-holder-initial', { textContent: name.trim()[0]?.toUpperCase() ?? '?' }), name, h.role === 'edit' ? 'Can edit' : 'Can view', button('Copy link', 'copyHolder', h.id), button('Remove', 'remove', h.id));
    li.dataset.holder = h.id;
    return li;
  });
  $('share-holders').replaceChildren(...peopleRows);
  // When each was last used, from the server (best effort: the rows are the point).
  if (people.length) {
    api.request('GET', `/shares/${share.id}/holders`).then((r) => {
      for (const h of r.holders ?? []) {
        const what = $('share-holders').querySelector(`[data-holder="${h.holder_id}"] .share-holder-what`);
        if (what && h.last_used_at) what.textContent += ` · used ${relTime(h.last_used_at * 1000)}`;
      }
    }).catch(() => {});
  }
}

$('share-holders').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy-holder]');
  if (copy) {
    const h = (shareOf(shareNote)?.holders ?? []).find((x) => x.id === copy.dataset.copyHolder);
    if (!h) return;
    await navigator.clipboard.writeText(holderLink(location.origin, shareNote, h.id, unb64(h.secret))).catch(() => {});
    flashLabel(copy, 'Copied');
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (!rm) return;
  const h = (shareOf(shareNote)?.holders ?? []).find((x) => x.id === rm.dataset.remove);
  if (!confirm(`Take back ${h?.label || 'this'}’s link? It stops working, the note gets new keys, and the links above are replaced too. Other people’s own links keep working.`)) return;
  shareAction(rm, () => removeHolder(shareNote, rm.dataset.remove));
});
$('share-person-go').addEventListener('click', (e) => {
  const name = $('share-person-name').value.replace(/\s+/g, ' ').trim();
  if (!name) return $('share-person-name').focus();
  shareAction(e.currentTarget, async () => {
    await addHolder(shareNote, name, $('share-person-role').value);
    $('share-person-name').value = '';
    shareSomeone = false; // (they're in "Who has this note" now, with their link)
  });
});
// A link for someone: its form, asked for (#…: less in the way than the links everyone uses).
for (const b of document.querySelectorAll('#share-dialog [data-someone]')) {
  b.addEventListener('click', async () => {
    shareSomeone = true;
    await renderShareDialog();
    $('share-person-name').focus();
  });
}
// Only apps have it: its links, shown when asked for (they're the ones it has; nothing new is made).
$('share-show-links').addEventListener('click', async () => {
  sharedOnPurpose(shareNote);
  await renderShareDialog();
});
$('share-person-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('share-person-go').click();
  }
});

// ---- the Share dialog ----

export async function openShareDialog(id) {
  shareNote = id;
  shareSomeone = false;
  setError('share-error');
  await renderShareDialog();
  $('share-dialog').showModal();
}

async function renderShareDialog() {
  const id = shareNote;
  const share = shareOf(id);
  renderAgents(id, share);
  $('share-note-title').textContent = notesMap().get(id)?.get('title') || 'this note';
  $('share-off').hidden = Boolean(share);
  $('share-on').hidden = !share;
  if (!share) return;
  const keys = await keysFor(share);
  // Shared with you: pass on the links you have (through a link of your own: that one); only
  // its owner can replace or stop them, or give people links of their own (#369).
  const mine = share.role === 'owner';
  const own = Boolean(share.holder);
  $('share-edit-link').closest('.setting').hidden = !share.seed;
  if (share.seed) $('share-edit-link').value = editLink(location.origin, id, share.id, unb64(share.seed));
  $('share-read-link').closest('.setting').hidden = own;
  if (!own) $('share-read-link').value = readLink(location.origin, id, share.id, keys.encRaw, keys.pubkey);
  $('share-yours').hidden = !own;
  if (own) $('share-your-link').value = holderLink(location.origin, id, share.holder.id, unb64(share.holder.secret));
  $('share-title').textContent = mine ? 'Share note' : 'Shared with you';
  // Who has it (yours): people with a link of their own (the agents: the switch above).
  const people = mine ? (share.holders ?? []).filter((h) => !h.connection) : [];
  $('share-who').hidden = !people.length;
  if (mine) renderWho(share, people);
  // Only apps have it: its links are held back until you ask for them (no one has them yet), and
  // there's nothing to replace or stop here (that's sharing with agents).
  const held = mine && appsOnly(share);
  const someone = mine && Boolean(shareSomeone);
  $('share-people-label').hidden = !mine;
  $('share-links-off').hidden = !held;
  $('share-links').hidden = held || (!share.seed && own);
  $('share-someone-row').hidden = !mine || someone;
  for (const b of $('share-links-off').querySelectorAll('[data-someone]')) b.hidden = someone;
  $('share-person').hidden = !someone;
  $('share-warn').hidden = held && !someone;
  $('share-stop').hidden = $('share-replace').hidden = !mine || held;
  $('share-stop').textContent = placeOf(id) === NOTEBOOK ? 'Stop sharing with people' : 'Stop sharing';
}

/**
 * Agents (#514): whether they see the note, a switch, with their letters and what it means. Not
 * on a note someone gave you a link of your own to (it's theirs to give).
 */
function renderAgents(id, share) {
  const on = placeOf(id) === NOTEBOOK;
  const reach = notebookReach();
  $('share-agents').hidden = Boolean(share?.holder);
  $('share-agents-on').checked = on;
  $('share-agents-marks').replaceChildren(agentMarks(reach, { label: false }));
  $('share-agents-sub').textContent = !on ? 'Off. Agents can’t see this note.'
    : reach.length ? `${agentNames(reach)} can read and edit this note.`
    : 'On. Any agent you connect can read and edit this note.';
}

/**
 * The switch (#514): the note shared with agents, or not. The agents' copies follow from this
 * device at once (connections-keep.js); one that loses it gets the note with new keys.
 */
$('share-agents-on').addEventListener('change', async (e) => {
  const m = notesMap().get(shareNote);
  if (!m) return;
  const on = e.currentTarget.checked;
  if (on) m.set('place', NOTEBOOK);
  else m.delete('place');
  editedHere.set(shareNote, clockNow()); // (this device's change: the agents' copies follow from here, at once)
  scheduleGrants(0);
  renderList();
  await renderShareDialog();
  showToast(on ? 'Shared with agents' : 'No longer shared with agents');
});

/** A link handed out on purpose: the note is shared for people now, not only for an app (it stays so when the app's tag goes). */
function sharedOnPurpose(id) {
  const share = shareOf(id);
  if (share?.via) {
    const { via, ...rest } = share;
    notesMap().get(id).set('share', rest);
  }
}

/** Run a dialog action with its button disabled, showing what went wrong. */
async function shareAction(button, fn) {
  setError('share-error');
  button.disabled = true;
  $('share-dialog').dataset.busy = 'true'; // (a click outside doesn't close it meanwhile)
  try {
    await fn();
    await renderShareDialog();
  } catch (err) {
    const msg = isOffline(err) ? 'Sharing needs a connection.'
      : err instanceof ApiError && err.status === 413 ? 'This note is too large to share.'
      : err instanceof ApiError && err.status === 507 ? 'Your storage is full.'
      : err;
    setError('share-error', msg);
  } finally {
    button.disabled = false;
    delete $('share-dialog').dataset.busy;
  }
}

$('share-create').addEventListener('click', (e) => shareAction(e.currentTarget, () => createShare(shareNote)));
$('share-replace').addEventListener('click', (e) => {
  if (!confirm('Replace the links? The current ones stop working for everyone who has them.')) return;
  shareAction(e.currentTarget, () => createShare(shareNote));
});
$('share-stop').addEventListener('click', (e) => {
  // People only: the agents keep it while it's shared with them (#514).
  const apps = noteReach(placeOf(shareNote));
  const ask = placeOf(shareNote) === NOTEBOOK
    ? `Stop sharing this note with people? The links you gave out stop working, and the note gets new keys. ${apps.length ? agentNames(apps) : 'Agents'} still see it, as it’s shared with agents.`
    : 'Stop sharing this note? Its links stop working. The note stays in your notes.';
  if (!confirm(ask)) return;
  shareAction(e.currentTarget, () => stopSharingWithPeople(shareNote));
});
for (const b of document.querySelectorAll('#share-dialog [data-copy]')) {
  b.addEventListener('click', async () => {
    sharedOnPurpose(shareNote);
    await navigator.clipboard.writeText($(b.dataset.copy).value).catch(() => $(b.dataset.copy).select());
    flashLabel(b, 'Copied');
  });
}
