// Shared notes: keys, links, blobs, sync, and who else is in a note (share.js, sharesync.js, presence.js, names.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from '../vendor/yjs.mjs';
import { b64, bytesToHex, encrypt, hexToBytes, sign, unb64, verify } from '../core/crypto.js';
import { ShareDocSync } from '../core/sharesync.js';
import { MemoryDocCache, MemoryOutbox } from '../core/vault.js';
import { shareAad, shareBlobMsg } from '../core/sig.js';
import { editLink, guestPath, keysFromLink, newShareId, newShareSeed, openShareBlob, parseShareLink, readKeys, readLink, sealShareBlob, shareKeys, signedByEditor } from '../core/share.js';
import { NAMES, fallbackName } from '../core/names.js';
import { cleanState, cleanUpdate } from '../core/presence.js';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from '../vendor/codemirror.mjs';
import { here, test, text, FakeShareServer } from './lib.mjs';

test('share keys match the Rust vectors (plim-core share_keys)', async () => {
  const v = JSON.parse(readFileSync(new URL('fixtures/share-vectors.json', here)));
  const k = await shareKeys(hexToBytes(v.seed));
  assert.equal(bytesToHex(k.encRaw), v.enc_key);
  assert.equal(bytesToHex(k.pubkey), v.pubkey);
  assert.equal(bytesToHex(k.readToken), v.read_token);
  const msg = shareBlobMsg(v.share_id, 'update', 0, new Uint8Array(12).fill(1), new TextEncoder().encode('ciphertext'));
  assert.equal(bytesToHex(msg), v.blob_msg);
  assert.equal(bytesToHex(await sign(k.signKey, msg)), v.blob_sig);
  assert.equal(bytesToHex(shareAad(v.share_id, 'snapshot')), v.aad);
  // A read-only link derives the same read token from the encryption key alone.
  assert.equal(bytesToHex((await readKeys(k.encRaw)).readToken), v.read_token);
});

test('presence from others is cleaned before the editor sees it', () => {
  // A real one survives as it was (what y-codemirror sends).
  const doc = new Y.Doc();
  doc.getText('body').insert(0, 'hello');
  const cursor = { anchor: Y.createRelativePositionFromTypeIndex(doc.getText('body'), 2), head: Y.createRelativePositionFromTypeIndex(doc.getText('body'), 5) };
  const real = { user: { name: 'Ada', color: 'c3', colorLight: 'c3', viewing: false }, cursor: JSON.parse(JSON.stringify(cursor)) };
  const sender = new Awareness(new Y.Doc());
  sender.setLocalState(real);
  const receiver = new Awareness(new Y.Doc());
  applyAwarenessUpdate(receiver, cleanUpdate(encodeAwarenessUpdate(sender, [sender.clientID])), 'remote');
  assert.deepEqual(receiver.getStates().get(sender.clientID), real);
  // Leaving (null) still works.
  sender.setLocalState(null);
  applyAwarenessUpdate(receiver, cleanUpdate(encodeAwarenessUpdate(sender, [sender.clientID])), 'remote');
  assert.equal(receiver.getStates().has(sender.clientID), false);
  [sender, receiver].forEach((a) => a.destroy());

  // Anything else is cut down to what's usable.
  assert.deepEqual(cleanState({ user: { name: 'x'.repeat(100), color: '" onmouseover="alert(1)', viewing: 'yes' } }),
    { user: { name: 'x'.repeat(40), color: 'c0', colorLight: 'c0', viewing: false } });
  assert.equal(cleanState({ user: { name: 'B' }, cursor: { anchor: { item: 5 }, head: 'nope' } }).cursor, undefined);
  assert.equal(cleanState({ user: { name: 'B' }, cursor: { anchor: null, head: { tname: 'body' } } }).cursor, undefined);
  assert.equal(cleanState({ user: { name: 'B' }, cursor: { anchor: { item: { client: -1, clock: 0 } }, head: { tname: 'body' } } }).cursor, undefined);
  assert.deepEqual(cleanState({ user: { name: 'B' }, cursor: { anchor: { tname: 'body', extra: 1 }, head: { item: { client: 1, clock: 2, x: 3 }, assoc: -1 } } }).cursor,
    { anchor: { type: null, tname: 'body', item: null, assoc: 0 }, head: { type: null, tname: null, item: { client: 1, clock: 2 }, assoc: -1 } });
  assert.equal(cleanState({ user: { name: 'B' }, cursor: { anchor: { tname: 'body', item: 'x' }, head: { tname: 'body' } } }).cursor, undefined);
  assert.equal(cleanState({ user: { name: 'B' }, cursor: { anchor: {}, head: { tname: 'body' } } }).cursor, undefined, 'points nowhere');
  assert.deepEqual(cleanState({ user: 'not an object' }), {});
  assert.deepEqual(cleanState(42), {});
  assert.equal(cleanState({ user: { name: 7 } }).user.name, '?');
  // Not an awareness update at all: refused.
  for (const bad of [new Uint8Array([]), new Uint8Array([1, 1, 1, 50, 123]), new Uint8Array([200]), new Uint8Array([100])]) {
    assert.throws(() => cleanUpdate(bad));
  }
});

test('without a name: a Middle-earth character, picked once per device', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const first = fallbackName(storage);
  assert.ok(NAMES.includes(first));
  for (let i = 0; i < 20; i++) assert.equal(fallbackName(storage), first, 'kept');
  store.set('tiro-fallback-name', 'Sauron');
  assert.ok(NAMES.includes(fallbackName(storage)), 'only names from the list');
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.ok(NAMES.includes(fallbackName(broken)), 'still a name without storage');
  assert.equal(new Set(NAMES).size, NAMES.length);
  assert.ok(NAMES.every((n) => n.length <= 40), 'fits the name limit');
});

test('share links: on the note’s address (#299), round trip; the ones from before still open; anything incomplete is refused', async () => {
  const id = newShareId();
  const note = '0d4c6f2e-1b7a-4c3d-9e8f-123456789abc';
  const seed = newShareSeed();
  const keys = await shareKeys(seed);
  const edit = new URL(editLink('https://plim.example', note, id, seed));
  const read = new URL(readLink('https://plim.example', note, id, keys.encRaw, keys.pubkey));
  assert.equal(edit.pathname, `/n/${note}`, 'the note’s address');
  assert.ok(edit.hash.startsWith(`#k=${id}.e.`));
  assert.ok(edit.hash.length < 90, 'short enough to paste anywhere');
  assert.ok(read.hash.length < 140);
  const e = parseShareLink(edit.pathname, edit.hash);
  assert.equal(e.mode, 'edit');
  assert.equal(e.shareId, id);
  assert.equal(e.noteId, note);
  assert.deepEqual(e.secret, seed);
  assert.deepEqual((await keysFromLink(e)).pubkey, keys.pubkey);
  // A read-only link carries the public key, to check what the server sends (#77).
  const r = parseShareLink(read.pathname, read.hash);
  assert.equal(r.mode, 'read');
  const rk = await keysFromLink(r);
  assert.deepEqual(rk.readToken, keys.readToken);
  assert.deepEqual(rk.pubkey, keys.pubkey);
  assert.equal(rk.signKey, null);
  // The guest page takes the key part alone, at /s/<share id>.
  assert.equal(guestPath(e, edit.hash), `/s/${id}${edit.hash.replace(`k=${id}.`, '')}`);
  // A link from before #299 (/s/<share id>#e.…) opens the same share, without a note id.
  const old = parseShareLink(`/s/${id}`, edit.hash.replace(`k=${id}.`, ''));
  assert.deepEqual({ ...old, noteId: note }, e);
  assert.equal(guestPath(old, `#e.x`), `/s/${id}#e.x`);
  // One from before #77 still opens, without a key to check with.
  const older = new URL(readLink('https://plim.example', note, id, keys.encRaw));
  assert.equal(older.hash.split('.').length, 3);
  assert.equal((await keysFromLink(parseShareLink(older.pathname, older.hash))).pubkey, null);
  const key = edit.hash.replace(`k=${id}.`, '');
  for (const [path, hash] of [
    [`/n/${note}`, ''], [`/n/${note}`, `#k=${id}.e.short`], [`/n/${note}`, `#k=nothex.${key.slice(1)}`], [`/n/${note}`, key], ['/', edit.hash], [`/s/${id}`, edit.hash],
    [`/n/0d4c6f2e`, edit.hash], [`/n/${note}`, `${edit.hash}.${read.hash.slice(-43)}`], // an edit link has no public key
    [`/s/${id}`, ''], [`/s/${id}`, '#e.short'], [`/s/${id}`, `#x.${key.slice(3)}`], ['/s/nothex', key], ['/', key],
    [`/s/${id}`, `${key}.${read.hash.slice(-43)}`], [`/n/${note}`, `${read.hash}.x`], [`/s/${id}`, key.slice(1)],
  ]) {
    assert.equal(parseShareLink(path, hash), null, `${path}${hash}`);
  }
});

test('share blobs: only ones signed with the share’s key count as written with an edit link', async () => {
  const id = newShareId();
  const edit = await shareKeys(newShareSeed());
  const read = await readKeys(edit.encRaw, edit.pubkey);
  const bytes = new TextEncoder().encode('hello');
  const update = { seq: 4, ...(await sealShareBlob(edit, id, 'update', bytes)) };
  const snapshot = await sealShareBlob(edit, id, 'snapshot', bytes, 7);
  assert.ok(await signedByEditor(read, id, 'update', update));
  assert.ok(await signedByEditor(read, id, 'snapshot', snapshot));
  // What a server could do with only the encryption key (a read-only link): encrypt, not sign.
  const { nonce, ciphertext } = await encrypt(read.encKey, bytes, shareAad(id, 'update'));
  const forged = { seq: 5, nonce: b64(nonce), ciphertext: b64(ciphertext) };
  assert.equal(new TextDecoder().decode(await openShareBlob(read, id, 'update', forged)), 'hello', 'it decrypts fine...');
  assert.equal(await signedByEditor(read, id, 'update', forged), false, '...but isn’t signed');
  for (const [kind, bad] of [
    ['update', { ...forged, sig: update.sig }], // another blob's signature
    ['snapshot', { ...snapshot, covers_seq: 8 }], // a signed snapshot, claimed to cover more
    ['update', { ...update, ciphertext: snapshot.ciphertext }],
    ['update', { ...forged, sig: 'not base64!' }],
    ['snapshot', { ...snapshot, covers_seq: 'x' }],
  ]) {
    assert.equal(await signedByEditor(read, id, kind, bad), false, JSON.stringify(bad));
  }
  assert.equal(await signedByEditor(read, newShareId(), 'update', update), false, 'bound to its share');
  assert.equal(await signedByEditor(read, id, 'snapshot', { ...update, covers_seq: 0 }), false, 'bound to its kind');
  assert.ok(await signedByEditor(await readKeys(edit.encRaw), id, 'update', forged), 'a link from before #77 can’t check');
});

test('share blobs: sealed and signed with an edit link; read-only links can open, not write', async () => {
  const id = newShareId();
  const edit = await shareKeys(newShareSeed());
  const blob = await sealShareBlob(edit, id, 'update', new TextEncoder().encode('hello'));
  const msg = shareBlobMsg(id, 'update', 0, unb64(blob.nonce), unb64(blob.ciphertext));
  assert.ok(await verify(edit.pubkey, msg, unb64(blob.sig)));
  const read = await readKeys(edit.encRaw);
  assert.equal(new TextDecoder().decode(await openShareBlob(read, id, 'update', blob)), 'hello');
  await assert.rejects(openShareBlob(read, newShareId(), 'update', blob), 'bound to its share');
  await assert.rejects(openShareBlob(read, id, 'snapshot', blob), 'bound to its kind');
  await assert.rejects(sealShareBlob(read, id, 'update', new Uint8Array(1)), /read-only/);
});

test('shared notes sync like private ones, with the share’s keys; read-only links never write', async () => {
  const id = newShareId();
  const seed = newShareSeed();
  const keys = await shareKeys(seed);
  const api = new FakeShareServer(id, keys.pubkey);
  const ctx = () => ({ api, outbox: new MemoryOutbox(), cache: new MemoryDocCache() });
  const a = new ShareDocSync(ctx(), { id, keys }, new Y.Doc());
  const b = new ShareDocSync(ctx(), { id, keys: await shareKeys(seed) }, new Y.Doc());
  assert.equal(a.docId, `share:${id}`);
  a.ydoc.getText('body').insert(0, 'from A ');
  await a.flush();
  await b.pull();
  b.ydoc.getText('body').insert(b.ydoc.getText('body').length, 'and B');
  await b.flush();
  await a.pull();
  assert.equal(text(a.ydoc), 'from A and B');
  assert.deepEqual(b.liveSubscription(), { sub: `share:${id}`, token: bytesToHex(keys.readToken) });

  // The offline copy is sealed with the share's key too.
  b.scheduleCache();
  await b.writeCache();
  const reopened = new ShareDocSync({ ...ctx(), cache: b.ctx.cache }, { id, keys }, new Y.Doc());
  assert.equal(await reopened.readCache(), true);
  assert.equal(text(reopened.ydoc), 'from A and B');

  // Read-only: reads, applies pushes, never uploads (and can't compact).
  const r = new ShareDocSync(ctx(), { id, keys: await readKeys(keys.encRaw) }, new Y.Doc());
  assert.equal(r.writable, false);
  await r.pull();
  assert.equal(text(r.ydoc), 'from A and B');
  const posted = api.posted.length;
  r.ydoc.getText('body').insert(0, 'sneaky ');
  await r.flush();
  await r.maybeCompact();
  assert.equal(api.posted.length, posted, 'nothing sent');
  assert.equal(await r.hasPending(), false);

  // Compaction with the edit link.
  await a.snapshot();
  assert.ok(api.snapshot);
  const late = new ShareDocSync(ctx(), { id, keys }, new Y.Doc());
  await late.pull();
  assert.equal(text(late.ydoc), 'from A and B');
  [a, b, reopened, r, late].forEach((s) => s.close());
});

test('shared notes: an edit the server took without the share’s signature is skipped and reported (#77)', async () => {
  const id = newShareId();
  const keys = await shareKeys(newShareSeed());
  const api = new FakeShareServer(id, keys.pubkey);
  const forgedDocs = [];
  const ctx = () => ({ api, outbox: new MemoryOutbox(), cache: new MemoryDocCache(), onForged: (doc) => forgedDocs.push(doc) });
  const text = (doc) => doc.getText('body').toString();
  const a = new ShareDocSync(ctx(), { id, keys }, new Y.Doc());
  a.ydoc.getText('body').insert(0, 'real');
  await a.flush();

  // A server colluding with a read-only link: it stores what that link can make (encrypted, unsigned).
  const mallory = new Y.Doc();
  Y.applyUpdate(mallory, Y.encodeStateAsUpdate(a.ydoc));
  mallory.getText('body').insert(0, 'FORGED ');
  const bytes = Y.encodeStateAsUpdate(mallory, Y.encodeStateVector(a.ydoc));
  const { nonce, ciphertext } = await encrypt(keys.encKey, bytes, shareAad(id, 'update'));
  api.updates.push({ seq: 2, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: api.updates[0].sig });
  a.ydoc.getText('body').insert(4, ' edit');
  await a.flush(); // seq 3

  const viewer = new ShareDocSync(ctx(), { id, keys: await readKeys(keys.encRaw, keys.pubkey) }, new Y.Doc());
  await viewer.pull();
  assert.equal(text(viewer.ydoc), 'real edit');
  assert.equal(viewer.lastSeq, 3, 'skipped, not asked for again');
  assert.deepEqual(forgedDocs, [`share:${id}`]);
  // Pushed live, too; and a forged snapshot.
  await viewer.push({ type: 'update', doc: viewer.docId, ...api.updates[1], seq: 4 });
  await viewer.push({ type: 'snapshot', doc: viewer.docId, covers_seq: 4, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: api.updates[0].sig });
  assert.equal(text(viewer.ydoc), 'real edit');
  assert.equal(forgedDocs.length, 3);
  assert.equal(viewer.snapshotSeq, 0);

  // A read-only link from before #77 has nothing to check with: it takes the server's word.
  const old = new ShareDocSync(ctx(), { id, keys: await readKeys(keys.encRaw) }, new Y.Doc());
  await old.pull();
  assert.equal(text(old.ydoc), 'FORGED real edit');
  [a, viewer, old].forEach((s) => s.close());
});
