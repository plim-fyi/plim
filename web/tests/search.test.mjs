// Searching notes (search.js, #24).
import assert from 'node:assert/strict';
import { findAll, fold, matchNote, queryWords, ranked } from '../core/search.js';
import { readFileSync } from 'node:fs';
import { here, test } from './lib.mjs';

const marked = (s, ranges) => ranges.reduceRight((t, [a, b]) => `${t.slice(0, a)}[${t.slice(a, b)}]${t.slice(b)}`, s);

test('search: words fold case and accents, and each is put back on the text as it is', () => {
  assert.deepEqual(queryWords('  Café   TRAM café '), ['cafe', 'tram']);
  assert.deepEqual(queryWords(''), []);
  assert.equal(fold('Pastéis ÉCLAIR').text, 'pasteis eclair');
  // (A folded match lands on the text as written: accents, case, and letters outside the BMP.)
  const s = 'Café 😀 crème Brûlée, CAFÉ';
  assert.equal(marked(s, findAll(s, queryWords('cafe brulee'))), '[Café] 😀 crème [Brûlée], [CAFÉ]');
  // Part of a word matches; overlapping or touching matches are one.
  assert.equal(marked('tramway trams', findAll('tramway trams', ['tram', 'way'])), '[tramway] [tram]s');
});

test('search: a note matches when every word is in it; its lines with a match, not its title', () => {
  const text = '# Trip to Lisbon\n\n- [ ] Reserve the **tram 28** tour\nDay one is Alfama.\nDay two, a tram… ferry to Cacilhas.\n- Tram again';
  const m = matchNote('Trip to Lisbon', text, queryWords('tram'));
  assert.equal(m.count, 3);
  assert.equal(m.inTitle, false);
  assert.deepEqual(m.lines.map((l) => marked(l.text, l.ranges)), ['- [ ] Reserve the **[tram] 28** tour', 'Day two, a [tram]… ferry to Cacilhas.']);
  assert.equal(matchNote('Trip to Lisbon', text, queryWords('tram sintra')), null, 'every word, not any');
  const t = matchNote('Trip to Lisbon', text, queryWords('lisbon trip'));
  assert.equal(t.inTitle, true);
  assert.deepEqual(t.lines, [], 'a match in the title alone: no lines under it');
  // The title line is the first line with text, whatever's above it.
  assert.deepEqual(matchNote('Tram', '\n\nTram\nno', ['tram']).lines, []);
  assert.equal(matchNote('x', 'x', []), null);
});

test('search: a long line is cut around its match, its ranges with it', () => {
  const long = `${'word '.repeat(60)}the tram ${'more '.repeat(40)}`;
  const [line] = matchNote('T', `T\n${long}`, ['tram']).lines;
  assert.ok(line.text.length <= 142, line.text.length);
  assert.ok(line.text.startsWith('…') && line.text.endsWith('…'));
  assert.equal(marked(line.text, line.ranges).match(/\[[^\]]*\]/)[0], '[tram]');
  const [short] = matchNote('T', 'T\n   indented tram  ', ['tram']).lines;
  assert.equal(marked(short.text, short.ranges), 'indented [tram]');
});

test('search: results with every word in the title come first, the rest in the list\'s order', () => {
  const r = (id, inTitle) => ({ id, match: { inTitle } });
  assert.deepEqual(ranked([r('a', false), r('b', true), r('c', false), r('d', true)]).map((x) => x.id), ['b', 'd', 'a', 'c']);
});

test('search: the cases the terminal client must agree on (fixtures/search.json, search.rs)', () => {
  const f = JSON.parse(readFileSync(new URL('fixtures/search.json', here)));
  for (const c of f.cases) {
    const m = matchNote(c.title, c.text, queryWords(c.query));
    const got = m && { count: m.count, inTitle: m.inTitle, lines: m.lines.map((l) => marked(l.text, l.ranges)) };
    assert.deepEqual(got, c.match, c.query);
  }
});
