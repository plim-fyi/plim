// Type / for a menu (slash.js).
import assert from 'node:assert/strict';
import { COMMANDS, clockTime, dayBefore, inCode, isoDay, matching, opensAt, queryAt, stamp, withoutCommand } from '../editor/slash.js';
import { test } from './lib.mjs';

test('/ menu: where a typed / opens it', () => {
  const at = (text) => opensAt(text.replace('|', ''), text.indexOf('|')); // (| marks the / typed)
  for (const yes of ['|/', 'a |/', '- |/', '## |/', '> |/', 'x\n|/', 'tab\t|/', '`code` |/', '```\ncode\n```\n|/', '~~~~\n```\n~~~~\n|/']) assert.equal(at(yes), true, yes);
  for (const no of ['a|/', 'https:/|/', 'and|/', '1|/', '[t](|/', '<|/', '`|/', 'a `b |/', '```\n|/', '```js\nx\n|/', '  ```\n|/', '~~~\n```\n|/', '```` |/', '``` |/']) assert.equal(at(no), false, no);
  assert.equal(opensAt('a b', 1), false, 'not a /');
  assert.equal(inCode('```\nx\n```\n', 10), false, 'after a closed fence');
  assert.equal(inCode('``` a`b\n', 8), false, "a backtick in the info: not a fence");
  assert.equal(inCode('`` a ` b ``', 6), true, 'a span closes only on a run of its length');
  assert.equal(inCode('`` a ` b `` c', 12), false);
});

test('/ menu: what typed after the / finds, best first', () => {
  const ids = (q) => matching(q).map((c) => c.id);
  assert.deepEqual(ids(''), ['today', 'now', 'yesterday', 'datetime'], 'a bare /: all');
  assert.deepEqual(ids('t'), ['today', 'now', 'datetime'], 'the name, then an alias, then a later word');
  assert.deepEqual(ids('Tod'), ['today'], 'case doesn’t matter (a phone capitalises it)');
  assert.deepEqual(ids('n'), ['now']);
  assert.deepEqual(ids('time'), ['now', 'datetime']);
  assert.deepEqual(ids('date'), ['datetime', 'today']);
  assert.deepEqual(ids('date and t'), ['datetime'], 'words, with their spaces');
  assert.deepEqual(ids('y'), ['yesterday']);
  for (const none of ['x', ' ', 'today ', 'etc', 'usr']) assert.deepEqual(ids(none), [], JSON.stringify(none));
  assert.equal(queryAt('a /tod', 2, 6), 'tod');
  assert.equal(queryAt('a /', 2, 3), '');
  assert.equal(queryAt('a /t\nx', 2, 6), null, 'a new line: no longer');
  assert.equal(queryAt('a x', 2, 3), null, 'the / gone');
  assert.equal(queryAt('a /', 2, 2), null, 'the cursor before it');
  assert.equal(queryAt(`/${'a'.repeat(30)}`, 0, 31), null, 'too long for a name');
  assert.equal(withoutCommand('Groceries /tod', { from: 10, to: 14 }), 'Groceries ');
  assert.equal(withoutCommand('x', null), 'x');
});

test('/ menu: the dates, as this device’s calendar has them, on a 12-hour clock', () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    // 8:30 PM in New York on the 9th is already the 10th in UTC: the day is the 9th.
    const evening = new Date(Date.UTC(2026, 9, 10, 0, 30));
    assert.equal(evening.toISOString().slice(0, 10), '2026-10-10');
    assert.equal(isoDay(evening), '2026-10-09');
    assert.equal(clockTime(evening), '8:30 PM');
    const at = (id, d) => COMMANDS.find((c) => c.id === id).text(d);
    assert.equal(at('today', evening), '2026-10-09');
    assert.equal(at('yesterday', evening), '2026-10-08');
    assert.equal(at('datetime', evening), '2026-10-09 8:30 PM');
    // Yesterday across a clock change (the 8th of March 2026 was 23 hours long in New York), a month's and a year's start.
    assert.equal(isoDay(dayBefore(new Date(2026, 2, 9, 0, 30))), '2026-03-08');
    assert.equal(isoDay(dayBefore(new Date(2026, 2, 1, 9))), '2026-02-28');
    assert.equal(isoDay(dayBefore(new Date(2026, 0, 1, 0, 5))), '2025-12-31');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(isoDay(new Date(Date.UTC(2026, 9, 9, 15, 30))), '2026-10-10', 'ahead of UTC: already tomorrow');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  const t = (h, m) => clockTime(new Date(2026, 9, 9, h, m));
  assert.equal(t(0, 5), '12:05 AM', 'just after midnight');
  assert.equal(t(9, 7), '9:07 AM');
  assert.equal(t(12, 30), '12:30 PM', 'noon');
  assert.equal(t(14, 32), '2:32 PM');
  assert.equal(t(23, 59), '11:59 PM');
});

test('a new note\'s stamp: its date and time, as its title (#313)', () => {
  assert.match(stamp(new Date(2026, 9, 9, 21, 14)), /^2026-10-09 9:14 PM$/);
});
