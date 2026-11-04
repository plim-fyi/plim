// Shared notes: keys, links, and sealing their blobs. Mirrors
// crates/plim-core (share_keys, share_blob_msg, share_aad) byte for byte.
//
// A shared note has a random 32-byte seed. From it (HKDF):
//   encryption key  — the note's updates and snapshots
//   signing key     — Ed25519; the server only accepts writes signed with it
//   read token      — from the encryption key; the server only serves reads to it
// An edit link carries the seed, a read-only link the encryption key and the
// signing key's public half. Both sit after the `#`, which browsers never
// send to the server.
//
// Clients check every update and snapshot is signed with the share's key
// (#77): the server checks too, but a server that didn't could otherwise
// pass off edits from someone with only a read-only link.

import { aesKey, b64, b64url, bytesToHex, decrypt, encrypt, hkdf, importSigningKey, randomBytes, sign, unb64, unb64url, verify } from './crypto.js';
import { holderAad, shareAad, shareBlobMsg } from './sig.js';

export const newShareId = () => bytesToHex(randomBytes(16));
export const newShareSeed = () => randomBytes(32);

/** Everything an edit link gives. */
export async function shareKeys(seed) {
  const encRaw = await hkdf(seed, 'tiro/v1/share-enc');
  const { signKey, pubkey } = await importSigningKey(await hkdf(seed, 'tiro/v1/share-sign'));
  return { ...(await readKeys(encRaw)), signKey, pubkey };
}

/**
 * What a read-only link gives: decrypt, read and check signatures, never
 * write. Links made before #77 have no public key: their signatures go unchecked.
 */
export async function readKeys(encRaw, pubkey = null) {
  return { encRaw, encKey: await aesKey(encRaw), readToken: await hkdf(encRaw, 'tiro/v1/share-read'), signKey: null, pubkey };
}

// ---- links ----


// A share's links are the note's own address (#299: /n/<note id>, noteurl.js) with the key
// after the `#`: `#k=<share id>.e.<seed>` to edit, `#k=<share id>.r.<key>.<pubkey>` to view.
// The address stays the note's whoever opens it and however it's shared; replacing the links
// changes only what's after the `#`. Links made before (#70): `/s/<share id>#e.…` and `#r.…`,
// which keep working.
export const editLink = (origin, noteId, shareId, seed) => `${origin}/n/${noteId}#k=${shareId}.e.${b64url(seed)}`;
/** (Without `pubkey`, only from a read-only link from before #77: what that link was.) */
export const readLink = (origin, noteId, shareId, encRaw, pubkey) =>
  `${origin}/n/${noteId}#k=${shareId}.r.${b64url(encRaw)}${pubkey ? `.${b64url(pubkey)}` : ''}`;

/** The key part of a link's fragment: `e.<seed>`, or `r.<key>.<pubkey>` (`r.<key>` before #77). */
export const LINK_FRAGMENT = /^([er])\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{43}))?$/;
/** A link on the note's address: its fragment is `k=<share id>.` and then the key part. */
const KEYED_FRAGMENT = /^k=([0-9a-f]{32})\.(.+)$/;
const NOTE_ID = /^\/n\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * A link's path and fragment → { shareId, noteId, mode: 'edit' | 'read', secret, pubkey },
 * or null if it isn't a complete share link. `noteId` is the note's address's (null from a
 * link made before #299); `pubkey` is null for an edit link (the seed gives it) and for a
 * read-only link from before #77.
 */
export function parseShareLink(pathname, hash) {
  if (!hash.startsWith('#')) return null;
  let id, noteId = null, frag = hash.slice(1);
  const keyed = frag.match(KEYED_FRAGMENT);
  if (keyed) {
    noteId = pathname.match(NOTE_ID)?.[1].toLowerCase();
    if (!noteId) return null;
    [, id, frag] = keyed;
  } else id = pathname.match(/^\/s\/([0-9a-f]{32})\/?$/)?.[1];
  const m = frag.match(LINK_FRAGMENT);
  if (!id || !m || (m[1] === 'e' && m[3])) return null;
  let secret, pubkey;
  try {
    secret = unb64url(m[2]);
    pubkey = m[3] ? unb64url(m[3]) : null;
  } catch {
    return null;
  }
  if (secret.length !== 32 || (pubkey && pubkey.length !== 32)) return null;
  return { shareId: id, noteId, mode: m[1] === 'e' ? 'edit' : 'read', secret, pubkey };
}

/** A link's fragment as the guest page (/s/<share id>) takes it: the key part alone, after the `#`. */
export const guestPath = (link, hash) => `/s/${link.shareId}#${hash.slice(1).replace(KEYED_FRAGMENT, '$2')}`;

/** Keys from a parsed link. */
export const keysFromLink = (link) => (link.mode === 'edit' ? shareKeys(link.secret) : readKeys(link.secret, link.pubkey));

// ---- blobs ----

/** Encrypt and sign an update or snapshot for POST /api/shares/{id}/updates|snapshots. */
export async function sealShareBlob(keys, shareId, kind, bytes, coversSeq = 0) {
  if (!keys.signKey) throw new Error('read-only link: this note can’t be changed');
  const { nonce, ciphertext } = await encrypt(keys.encKey, bytes, shareAad(shareId, kind));
  const sig = await sign(keys.signKey, shareBlobMsg(shareId, kind, coversSeq, nonce, ciphertext));
  return { covers_seq: coversSeq, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: b64(sig) };
}

export async function openShareBlob(keys, shareId, kind, blob) {
  return decrypt(keys.encKey, unb64(blob.nonce), unb64(blob.ciphertext), shareAad(shareId, kind));
}

/**
 * Whether an update or snapshot from the server was signed with the share's
 * key, i.e. written with an edit link. True when there's no key to check with
 * (a read-only link from before #77).
 */
export async function signedByEditor(keys, shareId, kind, blob) {
  if (!keys.pubkey) return true;
  if (typeof blob.sig !== 'string') return false;
  try {
    const coversSeq = kind === 'snapshot' ? blob.covers_seq : kind === 'version' ? blob.created_at : 0;
    return await verify(keys.pubkey, shareBlobMsg(shareId, kind, coversSeq, unb64(blob.nonce), unb64(blob.ciphertext)), unb64(blob.sig));
  } catch {
    return false; // malformed
  }
}

/** The read token as the server wants it (hex), and what it stores (SHA-256). */
export const readTokenHex = (keys) => bytesToHex(keys.readToken);

// ---- holders (#369): a share's keys held by more than one link ----
// Mirrors plim-core's holder_keys, seal_held_keys and open_held_keys byte for byte.
//
// A holder has a random 32-byte secret, carried by its link: the note's address with
// `#h=<holder id>.<secret>`. From the secret come the token the server serves the holder's
// row to, and the key that row's copy of the share's keys is sealed with. The row points at
// the note's current share: replacing the links makes a new share and re-seals its keys for
// each holder kept, so their links keep working; a holder taken away gets nothing.

export const newHolderId = () => bytesToHex(randomBytes(16));
export const newHolderSecret = () => randomBytes(32);

export async function holderKeys(secret) {
  return { token: await hkdf(secret, 'tiro/v1/holder-token'), sealKey: await aesKey(await hkdf(secret, 'tiro/v1/holder-seal')) };
}

/** The token as the server wants it (hex); it keeps its SHA-256. */
export const holderTokenHex = (hk) => bytesToHex(hk.token);

/**
 * The share's keys sealed for a holder: `{ mode: 'edit', seed }` (everything), or
 * `{ mode: 'read', encRaw, pubkey }` (as a view link has). A role byte, `e` or `r`, then the keys.
 */
export async function sealHeldKeys(hk, holderId, shareId, held) {
  const bytes = held.mode === 'edit'
    ? new Uint8Array([0x65, ...held.seed])
    : new Uint8Array([0x72, ...held.encRaw, ...held.pubkey]);
  const { nonce, ciphertext } = await encrypt(hk.sealKey, bytes, holderAad(holderId, shareId));
  return { role: held.mode, nonce: b64(nonce), ciphertext: b64(ciphertext) };
}

/** What a holder's row holds, opened: `{ mode: 'edit', seed }` or `{ mode: 'read', encRaw, pubkey }`. */
export async function openHeldKeys(hk, holderId, shareId, row) {
  const b = await decrypt(hk.sealKey, unb64(row.nonce), unb64(row.ciphertext), holderAad(holderId, shareId));
  if (b[0] === 0x65 && b.length === 33) return { mode: 'edit', seed: b.slice(1) };
  if (b[0] === 0x72 && b.length === 65) return { mode: 'read', encRaw: b.slice(1, 33), pubkey: b.slice(33) };
  throw new Error('the held keys are malformed');
}

/** The share's keys from what a holder's row held, as from a link of that kind. */
export const keysFromHeld = (held) => (held.mode === 'edit' ? shareKeys(held.seed) : readKeys(held.encRaw, held.pubkey));

export const holderLink = (origin, noteId, holderId, secret) => `${origin}/n/${noteId}#h=${holderId}.${b64url(secret)}`;
const HOLDER_FRAGMENT = /^h=([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

/**
 * A holder's link → { holderId, noteId, secret }, or null if it isn't one. On the note's
 * address (`noteId`), or as the guest page takes it, `/s/<holder id>#h=…` (`noteId` null).
 */
export function parseHolderLink(pathname, hash) {
  const m = hash.startsWith('#') ? hash.slice(1).match(HOLDER_FRAGMENT) : null;
  if (!m) return null;
  const noteId = pathname.match(NOTE_ID)?.[1].toLowerCase() ?? null;
  if (!noteId && pathname.replace(/\/$/, '') !== `/s/${m[1]}`) return null;
  let secret;
  try {
    secret = unb64url(m[2]);
  } catch {
    return null;
  }
  return secret.length === 32 ? { holderId: m[1], noteId, secret } : null;
}

/** A holder's link as the guest page takes it: /s/<holder id>, the same fragment. */
export const holderGuestPath = (link, hash) => `/s/${link.holderId}${hash}`;

/**
 * What a holder's link opens now: its row fetched with its token (`api.request` as api.js
 * has it), its keys opened → { shareId, mode, keys, held }. Throws the request's error: 404
 * (no such holder, or the wrong secret), 410 (the share turned off or gone).
 */
export async function resolveHolder(api, link) {
  const hk = await holderKeys(link.secret);
  const row = await api.request('GET', `/holders/${link.holderId}`, undefined, { headers: { 'x-holder-token': holderTokenHex(hk) } });
  const held = await openHeldKeys(hk, link.holderId, row.share_id, row);
  return { shareId: row.share_id, mode: held.mode, keys: await keysFromHeld(held), held };
}
