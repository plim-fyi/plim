// History (#60, #340): the open note's versions by day, each saying what it changed; the chosen one
// as the note read then, its changes marked; Restore. (The versions themselves: ../history.js.)
import { $, flashLabel, showToast, state } from './shared.js';
import { isOffline } from '../core/api.js';
import { appMark, appsBetween, whoOf } from '../core/authorship.js';
import { applyText, changeSummary, diffLines, diffSummary, foldContext, forgetHistory, listVersions, readVersion, saveVersion } from '../core/history.js';

/** The History dialog open now: its note, and what's loaded of it (null: closed). */
let current = null;


const RESTORE = 'restore'; // origin of a Restore's edit (local: it saves and syncs like typing)
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const secFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const yearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** "Today", "Yesterday", "Thu, 3 Oct" (and the year when it isn't this one), for a time in seconds. */
function dayLabel(secs) {
  const d = new Date(secs * 1000);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return (d.getFullYear() === new Date().getFullYear() ? dayFmt : yearFmt).format(d);
}
const whenLabel = (secs) => `${dayLabel(secs)}, ${timeFmt.format(secs * 1000)}`;

/** Lines added and removed, in words: "3 lines added, 1 removed". */
function countsLabel(added, removed) {
  const lines = (n) => `${n} line${n === 1 ? '' : 's'}`;
  if (added && removed) return `${lines(added)} added, ${removed} removed`;
  return added ? `${lines(added)} added` : `${lines(removed)} removed`;
}

const p = (className, textContent) => Object.assign(document.createElement('p'), { className, textContent });

/**
 * Instead of the versions: loading, none yet, offline (a line and, maybe, one under it). `brief`:
 * all there is to show (none yet, offline), so the dialog is a small one round it, not the
 * versions' big one empty (#358).
 */
function historyMessage(title, line = '', { brief = false } = {}) {
  $('history-message').replaceChildren(...(title ? [p('history-message-title', title)] : []), ...(line ? [p('', line)] : []));
  $('history-message').hidden = !title;
  $('history-body').hidden = Boolean(title);
  $('history-dialog').classList.toggle('brief', brief);
}

/** Fade something in (style.css .appear) rather than have it pop up. */
function appear(el) {
  el.classList.remove('appear');
  void el.offsetWidth; // (restarts the animation)
  el.classList.add('appear');
}

const NOW = 'now'; // the History list's top row: the note as it is
let folded = true; // only the changes (#547: as GitHub shows a diff), or the whole note (kept while the page is open)

/** The open note's History: its versions (newest first, by day), what each changed, Restore. */
async function openHistory() {
  const n = state.note;
  if (!n) return;
  const h = (current = { id: n.id, note: n, sync: n.sync, texts: new Map(), loads: new Map(), rows: new Map(), seconds: new Set(), selected: null });
  $('history-dialog').classList.remove('previewing');
  $('history-note').textContent = $('note-title').textContent;
  $('history-list').replaceChildren(); // (not the last note's rows while this loads)
  // Blank at first (at its full size): "Loading…" only if that takes a moment, not a flash before a quick load.
  historyMessage(' ');
  const slow = setTimeout(() => current === h && !h.revealed && historyMessage('Loading…'), 300);
  // The list first, if it's quick (a quarter of a second at most): then the dialog opens at the size
  // of what it shows, small round "No earlier versions yet", not big and then shrinking (#358).
  let listed = null;
  const listing = listVersions(n.sync).then((versions) => ({ versions }), (err) => ({ err }))
    .then((r) => (listed = r));
  await Promise.race([listing, new Promise((r) => setTimeout(r, 250))]);
  if (current !== h) return clearTimeout(slow);
  /** All there is to say instead of versions: none, or why they couldn't be listed (else null). */
  const nothing = ({ versions, err }) => {
    if (err) return [isOffline(err) ? 'History needs a connection.' : `Couldn’t load the history: ${err.message}`, ''];
    if (!versions.length) return ['No earlier versions yet', 'While you edit, Plim keeps a version of this note at most once an hour. They’ll show up here.'];
    return null;
  };
  if (listed && nothing(listed)) historyMessage(...nothing(listed), { brief: true });
  $('history-dialog').showModal();
  const opened = performance.now();
  const { versions, err } = await listing;
  if (current !== h) return;
  if (err || !versions.length) {
    clearTimeout(slow);
    return historyMessage(...nothing({ versions, err }), { brief: true });
  }
  h.versions = versions;
  h.texts.set(NOW, { id: NOW, at: null, text: n.sync.ydoc.getText('body').toString() });
  renderList(h);
  // Shown once the newest version's changes are ready too, in one go: one fade (none while the
  // dialog is still fading in itself, style.css dialog), not the list first and its text after.
  await selectVersion(h.versions[0].id);
  clearTimeout(slow);
  if (current !== h) return;
  historyMessage('');
  if (performance.now() - opened > 160) appear($('history-body'));
  h.revealed = true;
  watchRows(h); // (now that its rows are in sight)
  updateSums(h);
}

/** A row of the list: the time and (once both texts are here) the lines it added and removed, and what it changed. */
function historyRow(id, label, apps = []) {
  const b = Object.assign(document.createElement('button'), { type: 'button' });
  b.dataset.id = id;
  const top = Object.assign(document.createElement('span'), { className: 'history-row-top' });
  // An app's changes in it (#389): its badge before the time, its name in the row's label.
  for (const name of apps.slice(0, 2)) {
    const badge = Object.assign(document.createElement('span'), { className: 'reach-badge', title: `With changes by ${name}` });
    badge.dataset.i = appMark(name).letter;
    badge.style.setProperty('--c', appMark(name).color);
    top.append(badge);
  }
  if (apps.length) b.setAttribute('aria-description', `With changes by ${apps.join(' and ')}`);
  // Who, in words ("Claude · amber fox", #505): from the note's record until the version's own writer is read.
  top.append(Object.assign(document.createElement('span'), { className: 'history-time', textContent: label }),
    Object.assign(document.createElement('span'), { className: 'history-by', textContent: apps.join(', ') }),
    Object.assign(document.createElement('span'), { className: 'history-sum' }));
  b.append(top, Object.assign(document.createElement('span'), { className: 'history-what', textContent: id === NOW ? 'Your note as it is' : ' ' }));
  b.addEventListener('click', () => selectVersion(id === NOW ? NOW : Number(id), { show: true }));
  const li = document.createElement('li');
  li.append(b);
  return li;
}

/**
 * A version's row, once its own writer is read (#505): who it says made it, in place of what the
 * note's record of sessions suggested (versions are timed to the second, so that can be a step off).
 * A version that doesn't say keeps the suggestion.
 */
function labelRow(id, writer) {
  const who = whoOf(writer);
  const b = who && $('history-list').querySelector(`button[data-id="${id}"]`);
  if (!b) return;
  const top = b.querySelector('.history-row-top');
  for (const old of top.querySelectorAll('.reach-badge')) old.remove();
  const badge = Object.assign(document.createElement('span'), { className: 'reach-badge', title: `By ${who}` });
  badge.dataset.i = appMark(writer.name).letter;
  badge.style.setProperty('--c', appMark(writer.name).color);
  top.prepend(badge);
  top.querySelector('.history-by').textContent = who;
  b.setAttribute('aria-description', `By ${who}`);
}

/** The version a version's changes are counted from: the one before it (for Now, the newest). */
function olderThan(h, id) {
  if (id === NOW) return h.versions[0]?.id;
  return h.versions[h.versions.findIndex((v) => v.id === id) + 1]?.id;
}

/** A version's text, fetched and decrypted once. */
function versionText(h, id) {
  if (!h.loads.has(id)) {
    h.loads.set(id, readVersion(h.sync, id).then((v) => {
      h.texts.set(id, v);
      if (v.writer && current === h) labelRow(id, v.writer);
      return v;
    }));
  }
  return h.loads.get(id);
}

/** What a version changed since the one before (diffLines rows, worked out once), or null until both are here. */
function changesOf(h, id) {
  const v = h.texts.get(id);
  const o = h.texts.get(olderThan(h, id));
  if (!v || !o) return null;
  if (!h.rows.has(id)) h.rows.set(id, diffLines(o.text, v.text));
  return h.rows.get(id);
}

const PAGE = 60; // (versions listed at first, and more each time "Show earlier versions" is picked)
const BURST = 3; // (this many versions in a row by one app's session, minutes apart, are folded into one row)
const BURST_GAP = 5 * 60; // (seconds between two of a burst at most: #505)

/**
 * The list: Now, then the versions newest first by day, the first PAGE of them (and a row for more);
 * a run of BURST or more by the same app's session, each within BURST_GAP of the next (an agent at work, #74, #505),
 * folded into one row that opens to show them. A version's text is loaded once its row is in sight.
 */
function renderList(h) {
  const n = h.note;
  h.shown ??= PAGE;
  const groups = [];
  const group = (day) => {
    const li = Object.assign(document.createElement('li'), { className: 'history-group' });
    if (day) li.append(Object.assign(document.createElement('h3'), { className: 'history-day', textContent: day }));
    const ul = document.createElement('ul');
    li.append(ul);
    groups.push(li);
    return ul;
  };
  let rows = group('');
  // (The apps that wrote in each stretch, from the note's record of their sessions, #389.)
  const apps = (after, upto) => appsBetween(n.sync.ydoc, after * 1000, upto * 1000);
  rows.append(historyRow(NOW, 'Now', apps(h.versions[0].created_at, Infinity)));
  const listed = h.versions.slice(0, h.shown);
  const minute = (i) => listed[i] && Math.floor(listed[i].created_at / 60);
  const by = listed.map((v, i) => apps(h.versions[i + 1]?.created_at ?? 0, v.created_at));
  const label = (v, i) => {
    // Two in the same minute (#107): with seconds, to tell them apart.
    const seconds = minute(i) === minute(i - 1) || minute(i) === minute(i + 1);
    if (seconds) h.seconds.add(v.id);
    return (seconds ? secFmt : timeFmt).format(v.created_at * 1000);
  };
  let day = null;
  for (let i = 0; i < listed.length; ) {
    const v = listed[i];
    if (dayLabel(v.created_at) !== day) rows = group((day = dayLabel(v.created_at)));
    // A burst: the same session of an app (and only it), the same day, each close to the next.
    let end = i + 1;
    const who = by[i].join(', ');
    while (who && end < listed.length && by[end].join(', ') === who && dayLabel(listed[end].created_at) === day && listed[end - 1].created_at - listed[end].created_at <= BURST_GAP) end++;
    if (end - i >= BURST) {
      rows.append(burstRow(h, listed.slice(i, end).map((x, k) => historyRow(x.id, label(x, i + k), by[i + k])), who, listed[end - 1], v));
      i = end;
    } else {
      rows.append(historyRow(v.id, label(v, i), by[i]));
      i++;
    }
  }
  if (h.versions.length > h.shown) {
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'history-more', textContent: `Show earlier versions (${h.versions.length - h.shown} more)` });
    more.addEventListener('click', () => {
      h.shown += PAGE;
      renderList(h);
      for (const b of $('history-list').querySelectorAll('button[data-id]')) b.setAttribute('aria-current', String(b.dataset.id === String(h.selected)));
    });
    const li = document.createElement('li');
    li.append(more);
    groups.push(li);
  }
  $('history-list').replaceChildren(...groups);
  for (const [id, v] of h.texts) if (v.writer) labelRow(id, v.writer); // (what its versions say, kept across a redraw)
  watchRows(h);
  updateSums(h);
}

/** A burst's row: who, how many, from when to when; it opens to show them. */
function burstRow(h, items, who, first, last) {
  const li = Object.assign(document.createElement('li'), { className: 'history-burst' });
  const head = Object.assign(document.createElement('button'), { type: 'button', className: 'history-burst-head' });
  head.setAttribute('aria-expanded', 'false');
  const span = `${timeFmt.format(first.created_at * 1000)}–${timeFmt.format(last.created_at * 1000)}`;
  head.append(Object.assign(document.createElement('span'), { className: 'history-time', textContent: `${who} · ${items.length} versions` }),
    Object.assign(document.createElement('span'), { className: 'history-what', textContent: span }));
  const ul = Object.assign(document.createElement('ul'), { className: 'history-burst-rows', hidden: true });
  ul.append(...items);
  head.addEventListener('click', () => {
    ul.hidden = !ul.hidden;
    head.setAttribute('aria-expanded', String(!ul.hidden));
    watchRows(h);
  });
  // (One of its versions picked, from Now's neighbour or a key: it opens.)
  li.addEventListener('focusin', (e) => {
    if (e.target !== head && ul.hidden) head.click();
  });
  li.append(head, ul);
  return li;
}

/** Each row in sight (and the one before it, for what it changed) has its text loaded, once. */
function watchRows(h) {
  h.observer?.disconnect();
  h.observer = new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      h.observer.unobserve(e.target);
      const id = e.target.dataset.id === NOW ? NOW : Number(e.target.dataset.id);
      const older = olderThan(h, id);
      Promise.all([id === NOW ? null : versionText(h, id), older === undefined ? null : versionText(h, older)])
        .then(() => current === h && updateSums(h), () => {});
    }
  });
  for (const b of $('history-list').querySelectorAll('button[data-id]')) if (!b.dataset.done && b.offsetParent) h.observer.observe(b);
}

function updateSums(h) {
  for (const b of $('history-list').querySelectorAll('button[data-id]')) {
    const sum = b.querySelector('.history-sum');
    if (b.dataset.done) continue;
    const id = b.dataset.id === NOW ? NOW : Number(b.dataset.id);
    const what = b.querySelector('.history-what');
    if (olderThan(h, id) === undefined) {
      if (!h.texts.has(id)) continue;
      b.dataset.done = '1';
      what.textContent = 'The first version kept';
      if (h.revealed) appear(what);
      continue;
    }
    const rows = changesOf(h, id);
    if (!rows) continue;
    b.dataset.done = '1';
    const { added, removed } = diffSummary(rows);
    if (added) sum.append(Object.assign(document.createElement('span'), { className: 'plus', textContent: `+${added}` }));
    if (removed) sum.append(Object.assign(document.createElement('span'), { className: 'minus', textContent: `−${removed}` }));
    if (added || removed) sum.setAttribute('aria-label', countsLabel(added, removed));
    if (id !== NOW) what.textContent = changeSummary(rows) || 'No changes';
    if (h.revealed) for (const el of [sum, what]) appear(el); // (those ready before it's shown come with it)
  }
}

/** Show a version: the note as it read then, its changes marked. `show`: on a phone, switch to it. */
async function selectVersion(id, { show = false } = {}) {
  const h = current;
  if (!h?.versions) return;
  h.selected = id;
  for (const b of $('history-list').querySelectorAll('button[data-id]')) b.setAttribute('aria-current', String(b.dataset.id === String(id)));
  // (In a folded burst: it opens, so what's shown is in the list.)
  const row = $('history-list').querySelector(`button[data-id="${id}"]`);
  const burst = row?.closest('.history-burst-rows');
  if (burst?.hidden) burst.parentElement.querySelector('.history-burst-head').click();
  if (show && !$('history-dialog').classList.contains('previewing') && phone()) {
    $('history-dialog').classList.add('previewing');
    $('history-when').focus({ preventScroll: true }); // (read out first, as a page's title)
  }
  $('history-restore').disabled = $('history-copy').disabled = true;
  const older = olderThan(h, id);
  if (!h.texts.has(id) || (older !== undefined && !h.texts.has(older))) {
    // What was shown stays until this one is ready; "Loading…" only if that takes a moment (no flash).
    const slow = setTimeout(() => h.selected === id && $('history-diff').replaceChildren(historyNote('Loading…')), 300);
    try {
      await Promise.all([id === NOW ? null : versionText(h, id), older === undefined ? null : versionText(h, older)]);
    } catch (err) {
      const text = isOffline(err) ? 'History needs a connection.' : `Couldn’t open this version: ${err.message}`;
      if (h.selected === id) $('history-diff').replaceChildren(historyNote(text));
      if (!h.texts.has(id)) return;
    } finally {
      clearTimeout(slow);
    }
  }
  if (current !== h || h.selected !== id) return;
  renderVersion(h);
}

const phone = () => matchMedia('(max-width: 720px)').matches;

function historyNote(text) {
  return p('note', text);
}

function renderVersion(h) {
  const id = h.selected;
  const v = h.texts.get(id);
  const olderId = olderThan(h, id);
  const o = h.texts.get(olderId);
  // With seconds when the list shows them (two in one minute).
  const when = (x) => (h.seconds.has(x.id) ? `${dayLabel(x.at)}, ${secFmt.format(x.at * 1000)}` : whenLabel(x.at));
  const changes = changesOf(h, id);
  const rows = changes ?? (v.text === '' ? [] : v.text.split('\n').map((text) => ({ kind: 'same', text })));
  const { added, removed } = diffSummary(rows);
  let since = '';
  if (olderId === undefined) since = 'The first version Plim kept of this note';
  else if (o) since = `${added || removed ? countsLabel(added, removed) : 'No changes'} since ${when(o)}`;
  $('history-when').textContent = id === NOW ? 'Now' : when(v);
  $('history-since').textContent = id === NOW && since ? `Your note as it is · ${since[0].toLowerCase()}${since.slice(1)}` : since;
  // Only its changes, with 3 lines around each, the rest folded (each fold opens in place); or the whole note.
  const foldable = foldContext(rows);
  const canFold = foldable.some((r) => r.kind === 'fold') && (added || removed);
  $('history-fold').hidden = !canFold;
  $('history-fold').textContent = folded ? 'Show the whole note' : 'Only the changes';
  const shown = canFold && folded ? foldable : rows;
  const el = $('history-diff');
  el.replaceChildren(...(rows.length ? shown.map(diffRow) : [historyNote('The note was empty.')]));
  // Its first change in view (the whole note shown, it may be a long way down): a third of the way in.
  el.scrollTop = 0;
  const first = el.querySelector('ins, del');
  if (first && first.offsetTop + first.offsetHeight > el.clientHeight - 16) el.scrollTop = first.offsetTop - el.clientHeight / 3;
  // Switching versions fades the new one in; the first comes in with the dialog.
  if (h.revealed) for (const x of [el, $('history-when'), $('history-since')]) appear(x);
  $('history-copy').disabled = false;
  $('history-restore').hidden = id === NOW;
  $('history-restore').disabled = id === NOW;
  $('history-hint').textContent = id === NOW
    ? 'Choose an earlier version to see it, or to restore it.'
    : 'Restoring keeps what you have now as a version, so it can be undone.';
}

/** A fold's icon: arrows apart, as it opens (built, not markup: no innerHTML in the app). */
function unfoldIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M5 5.5 8 2.5l3 3', 'M5 10.5l3 3 3-3']) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** One line of the version (text only: a shared note's text is anyone's). A fold opens to its lines. */
function diffRow(r) {
  if (r.kind === 'fold') {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'fold' });
    b.append(unfoldIcon(), `Show ${r.count} unchanged line${r.count === 1 ? '' : 's'}`);
    b.addEventListener('click', () => b.replaceWith(...r.rows.map(diffRow)));
    return b;
  }
  const el = document.createElement(r.kind === 'del' ? 'del' : r.kind === 'add' ? 'ins' : 'span');
  el.className = r.kind === 'same' ? 'line same' : 'line';
  if (/^#{1,6}\s/.test(r.text)) el.classList.add('heading');
  if (r.parts) {
    for (const part of r.parts) el.append(part.changed ? Object.assign(document.createElement('span'), { className: 'word', textContent: part.text }) : part.text);
  } else {
    el.textContent = r.text;
  }
  return el;
}

/**
 * Make the note read like the selected version again: one edit (applyText),
 * so it saves, syncs and merges like typing. The note as it was is kept as a
 * version first, and the toast's Undo puts it straight back.
 */
async function restoreVersion() {
  const h = current;
  const v = h?.texts.get(h.selected);
  const n = state.note;
  if (!v || h.selected === NOW || n?.id !== h.id) return;
  const ytext = n.sync.ydoc.getText('body');
  const before = ytext.toString();
  $('history-dialog').close();
  if (before === v.text) return showToast('The note already reads like that version.');
  await saveVersion(n.sync, before).catch((e) => console.warn('could not keep the note as it was', e));
  if (state.note?.id !== h.id) return;
  applyText(ytext, v.text, RESTORE);
  showToast(`Restored the version from ${whenLabel(v.at)}`, {
    action: 'Undo',
    onAction: () => state.note?.id === h.id && applyText(state.note.sync.ydoc.getText('body'), before, RESTORE),
  });
}

$('note-history').addEventListener('click', openHistory);
$('history-back').addEventListener('click', () => {
  $('history-dialog').classList.remove('previewing');
  $('history-list').querySelector('button[aria-current="true"]')?.focus({ preventScroll: true });
});
$('history-restore').addEventListener('click', restoreVersion);
$('history-fold').addEventListener('click', () => {
  folded = !folded;
  if (current?.texts.has(current.selected)) renderVersion(current);
});
// Up and down (Home, End) move through the versions, as in a list.
$('history-list').addEventListener('keydown', (e) => {
  const rows = [...$('history-list').querySelectorAll('button[data-id], .history-burst-head')].filter((b) => b.offsetParent);
  const at = rows.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (at < 0 || to === undefined || !rows[to]) return;
  e.preventDefault();
  rows[to].focus();
  if (!phone() && rows[to].dataset.id) rows[to].click();
});
$('history-copy').addEventListener('click', async () => {
  const v = current?.texts.get(current.selected);
  if (!v) return;
  await navigator.clipboard.writeText(v.text).then(() => {
    flashLabel($('history-copy'), 'Copied');
  }, () => {});
});
// Forget history: every earlier version deleted for good (asked first: it can't be undone); the
// note stays as it is. On every device, as the versions are the server's.
$('history-forget').addEventListener('click', async () => {
  const h = current;
  const n = h?.versions?.length;
  if (!n) return;
  const which = n === 1 ? 'Its earlier version is' : `All ${n} of its earlier versions are`;
  if (!confirm(`Forget this note’s history?\n\n${which} deleted for good, on all your devices. The note itself stays as it is now.`)) return;
  try {
    await forgetHistory(h.sync);
  } catch (e) {
    return showToast(isOffline(e) ? 'Forgetting its history needs a connection.' : e?.status === 404 ? 'Only the note’s owner can forget its history.' : `Couldn’t forget its history: ${e.message}`);
  }
  if (current !== h) return;
  h.versions = [];
  historyMessage('History forgotten', 'Its earlier versions were deleted. New ones are kept from now on, as you edit.', { brief: true });
});
$('history-dialog').addEventListener('close', () => {
  current?.observer?.disconnect();
  current = null;
});
