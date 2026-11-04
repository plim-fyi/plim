// In-memory keyring: unwrapped vault keys by version, plus cached doc keys.
import { deriveDocKey, unwrapVaultKey } from './crypto.js';

export class Keyring {
  constructor() {
    this.vaultKeys = new Map(); // version → raw 32-byte key
    this.docKeys = new Map(); // `${version}:${docId}` → CryptoKey
  }

  static async fromEntries(identity, accountId, entries) {
    const kr = new Keyring();
    for (const e of entries) kr.vaultKeys.set(e.key_version, await unwrapVaultKey(identity, accountId, e));
    return kr;
  }

  get current() {
    return Math.max(...this.vaultKeys.keys());
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
