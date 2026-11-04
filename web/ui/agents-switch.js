// The switch to sharing with agents (#514), once: before, an agent reached the notes with the tags
// it was given; now it sees the notes shared with agents, whatever their tags. The notes it reached
// through tags, and that aren't shared with agents, are listed, ticked: those left ticked are shared
// with agents, the rest stay yours. Then the tags go from every connection, and upkeep
// (connections-keep.js) takes back what agents no longer have, re-keying it.
import { grantedTags, NOTEBOOK, reachedByTags } from '../core/connections-sync.js';
import { now as clockNow } from '../core/clock.js';
import { connectionsMap, grantsEdited, holdGrants, scheduleGrants } from './connections-keep.js';
import { renderList } from './notelist.js';
import { $, editedHere, el, notesMap, showToast } from './shared.js';

/** The connections still given tags (from before #514). */
const given = () => [...connectionsMap().entries()].filter(([, c]) => grantedTags(c).length);

/** The notes listed, as the dialog shows them; null when it isn't. */
let shown = null;

/**
 * Called as the notes open (app.js enterNotes): true if the switch was shown (upkeep waits for it).
 * With no note to ask about, the tags just go.
 */
export function maybeShowSwitch() {
  const old = given();
  if (!old.length) return false;
  const notes = reachedByTags(notesMap(), old.map(([, c]) => c));
  if (!notes.length) {
    finish([]);
    return false;
  }
  shown = notes;
  holdGrants(true); // (nothing taken back while you choose)
  const names = [...new Set(old.map(([, c]) => c.name))];
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  $('agents-switch-who').textContent = `${who} reached ${notes.length === 1 ? 'this note' : `these ${notes.length} notes`} through tags. Keep sharing them?`;
  $('agents-switch-list').replaceChildren(
    ...notes.map((n) => {
      const li = el('li', 'pick-row');
      const label = el('label', 'pick-label');
      const box = el('input', '', { type: 'checkbox', checked: true });
      box.dataset.id = n.id;
      box.addEventListener('change', renderGo);
      const words = el('span', 'pick-words');
      words.append(el('span', 'setting-title', { textContent: n.title }), el('span', 'setting-sub tag-name', { textContent: `#${n.through}` }));
      label.append(box, words);
      li.append(label);
      return li;
    }),
  );
  renderGo();
  $('agents-switch-dialog').showModal();
  return true;
}

const ticked = () => [...$('agents-switch-list').querySelectorAll('input:checked')].map((b) => b.dataset.id);

function renderGo() {
  const n = ticked().length;
  $('agents-switch-go').textContent = !n ? 'Share none' : n === shown?.length ? 'Share these with agents' : `Share ${n === 1 ? '1 note' : `${n} notes`} with agents`;
}

/** The ticked notes shared with agents, and the tags gone from every connection: upkeep follows. */
function finish(ids) {
  for (const id of ids) {
    const m = notesMap().get(id);
    if (!m || m.get('place') === NOTEBOOK) continue;
    m.set('place', NOTEBOOK);
    editedHere.set(id, clockNow()); // (this device's change: the apps' notes follow from here, at once)
  }
  for (const [cid, c] of given()) {
    const { tags, ownTag, notebook, ...rest } = c;
    connectionsMap().set(cid, rest);
    grantsEdited.add(cid); // (this device takes back what they no longer have)
  }
}

$('agents-switch-go').addEventListener('click', () => {
  const ids = ticked();
  finish(ids);
  shown = null;
  $('agents-switch-dialog').close();
  renderList();
  showToast(ids.length ? `${ids.length === 1 ? '1 note' : `${ids.length} notes`} shared with agents` : 'Your notes stay yours');
});
$('agents-switch-dialog').addEventListener('close', () => {
  shown = null; // (Later: asked again next time)
  holdGrants(false);
  scheduleGrants(0);
});
