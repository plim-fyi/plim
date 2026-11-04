// What the test files share: registering a test, and the fakes more than one of them uses.
import { bytesToHex, deriveIdentity, randomBytes, unb64, verify } from '../core/crypto.js';
import { Keyring } from '../core/keyring.js';
import { MemoryOutbox } from '../core/vault.js';
import { blobMsg, shareBlobMsg } from '../core/sig.js';
import { ApiError } from '../core/api.js';

export const here = new URL('.', import.meta.url);
export const tests = [];
/** A test, run by run.mjs in the order the files register them. */
export const test = (name, fn) => tests.push({ name, fn });

/** The newest seq a note's history has: its last update's, or what its snapshot covers (store.rs head). */
const headOf = (d) => Math.max(d.updates.at(-1)?.seq ?? 0, d.snapshot?.covers_seq ?? 0);

/**
 * Where a snapshot may go, as the server checks it (docs.rs check_covers): not ahead of the
 * history (400), not behind the newest snapshot (409, another device compacted further).
 */
function checkCovers(d, covers) {
  if (covers > headOf(d)) throw new ApiError(400, 'covers_seq is ahead of the server');
  if (covers < (d.snapshot?.covers_seq ?? 0)) throw new ApiError(409, 'a newer snapshot exists');
}

/**
 * /api/docs in memory, as the server answers (server/src/docs.rs, store.rs): seqs after the
 * head, a snapshot replacing older ones, a closed note (`close`) refusing writes with 410, a
 * blob over `maxBlob` with 413. The shared sync cases (sync-cases.json) hold it to the server.
 */
export class FakeServer {
  constructor(identity, accountId) {
    this.identity = identity;
    this.accountId = accountId;
    this.docs = new Map();
  }
  doc(id) {
    if (!this.docs.has(id)) this.docs.set(id, { updates: [], snapshot: null, gone: false });
    return this.docs.get(id);
  }
  /** No more writes for a note (POST /docs/{id}/close: shared or deleted elsewhere, #119). */
  close(id) {
    this.doc(id).gone = true;
  }
  /** A note's history, as server/src/versions.rs (every version kept). */
  versions(id) {
    return (this.history ??= new Map()).get(id) ?? this.history.set(id, []).get(id);
  }
  async request(method, path, body) {
    if (method === 'GET') return this.get(path);
    if (method === 'POST') return this.post(path, body);
    const [, id, vid] = path.match(/^\/docs\/([^/]+)\/versions\/(\d+)$/); // PUT: re-encrypt, same time
    const v = this.versions(id).find((x) => x.id === Number(vid));
    if (!v || body.covers_seq !== v.created_at) throw new ApiError(400, 'a version keeps its time');
    await this.checkSig(id, 'version', body);
    Object.assign(v, { key_version: body.key_version, nonce: body.nonce, ciphertext: body.ciphertext });
  }
  async checkSig(id, kind, body) {
    const msg = blobMsg(this.accountId, id, kind, body.key_version, body.covers_seq ?? 0, unb64(body.nonce), unb64(body.ciphertext));
    if (!(await verify(this.identity.pubkey, msg, unb64(body.sig)))) throw new ApiError(400, 'bad signature');
  }
  async get(path) {
    const versions = path.match(/^\/docs\/([^/]+)\/versions(?:\/(\d+))?$/);
    if (versions) {
      const all = this.versions(versions[1]);
      if (versions[2]) return all.find((v) => v.id === Number(versions[2]));
      return { versions: [...all].reverse().map((v) => ({ id: v.id, created_at: v.created_at, size: unb64(v.ciphertext).length })) };
    }
    const [, id, after] = path.match(/^\/docs\/([^?]+)\?after=(\d+)$/);
    const d = this.doc(id);
    const a = Number(after);
    const snap = d.snapshot && d.snapshot.covers_seq > a ? d.snapshot : null;
    const base = snap ? snap.covers_seq : a;
    return { snapshot: snap, updates: d.updates.filter((u) => u.seq > base), head: headOf(d) };
  }
  async post(path, body) {
    const version = path.match(/^\/docs\/([^/]+)\/versions$/);
    if (version) {
      await this.checkSig(version[1], 'version', body);
      const all = this.versions(version[1]);
      all.push({ id: all.length + 1, created_at: body.covers_seq, key_version: body.key_version, nonce: body.nonce, ciphertext: body.ciphertext });
      return { id: all.length, kept: true };
    }
    const [, id, kind] = path.match(/^\/docs\/([^/]+)\/(updates|snapshots)$/);
    const d = this.doc(id);
    // In the server's order (docs.rs verify_blob, then check_covers).
    if (d.gone) throw new ApiError(410, 'this note was moved or deleted');
    if (this.maxBlob && unb64(body.ciphertext).length > this.maxBlob) throw new ApiError(413, 'blob too large');
    const k = kind === 'updates' ? 'update' : 'snapshot';
    const msg = blobMsg(this.accountId, id, k, body.key_version, body.covers_seq ?? 0, unb64(body.nonce), unb64(body.ciphertext));
    if (!(await verify(this.identity.pubkey, msg, unb64(body.sig)))) throw new ApiError(400, 'bad signature');
    if (k === 'snapshot') checkCovers(d, body.covers_seq);
    (this.posted ??= []).push({ kind, bytes: unb64(body.ciphertext).length });
    if (k === 'update') {
      const seq = headOf(d) + 1;
      d.updates.push({ ...body, seq });
      return { seq };
    }
    d.snapshot = body;
    return { covers_seq: body.covers_seq };
  }
}

export async function fakeSession() {
  const identity = await deriveIdentity(randomBytes(64));
  const accountId = bytesToHex(randomBytes(16));
  const keyring = new Keyring();
  keyring.add(1, randomBytes(32));
  const api = new FakeServer(identity, accountId);
  const mk = (seen, reports = []) => ({
    api, accountId, identity, keyring, seen,
    outbox: new MemoryOutbox(),
    onRollback: (docId, info) => reports.push({ docId, ...info }),
  });
  return { api, keyring, mk };
}

export const text = (doc) => doc.getText('body').toString();

/**
 * /api/shares/{id} in memory, as the server answers (server/src/shares.rs): signatures checked with
 * the share's public key, the same seqs and snapshot rules as a private note, and links turned
 * off (`turnOff`) answering 410 to reads and writes.
 */
export class FakeShareServer {
  constructor(id, pubkey) {
    Object.assign(this, { id, pubkey, updates: [], snapshot: null, posted: [], versions: [], revoked: false });
  }
  /** Its links turned off (POST /shares/{id}/revoke). */
  turnOff() {
    this.revoked = true;
  }
  async request(method, path, body) {
    if (this.revoked) throw new ApiError(410, 'this link was revoked');
    const versions = path.match(/\/versions(?:\/(\d+))?$/);
    if (versions && method === 'GET') {
      if (versions[1]) return this.versions.find((v) => v.id === Number(versions[1]));
      return { versions: [...this.versions].reverse().map((v) => ({ id: v.id, created_at: v.created_at })) };
    }
    if (versions) {
      const msg = shareBlobMsg(this.id, 'version', body.covers_seq, unb64(body.nonce), unb64(body.ciphertext));
      if (!(await verify(this.pubkey, msg, unb64(body.sig)))) throw new ApiError(400, 'not signed with this share’s key');
      this.versions.push({ id: this.versions.length + 1, created_at: body.covers_seq, nonce: body.nonce, ciphertext: body.ciphertext, sig: body.sig });
      return { id: this.versions.length, kept: true };
    }
    if (method === 'GET') {
      const after = Number(path.match(/after=(\d+)/)[1]);
      const snap = this.snapshot && this.snapshot.covers_seq > after ? this.snapshot : null;
      const base = snap ? snap.covers_seq : after;
      return { snapshot: snap, updates: this.updates.filter((u) => u.seq > base), head: headOf(this) };
    }
    return this.post(path, body);
  }
  async post(path, body) {
    if (path.endsWith('/versions')) return this.request('POST', path, body);
    if (this.revoked) throw new ApiError(410, 'this link was revoked');
    if (this.maxBlob && unb64(body.ciphertext).length > this.maxBlob) throw new ApiError(413, 'blob too large');
    const kind = path.endsWith('/updates') ? 'update' : 'snapshot';
    const msg = shareBlobMsg(this.id, kind, body.covers_seq ?? 0, unb64(body.nonce), unb64(body.ciphertext));
    if (!(await verify(this.pubkey, msg, unb64(body.sig)))) throw new ApiError(400, 'not signed with this share’s key');
    if (kind === 'snapshot') checkCovers(this, body.covers_seq);
    this.posted.push(kind);
    if (kind === 'update') {
      const seq = headOf(this) + 1;
      this.updates.push({ ...body, seq });
      return { seq };
    }
    this.snapshot = body;
    return { covers_seq: body.covers_seq };
  }
}
