// A request the account's key signs (#144): what can't be undone, or locks something out. Its
// own module, below account.js and history.js, which both send them (#521: account.js imported
// history.js, and history.js account.js for this alone).
import { b64, sign, unb64 } from './crypto.js';
import { actionMsg } from './sig.js';

/**
 * What can't be undone, or locks something out (#144): deleting a note or a share, turning a
 * share's links off, closing or reopening a note, saving or removing a passkey's copy. The
 * account's key signs a fresh challenge for `action` (sig.js ACTION) on `target`, with `data` if
 * it puts something there, sent with the request: a session alone can't do it. `ctx`: the
 * session's { api, accountId, identity }.
 */
export async function signedRequest(ctx, method, path, action, target, { body, data } = {}) {
  const { api, accountId, identity } = ctx;
  const { nonce } = await api.post('/auth/challenge', { pubkey_hash: identity.pubkeyHash });
  const sig = await sign(identity.signKey, actionMsg(accountId, action, target, unb64(nonce), data));
  return api.request(method, path, body, { headers: { 'x-tiro-nonce': nonce, 'x-tiro-sig': b64(sig) } });
}
