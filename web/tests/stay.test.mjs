// Staying unlocked across reloads (stay.js).
import assert from 'node:assert/strict';
import { randomBytes } from '../core/crypto.js';
import { MemoryStayStore, STAY_DAYS, forgetKept, keepUnlocked, openKept, setStayUnlocked, touchKept } from '../core/stay.js';
import { test } from './lib.mjs';

const DAY = 24 * 3600 * 1000;
const ACCOUNT = 'aabbccddeeff00112233445566778899';

test('stay unlocked: round trip, and the key can not be read out', async () => {
  const store = new MemoryStayStore();
  const entropy = randomBytes(16);
  assert.equal(await keepUnlocked(store, { accountId: ACCOUNT, entropy }), true);
  // Not kept in the clear, and the key's bytes can't be exported.
  assert.ok(!Buffer.from(store.rec.ciphertext).includes(Buffer.from(entropy)));
  assert.equal(store.rec.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', store.rec.key));
  const got = await openKept(store);
  assert.equal(got.accountId, ACCOUNT);
  assert.deepEqual(got.entropy, entropy);
});

test(`stay unlocked: ${STAY_DAYS} days unused, sliding with each use`, async () => {
  const store = new MemoryStayStore();
  const t0 = Date.UTC(2026, 10, 1);
  await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) }, t0);
  // Opening on day 29 starts the 30 days again: day 58 still opens.
  assert.ok(await openKept(store, t0 + 29 * DAY));
  assert.ok(await openKept(store, t0 + 58 * DAY));
  // A tab in use touches it too.
  await touchKept(store, t0 + 80 * DAY);
  assert.ok(await openKept(store, t0 + 109 * DAY));
  // 31 days unused: gone, and deleted.
  assert.equal(await openKept(store, t0 + 140 * DAY), null);
  assert.equal(store.rec, null);
  // A touch can't bring back an expired one.
  await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) }, t0);
  await touchKept(store, t0 + 31 * DAY);
  assert.equal(await openKept(store, t0 + 31 * DAY), null);
});

test('stay unlocked: a changed record or another account opens nothing, and is deleted', async () => {
  const store = new MemoryStayStore();
  await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) });
  store.rec.ciphertext[0] ^= 1;
  assert.equal(await openKept(store), null);
  assert.equal(store.rec, null);
  await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) });
  store.rec.accountId = '00112233445566778899aabbccddeeff';
  assert.equal(await openKept(store), null);
  assert.equal(store.rec, null);
});

test('stay unlocked: forgetting, and turned off on this device', async () => {
  const store = new MemoryStayStore();
  await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) });
  await forgetKept(store);
  assert.equal(await openKept(store), null);
  // Off: forgets what was kept, and keeps nothing new.
  await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) });
  await setStayUnlocked(store, false);
  assert.equal(store.rec, null);
  assert.equal(await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) }), false);
  assert.equal(await openKept(store), null);
  // On again: the next unlock is kept.
  await setStayUnlocked(store, true);
  assert.equal(await keepUnlocked(store, { accountId: ACCOUNT, entropy: randomBytes(16) }), true);
  assert.ok(await openKept(store));
});
