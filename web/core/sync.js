// Per-document sync: encrypted autosave outbox, load/poll, compaction.
import * as Y from '../vendor/yjs.mjs';
import { b64, decrypt, encrypt, sign, unb64 } from './crypto.js';
import { blobAad, blobMsg } from './sig.js';
import { ApiError, isOffline } from './api.js';
import { VERSION_EVERY_SECS, listVersions, nowSecs, saveVersion, versionDue } from './history.js';

export const REMOTE = Symbol('remote');
const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 2000;
const COMPACT_AFTER = 100; // updates since the last snapshot…
const COMPACT_BYTES = 512 * 1024; // …or bytes of them (a few big pastes are enough)
const WIPE_CHARS = 50; // someone else's edit removing at least this much, and over half the note, is kept (history)
const CACHE_MS = 1000;
const GAP_MS = 1500; // a live push skipped ahead: wait this long for the missing ones, then pull
/** Until the server says otherwise (GET /account → max_blob_bytes): what older servers accept. */
const DEFAULT_MAX_BLOB = 1024 * 1024;
const KEEPALIVE_MAX = 60 * 1024; // browsers refuse larger keepalive requests (64 KiB in total)

/**
 * Shared per-session context: { api, accountId, identity, keyring, outbox, seen?, cache?, maxBlobBytes? }.
 * With `cache` (vault.js IdbDocCache), the doc's latest state is kept on the
 * device, encrypted with its key, so it opens instantly and offline.
 * `maxBlobBytes` is the server's largest accepted blob; uploads are split to fit.
 * Status is reported through ctx.onStatus(docId, 'saving'|'saved'|'offline'|'full'|'too-large'|'error'),
 * and a refused sign-in (401 after retrying) through ctx.onSessionEnded().
 *
 * Rollback detection (when ctx.seen is set): `shadow` is a second Y.Doc holding
 * only state the server has confirmed — what it delivered plus what it acked.
 * Its state vector (per-client Yjs clocks, carried inside the authenticated
 * ciphertext) is remembered per device. If the server later delivers less than
 * that, or delivers updates whose predecessors are missing, ctx.onRollback fires.
 */
export class DocSync {
  constructor(ctx, docId, ydoc = new Y.Doc()) {
    this.ctx = ctx;
    this.docId = docId;
    this.ydoc = ydoc;
    this.lastSeq = 0; // the server seq up to which everything has been applied
    this.ahead = new Map(); // seq → live-pushed update waiting for the ones before it (see push)
    this.gapTimer = null;
    this.snapshotSeq = 0; // covers_seq of the newest snapshot we know of
    this.bytesSinceSnapshot = 0; // ciphertext of updates newer than that snapshot
    this.snapshotBytes = 0;
    this.tooLarge = false; // the server refused an upload as too large: wait for the next edit
    this.oversize = false; // the whole note is too big to snapshot
    this.debounce = null;
    this.maxWait = null;
    this.flushing = null;
    this.retryMs = 1000;
    this.closed = false;
    this.shadow = new Y.Doc();
    this.remembered = null; // Map<clientID, clock> — highest server-confirmed state seen on this device
    this.rollbackReported = false;
    this.onUpdate = (update, origin) => {
      if (origin === REMOTE) return;
      this.enqueue(update);
    };
    ydoc.on('update', this.onUpdate);
  }

  status(s) {
    // A note too big to compact still saves; keep saying so instead of "saved".
    this.ctx.onStatus?.(this.docId, s === 'saved' && this.oversize ? 'too-large' : s);
  }

  /** Largest blob the server takes, and the size to batch uploads to (half, leaving room). */
  get maxBlob() {
    return this.ctx.maxBlobBytes || DEFAULT_MAX_BLOB;
  }

  // ---- where the doc lives, and its keys (a shared note overrides these: sharesync.js) ----

  /**
   * Encrypt for upload ('update', 'snapshot': signed) or for this device's own
   * storage ('outbox', 'cache': only ever decrypted here, so not signed).
   */
  async seal(kind, bytes, coversSeq = 0) {
    const { accountId, identity, keyring } = this.ctx;
    const kv = keyring.current;
    const key = await keyring.docKey(kv, this.docId);
    const { nonce, ciphertext } = await encrypt(key, bytes, blobAad(accountId, this.docId, kind, kv));
    if (kind === 'outbox' || kind === 'cache') return { key_version: kv, nonce: b64(nonce), ciphertext: b64(ciphertext) };
    const sig = await sign(identity.signKey, blobMsg(accountId, this.docId, kind, kv, coversSeq, nonce, ciphertext));
    return { key_version: kv, covers_seq: coversSeq, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: b64(sig) };
  }

  async open(kind, blob) {
    return openBlob(this.ctx, this.docId, kind, blob);
  }

  /** The server's state after `after` (GET /docs/{id}). */
  fetchSince(after) {
    return this.ctx.api.get(`/docs/${this.docId}?after=${after}`);
  }

  /** GET something of this doc's (a shared note's need its read token: sharesync.js). */
  getJSON(path) {
    return this.ctx.api.get(path);
  }

  /** Where uploads go: kind 'updates' or 'snapshots'. */
  uploadPath(kind) {
    return `/docs/${this.docId}/${kind}`;
  }

  /** What live.js subscribes with. */
  liveSubscription() {
    return { sub: this.docId };
  }

  /** Whether edits can be saved (false for a note opened with a read-only link). */
  get writable() {
    return true;
  }

  // ---- inbound ----

  applyRemote(bytes) {
    const length = this.ydoc.getText('body').length;
    Y.applyUpdate(this.ydoc, bytes, REMOTE);
    // Most of the note just went (see keepWiped): the shadow, not updated yet, still has it.
    const left = this.ydoc.getText('body').length;
    const wiped = this.keepsHistory && length - left >= WIPE_CHARS && left <= length / 2;
    const before = wiped ? this.shadow.getText('body').toString() : null;
    Y.applyUpdate(this.shadow, bytes);
    if (before) this.keepWiped(before);
  }

  /** Fetch and apply everything after lastSeq. Throws if the server returns data we cannot decrypt. */
  async pull() {
    const r = await this.fetchSince(this.lastSeq);
    await this.applyServer(r);
    return r;
  }

  /**
   * Apply what the server sent (GET /docs, or the history a live subscription
   * starts with): a snapshot and/or the updates after lastSeq, in order.
   * Inbound data is applied one batch at a time (pulls and live pushes can overlap).
   */
  applyServer(r) {
    return this.inbound(async () => {
      if (r.snapshot) await this.applySnapshot(r.snapshot);
      for (const u of r.updates) await this.applyUpdate(u);
      await this.drainAhead();
      if (r.snapshot || r.updates.length) this.scheduleCache();
      await this.checkRollback();
    });
  }

  /**
   * A live push (live.js): an update is applied when it's the next one, and
   * otherwise held until the ones before it arrive. Updates can come out of
   * order, and applying one before its predecessors would look like the
   * server withholding data (rollback detection). A gap that doesn't fill
   * soon is fetched with a normal pull.
   */
  push(ev) {
    return this.inbound(async () => {
      if (ev.type === 'snapshot') {
        if (ev.covers_seq <= this.snapshotSeq) return;
        await this.applySnapshot(ev);
      } else if (ev.seq <= this.lastSeq) {
        return; // already have it (e.g. our own upload, acknowledged first)
      } else if (ev.seq !== this.lastSeq + 1) {
        this.ahead.set(ev.seq, ev);
        this.gapTimer ??= setTimeout(() => {
          this.gapTimer = null;
          if (this.ahead.size && !this.closed) this.pull().catch(() => {});
        }, GAP_MS);
        return;
      } else {
        await this.applyUpdate(ev);
      }
      await this.drainAhead();
      this.scheduleCache();
      await this.checkRollback();
    });
  }

  inbound(fn) {
    this.receiving = (this.receiving ?? Promise.resolve()).then(fn);
    // A failure (e.g. undecryptable data) is reported to this caller, not to the next one.
    const done = this.receiving;
    this.receiving = done.catch(() => {});
    return done;
  }

  async applySnapshot(s) {
    this.applyRemote(await this.open('snapshot', s));
    this.lastSeq = Math.max(this.lastSeq, s.covers_seq);
    this.snapshotSeq = s.covers_seq;
    this.snapshotBytes = blobBytes(s);
    this.bytesSinceSnapshot = 0;
  }

  async applyUpdate(u) {
    if (u.seq <= this.lastSeq) return;
    this.applyRemote(await this.open('update', u));
    this.lastSeq = u.seq;
    this.bytesSinceSnapshot += blobBytes(u);
  }

  /** Apply held pushes that are now next in line; forget the ones already covered. */
  async drainAhead() {
    for (const seq of this.ahead.keys()) if (seq <= this.lastSeq) this.ahead.delete(seq);
    for (let next = this.ahead.get(this.lastSeq + 1); next; next = this.ahead.get(this.lastSeq + 1)) {
      this.ahead.delete(next.seq);
      await this.applyUpdate(next);
    }
    if (!this.ahead.size) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  // ---- rollback detection ----

  async loadRemembered() {
    if (this.remembered || !this.ctx.seen) return;
    const bytes = await this.ctx.seen.getSV(this.docId);
    this.remembered ??= bytes ? Y.decodeStateVector(bytes) : new Map();
  }

  shadowSV() {
    return Y.decodeStateVector(Y.encodeStateVector(this.shadow));
  }

  /** Compare what the server has delivered against what this device has seen it confirm before. */
  async checkRollback() {
    if (!this.ctx.seen) return;
    await this.loadRemembered();
    const have = this.shadowSV();
    const missing = [];
    for (const [client, expected] of this.remembered) {
      const got = have.get(client) ?? 0;
      if (got < expected) missing.push({ client, expected, got });
    }
    // Updates that reference content the server never sent stay pending.
    const store = this.shadow.store;
    const incomplete = store.pendingStructs !== null || store.pendingDs !== null;
    if ((missing.length || incomplete) && !this.rollbackReported) {
      this.rollbackReported = true;
      this.ctx.onRollback?.(this.docId, { missing, incomplete, sync: this, current: Y.encodeStateVector(have) });
    }
    this.remember(have);
  }

  /** Raise the remembered state vector (never lowers it) and persist if it changed. */
  remember(sv) {
    if (!this.ctx.seen || !this.remembered) return;
    let changed = false;
    for (const [client, clock] of sv) {
      if ((this.remembered.get(client) ?? 0) < clock) {
        this.remembered.set(client, clock);
        changed = true;
      }
    }
    if (changed) this.persistRemembered();
  }

  persistRemembered() {
    const bytes = Y.encodeStateVector(this.remembered);
    this.persisting = (this.persisting ?? Promise.resolve())
      .then(() => this.ctx.seen.setSV(this.docId, bytes))
      .catch((e) => console.warn('could not store sync state', e));
    return this.persisting;
  }

  /** The user acknowledged a rollback: treat what the server has now as the baseline. */
  acceptServerState() {
    this.remembered = this.shadowSV();
    this.rollbackReported = false;
    return this.persistRemembered();
  }

  /** Server confirmed it stored `bytes`: count them as server state. */
  async confirmed(bytes) {
    Y.applyUpdate(this.shadow, bytes);
    await this.loadRemembered();
    this.remember(this.shadowSV());
  }

  /** Initial load: what this device has, then the server's state. */
  async load() {
    await this.loadLocal();
    await this.loadRemote();
  }

  /**
   * What this device already has, without the network: the offline copy and
   * edits still waiting in the outbox. Fast (IndexedDB only), so a note can be
   * shown at once. Returns whether there was anything.
   */
  async loadLocal() {
    const cached = await this.readCache();
    const pending = await this.ctx.outbox.list(this.docId);
    for (const { record } of pending) Y.applyUpdate(this.ydoc, await this.open('outbox', record), REMOTE);
    return cached || pending.length > 0;
  }

  /**
   * The server's state (fine to run while the doc is already shown and being
   * edited: it merges in). Then upload anything pending, or compact.
   */
  async loadRemote() {
    let online = true;
    try {
      await this.pull();
    } catch (e) {
      if (!isOffline(e)) throw e;
      this.status('offline');
      online = false;
    }
    if (await this.hasPending()) this.schedule(0);
    else if (online) this.maybeCompact();
  }

  // ---- outbound (autosave) ----

  enqueue(update) {
    if (!this.writable) return; // a read-only link: nothing to save (the editor doesn't allow edits)
    this.firstEdit();
    this.tooLarge = false; // a new edit: worth trying again
    this.status('saving');
    // Chain so records land in the outbox in edit order, and flush can wait for them.
    this.enqueued = (this.enqueued ?? Promise.resolve())
      .then(async () => this.ctx.outbox.add(this.docId, await this.seal('outbox', update)))
      .catch((e) => (console.error('could not store edit', e), this.status('error')));
    this.schedule();
    return this.enqueued;
  }

  schedule(delay = DEBOUNCE_MS) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), delay);
    this.maxWait ??= setTimeout(() => this.flush(), MAX_WAIT_MS);
  }

  /**
   * Upload pending outbox records, merged into as few encrypted updates as
   * fit the server's blob limit (several for a big paste or a long offline
   * session).
   */
  flush({ keepalive = false } = {}) {
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    this.debounce = this.maxWait = null;
    // Serialize flushes; a second call chains after the running one.
    this.flushing = (this.flushing ?? Promise.resolve()).then(() => this.lockedFlush(keepalive));
    return this.flushing;
  }

  /**
   * One tab at a time uploads a note's outbox: tabs share it (IndexedDB), and
   * each would otherwise post the same edits. A keepalive flush (the tab is
   * closing) doesn't wait: if another tab holds the lock, it's uploading them.
   */
  lockedFlush(keepalive) {
    const locks = globalThis.navigator?.locks;
    if (!locks) return this.flushOnce(keepalive);
    return locks.request(`tiro-flush:${this.ctx.accountId}:${this.docId}`, keepalive ? { ifAvailable: true } : {},
      (lock) => (lock ? this.flushOnce(keepalive) : undefined));
  }

  async flushOnce(keepalive) {
    await this.enqueued;
    const pending = await this.ctx.outbox.list(this.docId);
    if (!pending.length) {
      if (!this.closed) this.status('saved');
      return;
    }
    if (this.tooLarge) return; // the server refused it; retrying can't help until the note changes
    if (this.gone) return; // the note moved (shared) or was deleted for good: see onGone below
    try {
      const updates = await Promise.all(pending.map(({ record }) => this.open('outbox', record)));
      for (const batch of batches(pending, updates, this.maxBlob / 2)) {
        const merged = batch.updates.length === 1 ? batch.updates[0] : Y.mergeUpdates(batch.updates);
        if (merged.length > this.maxBlob - 1024) throw new ApiError(413, 'blob too large');
        // Closing the tab: browsers only send small keepalive requests; the rest waits for next time.
        if (keepalive && merged.length > KEEPALIVE_MAX) break;
        const body = await this.seal('update', merged);
        delete body.covers_seq;
        const r = await this.ctx.api.post(this.uploadPath('updates'), body, { keepalive });
        await this.ctx.outbox.remove(batch.ids);
        await this.confirmed(merged);
        this.bytesSinceSnapshot += blobBytes(body);
        // Directly after what we've pulled: count it as seen, so this device compacts too.
        if (r?.seq === this.lastSeq + 1) this.lastSeq = r.seq;
      }
      this.scheduleCache();
      this.retryMs = 1000;
      this.versionAfterSave();
      const more = (await this.ctx.outbox.list(this.docId)).length;
      if (more && !keepalive) this.schedule(0);
      else if (!more) this.status('saved');
      this.maybeCompact();
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        // This doc takes no more writes (#119): the note was shared (its text
        // moved to the share) or deleted for good. The edits stay in the
        // outbox; the app moves them to the note's new home, or drops them.
        this.gone = true;
        this.ctx.onGone?.(this.docId);
        return;
      }
      if (e instanceof ApiError && e.status === 507) this.status('full');
      else if (e instanceof ApiError && e.status === 413) {
        // Too big for the server even on its own (a huge single edit). Keep it
        // in the outbox, say so, and stop retrying until the note changes.
        this.tooLarge = true;
        this.ctx.onStatus?.(this.docId, 'too-large');
        return;
      } else if (isOffline(e)) this.status('offline');
      else if (e instanceof ApiError && e.status === 401) {
        // Signing in again failed too: the phrase was changed on another device.
        this.status('error');
        this.ctx.onSessionEnded?.();
      }
      else {
        console.error('save failed', e);
        this.status('error');
      }
      // Data is safe in the outbox; try again later.
      if (!this.closed) {
        this.retryTimer = setTimeout(() => this.flush(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
      }
    }
  }

  async hasPending() {
    return (await this.ctx.outbox.list(this.docId)).length > 0;
  }

  // ---- history (#60, see history.js) ----

  /** Whether this doc keeps versions: notes do (shared ones too, with an edit link); the note list doesn't. */
  get keepsHistory() {
    return this.docId !== 'index' && this.writable;
  }

  get versionEvery() {
    return this.ctx.versionEverySecs || VERSION_EVERY_SECS;
  }

  /**
   * The first local edit this session: if the last version is older than the
   * interval, save the note as it was before it (the server-confirmed text:
   * the edit isn't in it yet). In the background; a failure just means no
   * version this time.
   */
  firstEdit() {
    if (this.editedThisSession || !this.keepsHistory) return;
    this.editedThisSession = true;
    const before = this.shadow.getText('body').toString();
    const now = nowSecs();
    this.versioning = (async () => {
      const [last] = await listVersions(this);
      if (!versionDue(last?.created_at, now, this.versionEvery)) {
        this.lastVersionAt = last.created_at;
        return;
      }
      // (A new, empty note has nothing to keep yet: its first version comes an interval from now.)
      if (before) await saveVersion(this, before, now);
      this.lastVersionAt = now;
      this.lastVersionText = before;
    })().catch((e) => isOffline(e) || e?.status === 410 || console.warn('could not save a version', e));
  }

  /**
   * Someone else's edit just removed most of the note (a slip, or anyone with
   * a shared note's edit link wiping it): keep the text as it was, whatever
   * the interval, so History has it. At most once a minute.
   */
  keepWiped(before) {
    const now = nowSecs();
    if (this.lastWipeKept && now - this.lastWipeKept < 60) return;
    this.lastWipeKept = now;
    this.versioning = (this.versioning ?? Promise.resolve())
      .then(() => saveVersion(this, before, now))
      .catch((e) => isOffline(e) || e?.status === 410 || console.warn('could not keep the note as it was', e));
  }

  /** After an upload: while edits keep coming, a version at most once per interval. */
  versionAfterSave() {
    if (!this.keepsHistory || this.lastVersionAt === undefined) return; // (firstEdit hasn't looked yet)
    const now = nowSecs();
    const text = this.shadow.getText('body').toString();
    if (!text || text === this.lastVersionText || !versionDue(this.lastVersionAt, now, this.versionEvery)) return;
    this.lastVersionAt = now; // (taken: another save meanwhile doesn't make a second)
    this.lastVersionText = text;
    this.versioning = (this.versioning ?? Promise.resolve())
      .then(() => saveVersion(this, text, now))
      .catch((e) => isOffline(e) || e?.status === 410 || console.warn('could not save a version', e));
  }

  // ---- offline copy ----

  /**
   * Apply the copy kept on this device to the doc (not to `shadow`: only the
   * server's own answers count for rollback detection). A copy that can't be
   * opened is ignored; the server's state follows anyway.
   */
  async readCache() {
    const rec = await this.ctx.cache?.get(this.docId).catch(() => null);
    if (!rec) return false;
    try {
      Y.applyUpdate(this.ydoc, await this.open('cache', rec), REMOTE);
      return true;
    } catch (e) {
      console.warn('ignoring unreadable offline copy', this.docId, e);
      return false;
    }
  }

  scheduleCache() {
    if (!this.ctx.cache) return;
    this.cacheDirty = true;
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.writeCache(), CACHE_MS);
  }

  /**
   * Save the server-confirmed state, encrypted with the doc's current key, as
   * this device's offline copy. Edits not yet confirmed are in the outbox,
   * which loading applies on top. (The shadow, not the live doc: an editor's
   * undo manager keeps deleted text alive in the live doc so it can bring it
   * back, and that shouldn't be stored.)
   */
  writeCache() {
    clearTimeout(this.cacheTimer);
    if (!this.ctx.cache || !this.cacheDirty) return this.cacheWriting;
    this.cacheDirty = false;
    const state = Y.encodeStateAsUpdate(this.shadow); // now, before the doc can change or close
    this.cacheWriting = (this.cacheWriting ?? Promise.resolve())
      .then(async () => this.ctx.cache.put(this.docId, { ...(await this.seal('cache', state)), saved_at: Date.now() }))
      .catch((e) => console.warn('could not save offline copy', e));
    return this.cacheWriting;
  }

  // ---- compaction ----

  /**
   * Snapshot once the updates since the last snapshot are many, or big:
   * more than COMPACT_AFTER of them, or more bytes than both COMPACT_BYTES
   * (or half the server's blob limit, if smaller) and the last snapshot. Loading then fetches one blob, not the history.
   */
  async maybeCompact() {
    if (!this.writable) return; // compacting is writing
    if (this.lastSeq <= this.snapshotSeq) return; // nothing new on the server to cover
    const many = this.lastSeq - this.snapshotSeq > COMPACT_AFTER;
    const big = this.bytesSinceSnapshot > Math.max(Math.min(COMPACT_BYTES, this.maxBlob / 2), this.snapshotBytes);
    if (!many && !big) return;
    try {
      await this.snapshot();
    } catch (e) {
      if (e instanceof ApiError && e.status === 413) this.markOversize(true);
      else if (!(e instanceof ApiError && (e.status === 409 || e.status === 410))) console.warn('compaction failed', e);
    }
  }

  /**
   * Upload the server-confirmed state as a snapshot covering everything up to
   * lastSeq. (Local edits not yet confirmed are still in the outbox and upload
   * as later updates. The shadow, not the live doc, so text an undo manager
   * keeps alive for undo isn't stored.)
   */
  async snapshot() {
    const covers = this.lastSeq;
    const state = Y.encodeStateAsUpdate(this.shadow);
    // Too big for one blob: it can't be compacted (edits still save, in batches).
    if (state.length > this.maxBlob - 1024) {
      this.markOversize(true);
      throw new ApiError(413, 'this note is too large to compact');
    }
    this.markOversize(state.length > this.maxBlob * 0.9);
    const body = await this.seal('snapshot', state, covers);
    await this.ctx.api.post(this.uploadPath('snapshots'), body);
    this.snapshotSeq = covers;
    this.snapshotBytes = blobBytes(body);
    this.bytesSinceSnapshot = 0;
    await this.confirmed(state);
  }

  /** The note is (nearly) too big for one blob: say so until it shrinks. */
  markOversize(on) {
    if (this.oversize === on) return;
    this.oversize = on;
    if (on) this.ctx.onStatus?.(this.docId, 'too-large');
  }

  close() {
    this.writeCache();
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    clearTimeout(this.gapTimer);
    this.ydoc.off('update', this.onUpdate);
    this.shadow.destroy();
  }
}

/** Size of a blob's ciphertext, from its base64. */
function blobBytes(blob) {
  return Math.floor((blob.ciphertext.length * 3) / 4);
}

/** Group outbox records, in order, into batches whose updates add up to at most `limit` bytes (one record per batch at least). */
function* batches(pending, updates, limit) {
  let batch = { ids: [], updates: [], size: 0 };
  for (let i = 0; i < pending.length; i++) {
    if (batch.ids.length && batch.size + updates[i].length > limit) {
      yield batch;
      batch = { ids: [], updates: [], size: 0 };
    }
    batch.ids.push(pending[i].id);
    batch.updates.push(updates[i]);
    batch.size += updates[i].length;
  }
  if (batch.ids.length) yield batch;
}

/** Decrypt one of a private doc's blobs (an outbox record too) without a DocSync for it. */
export async function openBlob(ctx, docId, kind, blob) {
  const { accountId, keyring } = ctx;
  const key = await keyring.docKey(blob.key_version, docId);
  return decrypt(key, unb64(blob.nonce), unb64(blob.ciphertext), blobAad(accountId, docId, kind, blob.key_version));
}
