// A note's row, sorting, address, tags and title (notesort.js, noteurl.js, tags.js, title.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { titleFromLine } from '../core/title.js';
import { createdLabel, sortNotes } from '../core/notesort.js';
import { noteIdAt, notePath, noteUrl } from '../core/noteurl.js';
import { rowTags, tagCounts, tagLine, tagMatches, tagName, tagRanges, tagsByRecent, tagsIn } from '../core/tags.js';
import { here, test } from './lib.mjs';

test('the chips over the list: the most recently used tag first, by a note made or edited with it', () => {
  const notes = [
    { tags: ['gym', 'training'], created: 1, updated: 50 },
    { tags: ['travel'], created: 10, updated: 20 },
    { tags: ['gym/legs', 'gym'], created: 90, updated: 0 }, // (made lately, never edited)
    { tags: ['books'], created: 5, updated: 5 },
    { tags: [], created: 99, updated: 99 },
  ];
  assert.deepEqual(tagsByRecent(notes), [['gym', 2], ['gym/legs', 1], ['training', 1], ['travel', 1], ['books', 1]]);
  assert.deepEqual(tagsByRecent([]), []);
});

test('the note list: a row\'s tags, not the one picked, three at most then how many more (#350)', () => {
  assert.deepEqual(rowTags(['travel', 'lisbon']), { tags: ['travel', 'lisbon'], more: 0 });
  assert.deepEqual(rowTags([]), { tags: [], more: 0 });
  assert.deepEqual(rowTags(['planning', 'q4', 'roadmap', 'work']), { tags: ['planning', 'q4', 'roadmap'], more: 1 });
  assert.deepEqual(rowTags(['planning', 'q4', 'roadmap', 'work'], null, 2), { tags: ['planning', 'q4'], more: 2 }, 'a phone: two');
  assert.deepEqual(rowTags(['gym', 'training'], 'gym'), { tags: ['training'], more: 0 }, 'the tag picked is the list\'s own');
  assert.deepEqual(rowTags(['gym/legs'], 'gym'), { tags: ['gym/legs'], more: 0 }, 'one under it is said in full');
});

test('the note list: by last edited or by date created, newest first (#344)', () => {
  const now = Date.UTC(2026, 9, 10, 12);
  const h = 3_600_000;
  const notes = [
    { id: 'a', created: now - 100 * h, updated: now - 1 * h },
    { id: 'b', created: now - 2 * h, updated: now - 50 * h },
    { id: 'c', created: now - 30 * h, updated: now + 10 * h }, // (a clock ahead: counts as now)
    { id: 'd', updated: now - 5 * h }, // (no created time: by its last edit)
  ];
  assert.deepEqual(sortNotes(notes, 'edited', now).map((n) => n.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(sortNotes(notes, 'created', now).map((n) => n.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(notes.map((n) => n.id), ['a', 'b', 'c', 'd'], 'the list given is left as it was');
  const tie = [{ id: 'z', created: 5, updated: 5 }, { id: 'y', created: 5, updated: 5 }];
  assert.deepEqual(sortNotes(tie, 'created', now).map((n) => n.id), ['y', 'z'], 'ties by id, never flickering');
  // The row's date, by date created.
  const local = new Date(2026, 9, 10, 15).getTime();
  assert.equal(createdLabel(local - 60_000, local), 'Created today');
  assert.equal(createdLabel(new Date(2026, 9, 9, 23).getTime(), local), 'Created yesterday');
  assert.equal(createdLabel(new Date(2026, 9, 2, 9).getTime(), local, 'en-US'), 'Created Oct 2');
  assert.equal(createdLabel(new Date(2025, 2, 24).getTime(), local, 'en-US'), 'Created Mar 24, 2025');
  assert.equal(createdLabel(0, local), '');
});

test("a note's address (#299): /n/<id>, read back from a path, and nothing else is one", () => {
  const id = '0d4c6f2e-1b7a-4c3d-9e8f-123456789abc';
  assert.equal(noteUrl(id, 'https://plim.example'), `https://plim.example/n/${id}`);
  assert.equal(notePath(id), `/n/${id}`);
  assert.equal(noteIdAt(`/n/${id}`), id);
  assert.equal(noteIdAt(`/n/${id}/`), id, 'a trailing slash');
  assert.equal(noteIdAt(`/n/${id.toUpperCase()}`), id, 'as typed in capitals');
  for (const not of ['/', `/${id}`, `/s/${id}`, '/n/', '/n/0d4c6f2e', `/n/${id}/more`, `/n/${id}x`]) assert.equal(noteIdAt(not), null, not);
});

test('tags: the same as the terminal client reads them (the shared cases, #308)', () => {
  const f = JSON.parse(readFileSync(new URL('fixtures/tags.json', here)));
  for (const [text, want] of f.tags) assert.deepEqual(tagsIn(text), want, JSON.stringify(text));
  for (const [input, want] of f.names) assert.equal(tagName(input), want, JSON.stringify(input));
  for (const [tag, query, want] of f.matches) assert.equal(tagMatches(tag, query), want, `${tag} ${query}`);
});

test('tags: where they are in a piece of text, a line of tags, and counts with their parents', () => {
  const text = 'Felt 💪 today #gym/legs and #Run.';
  const r = tagRanges(text);
  assert.deepEqual(r.map((t) => [text.slice(t.from, t.to), t.name]), [['#gym/legs', 'gym/legs'], ['#Run', 'run']], 'UTF-16 ranges, past an emoji');
  assert.deepEqual(tagRanges('#a', 'x'), [], 'after a letter (the text before it, elsewhere): no tag');
  assert.deepEqual(tagRanges('#a', ' ').map((t) => t.name), ['a']);
  assert.equal(tagLine('#gym #training'), true);
  assert.equal(tagLine('  #gym  '), true);
  assert.equal(tagLine('#gym and more'), false);
  assert.equal(tagLine(''), false);
  assert.deepEqual(tagCounts([['gym', 'training'], ['gym/legs'], ['gym/legs', 'gym'], []]), [['gym', 2], ['gym/legs', 2], ['training', 1]], 'a tag is a word (#539)');
});

test('titles leave out markdown marks (the cases the terminal client passes too)', () => {
  const { cases } = JSON.parse(readFileSync(new URL('fixtures/titles.json', here)));
  for (const [line, title] of cases) assert.equal(titleFromLine(line), title, line);
});
