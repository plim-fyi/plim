// Sync for a shared note (#70): the same as a private note (outbox, offline
// copy, compaction, live pushes, rollback detection), but at /api/shares/{id},
// sealed with the share's own keys (share.js) instead of the vault's, and
// writable only with an edit link. Its doc ID here is "share:<id>".

import { b64, encrypt } from './crypto.js';
import { ApiError } from './api.js';
import { shareAad } from './sig.js';
import { DocSync } from './sync.js';
import { openShareBlob, readTokenHex, sealShareBlob, signedByEditor } from './share.js';

export class ShareDocSync extends DocSync {
  /** `share` = { id, keys } (keys from share.js: shareKeys or readKeys). onGone(why) when the link stops working. */
  constructor(ctx, share, ydoc, { onGone } = {}) {
    super(ctx, `share:${share.id}`, ydoc);
    this.share = share;
    this.onGone = onGone;
  }

  get writable() {
    return Boolean(this.share.keys.signKey);
  }

  async seal(kind, bytes, coversSeq = 0) {
    const { id, keys } = this.share;
    if (kind === 'outbox' || kind === 'cache') {
      const { nonce, ciphertext } = await encrypt(keys.encKey, bytes, shareAad(id, kind));
      return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
    }
    return sealShareBlob(keys, id, kind, bytes, coversSeq);
  }

  open(kind, blob) {
    return openShareBlob(this.share.keys, this.share.id, kind, blob);
  }

  // Inbound: anything not signed with the share's key (#77) was written
  // without an edit link, so the server shouldn't have taken it. It's
  // skipped, and reported with ctx.onForged(docId).

  async applyUpdate(u) {
    if (u.seq <= this.lastSeq) return;
    if (await signedByEditor(this.share.keys, this.share.id, 'update', u)) return super.applyUpdate(u);
    this.lastSeq = u.seq; // not applied, and not asked for again
    this.forged('update', u.seq);
  }

  async applySnapshot(s) {
    if (await signedByEditor(this.share.keys, this.share.id, 'snapshot', s)) return super.applySnapshot(s);
    this.forged('snapshot', s.covers_seq);
  }

  forged(kind, seq) {
    console.warn(`shared note ${this.share.id}: ${kind} ${seq} isn't signed with the share's key; ignored`);
    this.ctx.onForged?.(this.docId);
  }

  /**
   * Its links turned off (410) or the share gone (404): no more writes either, so nothing is
   * tried again (as a refused upload does). Still thrown: the page says so (#441's cases).
   */
  async fetchSince(after) {
    try {
      return await this.getJSON(`/shares/${this.share.id}/doc?after=${after}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) this.gone = true;
      throw e;
    }
  }

  getJSON(path) {
    return this.ctx.api.request('GET', path, undefined, { headers: { 'x-share-token': readTokenHex(this.share.keys) } });
  }

  /** A version from the server: signed with the share's key, i.e. saved with an edit link? (#77) */
  checkVersion(blob) {
    return signedByEditor(this.share.keys, this.share.id, 'version', blob);
  }

  uploadPath(kind) {
    return `/shares/${this.share.id}/${kind}`;
  }

  liveSubscription() {
    return { sub: this.docId, token: readTokenHex(this.share.keys) };
  }

  /** Live: the link was revoked (or never worked). */
  linkGone(why) {
    this.onGone?.(why);
  }
}
