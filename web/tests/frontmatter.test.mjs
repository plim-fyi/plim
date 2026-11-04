// A note's frontmatter (#584, core/frontmatter.js): the cases the terminal client passes too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fm from '../core/frontmatter.js';
import { here, test } from './lib.mjs';

const F = JSON.parse(readFileSync(new URL('fixtures/frontmatter.json', here)));

test('frontmatter: a note\'s title and tags, read from its block (the shared cases)', () => {
  for (const [text, title, tags] of F.read) assert.deepEqual(fm.readFrontmatter(text), { title, tags }, JSON.stringify(text));
  for (const [text, body] of F.body) assert.equal(fm.bodyOf(text), body, JSON.stringify(text));
  for (const [text, title] of F.title) assert.equal(fm.noteTitle(text), title, JSON.stringify(text));
});

test('frontmatter: the title and tags set, only their lines changed (the shared cases)', () => {
  const ops = { title: fm.setTitle, tags: fm.setTags, add: fm.addTag, remove: fm.removeTag };
  for (const [text, op, value, want] of F.set) {
    const got = ops[op](text, value);
    assert.equal(got === text && want === null ? null : got, want, `${op} ${JSON.stringify(value)} on ${JSON.stringify(text)}`);
  }
  for (const [s, flow, want] of F.scalar) assert.equal(fm.yamlScalar(s, flow), want, JSON.stringify(s));
});

test('frontmatter: a note\'s tags are only its block\'s; a #word is text (#584)', () => {
  assert.deepEqual(fm.noteTags('Leg day\n#gym\n\nSquat #knee'), []);
  assert.deepEqual(fm.noteTags('---\ntags: [gym]\n---\nx #y'), ['gym']);
});

test('frontmatter: two devices moving one note at once: the second block taken out (#582)', () => {
  const one = fm.toFrontmatter('Leg day\n#gym\n\nSquat');
  const block = one.slice(0, fm.bodyStart(one));
  assert.equal(fm.withoutRepeatedBlock(block + one), one);
  assert.equal(fm.withoutRepeatedBlock(one), null);
  assert.equal(fm.withoutRepeatedBlock('---\ntitle: A\n---\n---\ntitle: B\n---\nx'), null, 'a different block is text');
  assert.equal(fm.withoutRepeatedBlock('no block'), null);
});

test('frontmatter: a note from before moved into a block: its title, its tags (the shared cases, #582)', () => {
  for (const [text, want] of F.convert) assert.equal(fm.toFrontmatter(text), want, JSON.stringify(text));
});

test('frontmatter: what is set reads back as set', () => {
  for (const title of ['Leg day', 'Trip: Lisbon', 'Say "hi"', '#1 idea', 'true', 'C# notes', 'back\\slash', '- dash', 'Notes #1']) {
    assert.equal(fm.readFrontmatter(fm.setTitle('body', title)).title, title, title);
  }
  const t = fm.setTags('body', ['gym', 'gym/legs', 'café']);
  assert.deepEqual(fm.readFrontmatter(t).tags, ['gym', 'gym/legs', 'café']);
  assert.deepEqual(fm.noteTags(t), ['café', 'gym', 'gym/legs'].sort());
  assert.deepEqual(fm.noteTags('Leg day\n#gym'), [], 'without a block: no tags (#word is text)');
});
