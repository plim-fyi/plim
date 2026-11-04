// The editor's markdown: typing, tasks, links (markdown.js).
import assert from 'node:assert/strict';
import { EditorState, EditorView } from '../vendor/codemirror.mjs';
import { continueList, insertLink, linkAt, linkCard, linkCardAt, linkMarkdown, markdown, plainTyping, removeMarker, toggleTask, toggleTaskHere, wrap } from '../editor/markdown.js';
import { test } from './lib.mjs';

test('markdown: a phone\'s smart punctuation is undone where markdown needs plain characters (#233)', () => {
  // Typing `text` at the end of `doc`: the doc after it, as the editor would leave it.
  const typed = (doc, text) => {
    const state = EditorState.create({ doc, extensions: [markdown.extension] });
    const at = doc.length;
    const change = plainTyping(state, at, at, text) ?? { from: at, to: at, insert: text };
    return state.update({ changes: change }).state.doc.toString();
  };
  // A dividing line: "- - -" arrives as "—" then "-".
  assert.equal(typed('Above\n—', '-'), 'Above\n---');
  assert.equal(typed('Above\n  —', '-'), 'Above\n  ---');
  assert.equal(typed('| a | b |\n|—', '-'), '| a | b |\n|---');
  // Not in prose: "—" then "-" mid-sentence stays, and so do curly quotes and dashes.
  assert.equal(typed('a pause —', '-'), 'a pause —-');
  assert.equal(typed('She said ', '“'), 'She said “');
  assert.equal(typed('wait', '—'), 'wait—');
  // In code: straight quotes, and "--".
  assert.equal(typed('Run `print(', '“'), 'Run `print("');
  assert.equal(typed('Run `it', '’'), "Run `it'");
  assert.equal(typed('```\nls -', '—'), '```\nls -' + '--');
  assert.equal(typed('```js\nconst s = ', '‘'), "```js\nconst s = '");
  assert.equal(typed('    indented ', '“'), '    indented "');
  // After the code closes, prose again.
  assert.equal(typed('Run `ls` and ', '“'), 'Run `ls` and “');
  assert.equal(typed('```\ncode\n```\nThen ', '“'), '```\ncode\n```\nThen “');
});

test('markdown: a checkbox ticks with a one-character edit, only if it still says what was drawn', () => {
  const view = (doc, editable = true) => ({
    state: EditorState.create({ doc, extensions: [EditorView.editable.of(editable)] }),
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
  });
  const v = view('- [ ] Book\n1. [x] Done');
  assert.equal(toggleTask(v, 0, false), true);
  assert.equal(v.state.doc.toString(), '- [x] Book\n1. [x] Done');
  assert.equal(toggleTask(v, 0, false), false, 'already ticked (by someone else): left alone');
  assert.equal(toggleTask(v, 11, true), true);
  assert.equal(v.state.doc.toString(), '- [x] Book\n1. [ ] Done');
  const viewOnly = view('- [ ] Book', false);
  assert.equal(toggleTask(viewOnly, 0, false), false, 'a view-only link');
  assert.equal(viewOnly.state.doc.toString(), '- [ ] Book');
});

/** A command run on `doc` with the cursor at "|" (or a selection between "[[" and "]]"): the text after, cursor marked the same way. */
function typed(cmd, doc) {
  let sel;
  if (doc.includes('[[')) {
    const a = doc.indexOf('[['); const b = doc.indexOf(']]') - 2;
    doc = doc.replace('[[', '').replace(']]', '');
    sel = { anchor: a, head: b };
  } else {
    sel = { anchor: doc.indexOf('|') };
    doc = doc.replace('|', '');
  }
  // (Commands may take dispatch on its own: no `this`.)
  const view = { state: EditorState.create({ doc, selection: sel, extensions: [markdown.extension] }) };
  view.dispatch = (tr) => (view.state = tr.state ?? view.state.update(tr).state);
  const ran = cmd(view);
  const { from, to } = view.state.selection.main;
  const text = view.state.doc.toString();
  return { ran, text: from === to ? text.slice(0, from) + '|' + text.slice(from) : `${text.slice(0, from)}[[${text.slice(from, to)}]]${text.slice(to)}` };
}

test('markdown: Enter continues lists, tasks and quotes, and ends an empty item', () => {
  assert.equal(typed(continueList, '- one|').text, '- one\n- |');
  assert.equal(typed(continueList, '- [x] done|').text, '- [x] done\n- [ ] |');
  assert.equal(typed(continueList, '1. one|\n2. two').text, '1. one\n2. |\n3. two');
  assert.equal(typed(continueList, '> said|').text, '> said\n> |');
  assert.equal(typed(continueList, '- one\n- |').text, '- one\n|', 'an empty item: the list ends');
  assert.equal(typed(continueList, '- one\n- [ ] |').text, '- one\n|');
  assert.equal(typed(continueList, 'Just text|').ran, false, 'not a list: a plain newline (the next key binding)');
});

test('markdown: Backspace right after a marker removes it', () => {
  assert.equal(typed(removeMarker, '- |one').text, '|one');
  assert.equal(typed(removeMarker, '  - [ ] |task').text, '  |task');
  assert.equal(typed(removeMarker, '1. |x').text, '|x');
  assert.equal(typed(removeMarker, '- o|ne').ran, false, 'not just after the marker: an ordinary Backspace');
});

test('markdown: Ctrl+B, I, E wrap and unwrap; Ctrl+K makes a link; Ctrl+Enter ticks', () => {
  assert.equal(typed(wrap('**'), 'a [[word]] b').text, 'a **[[word]]** b');
  assert.equal(typed(wrap('**'), 'a **[[word]]** b').text, 'a [[word]] b', 'already bold: unwrapped');
  assert.equal(typed(wrap('**'), 'a [[**word**]] b').text, 'a [[word]] b', 'the marks selected too');
  assert.equal(typed(wrap('_'), 'x|').text, 'x_|_', 'nothing selected: the marks, the cursor between');
  assert.equal(typed(wrap('`'), '[[code]]').text, '`[[code]]`');
  assert.equal(typed(insertLink, 'see [[the guide]]').text, 'see [the guide]([[url]])');
  assert.equal(typed(insertLink, '[[https://e.com]]').text, '[|](https://e.com)');
  assert.equal(typed(toggleTaskHere, '- [ ] bo|ok').text, '- [x] bo|ok');
  assert.equal(typed(toggleTaskHere, '  1. [X] d|one').text, '  1. [ ] d|one');
  assert.equal(typed(toggleTaskHere, '- not a ta|sk').ran, false);
});

test('markdown: which links open, and an "open" button after each', () => {
  const doc = 'A [guide](https://e.com/x) and <mailto:a@b.c> and https://bare.d and [bad](javascript:alert(1)) and [ref][r]';
  const state = EditorState.create({ doc, extensions: [markdown.extension] });
  assert.equal(linkAt(state, doc.indexOf('guide') + 1), 'https://e.com/x');
  assert.equal(linkAt(state, doc.indexOf('a@b') + 1), 'mailto:a@b.c');
  assert.equal(linkAt(state, doc.indexOf('bare') + 1), 'https://bare.d');
  assert.equal(linkAt(state, doc.indexOf('bad') + 1), null, 'javascript: never opens');
  assert.equal(linkAt(state, doc.indexOf('ref') + 1), null, 'a reference without an address');
  assert.equal(linkAt(state, 0), null);
});

test('markdown: the link card shows where the link at the cursor goes, opened or not (#149)', () => {
  const doc = 'See [https://bank.example](https://evil.example/login) and [bad](javascript:alert(1)) and [ref][r].';
  const at = (pos, head = pos) => linkCardAt(EditorState.create({ doc, selection: { anchor: pos, head }, extensions: [markdown.extension] }));
  const spoof = at(doc.indexOf('bank') + 2);
  assert.deepEqual(spoof, { from: doc.indexOf('[https'), to: doc.indexOf('login)') + 6, textFrom: doc.indexOf('https://bank'), textTo: doc.indexOf('](https://evil'),
    href: 'https://evil.example/login', kind: 'link', opens: true }, 'its real address, not its text (which is what gets highlighted)');
  assert.deepEqual(at(doc.indexOf('bad') + 1), { from: doc.indexOf('[bad'), to: doc.indexOf('(1))') + 4, textFrom: doc.indexOf('bad'), textTo: doc.indexOf('bad') + 3,
    href: 'javascript:alert(1)', kind: 'link', opens: false });
  // A bare address: it's its own text.
  const bare = 'Go to https://example.com now';
  const b = linkCardAt(EditorState.create({ doc: bare, selection: { anchor: bare.indexOf('example') }, extensions: [markdown.extension] }));
  assert.deepEqual([b?.textFrom, b?.textTo], [bare.indexOf('https'), bare.indexOf(' now')]);
  assert.equal(at(doc.indexOf('ref') + 1), null, 'a reference link: no address here');
  assert.equal(at(doc.indexOf('[https')), null, 'just before a link: not in it');
  assert.equal(at(0), null);
  assert.equal(at(doc.indexOf('bank'), doc.indexOf('bank') + 3), null, 'a selection, not a cursor');
  // In its "(address)" part, you're editing the markdown: no card in the way (#194).
  assert.equal(at(doc.indexOf('evil.example') + 3), null, 'in the address part: no card');
  assert.ok(at(doc.indexOf('](https://evil')), 'at the end of its text: still the card');
});

test('markdown: the link card keeps out of the way while you type, and comes back when the cursor moves (#194)', () => {
  const doc = 'Notes from [the guidebook](https://example.com).';
  let state = EditorState.create({ doc, selection: { anchor: doc.indexOf('guide') }, extensions: [markdown.extension, linkCard] });
  assert.ok(state.field(linkCard), 'the cursor in its text: the card');
  const at = doc.indexOf('guide');
  state = state.update({ changes: { from: at, insert: 'x' }, selection: { anchor: at + 1 }, userEvent: 'input.type' }).state;
  assert.equal(state.field(linkCard), null, 'typing: gone');
  state = state.update({ selection: { anchor: at + 3 } }).state;
  assert.ok(state.field(linkCard), 'the cursor moved: back');
  const kept = state.field(linkCard);
  state = state.update({ changes: { from: 0, insert: 'Some ' } }).state; // (someone else's edit: no userEvent)
  assert.ok(state.field(linkCard), "others' edits don't hide it");
  assert.notEqual(kept, null);
});

test("markdown: a link's markdown from the card's Edit form (#194)", () => {
  assert.equal(linkMarkdown('the guidebook', 'https://example.com'), '[the guidebook](https://example.com)');
  assert.equal(linkMarkdown('  two   words ', ' https://example.com/a '), '[two words](https://example.com/a)');
  assert.equal(linkMarkdown('', 'https://example.com'), 'https://example.com', 'no text: the address alone');
  assert.equal(linkMarkdown('https://example.com', 'https://example.com'), 'https://example.com', 'text that is the address: the address alone');
  assert.equal(linkMarkdown('', 'example.com'), '<example.com>', 'not a web address on its own: in angle brackets');
  assert.equal(linkMarkdown('the guidebook', ''), 'the guidebook', 'no address: the text, unlinked');
  assert.equal(linkMarkdown('a [b] c', 'https://x.example'), '[a \\[b\\] c](https://x.example)', 'brackets in the text stay text');
  assert.equal(linkMarkdown('wiki', 'https://en.wikipedia.org/wiki/A_(b)'), '[wiki](<https://en.wikipedia.org/wiki/A_(b)>)', 'brackets in the address stay in it');
  // What it writes is one link, going where it said.
  for (const md of [linkMarkdown('a [b] c', 'https://x.example'), linkMarkdown('wiki', 'https://en.wikipedia.org/wiki/A_(b)')]) {
    const st = EditorState.create({ doc: md, extensions: [markdown.extension] });
    assert.ok(linkAt(st, 2), md);
  }
});
