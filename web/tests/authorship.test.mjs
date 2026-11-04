// What an app wrote in a note (authorship.js).
import assert from 'node:assert/strict';
import * as Y from '../vendor/yjs.mjs';
import { test } from './lib.mjs';

test('what an app wrote in a note, from its recorded sessions (#389)', async () => {
  const { appRanges, appsBetween, lastAppEdit } = await import('../core/authorship.js');
  const mine = new Y.Doc();
  mine.getText('body').insert(0, 'Training\n- squats\n');
  // Claude's session, another device's Y.Doc, its edit and its record arriving as one update.
  const claude = new Y.Doc();
  Y.applyUpdate(claude, Y.encodeStateAsUpdate(mine));
  const now = Date.now();
  claude.transact(() => {
    claude.getText('body').insert(claude.getText('body').length, '- bench\n- deadlift\n');
    claude.getMap('authors').set(String(claude.clientID), { name: 'Claude', connection: 'c1', at: now });
  });
  Y.applyUpdate(mine, Y.encodeStateAsUpdate(claude));
  // You type in the middle of Claude's text: that bit is yours.
  mine.getText('body').insert('Training\n- squats\n- bench'.length, ' (heavy)');
  const text = mine.getText('body').toString();
  const ranges = appRanges(mine.getText('body'));
  assert.deepEqual(ranges.map((r) => text.slice(r.from, r.to)), ['- bench', '- deadlift'], '(without the line breaks at their ends)');
  assert.equal(ranges[0].name, 'Claude');
  assert.equal(lastAppEdit(mine).name, 'Claude');
  assert.deepEqual(appsBetween(mine, now - 1000, now), ['Claude']);
  assert.deepEqual(appsBetween(mine, now, now + 1000), []);
  // A day later: nothing in the margin; still in History.
  assert.deepEqual(appRanges(mine.getText('body'), now + 1), []);
  // A record that isn't one (a bad id, no time): ignored.
  mine.getMap('authors').set('nope', { name: 'X', at: now });
  assert.equal(appRanges(mine.getText('body')).length, 2);
});

test('two sessions of one app told apart, in the margin and in History (#505)', async () => {
  const { appRanges, appsBetween, whoOf } = await import('../core/authorship.js');
  const mine = new Y.Doc();
  mine.getText('body').insert(0, 'Plan\n');
  const now = Date.now();
  // Two Claude sessions, each its own Y.Doc, writing one after the other.
  for (const [session, line, at] of [['amber fox', '- one\n', now - 2000], ['quiet river', '- two\n', now - 1000]]) {
    const s = new Y.Doc();
    Y.applyUpdate(s, Y.encodeStateAsUpdate(mine));
    s.transact(() => {
      s.getText('body').insert(s.getText('body').length, line);
      s.getMap('authors').set(String(s.clientID), { name: 'Claude', connection: 'plim mcp', session, at });
    });
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(s));
  }
  const ranges = appRanges(mine.getText('body'));
  assert.deepEqual(ranges.map((r) => [whoOf(r), mine.getText('body').toString().slice(r.from, r.to)]), [['Claude · amber fox', '- one'], ['Claude · quiet river', '- two']], 'not run together');
  assert.deepEqual(appsBetween(mine, now - 3000, now), ['Claude · amber fox', 'Claude · quiet river']);
  assert.deepEqual(appsBetween(mine, now - 1500, now), ['Claude · quiet river']);
  // Who, in words: an app and its session, the app alone, or nobody.
  assert.equal(whoOf({ name: 'Codex', session: 'wise yak', sid: '00' }), 'Codex · wise yak');
  assert.equal(whoOf({ name: 'Claude' }), 'Claude');
  assert.equal(whoOf({ session: 'amber fox' }), '');
  assert.equal(whoOf(null), '');
});

test('each app its own mark: Claude a clay C, Codex a jade X, another its initial, neutral (#486)', async () => {
  const { appMark } = await import('../core/authorship.js');
  assert.deepEqual(appMark('Claude'), { letter: 'C', tone: 'claude', color: 'var(--reach-1)' });
  assert.deepEqual(appMark('Codex'), { letter: 'X', tone: 'codex', color: 'var(--reach-2)' });
  // The others we know (#482), each in a colour of its own, never Claude's; by a part of the name,
  // as a connection is named as its app calls itself.
  assert.deepEqual(appMark('Cursor'), { letter: 'C', tone: 'cursor', color: 'var(--reach-4)' });
  assert.equal(appMark('Gemini').tone, 'gemini');
  assert.equal(appMark('ChatGPT').color, 'var(--reach-3)');
  assert.equal(appMark('Claude for Desktop').tone, 'claude');
  assert.deepEqual(appMark('some-agent'), { letter: 'S', tone: 'other', color: 'var(--muted)' });
  assert.equal(appMark('toString').tone, 'other');
  assert.equal(appMark('').letter, '?');
});
