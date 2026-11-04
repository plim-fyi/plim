// The server's clock (clock.js).
import assert from 'node:assert/strict';
import { Api } from '../core/api.js';
import { notAfterNow, now as clockNow, nowSecs as clockSecs, offsetFrom, sawServerDate } from '../core/clock.js';
import { test } from './lib.mjs';

test('clock: times written follow the server’s clock when this one is off (#58)', async () => {
  const at = Date.parse('Sun, 05 Oct 2026 08:00:00 GMT');
  const date = (ms) => new Date(ms).toUTCString();
  // Right (to within the header's whole seconds and the round trip): no correction.
  assert.equal(offsetFrom(date(at), at - 100, at + 300), 0);
  assert.equal(offsetFrom(date(at + 5000), at, at + 200), 0, 'a few seconds off counts as right');
  // This device 5 minutes behind / 2 hours ahead: corrected, to the second.
  assert.ok(Math.abs(offsetFrom(date(at + 300_000), at - 100, at + 100) - 300_500) <= 1000);
  assert.ok(Math.abs(offsetFrom(date(at - 7_200_000), at - 100, at + 100) + 7_199_500) <= 1000);
  // Can't tell: a slow answer, or no usable header, keeps what was known.
  assert.equal(offsetFrom(date(at + 300_000), at, at + 15_000, 42), 42);
  assert.equal(offsetFrom(null, at, at + 100, 42), 42);
  assert.equal(offsetFrom('not a date', at, at + 100, 42), 42);
  // What the app uses: 10 minutes behind the server, then right again.
  const t = Date.now();
  sawServerDate(date(t + 600_000), t, t);
  assert.ok(Math.abs(clockNow() - Date.now() - 600_000) < 2000);
  assert.ok(Math.abs(clockSecs() - Math.floor(Date.now() / 1000) - 600) <= 2);
  sawServerDate(date(Date.now()), Date.now(), Date.now());
  assert.ok(Math.abs(clockNow() - Date.now()) < 5);
  // Every API answer tells it (api.js), errors too.
  const realFetch = globalThis.fetch;
  try {
    for (const status of [200, 404]) {
      globalThis.fetch = async () => new Response('{}', { status, headers: { date: date(Date.now() - 3_600_000) } });
      sawServerDate(date(Date.now()), Date.now(), Date.now());
      await new Api('http://x').get('/account').catch(() => {});
      assert.ok(Math.abs(clockNow() - Date.now() + 3_600_000) < 2000, `an hour behind, from a ${status}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    sawServerDate(date(Date.now()), Date.now(), Date.now());
  }
  // Shown and sorted: never later than now.
  assert.equal(notAfterNow(at + 60_000, at), at);
  assert.equal(notAfterNow(at - 60_000, at), at - 60_000);
});
