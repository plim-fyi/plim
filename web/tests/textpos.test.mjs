// Places in a note, through changes (textpos.js).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { mapPos, unmapPos } from '../core/textpos.js';
import { test } from './lib.mjs';

test('a place in a note follows its text through others\' edits (#302: what Preview keeps on screen)', () => {
  // Each case: a change made to "0123456789" as Yjs reports it, and where position 5 (the "5") goes.
  const doc = new Y.Doc();
  const t = doc.getText('t');
  t.insert(0, '0123456789');
  const after = (change) => {
    let delta = null;
    const seen = (e) => (delta = e.delta);
    t.observe(seen);
    doc.transact(() => change(t));
    t.unobserve(seen);
    const pos = mapPos(5, delta);
    const text = t.toString();
    t.delete(0, t.length);
    t.insert(0, '0123456789');
    return text[pos] ?? `end ${pos}`;
  };
  assert.equal(after((x) => x.insert(0, 'abc')), '5', 'text put in above: it moves down with its text');
  assert.equal(after((x) => x.insert(5, 'abc')), '5', 'put in right at it: still the same character');
  assert.equal(after((x) => x.insert(8, 'abc')), '5', 'below: no change');
  assert.equal(after((x) => x.delete(1, 2)), '5', 'taken out above');
  assert.equal(after((x) => x.delete(3, 4)), '7', 'taken out around it: where that was');
  assert.equal(after((x) => { x.insert(9, 'z'); x.delete(0, 3); }), '5', 'several changes at once');
});

test('unmapPos: a position after a change, where it was before it (#331)', () => {
  // "hello world" → "hello big world": 4 put in at 6.
  const ins = [{ retain: 6 }, { insert: 'big ' }];
  assert.equal(unmapPos(3, ins), 3, 'before what was put in');
  assert.equal(unmapPos(6, ins), 6, 'at its start');
  assert.equal(unmapPos(8, ins), 6, 'inside it: where it went in');
  assert.equal(unmapPos(10, ins), 6, 'at its end: where it went in');
  assert.equal(unmapPos(12, ins), 8, 'after it');
  // "hello big world" → "hello world": 4 taken out at 6.
  const del = [{ retain: 6 }, { delete: 4 }];
  assert.equal(unmapPos(3, del), 3);
  assert.equal(unmapPos(6, del), 6, 'where it was taken out: before it');
  assert.equal(unmapPos(8, del), 12, 'after it');
  // Typing at a paragraph's end, a key at a time: the cursor, back on the text as drawn, at the paragraph's end.
  const typed = [[{ retain: 20 }, { insert: 'a' }], [{ retain: 21 }, { insert: 'b' }], [{ retain: 22 }, { insert: 'c' }]];
  assert.equal(typed.reduceRight((p, d) => unmapPos(p, d), 23), 20);
  assert.equal(typed.reduceRight((p, d) => unmapPos(p, d), 30), 27, 'after them all');
  // Round trips: mapPos then unmapPos, outside what was put in or taken out. (Right after text
  // taken out, 8 here, comes back as where it was taken out, 5: both are 5 after the change.)
  const delta = [{ retain: 5 }, { delete: 3 }, { retain: 4 }, { insert: 'xyz' }, { retain: 10 }];
  for (const p of [0, 2, 5, 10, 12, 15, 20]) assert.equal(unmapPos(mapPos(p, delta), delta), p, `round trip from ${p}`);
  assert.equal(unmapPos(mapPos(8, delta), delta), 5);
});
