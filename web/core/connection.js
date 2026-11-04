// A connection (#369): an app (Claude, through the connector) connected to your notes. Mirrors
// crates/plim-core (connection_keys, connection_holder_secret) byte for byte.
//
// A connection has a random 32-byte secret, carried by the token Claude holds (sealed by the
// connector; this app never sees the token). From the secret come: the Ed25519 key it signs
// with (to make notes on your behalf), and its own list note's holder: an id and a secret,
// derived, so with nothing but the secret it finds its list. Each note granted to it is a
// holder too (share.js), whose secret comes from the connection's secret and that holder's id.

import { bytesToHex, hkdf, importSigningKey, randomBytes, sha256 } from './crypto.js';

export const newConnectionId = () => bytesToHex(randomBytes(16));
export const newConnectionSecret = () => randomBytes(32);

export async function connectionKeys(secret) {
  const { signKey, pubkey } = await importSigningKey(await hkdf(secret, 'tiro/v1/conn-sign'));
  return {
    signKey,
    pubkey,
    pubkeyHash: bytesToHex(await sha256(pubkey)),
    listHolderId: bytesToHex((await hkdf(secret, 'tiro/v1/conn-list-id')).slice(0, 16)),
    listHolderSecret: await hkdf(secret, 'tiro/v1/conn-list-secret'),
  };
}

/** The secret of one of a connection's holders (a note granted to it), from its id. */
export const connectionHolderSecret = (secret, holderId) => hkdf(secret, `tiro/v1/conn-holder/${holderId}`);
