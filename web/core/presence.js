// Who's in a shared note, and where their cursor is (#70, phase 3): a Yjs
// awareness for the note, carried over the live socket encrypted with the
// share's key (the server relays it to the others, never stores it).
// y-codemirror draws the others' cursors and selections from it.

import { b64, decrypt, encrypt, unb64 } from './crypto.js';
import { shareAad } from './sig.js';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from '../vendor/codemirror.mjs';

/**
 * The others in a note, as chips in `el` (the app's note header, the guest
 * page's header). One chip per person, updated in place, so presence updates
 * (every cursor move) don't redraw them: only someone arriving or leaving
 * animates (style.css: .presence span). Its row is always there while a
 * note is open, so nothing else moves either.
 */
export function renderChips(el, people) {
  const here = new Set(people.map((p) => String(p.id)));
  let prev = null;
  for (const p of people) {
    let chip = [...el.children].find((c) => c.dataset.client === String(p.id) && !c.classList.contains('leaving'));
    if (!chip) {
      chip = document.createElement('span');
      chip.dataset.client = String(p.id);
    }
    const label = p.viewing ? `${p.name} (viewing)` : p.name;
    if (chip.textContent !== label) chip.textContent = label;
    chip.title = p.viewing ? `${p.name} is viewing` : `${p.name} is here`;
    chip.classList.toggle('viewing', Boolean(p.viewing));
    chip.dataset.ycolor = p.color;
    chip.dataset.name = p.name;
    chip.dataset.initial = [...p.name][0]?.toUpperCase() ?? '?'; // (phones show initials: style.css)
    const at = prev ? prev.nextSibling : el.firstChild;
    if (chip !== at) el.insertBefore(chip, at);
    prev = chip;
  }
  for (const chip of [...el.children]) {
    if (here.has(chip.dataset.client) || chip.classList.contains('leaving')) continue;
    chip.classList.add('leaving');
    const gone = () => chip.remove();
    // Gone once it has faded out (at once if there's no animation: "reduce motion").
    if (getComputedStyle(chip).animationName === 'none') gone();
    else {
      chip.addEventListener('animationend', gone, { once: true });
      setTimeout(gone, 500); // (in case the animation never runs, e.g. a hidden tab)
    }
  }
}

/** Cursor colours: palette names that style.css turns into colours (CSP-safe, see tools/vendor/build.mjs). */
const PALETTE_SIZE = 8;
const NAME_MAX = 40;

// ---- what others send, cleaned before the editor sees it ----
// Anyone with a link (a view link too) can send anything as their presence.
// y-codemirror trusts it: one malformed cursor crashes its cursor drawing
// for the rest of the session. So each state is rebuilt from the fields we
// use, checked, before it's applied (applying is when the editor reacts).
// The format (y-protocols awareness): a count, then per client its ID,
// clock and state as JSON; numbers are lib0 varuints, strings length-prefixed.

const isId = (v) => v && Number.isSafeInteger(v.client) && v.client >= 0 && Number.isSafeInteger(v.clock) && v.clock >= 0;

/**
 * A Yjs relative position as JSON, in the exact shape Yjs makes (all four
 * fields, null when unused: y-codemirror checks them with `!== null`), or null.
 */
function cleanPosition(p) {
  if (!p || typeof p !== 'object') return null;
  const id = (v) => (v == null ? null : isId(v) ? { client: v.client, clock: v.clock } : undefined);
  const out = {
    type: id(p.type),
    tname: p.tname == null ? null : typeof p.tname === 'string' && p.tname.length <= 64 ? p.tname : undefined,
    item: id(p.item),
    assoc: p.assoc == null ? 0 : Number.isSafeInteger(p.assoc) ? p.assoc : undefined,
  };
  if (Object.values(out).includes(undefined)) return null; // a field of the wrong kind
  if (out.item === null && out.tname === null && out.type === null) return null; // points nowhere
  return out;
}

/** Someone's state, rebuilt from what we use: { user: { name, color, colorLight, viewing }, cursor }. Null if unusable. */
export function cleanState(s) {
  if (s === null) return null; // gone
  if (!s || typeof s !== 'object' || !s.user || typeof s.user !== 'object') return {};
  const color = /^c[0-7]$/.test(s.user.color) ? s.user.color : 'c0';
  const name = (typeof s.user.name === 'string' ? s.user.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '') || '?';
  const out = { user: { name, color, colorLight: color, viewing: s.user.viewing === true } };
  if (s.cursor != null) {
    const anchor = cleanPosition(s.cursor.anchor);
    const head = cleanPosition(s.cursor.head);
    if (anchor && head) out.cursor = { anchor, head };
  }
  return out;
}

function readUint(b, at) {
  let n = 0;
  for (let shift = 0; shift < 53; shift += 7) {
    if (at.i >= b.length) throw new Error('truncated');
    const byte = b[at.i++];
    n += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return n;
  }
  throw new Error('number too big');
}

function writeUint(out, n) {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

/** An awareness update with every state cleaned (see cleanState). Throws if it isn't one. */
export function cleanUpdate(bytes) {
  const at = { i: 0 };
  const count = readUint(bytes, at);
  if (count > 64) throw new Error('too many clients');
  const out = [];
  writeUint(out, count);
  for (let k = 0; k < count; k++) {
    const client = readUint(bytes, at);
    const clock = readUint(bytes, at);
    const len = readUint(bytes, at);
    if (at.i + len > bytes.length) throw new Error('truncated');
    const state = cleanState(JSON.parse(new TextDecoder().decode(bytes.subarray(at.i, at.i + len))));
    at.i += len;
    const json = new TextEncoder().encode(JSON.stringify(state));
    writeUint(out, client);
    writeUint(out, clock);
    writeUint(out, json.length);
    out.push(...json);
  }
  return new Uint8Array(out);
}
const SEND_MS = 100; // at most ~10 a second, as the server allows

export class Presence {
  /**
   * `sync` is the note's ShareDocSync, `live` the Live connection.
   * `user` = { name, viewing } (viewing: a view-only link, so no cursor to show).
   * `onChange(people)` with the others: [{ id, name, color, viewing }].
   */
  constructor(sync, live, user, { onChange = () => {} } = {}) {
    this.sync = sync;
    this.live = live;
    this.onChange = onChange;
    this.awareness = new Awareness(sync.ydoc);
    const color = `c${this.awareness.clientID % PALETTE_SIZE}`;
    this.awareness.setLocalStateField('user', { name: user.name, color, colorLight: color, viewing: Boolean(user.viewing) });
    this.pending = new Set();
    this.greeted = new Set(); // clients we've sent our full state to since they appeared
    this.onUpdate = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') {
        // Someone new: tell them about us (they only know what's sent after they joined).
        if (added.some((c) => !this.greeted.has(c))) {
          added.forEach((c) => this.greeted.add(c));
          this.queue([this.awareness.clientID]);
        }
        removed.forEach((c) => this.greeted.delete(c));
      } else {
        this.queue([...added, ...updated, ...removed]);
      }
    };
    this.awareness.on('update', this.onUpdate);
    this.onPeople = () => this.onChange(this.people());
    this.awareness.on('change', this.onPeople);
    sync.presence = this; // live pushes for the note come in through the sync
    this.queue([this.awareness.clientID]); // say hello
  }

  setName(name) {
    this.awareness.setLocalStateField('user', { ...this.awareness.getLocalState().user, name });
  }

  /** The others in the note now. */
  people() {
    const out = [];
    for (const [id, state] of this.awareness.getStates()) {
      if (id !== this.awareness.clientID && state.user) out.push({ id, ...state.user });
    }
    return out;
  }

  queue(clients) {
    clients.forEach((c) => this.pending.add(c));
    this.timer ??= setTimeout(() => this.send(), SEND_MS);
  }

  async send() {
    this.timer = null;
    const clients = [...this.pending];
    this.pending.clear();
    if (!clients.length) return;
    const { id, keys } = this.sync.share;
    const update = encodeAwarenessUpdate(this.awareness, clients);
    const { nonce, ciphertext } = await encrypt(keys.encKey, update, shareAad(id, 'presence'));
    const data = new Uint8Array(12 + ciphertext.length);
    data.set(nonce);
    data.set(ciphertext, 12);
    this.live.send({ presence: this.sync.docId, data: b64(data) });
  }

  /** A presence message from the server (someone else). */
  async receive(data) {
    let update;
    try {
      const bytes = unb64(data);
      const { id, keys } = this.sync.share;
      update = cleanUpdate(await decrypt(keys.encKey, bytes.subarray(0, 12), bytes.subarray(12), shareAad(id, 'presence')));
    } catch {
      return; // not from this share's key, or not a presence message: ignore
    }
    applyAwarenessUpdate(this.awareness, update, 'remote');
  }

  /** (Re)subscribed: everyone else may have missed us. */
  resubscribed() {
    this.greeted.clear();
    this.queue([this.awareness.clientID]);
  }

  /**
   * The page is going away, maybe only into the browser's back/forward cache:
   * say goodbye (as destroy does), but keep everything, to rejoin() if the
   * page is shown again. Returns when the goodbye is sent.
   */
  leave() {
    if (this.left || !this.awareness.getLocalState()) return Promise.resolve();
    this.left = this.awareness.getLocalState();
    clearTimeout(this.timer);
    this.timer = null;
    removeAwarenessStates(this.awareness, [this.awareness.clientID], 'local');
    clearTimeout(this.timer); // (queued by that: sent now instead)
    this.timer = null;
    this.pending = new Set([this.awareness.clientID]);
    return this.send().catch(() => {});
  }

  /** Shown again after leave() (Back, then Forward): here again, as before. */
  rejoin() {
    if (!this.left) return;
    const state = this.left;
    this.left = null;
    this.greeted.clear(); // the others dropped us: let them introduce themselves again
    this.awareness.setLocalState(state); // queued and sent like any change
  }

  /**
   * Leaving the note: say goodbye, so our cursor disappears for the others at
   * once. Returns when it's sent: unsubscribe only then, or the server drops
   * it (presence needs a subscription) and we linger for 30 s.
   */
  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
    this.awareness.off('update', this.onUpdate); // the goodbye is sent once, below
    this.awareness.off('change', this.onPeople);
    removeAwarenessStates(this.awareness, [this.awareness.clientID], 'local');
    this.pending = new Set([this.awareness.clientID]);
    const bye = this.send(); // (encodes the goodbye before its first await)
    this.awareness.destroy();
    if (this.sync.presence === this) this.sync.presence = null;
    return bye.catch(() => {});
  }
}
