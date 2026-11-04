// Type / for a menu (#311): the menu under the cursor's line, for
// either editor (the rules it follows: slash.js). The editor tells it what happens — a character
// typed, the text or the cursor moved, a key — and it tells the editor what to put in when an
// option is picked.
//
// It never takes the focus: the editor keeps it (and a phone its keyboard) while the menu is
// tapped or clicked, and keys reach it through the editor.
import { localNow, matching, opensAt, queryAt } from './slash.js';

let menus = 0;

/**
 * What the menu offers, and when. `opens(slice, ch, pos)`: where what it replaces starts, now that
 * `ch` is typed at `pos` (`slice`: the host's, the note's text read only when it may open), or null; `query(piece)`: what's typed, from there to
 * the cursor, or null when it's no longer one of its own; `items(query, host)`: the options, each
 * { id, label, detail, text() } (text(): what a pick puts in, at the moment it's picked);
 * `enterPicks(query, item)`: whether Enter (and a phone's Return) picks `item`, or goes on to be
 * a new line.
 */
const SOURCES = {
  // Commands: a `/` typed at a line's start or after a space.
  command: {
    label: 'Insert',
    opens: (slice, ch, pos) => (ch === '/' && opensAt(slice(0, pos + 1), pos) ? pos : null),
    query: (piece) => queryAt(piece, 0, piece.length),
    items: (q) => {
      const now = localNow();
      return matching(q).map((c) => ({ id: c.id, label: c.label, detail: c.text(now), text: () => c.text(localNow()) }));
    },
    // (On a computer, Enter picks a bare `/`'s first, as Notion does; a phone's Return, once something's typed.)
    enterPicks: (q, item, touch) => !touch || q !== '',
  },
  // (Tags aren't typed in the text since #584: the note's header has their picker, ui/notehead.js.)
};

export class SlashMenu {
  /**
   * `host`, the editor as the menu needs it:
   *   root: the element the menu is drawn in (positioned); field: the element with the focus;
   *   scroller: what scrolls the text; slice(from, to): the note's text; cursor(): the cursor's
   *   position (null with a selection); caretRect(pos): the character's box on screen (null if
   *   not drawn); replace(from, to, text): a pick put in, as one undo step; measure(fn): `fn` run
   *   when the layout can be read (optional); touch: a phone's (its Return picks a command only
   *   after a filter);
   *   onToggle(open): the menu came or went (optional: the title isn't taken from what's being typed).
   */
  constructor(host) {
    this.host = host;
    this.source = null; // what's open: SOURCES' command
    this.start = null; // where what it replaces starts (its `/` or `#`)
    this.query = null;
    this.items = [];
    this.active = 0;
    const el = (this.el = document.createElement('div'));
    el.className = 'slash-menu';
    el.id = `slash-menu-${++menus}`;
    el.setAttribute('role', 'listbox');
    el.hidden = true;
    // (Pressed: the editor keeps the focus, and a phone its keyboard.)
    for (const type of ['pointerdown', 'mousedown']) el.addEventListener(type, (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      const option = e.target.closest('[data-i]');
      if (option) this.pick(Number(option.dataset.i));
    });
    host.root.append(el);
    this.follow = () => this.placeSoon();
  }

  get isOpen() {
    return this.source != null;
  }

  /** What's being typed for the menu (`/tod`, `#gy`), where it is: not part of the title. Null when closed. */
  range() {
    const cursor = this.host.cursor();
    return this.isOpen && cursor != null ? { from: this.start, to: cursor } : null;
  }

  /** `ch` typed at `pos` (by you: not pasted, not someone else's): the menu, if it's somewhere one is likely meant. */
  typed(pos, ch) {
    if (this.isOpen) return this.refresh();
    for (const source of Object.values(SOURCES)) {
      const start = source.opens(this.host.slice, ch, pos);
      if (start == null) continue;
      this.source = source;
      this.start = start;
      this.query = null;
      this.active = 0;
      this.nudged = false;
      this.el.setAttribute('aria-label', source.label);
      this.host.scroller.addEventListener('scroll', this.follow, { passive: true });
      globalThis.visualViewport?.addEventListener('resize', this.follow);
      this.host.onToggle?.(true);
      return this.refresh();
    }
  }

  /** Positions moved by an edit from elsewhere: the menu's start, through `map`. */
  map(map) {
    if (this.isOpen) this.start = map(this.start);
  }

  /** What's typed for it now, or null when that's no longer the menu's (the cursor moved off it, a space typed…). */
  current() {
    const cursor = this.host.cursor();
    if (cursor == null || cursor <= this.start) return null;
    const q = this.source.query(this.host.slice(this.start, cursor));
    return q == null ? null : { q, cursor };
  }

  /** After the text changed or the cursor moved: still being typed, with options to offer? Else the menu goes. */
  refresh() {
    if (!this.isOpen) return;
    const now = this.current();
    const items = now ? this.source.items(now.q, this.host) : [];
    if (!items.length) return this.close();
    if (now.q !== this.query) this.active = 0; // (more typed: the best match first)
    this.query = now.q;
    this.items = items;
    this.render();
    this.placeSoon();
  }

  /** A key while the menu is open: ↑ ↓ choose, Enter and Tab pick, Escape closes. Whether it was the menu's. */
  key(key) {
    if (!this.isOpen) return false;
    const n = this.items.length;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.active = (this.active + (key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.render();
      return true;
    }
    if (key === 'Tab') return this.pick(this.active), true;
    if (key === 'Enter') return this.returnPicks();
    if (key === 'Escape') return this.close(), true;
    return false;
  }

  /** Enter, or a phone's Return: picks (whether it does: SOURCES' enterPicks), else the menu goes and it's a new line. */
  returnPicks() {
    if (!this.isOpen) return false;
    if (this.source.enterPicks(this.query, this.items[this.active], Boolean(this.host.touch))) return this.pick(this.active), true;
    this.close();
    return false;
  }

  /** The option at `i` picked: what's typed for the menu replaced with its text, as it is now. */
  pick(i) {
    const item = this.items[i];
    const now = this.isOpen ? this.current() : null;
    const from = this.start;
    this.close();
    if (!item || !now) return;
    let text = item.text();
    if (text.endsWith(' ') && /^\s/.test(this.host.slice(now.cursor, now.cursor + 1))) text = text.slice(0, -1); // (a space there already)
    this.host.replace(from, now.cursor, text);
  }

  close() {
    if (!this.isOpen) return;
    this.source = null;
    this.start = null;
    this.query = null;
    this.items = [];
    this.el.hidden = true;
    this.el.replaceChildren();
    this.shown = null;
    const { field } = this.host;
    for (const a of ['aria-expanded', 'aria-controls', 'aria-activedescendant']) field.removeAttribute(a);
    this.host.scroller.removeEventListener('scroll', this.follow);
    globalThis.visualViewport?.removeEventListener('resize', this.follow);
    this.host.onToggle?.(false);
  }

  /** The options drawn, when they've changed (not at every cursor move: a tap mid-way would lose its option). */
  render() {
    const shown = this.items.map((c) => `${c.id}:${c.detail}`).join('\n') + `@${this.active}`;
    if (shown === this.shown) return;
    this.shown = shown;
    const options = this.items.map((c, i) => {
      const option = document.createElement('div');
      option.className = 'slash-option';
      option.id = `${this.el.id}-${i}`;
      option.dataset.i = String(i);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === this.active));
      const label = Object.assign(document.createElement('span'), { className: 'slash-label', textContent: c.label });
      const badge = c.badge?.();
      if (badge) label.append(badge);
      option.append(label, Object.assign(document.createElement('span'), { className: 'slash-detail', textContent: c.detail }));
      return option;
    });
    this.el.replaceChildren(...options);
    const { field } = this.host;
    field.setAttribute('aria-expanded', 'true');
    field.setAttribute('aria-controls', this.el.id);
    field.setAttribute('aria-activedescendant', options[this.active].id);
  }

  /** Placed once the layout can be read (CodeMirror's: in its measure step). */
  placeSoon() {
    if (!this.isOpen) return;
    if (this.host.measure) this.host.measure(() => this.place());
    else this.place();
  }

  /**
   * Under the line, or over it when there's no room below (above a phone's keyboard); out of
   * sight while the line is scrolled out of view.
   */
  place() {
    if (!this.isOpen) return;
    const { el, host } = this;
    const at = host.caretRect(this.start);
    const root = host.root.getBoundingClientRect();
    const view = host.scroller.getBoundingClientRect();
    const vv = globalThis.visualViewport;
    const bottom = Math.min(view.bottom, vv ? vv.offsetTop + vv.height : innerHeight);
    if (!at || at.bottom < view.top || at.top > bottom) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.maxHeight = '';
    const gap = 4, w = el.offsetWidth, h = el.offsetHeight;
    let below = at.bottom + gap + h <= bottom - 8 || at.top - gap - h < Math.max(view.top, vv ? vv.offsetTop : 0);
    // Over the line would cover the note's title and tags (a phone, the keyboard up, the first
    // lines): the text scrolled up instead, once, the header with it, for room under the line (its
    // scroll places the menu again); a short note, with nothing to scroll, gets the menu under the
    // line, shorter (it scrolls), if two options fit there.
    const head = document.getElementById('note-head');
    const headBottom = head && !head.hidden ? head.getBoundingClientRect().bottom : -Infinity;
    if (!below && at.top - gap - h < headBottom) {
      const s = host.scroller, need = Math.ceil(at.bottom + gap + h - (bottom - 8));
      if (!this.nudged && need > 0 && need <= s.scrollHeight - s.clientHeight - s.scrollTop) {
        this.nudged = true;
        s.scrollTop += need;
        return;
      }
      const room = Math.floor(bottom - 8 - (at.bottom + gap));
      if (room >= 96) {
        below = true;
        el.style.maxHeight = `${room}px`;
      }
    }
    const top = below ? at.bottom + gap : at.top - gap - h;
    const left = Math.max(8, Math.min(at.left - 12 - root.left, root.width - w - 8));
    el.classList.toggle('above', !below);
    el.style.top = `${Math.round(top - root.top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }
}
