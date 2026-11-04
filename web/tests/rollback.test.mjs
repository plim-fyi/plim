// Rollback detection: the keyring. (A note's rollbacks are sync cases, fixtures/sync-cases.json,
// played by sync-cases.test.mjs and the terminal client alike, #441.)
import assert from 'node:assert/strict';
import { randomBytes } from '../core/crypto.js';
import { Keyring } from '../core/keyring.js';
import { MemorySeen } from '../core/vault.js';
import { checkKeyring } from '../core/account.js';
import { test } from './lib.mjs';

test('rollback: an older keyring than previously seen is detected', async () => {
  const seen = new MemorySeen();
  const kr = new Keyring();
  kr.add(1, randomBytes(32));
  assert.equal(await checkKeyring(seen, kr), null);
  kr.add(2, randomBytes(32));
  assert.equal(await checkKeyring(seen, kr), null);
  assert.equal(await seen.getKeyVersion(), 2);
  const old = new Keyring();
  old.add(1, randomBytes(32));
  assert.deepEqual(await checkKeyring(seen, old), { expected: 2, got: 1 });
});
