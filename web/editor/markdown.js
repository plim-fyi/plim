// Markdown in the editor: a note is edited as the markdown it is (and read as a page,
// render.js). Nothing is drawn formatted while editing; typing knows markdown instead: Enter
// continues a list, Tab indents an item, Ctrl+B/I/E/K format the selection, Ctrl+Enter ticks a
// task; a link shows where it goes (the link card), and Ctrl+click opens it. The note's text
// (its Y.Text) is the same markdown everywhere: for sync, History, the terminal client and agents.

import {
  Decoration, EditorSelection, EditorView, indentLess, indentMore, insertNewlineContinueMarkup, keymap, Language, markdownLanguage, Prec,
  showTooltip, StateField, syntaxTree, tooltips,
} from '../vendor/codemirror.mjs';

/**
 * GitHub-flavoured markdown without "setext" headings: in markdown, a line
 * of `---` or `===` under text makes that text a heading, but in notes it's
 * meant as a dividing line.
 */
export const markdown = new Language(markdownLanguage.data, markdownLanguage.parser.configure({ remove: ['SetextHeading'] }), [], 'markdown');

/** Links Plim opens: web and mail ones only (never javascript:, data: or the like). */
export const SAFE_URL = /^(?:https?:\/\/|mailto:)\S+$/i;

/** The link at `pos` ([text](url), <url> or a bare https://…): where it is and its address, opened by Plim or not. */
function linkNodeAt(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    // An address inside a link's text ("[https://bank.example](…)") isn't where the link goes: its link is.
    if (n.name === 'URL' && n.parent?.name === 'Link') continue;
    if (n.name === 'Link' || n.name === 'Autolink' || n.name === 'URL') {
      const url = n.name === 'URL' ? n : address(n);
      if (!url) return null; // (a reference link: its address is elsewhere)
      // Its text: what's between "[" and "]" (a bare or <…> address: the address itself).
      const marks = n.name === 'Link' ? n.getChildren('LinkMark') : [];
      const text = marks.length >= 2 ? { from: marks[0].to, to: marks[1].from } : n.name === 'Autolink' ? url : n;
      const kind = n.name === 'Link' ? 'link' : n.name === 'Autolink' ? 'autolink' : 'url';
      const raw = state.sliceDoc(url.from, url.to);
      const href = /^<.*>$/.test(raw) ? raw.slice(1, -1) : raw; // ("](<an address with spaces or brackets>)")
      return { from: n.from, to: n.to, textFrom: text.from, textTo: text.to, href, kind };
    }
  }
  return null;
}

/** A link's own address: the URL after its "](", not one in its text. */
function address(link) {
  const marks = link.getChildren('LinkMark');
  const after = link.name === 'Link' ? marks[1]?.to : link.from;
  return after == null ? null : link.getChildren('URL').find((u) => u.from >= after) ?? null;
}

/** The address of the link at `pos`, if it's one Plim opens. */
export function linkAt(state, pos) {
  const href = linkNodeAt(state, pos)?.href;
  return href && SAFE_URL.test(href) ? href : null;
}

// ---- typing: lists, shortcuts, tasks ----

/** A list item's or a quote's marker at the start of a line: its indentation, then the marker with its spaces. */
const ITEM = /^(\s*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|>[ \t]?)/;

/**
 * Enter: in a list, task list or quote, the next item (numbered on; a new
 * task unticked). On an empty item the list ends there instead: its marker
 * goes, as in most editors.
 */
export function continueList(view) {
  const { state } = view;
  const r = state.selection.main;
  if (r.empty && state.selection.ranges.length === 1) {
    const line = state.doc.lineAt(r.head);
    const m = ITEM.exec(line.text);
    if (m && r.head === line.to && line.text.length === m[0].length) {
      view.dispatch({ changes: { from: line.from, to: line.to }, userEvent: 'delete' });
      return true;
    }
  }
  return insertNewlineContinueMarkup(view);
}

/** Backspace just after an item's marker ("- ", "1. ", "- [ ] ", "> "): the marker goes, the item becomes text. */
export function removeMarker(view) {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(r.head);
  const m = ITEM.exec(line.text);
  if (!m || r.head !== line.from + m[0].length) return false;
  view.dispatch({ changes: { from: line.from + m[1].length, to: r.head }, userEvent: 'delete.backward' });
  return true;
}

const inList = (state) =>
  state.selection.ranges.every((r) => /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]/.test(state.doc.lineAt(r.from).text));
/** Tab and Shift+Tab indent and outdent list items; elsewhere they move the focus on, as usual. */
const indentItem = (view) => inList(view.state) && indentMore(view);
const outdentItem = (view) => inList(view.state) && indentLess(view);

/** Bold (Ctrl+B), italic (Ctrl+I), code (Ctrl+E): wrap the selection in `mark`, or unwrap it if it's wrapped already. */
export function wrap(mark) {
  const n = mark.length;
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((r) => {
      const inner = state.sliceDoc(r.from, r.to);
      if (state.sliceDoc(r.from - n, r.from) === mark && state.sliceDoc(r.to, r.to + n) === mark) {
        return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
      }
      if (inner.length >= 2 * n && inner.startsWith(mark) && inner.endsWith(mark)) {
        return { changes: { from: r.from, to: r.to, insert: inner.slice(n, -n) }, range: EditorSelection.range(r.from, r.to - 2 * n) };
      }
      return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + n, r.to + n) };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** Ctrl+K: the selection as a link's text, "url" selected to type over (a selected address becomes the link's address). */
export function insertLink(view) {
  const { state } = view;
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    if (SAFE_URL.test(text)) return { changes: { from: r.from, to: r.to, insert: `[](${text})` }, range: EditorSelection.cursor(r.from + 1) };
    const at = r.from + text.length + 3; // after "[text]("
    return { changes: { from: r.from, to: r.to, insert: `[${text}](url)` }, range: EditorSelection.range(at, at + 3) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
}

/** Ctrl+Enter on a task's line: tick or untick it (as a tap on its box on the page). */
export function toggleTaskHere(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(\s*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/.exec(line.text);
  return Boolean(m) && toggleTask(view, line.from + m[1].length, /x/i.test(m[2]));
}

/**
 * Tick or untick the task whose list mark starts at `pos`. An ordinary edit
 * of one character (`[ ]` ↔ `[x]`), so it syncs, shows in History, and your
 * undo takes it back. Only if the task still says what was seen: someone may
 * have ticked it a moment ago.
 */
export function toggleTask(view, pos, checked) {
  if (!view.state.facet(EditorView.editable)) return false; // (a view-only link)
  const m = /^(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/.exec(view.state.doc.sliceString(pos, pos + 16));
  if (!m || /x/i.test(m[1]) !== checked) return false;
  const at = pos + m[0].length - 2;
  view.dispatch({ changes: { from: at, to: at + 1, insert: checked ? ' ' : 'x' }, userEvent: 'input.toggle' });
  return true;
}

/**
 * A phone's (or a tablet's) smart punctuation undone where markdown needs the plain characters
 * (#233): iOS turns "--" into "—" as you type (so "---", a dividing line, arrives as "—-"), and
 * quotes into curly ones, which break code. Prose keeps them. For what's typed (`text` replacing
 * `from`–`to`): the change to make instead, or null to let it be. (A paste stays as it is.)
 */
export function plainTyping(state, from, to, text) {
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  // A dividing line (or a table's): a "-" after a "—" at a line's start, or after a "|".
  if (text === '-' && /(?:^\s*|\|\s*)—$/.test(before)) return { from: from - 1, to, insert: '---' };
  if (!/[“”‘’—]/.test(text) || !inCode(state, from, before)) return null;
  return { from, to, insert: text.replace(/[“”‘’—]/g, (c) => PLAIN[c]) };
}
const PLAIN = { '“': '"', '”': '"', '‘': "'", '’': "'", '—': '--' };

/** In code: a fenced or indented block (one not closed yet too), or in `backticks` on this line (an odd number before). */
function inCode(state, pos, before) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') return true;
  }
  return (before.match(/`/g) ?? []).length % 2 === 1;
}

const plainMarks = EditorView.inputHandler.of((view, from, to, text) => {
  const change = plainTyping(view.state, from, to, text);
  if (!change) return false;
  view.dispatch({ changes: change, selection: { anchor: change.from + change.insert.length }, userEvent: 'input.type' });
  return true;
});

const editing = Prec.high(
  keymap.of([
    { key: 'Enter', run: continueList },
    { key: 'Backspace', run: removeMarker },
    { key: 'Tab', run: indentItem, shift: outdentItem },
    { key: 'Mod-b', run: wrap('**') },
    { key: 'Mod-i', run: wrap('_') },
    { key: 'Mod-e', run: wrap('`') },
    { key: 'Mod-k', run: insertLink },
    { key: 'Mod-Enter', run: toggleTaskHere },
  ]),
);

/**
 * Opening links: Ctrl/Cmd+click, as in other editors (a plain click places
 * the cursor); with a view-only link, a plain click (there's no cursor to place).
 */
const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const readOnly = !view.state.facet(EditorView.editable);
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey || readOnly)) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const url = pos == null ? null : linkAt(view.state, pos);
    if (!url) return false;
    e.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  },
});

/**
 * The link card: with the cursor in a link's text (a click, a tap or the arrow
 * keys), a card under it shows where it really goes (its text can say otherwise,
 * #149), with Open, Copy and Edit, and the link's text is highlighted meanwhile
 * (#181). It keeps out of the way of editing the markdown itself (#194): not
 * with the cursor in the "(address)" part, and not while you type (it's back
 * once the cursor moves). A click still places the cursor; Ctrl/Cmd+click
 * opens the link at once.
 */
export function linkCardAt(state) {
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length !== 1) return null;
  const link = linkNodeAt(state, r.head);
  if (!link || r.head === link.from || r.head < link.textFrom || r.head > link.textTo) return null; // (not in its text)
  return { ...link, opens: SAFE_URL.test(link.href) };
}

/**
 * A link's markdown, from what the card's Edit form holds: "[text](address)",
 * or the address alone when there's no text (or it's the address itself); no
 * address leaves the text, unlinked. "]" in the text and an address with
 * spaces or brackets are written so they stay one link.
 */
export function linkMarkdown(text, address) {
  text = text.replace(/\s+/g, ' ').trim();
  address = address.trim();
  if (!address) return text;
  const dest = /[\s()<>]/.test(address) ? `<${address.replace(/[<>]/g, encodeURIComponent)}>` : address;
  if (!text || text === address) return /^(?:https?:\/\/|mailto:)\S+$/i.test(address) ? address : `<${address}>`;
  return `[${text.replace(/[\\[\]]/g, '\\$&')}](${dest})`;
}

function linkCardDom(view, link) {
  const card = document.createElement('div');
  card.className = 'md-linkcard';
  const button = (label, run, cls = 'small ghost') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label });
    b.addEventListener('mousedown', (e) => e.preventDefault()); // (the editor keeps the focus and the cursor)
    b.addEventListener('click', run);
    return b;
  };
  const show = () => {
    card.classList.remove('editing');
    const address = Object.assign(document.createElement('span'), { className: 'md-linkcard-url', textContent: link.href, title: link.href });
    const parts = [address];
    if (link.opens) parts.push(button('Open ↗', () => window.open(link.href, '_blank', 'noopener,noreferrer')));
    else parts.push(Object.assign(document.createElement('span'), { className: 'md-linkcard-note', textContent: 'Not opened: only web and email links open' }));
    const copy = button('Copy', async () => {
      try {
        await navigator.clipboard.writeText(link.href);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Couldn’t copy';
      }
    });
    parts.push(copy);
    if (view.state.facet(EditorView.editable)) parts.push(button('Edit', edit)); // (not with a view-only link)
    card.replaceChildren(...parts);
  };
  // Edit: the link's text and address in two fields; Save writes its markdown.
  const edit = () => {
    card.classList.add('editing');
    const field = (label, value, name) => {
      const input = Object.assign(document.createElement('input'), { value, name, autocomplete: 'off', spellcheck: false });
      input.setAttribute('aria-label', label);
      if (name === 'address') Object.assign(input, { type: 'url', inputMode: 'url', autocapitalize: 'off' });
      const l = Object.assign(document.createElement('label'), { className: 'md-linkcard-field' });
      l.append(Object.assign(document.createElement('span'), { textContent: label }), input);
      return [l, input];
    };
    const text = link.kind === 'link' ? view.state.sliceDoc(link.textFrom, link.textTo) : '';
    const [textRow, textInput] = field('Text', text, 'text');
    const [addressRow, addressInput] = field('Address', link.href, 'address');
    const save = () => {
      const insert = linkMarkdown(textInput.value, addressInput.value);
      view.dispatch({ changes: { from: link.from, to: link.to, insert }, selection: { anchor: link.from + insert.length }, userEvent: 'input.link' });
      view.focus();
    };
    const cancel = () => {
      show();
      view.focus();
    };
    for (const input of [textInput, addressInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault(), save();
        if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), cancel();
      });
    }
    const actions = Object.assign(document.createElement('div'), { className: 'md-linkcard-actions' });
    actions.append(button('Cancel', cancel), button('Save', save, 'small primary'));
    card.replaceChildren(textRow, addressRow, actions);
    // (Not scrolled to: Safari would move the page to show the field before the card has found
    // its place above a phone's keyboard, and the card would settle where the page was then.)
    (link.kind === 'link' ? addressInput : textInput).focus({ preventScroll: true });
  };
  show();
  return card;
}

// Cards keep a little way in from the window's edges (on a tablet, a card under a link near the edge would touch it),
// and above a keyboard: with no room under the link there, the card goes over it (its Save was under the keyboard).
const cardSpace = tooltips({
  tooltipSpace: () => {
    const vv = window.visualViewport;
    return { top: 0, left: 12, bottom: vv ? Math.min(innerHeight, vv.offsetTop + vv.height) : innerHeight, right: innerWidth - 12 };
  },
});

const activeLink = Decoration.mark({ class: 'md-link-active' });

/** The same link (where it is and goes): its card is kept as it is (an Edit form in progress, too). */
const sameLink = (a, b) => a && b && a.from === b.from && a.to === b.to && a.href === b.href && a.textFrom === b.textFrom && a.textTo === b.textTo;

export const linkCard = StateField.define({
  create: (state) => linkCardAt(state),
  update: (link, tr) => {
    // Typing or deleting: out of the way until the cursor moves again (others' edits don't count).
    if (tr.docChanged && (tr.isUserEvent('input') || tr.isUserEvent('delete')) && !tr.isUserEvent('input.link')) return null;
    if (!tr.docChanged && !tr.selection) return link;
    const next = linkCardAt(tr.state);
    return sameLink(link, next) ? link : next;
  },
  provide: (f) => [
    showTooltip.from(f, (link) => link && { pos: link.from, end: link.to, above: false, arrow: false, create: (view) => ({ dom: linkCardDom(view, link) }) }),
    EditorView.decorations.from(f, (link) => (link && link.textTo > link.textFrom ? Decoration.set([activeLink.range(link.textFrom, link.textTo)]) : Decoration.none)),
  ],
});

/** The editor's markdown: the parser, typing that knows lists, tasks and shortcuts, and the link card. */
export const markdownEditing = [markdown.extension, editing, plainMarks, linkClicks, linkCard, cardSpace];
