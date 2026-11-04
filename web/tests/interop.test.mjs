// Interop with the Rust client (plim-core): data, holders, connections.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from '../vendor/yjs.mjs';
import { mnemonicToSeed } from '../core/bip39.js';
import { b64, bytesToHex, decrypt, deriveDocKey, deriveIdentity, encrypt, hexToBytes, sign, unb64, unwrapVaultKey, verify, wrapVaultKey } from '../core/crypto.js';
import { blobAad, blobMsg, encode, TAG } from '../core/sig.js';
import { holderKeys, holderLink, holderTokenHex, keysFromHeld, newHolderId, newHolderSecret, newShareId, newShareSeed, openHeldKeys, parseHolderLink, parseShareLink, sealHeldKeys, shareKeys } from '../core/share.js';
import { connectionHolderSecret, connectionKeys } from '../core/connection.js';
import { here, test } from './lib.mjs';

const INTEROP_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('interop: JS opens data sealed by the Rust client', async () => {
  const fx = JSON.parse(readFileSync(new URL('fixtures/interop-rust.json', here)));
  const identity = await deriveIdentity(await mnemonicToSeed(INTEROP_PHRASE));
  // Same phrase → same identity in both implementations.
  assert.equal(identity.pubkeyHash, fx.pubkey_hash);
  const vaultKey = await unwrapVaultKey(identity, fx.account_id, fx.keyring);
  assert.equal(bytesToHex(vaultKey), fx.vault_key);
  assert.ok(await verify(identity.pubkey, encode(TAG.keyring, fx.account_id, 1, unb64(fx.keyring.nonce), unb64(fx.keyring.wrapped)), unb64(fx.keyring.sig)));
  const u = fx.update;
  const msg = blobMsg(fx.account_id, fx.doc_id, 'update', u.key_version, 0, unb64(u.nonce), unb64(u.ciphertext));
  assert.ok(await verify(identity.pubkey, msg, unb64(u.sig)));
  const bytes = await decrypt(await deriveDocKey(vaultKey, fx.doc_id), unb64(u.nonce), unb64(u.ciphertext), blobAad(fx.account_id, fx.doc_id, 'update', u.key_version));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  assert.equal(doc.getText('body').toString(), fx.text);
  assert.equal(doc.getMap('notes').get('n1').get('title'), fx.title);
});

test('interop: JS opens a holder\'s keys sealed by the Rust client, and derives the same token', async () => {
  const { holder: fx } = JSON.parse(readFileSync(new URL('fixtures/interop-rust.json', here)));
  const hk = await holderKeys(hexToBytes(fx.secret));
  assert.equal(holderTokenHex(hk), fx.token);
  const edit = await openHeldKeys(hk, fx.edit.holder_id, fx.share_id, fx.edit);
  assert.equal(edit.mode, 'edit');
  assert.equal(bytesToHex(edit.seed), fx.share_seed);
  const read = await openHeldKeys(hk, fx.read.holder_id, fx.share_id, fx.read);
  const sk = await shareKeys(hexToBytes(fx.share_seed));
  assert.equal(read.mode, 'read');
  assert.equal(bytesToHex(read.encRaw), bytesToHex(sk.encRaw));
  assert.equal(bytesToHex(read.pubkey), bytesToHex(sk.pubkey));
  // What a holder's row gives is a share's keys, as from a link of that kind.
  assert.equal(bytesToHex((await keysFromHeld(edit)).readToken), bytesToHex(sk.readToken));
  assert.equal((await keysFromHeld(read)).signKey, null);
  // Sealed to that holder and share only.
  await assert.rejects(openHeldKeys(hk, fx.read.holder_id, fx.share_id, fx.edit));
  await assert.rejects(openHeldKeys(hk, fx.edit.holder_id, 'ffffffffffffffffffffffffffffffff', fx.edit));
  await assert.rejects(openHeldKeys(await holderKeys(new Uint8Array(32).fill(1)), fx.edit.holder_id, fx.share_id, fx.edit));
});

test('interop: a connection\'s keys from its secret match the Rust client\'s', async () => {
  const { connection: fx } = JSON.parse(readFileSync(new URL('fixtures/interop-rust.json', here)));
  const secret = hexToBytes(fx.secret);
  const k = await connectionKeys(secret);
  assert.equal(bytesToHex(k.pubkey), fx.pubkey);
  assert.equal(k.pubkeyHash, fx.pubkey_hash);
  assert.equal(k.listHolderId, fx.list_holder_id);
  assert.equal(bytesToHex(k.listHolderSecret), fx.list_holder_secret);
  assert.equal(bytesToHex(await connectionHolderSecret(secret, fx.holder_id)), fx.holder_secret);
  // It signs as a connection does: the Rust side checks the public key it registered.
  const msg = new TextEncoder().encode('hello');
  assert.ok(await verify(k.pubkey, msg, await sign(k.signKey, msg)));
});

test('a holder\'s link carries its secret; its keys seal and open; a bad link is none', async () => {
  const secret = newHolderSecret();
  const id = newHolderId();
  const noteId = '3f1c2a9e-0000-4000-8000-000000000001';
  const link = holderLink('https://plim.example', noteId, id, secret);
  const url = new URL(link);
  const parsed = parseHolderLink(url.pathname, url.hash);
  assert.equal(parsed.holderId, id);
  assert.equal(parsed.noteId, noteId);
  assert.equal(bytesToHex(parsed.secret), bytesToHex(secret));
  assert.equal(parseShareLink(url.pathname, url.hash), null, 'a holder link is not a share link');
  assert.equal(parseHolderLink('/s/' + id, url.hash).noteId, null, 'as the guest page takes it: /s/<holder id>, no note id');
  assert.equal(parseHolderLink('/s/' + newHolderId(), url.hash), null, 'not under another id');
  assert.equal(parseHolderLink(url.pathname, '#h=' + id + '.short'), null);
  assert.equal(parseHolderLink(url.pathname, '#k=' + id + '.e.' + url.hash.split('.')[1]), null);
  const hk = await holderKeys(secret);
  const seed = newShareSeed();
  const shareId = newShareId();
  const sealed = await sealHeldKeys(hk, id, shareId, { mode: 'edit', seed });
  assert.equal(sealed.role, 'edit');
  const back = await openHeldKeys(hk, id, shareId, sealed);
  assert.equal(bytesToHex(back.seed), bytesToHex(seed));
  const sk = await shareKeys(seed);
  const sealedRead = await sealHeldKeys(hk, id, shareId, { mode: 'read', encRaw: sk.encRaw, pubkey: sk.pubkey });
  assert.equal(sealedRead.role, 'read');
  const backRead = await openHeldKeys(hk, id, shareId, sealedRead);
  assert.equal(bytesToHex(backRead.encRaw), bytesToHex(sk.encRaw));
  assert.equal(bytesToHex(backRead.pubkey), bytesToHex(sk.pubkey));
});

export async function makeInteropFixture() {
  const identity = await deriveIdentity(await mnemonicToSeed(INTEROP_PHRASE));
  const accountId = 'aabbccddeeff00112233445566778899';
  const docId = '3f1c2a9e-0000-4000-8000-000000000001';
  const vaultKey = new Uint8Array(32).fill(0x11);
  const doc = new Y.Doc();
  doc.getText('body').insert(0, 'hello from JS — ünïcödé ✓');
  doc.getMap('notes').set('n1', new Y.Map([['title', 'JS title'], ['deleted', false]]));
  const { nonce, ciphertext } = await encrypt(await deriveDocKey(vaultKey, docId), Y.encodeStateAsUpdate(doc), blobAad(accountId, docId, 'update', 1));
  // A holder's keys sealed here (#369): the Rust client must open them.
  const holderSecret = new Uint8Array(32).fill(0x33);
  const hk = await holderKeys(holderSecret);
  const shareSeed = new Uint8Array(32).fill(0x44);
  const sk = await shareKeys(shareSeed);
  const shareId = 'ffeeddccbbaa99887766554433221100';
  const editHolder = 'abcdefabcdefabcdefabcdefabcdefab';
  const readHolder = '0000000011111111222222223333333a';
  const holder = {
    secret: bytesToHex(holderSecret),
    token: holderTokenHex(hk),
    share_id: shareId,
    share_seed: bytesToHex(shareSeed),
    edit: { holder_id: editHolder, ...(await sealHeldKeys(hk, editHolder, shareId, { mode: 'edit', seed: shareSeed })) },
    read: { holder_id: readHolder, ...(await sealHeldKeys(hk, readHolder, shareId, { mode: 'read', encRaw: sk.encRaw, pubkey: sk.pubkey })) },
  };
  const connSecret = new Uint8Array(32).fill(0x66);
  const ck = await connectionKeys(connSecret);
  const connection = {
    secret: bytesToHex(connSecret), pubkey: bytesToHex(ck.pubkey), pubkey_hash: ck.pubkeyHash,
    list_holder_id: ck.listHolderId, list_holder_secret: bytesToHex(ck.listHolderSecret),
    holder_id: editHolder, holder_secret: bytesToHex(await connectionHolderSecret(connSecret, editHolder)),
  };
  return {
    connection,
    holder,
    phrase: INTEROP_PHRASE,
    pubkey_hash: identity.pubkeyHash,
    account_id: accountId,
    doc_id: docId,
    vault_key: bytesToHex(vaultKey),
    keyring: await wrapVaultKey(identity, accountId, 1, vaultKey),
    update: { key_version: 1, nonce: b64(nonce), ciphertext: b64(ciphertext) },
    text: doc.getText('body').toString(),
    title: 'JS title',
  };
}
