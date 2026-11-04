// The page a note is rendered as (render.js).
import assert from 'node:assert/strict';
import { el, render, toDOM, toHTML } from '../editor/render.js';
import { test } from './lib.mjs';

const html = (text) => toHTML(render(text));
/** The page's text, as toDOM makes it (each text node's characters, in order). */
const toDOMText = (text) => {
  const sources = [];
  const node = () => ({ append() {}, setAttribute() {} });
  toDOM(render(text), { createDocumentFragment: node, createElement: node, createTextNode: (t) => ({ t }) }, sources);
  return sources.map((s) => s.node.t).join('');
};

test('render: every construct, as elements, each block knowing where it is in the note', () => {
  const text = [
    '# Title ##', '', 'Some **bold** _it_ ~~old~~ `code` and ` a ` [a](https://e.com "t") <https://x.y> https://bare.z a\\*b &amp; &#169; &#x1F600; line  ', 'break',
    '', '- one', '- [ ] task', '- [X] done', '  - nested', '', '3. third', '4. fourth', '', '> quote', '> more', '', '```js', 'code();', '  two', '```', '',
    '    indented', '    more', '', '---', '', '| a | b | c |', '|:--|--:|:-:|', '| 1 | 2 |',
  ].join('\n');
  assert.equal(html(text), [
    '<h1 data-from="0" data-to="10">Title</h1>',
    '<p data-from="12" data-to="148">Some <strong>bold</strong> <em>it</em> <s>old</s> <code>code</code> and <code>a</code> <a href="https://e.com">a</a> <a href="https://x.y">https://x.y</a> <a href="https://bare.z">https://bare.z</a> a*b &amp; © 😀 line<br>break</p>',
    '<ul data-from="150" data-to="188"><li data-from="150" data-to="155"><p data-from="152" data-to="155">one</p></li>',
    '<li data-from="156" data-to="166" class="task"><label><input type="checkbox" data-from="158" data-to="161"> task</label></li>',
    '<li data-from="167" data-to="188" class="task done"><label><input type="checkbox" data-from="169" data-to="172" checked> done</label><ul data-from="180" data-to="188"><li data-from="180" data-to="188"><p data-from="182" data-to="188">nested</p></li></ul></li></ul>',
    '<ol data-from="190" data-to="208" start="3"><li data-from="190" data-to="198"><p data-from="193" data-to="198">third</p></li><li data-from="199" data-to="208"><p data-from="202" data-to="208">fourth</p></li></ol>',
    '<blockquote data-from="210" data-to="224"><p data-from="212" data-to="224">quote\nmore</p></blockquote>',
    '<pre data-from="226" data-to="249"><code class="language-js">code();\n  two</code></pre>',
    '<pre data-from="255" data-to="272"><code>indented\nmore</code></pre>',
    '<hr data-from="274" data-to="277">',
    '<table data-from="279" data-to="316"><thead><tr data-from="279" data-to="292"><th class="left">a</th><th class="right">b</th><th class="center">c</th></tr></thead>',
    '<tbody><tr data-from="307" data-to="316"><td class="left">1</td><td class="right">2</td></tr></tbody></table>',
  ].join(''));
  // What a block says it covers is the note's text of it.
  const covers = (nodes) => nodes.flatMap((n) => (n.text != null ? [] : [[n.tag, n.attrs['data-from'], n.attrs['data-to']], ...covers(n.children)]));
  for (const [tag, from, to] of covers(render(text)).filter(([, f]) => f != null)) {
    const slice = text.slice(Number(from), Number(to));
    assert.ok(slice.length && slice.trim() === slice, `${tag} ${from}-${to}: ${JSON.stringify(slice)}`);
  }
  // And each piece of text where its characters came from (#302): the same characters, but for
  // an entity's, an escape's and an indented code block's (whose source says more than the page).
  const texts = (nodes) => nodes.flatMap((n) => (n.text != null ? [n] : texts(n.children)));
  const pieces = texts(render(text));
  assert.equal(pieces.map((t) => t.text).join(''), toDOMText(text), 'every character on the page has its place');
  for (const t of pieces) {
    if (t.to - t.from === t.text.length) assert.equal(text.slice(t.from, t.to), t.text, `${t.from}-${t.to}`);
    else assert.ok(['&amp;', '&#169;', '&#x1F600;'].includes(text.slice(t.from, t.to)) || t.text.includes('indented'), JSON.stringify(t));
  }
  for (let i = 1; i < pieces.length; i++) assert.ok(pieces[i].from >= pieces[i - 1].to, 'in the note\'s order');
  assert.equal(html('| a | b |\n|---|---|\n| 1 | 2 |'), '<table data-from="0" data-to="29"><thead><tr data-from="0" data-to="9"><th>a</th><th>b</th></tr></thead><tbody><tr data-from="20" data-to="29"><td>1</td><td>2</td></tr></tbody></table>');
  // An empty cell keeps its place (#352): a header's empty corner, a row's missing value.
  const bare = (md) => html(md).replace(/ data-(?:from|to)="\d+"/g, '');
  assert.equal(bare('| | Planned | Spent |\n|---|---:|---:|\n| Hotel | €540 | €540 |\n| Trips | €90 | |'),
    '<table><thead><tr><th></th><th class="right">Planned</th><th class="right">Spent</th></tr></thead>'
    + '<tbody><tr><td>Hotel</td><td class="right">€540</td><td class="right">€540</td></tr><tr><td>Trips</td><td class="right">€90</td><td class="right"></td></tr></tbody></table>');
  assert.equal(bare('a | b\n--|--\n1 | 2'), '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>', 'no outer pipes');
  assert.equal(bare('| a | | c |\n|---|---|---|\n| | 2 | |'), '<table><thead><tr><th>a</th><th></th><th>c</th></tr></thead><tbody><tr><td></td><td>2</td><td></td></tr></tbody></table>');
});

test('render: what a note says is never markup, and a link is a link only with an address worth following', () => {
  const hostile = '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> and <b onclick="x">b</b>\n\n[bad](javascript:alert(1)) [data](data:text/html,x) [ok](https://ok.org) [ftp](ftp://x) [mail](mailto:a@b.c)\n\n<https://x.y/?a=1&b=2> &lt;not a tag&gt; "quotes"';
  const out = html(hostile);
  // No tag of the note's, no handler attribute, no address that runs anything: the words appear only as text.
  assert.ok(!/<script|<img|<[a-z]+[^>]* on\w+=|href="(javascript|data):/.test(out), out);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && out.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'HTML shown as the text it is');
  assert.ok(/>bad data </.test(out), 'a javascript: or data: link is its text alone');
  assert.ok(out.includes('<a href="https://ok.org">ok</a>') && out.includes('<a href="mailto:a@b.c">mail</a>'));
  assert.ok(!out.includes('<a href="ftp') && !out.includes('href="data:'));
  assert.ok(out.includes('<a href="https://x.y/?a=1&amp;b=2">https://x.y/?a=1&amp;b=2</a>'), 'an address with & is escaped in the HTML, intact in the href');
  // Only these tags and attributes ever come out.
  const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'label', 'input', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 's', 'a', 'br', 'span']);
  const ATTRS = new Set(['data-from', 'data-to', 'class', 'href', 'type', 'checked', 'start', 'data-tag']);
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.text != null) return;
    assert.ok(TAGS.has(n.tag), n.tag);
    for (const k of Object.keys(n.attrs)) assert.ok(ATTRS.has(k), k);
    walk(n.children);
  });
  walk(render(hostile + '\n\n# h\n\n- [ ] t\n\n1. x\n\n```\nc\n```\n\n| a |\n|-|\n| b |'));
});

test('render: the frontmatter not drawn, positions after it kept; a #word is text (#584)', () => {
  const text = '---\ntitle: Training\ntags: [gym]\n---\nFelt strong #gym/legs and C#.';
  const body = text.indexOf('Felt');
  assert.equal(html(text), `<p data-from="${body}" data-to="${text.length}">Felt strong #gym/legs and C#.</p>`);
  const sources = [];
  const node = () => ({ append() {}, setAttribute() {} });
  toDOM(render(text), { createDocumentFragment: node, createElement: node, createTextNode: (t) => ({ t }) }, sources);
  for (const s of sources) if (s.to - s.from === s.node.t.length) assert.equal(text.slice(s.from, s.to), s.node.t);
});

test('render: the elements are built, not parsed', () => {
  // A document that records what's made of it.
  const made = [];
  const node = (tag) => ({ tag, attrs: {}, children: [], append(c) { this.children.push(c); }, setAttribute(k, v) { this.attrs[k] = v; } });
  const doc = {
    createDocumentFragment: () => node('#fragment'),
    createElement: (tag) => (made.push(tag), node(tag)),
    createTextNode: (text) => ({ text }),
  };
  const frag = toDOM(render('Hi **there** <b>x</b>'), doc);
  assert.deepEqual(made, ['p', 'strong']);
  const p = frag.children[0];
  assert.deepEqual(p.attrs, { 'data-from': '0', 'data-to': '21' });
  assert.deepEqual(p.children.map((c) => c.text ?? c.tag), ['Hi ', 'strong', ' <b>x</b>']);
  assert.deepEqual(toHTML([el('p', { class: 'x' }, 'a & b', el('br', {}))]), '<p class="x">a &amp; b<br></p>');
});
