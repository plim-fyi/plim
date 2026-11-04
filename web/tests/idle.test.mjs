// Auto-lock (idle.js).
import assert from 'node:assert/strict';
import { AutoLock } from '../core/idle.js';
import { test } from './lib.mjs';

test('auto-lock: activity in another tab restarts the countdown, and own activity is reported', () => {
  let t = 0;
  let reported = 0;
  const min = 60_000;
  const a = new AutoLock({ onLock: () => {}, onActivity: () => reported++, now: () => t, checkEveryMs: 3_600_000 });
  a.start(15);
  t = 14 * min;
  a.touch(); // another tab was used: not reported back
  assert.equal(reported, 0);
  t = 28 * min;
  assert.equal(a.check(), false);
  a.activity(); // used here: restarts, and is reported for the other tabs
  assert.equal(reported, 1);
  t = 42 * min;
  assert.equal(a.check(), false);
  t = 44 * min;
  assert.equal(a.check(), true);
  a.stop();
});

test('auto-lock: idle limit, activity resets, never, and postponement', () => {
  let t = 0;
  const min = 60_000;
  let locks = 0;
  let allowed = true;
  const a = new AutoLock({ onLock: () => locks++, canLock: () => allowed, now: () => t, checkEveryMs: 3_600_000 });
  a.start(15);
  t = 14 * min;
  assert.equal(a.check(), false);
  a.activity(); // typing at 14 min restarts the countdown
  t = 28 * min;
  assert.equal(a.check(), false);
  t = 29 * min;
  assert.equal(a.check(), true);
  assert.equal(locks, 1);
  assert.equal(a.check(), false); // stopped after locking: never a second lock
  assert.equal(locks, 1);

  // Never: no lock however long.
  a.start(0);
  t += 10_000 * min;
  assert.equal(a.check(), false);
  assert.equal(a.remaining(), Infinity);

  // Busy (e.g. changing the phrase): postponed, then locks once idle again.
  a.start(5);
  allowed = false;
  t += 6 * min;
  assert.equal(a.check(), false);
  allowed = true;
  t += 4 * min;
  assert.equal(a.check(), false);
  t += 1 * min;
  assert.equal(a.check(), true);
  assert.equal(locks, 2);

  // Changing the setting takes effect immediately and restarts the countdown.
  a.start(60);
  t += 30 * min;
  a.setMinutes(5);
  t += 4 * min;
  assert.equal(a.check(), false);
  t += 1 * min;
  assert.equal(a.check(), true);
  a.stop();
});
