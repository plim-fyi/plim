// Device-local storage (IndexedDB): passkey copies of the recovery entropy,
// the encrypted autosave outbox, and encrypted copies of notes and the
// keyring for offline use.
import { b64, unb64 } from './crypto.js';

const DB_NAME = 'tiro';

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('kv');
        const ob = d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        ob.createIndex('doc', ['accountId', 'docId']);
      }
      // v2: encrypted copies of each note, for opening them offline.
      if (e.oldVersion < 2) d.createObjectStore('docs', { keyPath: ['accountId', 'docId'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * One transaction: `fn` makes its requests at once (none waits for another's result), and it's
 * committed straight away (#235). Otherwise it commits only once this page has had the results,
 * and a page frozen before then (Safari keeps one, for Back, as you leave it) keeps it open:
 * every Plim page on the site then waits for those stores, the app's included, showing nothing.
 */
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let result;
    Promise.resolve(fn(t.objectStore(store))).then((r) => (result = r));
    try {
      t.commit?.();
    } catch {} // (already finishing)
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// ---- small key/value helpers (device-local settings) ----

export const kvGet = (key) => tx('kv', 'readonly', (s) => wrap(s.get(key)));
export const kvPut = (key, value) => tx('kv', 'readwrite', (s) => wrap(s.put(value, key)));
export const kvDelete = (key) => tx('kv', 'readwrite', (s) => wrap(s.delete(key)));

// ---- passkey copies ----

const PASSKEYS = 'passkeys';

/**
 * The passkey copies of the recovery entropy this device has used (see
 * account.js savePasskey): exactly what the server holds, so a passkey can
 * unlock this device offline. Records: { accountId, credentialId, credHash,
 * nonce, ciphertext, synced }.
 */
export const passkeyCache = {
  list: async () => (await kvGet(PASSKEYS)) ?? [],
  async put(rec) {
    const rest = (await this.list()).filter((r) => r.credHash !== rec.credHash);
    await kvPut(PASSKEYS, [...rest, rec]);
  },
  async remove(match) {
    await kvPut(PASSKEYS, (await this.list()).filter((r) => !match(r)));
  },
};

/**
 * Before passkey sign-in, a device could have its own passkey or password
 * unlock. Those are no longer used: drop them, and return the old passkey's
 * credential ID (base64) so its manager can be told, if there was one.
 */
export async function removeLegacyUnlock() {
  const old = await kvGet('passkey-unlock');
  await kvDelete('passkey-unlock');
  await kvDelete('quick-unlock');
  return old?.credentialId ?? null;
}

/** Whether the user has said they saved the recovery phrase (undefined: never asked on this device). */
export const phraseSaved = {
  get: (accountId) => kvGet(`phrase-saved:${accountId}`),
  set: (accountId, saved) => kvPut(`phrase-saved:${accountId}`, saved),
};

// ---- outbox ----

/** Persistent queue of locally-made, not-yet-uploaded (encrypted) Yjs updates. */
export class IdbOutbox {
  constructor(accountId) {
    this.accountId = accountId;
  }

  async add(docId, record) {
    return tx('outbox', 'readwrite', (s) => wrap(s.add({ accountId: this.accountId, docId, record })));
  }

  async list(docId) {
    const rows = await tx('outbox', 'readonly', (s) =>
      wrap(s.index('doc').getAll([this.accountId, docId])),
    );
    return rows.map(({ id, record }) => ({ id, record }));
  }

  async remove(ids) {
    await tx('outbox', 'readwrite', (s) => Promise.all(ids.map((id) => wrap(s.delete(id)))));
  }

  async docs() {
    const rows = await tx('outbox', 'readonly', (s) => wrap(s.getAll()));
    return [...new Set(rows.filter((r) => r.accountId === this.accountId).map((r) => r.docId))];
  }
}

/** Same interface, in memory (tests). */
export class MemoryOutbox {
  constructor() {
    this.rows = [];
    this.next = 1;
  }
  async add(docId, record) {
    this.rows.push({ id: this.next, docId, record });
    return this.next++;
  }
  async list(docId) {
    return this.rows.filter((r) => r.docId === docId).map(({ id, record }) => ({ id, record }));
  }
  async remove(ids) {
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
  }
  async docs() {
    return [...new Set(this.rows.map((r) => r.docId))];
  }
}

// ---- rollback detection memory ----

/**
 * What this device has seen the server confirm, per account: each doc's Yjs
 * state vector and the highest vault key version. Only ever raised.
 */
export class IdbSeen {
  constructor(accountId) {
    this.prefix = `seen:${accountId}:`;
  }
  async get(key) {
    return tx('kv', 'readonly', (s) => wrap(s.get(this.prefix + key)));
  }
  async set(key, value) {
    await tx('kv', 'readwrite', (s) => s.put(value, this.prefix + key));
  }
  async getSV(docId) {
    const v = await this.get(`sv:${docId}`);
    return v ? unb64(v) : null;
  }
  setSV(docId, sv) {
    return this.set(`sv:${docId}`, b64(sv));
  }
  async getKeyVersion() {
    return (await this.get('key_version')) ?? 0;
  }
  setKeyVersion(v) {
    return this.set('key_version', v);
  }
}

/** Same interface, in memory (tests). */
export class MemorySeen {
  constructor() {
    this.svs = new Map();
    this.keyVersion = 0;
  }
  async getSV(docId) {
    return this.svs.get(docId) ?? null;
  }
  async setSV(docId, sv) {
    this.svs.set(docId, sv);
  }
  async getKeyVersion() {
    return this.keyVersion;
  }
  async setKeyVersion(v) {
    this.keyVersion = v;
  }
}

// ---- offline copies ----

/**
 * The latest state of each note, encrypted with that note's key (see
 * DocSync.writeCache), so notes open instantly and without a connection.
 * Records: { key_version, nonce, ciphertext, saved_at }.
 */
export class IdbDocCache {
  constructor(accountId) {
    this.accountId = accountId;
  }
  async get(docId) {
    const row = await tx('docs', 'readonly', (s) => wrap(s.get([this.accountId, docId])));
    return row?.record ?? null;
  }
  async put(docId, record) {
    await tx('docs', 'readwrite', (s) => wrap(s.put({ accountId: this.accountId, docId, record })));
  }
  async delete(docId) {
    await tx('docs', 'readwrite', (s) => wrap(s.delete([this.accountId, docId])));
  }
}

/** Same interface, in memory (tests). */
export class MemoryDocCache {
  constructor() {
    this.rows = new Map();
  }
  async get(docId) {
    return this.rows.get(docId) ?? null;
  }
  async put(docId, record) {
    this.rows.set(docId, record);
  }
  async delete(docId) {
    this.rows.delete(docId);
  }
}

/**
 * What a sign-in returned (account ID and the keyring, still wrapped with the
 * key from the 12 words — exactly what the server holds), by public key hash,
 * so the vault can be opened offline with the same seed.
 */
export const sessionStore = {
  save: (pubkeyHash, record) => kvPut(`session:${pubkeyHash}`, record),
  load: (pubkeyHash) => kvGet(`session:${pubkeyHash}`),
  delete: (pubkeyHash) => kvDelete(`session:${pubkeyHash}`),
};

/** Same interface, in memory (tests). */
export class MemorySessionStore {
  constructor() {
    this.rows = new Map();
  }
  async save(pubkeyHash, record) {
    this.rows.set(pubkeyHash, structuredClone(record));
  }
  async load(pubkeyHash) {
    return this.rows.get(pubkeyHash) ?? null;
  }
  async delete(pubkeyHash) {
    this.rows.delete(pubkeyHash);
  }
}

/**
 * "Forget this device": drop every offline copy, passkey copy, saved sign-in
 * and remembered cursor/scroll position. The outbox stays.
 */
export async function clearOfflineData() {
  await tx('docs', 'readwrite', (s) => wrap(s.clear()));
  const keys = await tx('kv', 'readonly', (s) => wrap(s.getAllKeys()));
  const sessions = keys.filter((k) => /^(session|view):/.test(String(k)) || k === PASSKEYS);
  await tx('kv', 'readwrite', (s) => Promise.all(sessions.map((k) => wrap(s.delete(k)))));
}
