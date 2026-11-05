// In-memory keyring: unwrapped vault keys by version, plus cached doc keys.
import { deriveDocKey, unwrapVaultKey } from './crypto.js';

export class Keyring {
  constructor() {
    this.vaultKeys = new Map(); // version → raw 32-byte key
    this.docKeys = new Map(); // `${version}:${docId}` → CryptoKey
    // Entries this phrase can't open: a phrase change that wasn't finished registered its new key
    // under the new phrase (account.js rotatePhrase); the old phrase still signs in, and the app
    // asks for the new one to open these (unlock) and finish.
    this.locked = new Map(); // version → the server's entry
  }

  static async fromEntries(identity, accountId, entries) {
    const kr = new Keyring();
    for (const e of entries) await kr.addEntry(identity, accountId, e);
    if (!kr.vaultKeys.size) throw new Error(kr.locked.size ? 'none of the vault keys opens with this phrase' : 'the server returned no vault keys');
    return kr;
  }

  /** The server's entry, opened with `identity` if it can be, kept as locked if not. */
  async addEntry(identity, accountId, e) {
    if (this.vaultKeys.has(e.key_version) || this.locked.has(e.key_version)) return;
    try {
      this.vaultKeys.set(e.key_version, await unwrapVaultKey(identity, accountId, e));
    } catch {
      this.locked.set(e.key_version, e);
    }
  }

  /** The locked entries opened with another phrase's identity: all of them, or none and an error. */
  async unlock(identity, accountId) {
    const opened = new Map();
    for (const [v, e] of this.locked) opened.set(v, await unwrapVaultKey(identity, accountId, e));
    for (const [v, key] of opened) {
      this.vaultKeys.set(v, key);
      this.locked.delete(v);
    }
  }

  /** The key new writes go under: the highest this phrase opens. */
  get current() {
    return Math.max(...this.vaultKeys.keys());
  }

  /** The highest version registered, locked ones too (what the rollback check remembers). */
  get highest() {
    return Math.max(this.current, ...this.locked.keys());
  }

  add(version, rawKey) {
    this.vaultKeys.set(version, rawKey);
  }

  async docKey(version, docId) {
    const id = `${version}:${docId}`;
    if (!this.docKeys.has(id)) {
      const vk = this.vaultKeys.get(version);
      if (!vk) throw new Error(`missing vault key v${version}`);
      this.docKeys.set(id, await deriveDocKey(vk, docId));
    }
    return this.docKeys.get(id);
  }

  wipe() {
    for (const k of this.vaultKeys.values()) k.fill(0);
    this.vaultKeys.clear();
    this.docKeys.clear();
  }
}
