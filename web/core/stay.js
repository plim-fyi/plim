// Staying unlocked on this device across reloads: after an unlock, the recovery entropy
// (what a passkey wraps) is kept on the device, encrypted with AES-GCM under a random key made
// non-extractable, which is stored beside it (IndexedDB keeps a CryptoKey as it is, and no script
// can read its bytes out). A reload within 30 days of the last use opens the vault from it; Log
// out, Forget this device, or turning it off deletes it.
//
// This only keeps a page's script from reading the key: the browser keeps its bytes in the
// profile, so anyone who can use this browser profile can open the vault until then (README,
// Known limitations). Local only: the server learns nothing new.

const subtle = crypto.subtle;
const te = new TextEncoder();

/** How long a device stays unlocked without being used. */
export const STAY_DAYS = 30;
const STAY_MS = STAY_DAYS * 24 * 3600 * 1000;
/** A label of this device's own, never sent anywhere (so not one of the protocol's tiro/v1 labels). */
const AAD = 'plim/stay-unlocked/v1';

const aad = (accountId) => te.encode(`${AAD}\0${accountId}`);

/** Whether a record last used at `lastUsed` still opens at `now`. */
export const stillKept = (lastUsed, now = Date.now()) => typeof lastUsed === 'number' && now - lastUsed <= STAY_MS;

/**
 * Keep `entropy` for `accountId` on this device (replacing what was kept), unless staying
 * unlocked is turned off here.
 */
export async function keepUnlocked(store, { accountId, entropy }, now = Date.now()) {
  if (await store.isOff()) return false;
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(accountId) }, key, entropy));
  await store.save({ accountId, key, iv, ciphertext, lastUsed: now });
  return true;
}

/**
 * What this device kept: `{ accountId, entropy }`, its 30 days started again; or null (nothing
 * kept, turned off, expired or unreadable: the last two are deleted).
 */
export async function openKept(store, now = Date.now()) {
  const rec = await store.load();
  if (!rec) return null;
  if ((await store.isOff()) || !stillKept(rec.lastUsed, now)) {
    await store.delete();
    return null;
  }
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: aad(rec.accountId) }, rec.key, rec.ciphertext);
    await store.save({ ...rec, lastUsed: now });
    return { accountId: rec.accountId, entropy: new Uint8Array(plain) };
  } catch {
    await store.delete();
    return null;
  }
}

/** Start the 30 days again (a tab left open and in use). */
export async function touchKept(store, now = Date.now()) {
  const rec = await store.load();
  if (rec && stillKept(rec.lastUsed, now)) await store.save({ ...rec, lastUsed: now });
}

/** Forget what was kept (Log out, Forget this device). */
export const forgetKept = (store) => store.delete();

/** Turn staying unlocked on or off on this device; off forgets what was kept. */
export async function setStayUnlocked(store, on) {
  await store.setOff(!on);
  if (!on) await store.delete();
}

/** The same interface as vault.js's stayStore, in memory (tests). */
export class MemoryStayStore {
  constructor() {
    this.rec = null;
    this.off = false;
  }
  async load() {
    return this.rec;
  }
  async save(rec) {
    this.rec = rec;
  }
  async delete() {
    this.rec = null;
  }
  async isOff() {
    return this.off;
  }
  async setOff(off) {
    this.off = off;
  }
}
