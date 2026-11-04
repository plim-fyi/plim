// Canonical message encoding — MUST match server/src/sig.rs.
// Each field is a u32 big-endian length followed by its bytes; the first
// field is always a domain tag. Integers are 8-byte big-endian.

export const TAG = {
  auth: 'tiro/v1/auth',
  blob: 'tiro/v1/blob',
  keyring: 'tiro/v1/keyring',
  keyringAad: 'tiro/v1/keyring-aad',
  blobAad: 'tiro/v1/blob-aad',
  rotateOld: 'tiro/v1/rotate-old',
  rotateNew: 'tiro/v1/rotate-new',
  shareBlob: 'tiro/v1/share-blob',
  shareAad: 'tiro/v1/share-aad',
  holderAad: 'tiro/v1/holder-aad',
  deleteAccount: 'tiro/v1/delete-account',
  action: 'tiro/v1/action',
};

const te = new TextEncoder();

export function u64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

/** encode(tag, ...fields) — fields are strings, numbers (u64) or Uint8Arrays. */
export function encode(tag, ...fields) {
  const parts = [tag, ...fields].map((f) =>
    typeof f === 'string' ? te.encode(f) : typeof f === 'number' ? u64(f) : f,
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const dv = new DataView(out.buffer);
  let off = 0;
  for (const p of parts) {
    dv.setUint32(off, p.length);
    out.set(p, off + 4);
    off += 4 + p.length;
  }
  return out;
}

export const blobMsg = (accountId, docId, kind, keyVersion, coversSeq, nonce, ciphertext) =>
  encode(TAG.blob, accountId, docId, kind, keyVersion, coversSeq, nonce, ciphertext);

export const blobAad = (accountId, docId, kind, keyVersion) =>
  encode(TAG.blobAad, accountId, docId, kind, keyVersion);

export const keyringMsg = (accountId, keyVersion, nonce, wrapped) =>
  encode(TAG.keyring, accountId, keyVersion, nonce, wrapped);

export const keyringAad = (accountId, keyVersion) => encode(TAG.keyringAad, accountId, keyVersion);

export const authMsg = (nonce, pubkeyHash) => encode(TAG.auth, nonce, pubkeyHash);

/** A shared note's update or snapshot, as signed with the share's own key. */
export const shareBlobMsg = (shareId, kind, coversSeq, nonce, ciphertext) =>
  encode(TAG.shareBlob, shareId, kind, coversSeq, nonce, ciphertext);

export const shareAad = (shareId, kind) => encode(TAG.shareAad, shareId, kind);
/** Binds a holder's sealed copy of a share's keys (#369) to the holder and the share. */
export const holderAad = (holderId, shareId) => encode(TAG.holderAad, holderId, shareId);

export const rotateMsg = (tag, accountId, newPubkey) => encode(tag, accountId, newPubkey);
/** Deleting the account: its key over a fresh challenge's nonce (a session alone can't). */
export const deleteAccountMsg = (accountId, nonce) => encode(TAG.deleteAccount, accountId, nonce);

/**
 * What can't be undone, or locks something out (#144): deleting a note or a share, turning a
 * share's links off, closing or reopening a note to writes, replacing or removing a passkey's
 * copy. Signed with the account's key over a fresh challenge, naming the action (ACTION) and
 * what it's done to, so a session alone can't do it. `data`: what it puts there, if anything
 * (a passkey's copy: its nonce, then its ciphertext). As plim-core's action_msg.
 */
export const actionMsg = (accountId, action, target, nonce, data = new Uint8Array(0)) =>
  encode(TAG.action, accountId, action, target, nonce, data);

export const ACTION = {
  deleteDoc: 'delete-doc',
  closeDoc: 'close-doc',
  reopenDoc: 'reopen-doc',
  deleteShare: 'delete-share',
  revokeShare: 'revoke-share',
  putPasskey: 'put-passkey',
  deletePasskey: 'delete-passkey',
  restoreDoc: 'restore-doc', // (a note's or share's data, deleted, back from the trash: #253)
  restoreShare: 'restore-share',
  deleteHolder: 'delete-holder', // (a link of someone's own taken back, #369)
  revokeConnection: 'revoke-connection', // (an app connected to your notes, turned off, #369)
  deleteConnection: 'delete-connection',
  forgetHistory: 'forget-history', // (a note's versions before a time, deleted for good: target its doc or share, data the time)
};
