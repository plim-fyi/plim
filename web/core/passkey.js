// Passkey sign-in: one of the two ways into a vault (the other is the 12 words).
//
// Uses the WebAuthn PRF extension: the authenticator derives a 32-byte secret
// from (this passkey, SIGNIN_SALT) that never leaves it. That secret, through
// HKDF, becomes the AES key that wraps the vault's recovery entropy. The
// wrapped copy is kept on the server (so the passkey works on any device it
// syncs to) and cached on each device that used it (so it also works offline).
// The salt is fixed: a new device asks for the secret before it knows which
// passkey will be picked.
//
// Safari only allows a passkey prompt that starts directly from a tap, so
// every navigator.credentials call here is the first thing awaited.

import { aesKey, b64, bytesToHex, decrypt, encrypt, hkdf, randomBytes, sha256 } from './crypto.js';
import { encode } from './sig.js';

const INFO = 'tiro/v1/passkey-signin';
const SIGNIN_SALT = await sha256(new TextEncoder().encode(INFO));
const TIMEOUT = 120_000;

/** A passkey problem to show; `details` (optional) is what the browser reported, shown smaller. */
export class PasskeyError extends Error {
  constructor(message, { details } = {}) {
    super(message);
    this.details = details;
  }
}

// ---- pure crypto (unit-tested) ----

const aad = (credentialId) => encode(INFO, credentialId);

async function prfKey(prfOutput) {
  return aesKey(await hkdf(prfOutput, INFO));
}

export async function wrapWithPrf(prfOutput, credentialId, secret) {
  return encrypt(await prfKey(prfOutput), secret, aad(credentialId));
}

export async function unwrapWithPrf(prfOutput, credentialId, nonce, ciphertext) {
  return decrypt(await prfKey(prfOutput), nonce, ciphertext, aad(credentialId));
}

/** How the server knows a passkey: SHA-256 of its credential ID, as hex. */
export async function credHash(credentialId) {
  return bytesToHex(await sha256(credentialId));
}

// ---- names ----

// Password managers by the AAGUID their passkeys report (from the community
// list at github.com/passkeydeveloper/passkey-authenticator-aaguids).
const PROVIDERS = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

export const NAME_MAX = 40;

/** The AAGUID in a new credential's authenticator data, as a UUID string (null if absent or all zeros). */
export function aaguidOf(authData) {
  if (!authData || authData.length < 53) return null;
  const hex = bytesToHex(authData.subarray(37, 53));
  if (/^0+$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A starting name for a new passkey: its password manager when known from
 * the AAGUID, otherwise this browser and system ("Chrome on macOS").
 */
export function defaultPasskeyName(aaguid, userAgent = globalThis.navigator?.userAgent ?? '') {
  if (PROVIDERS[aaguid]) return PROVIDERS[aaguid];
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Passkey';
}

/** A name as typed: trimmed, single-spaced, at most NAME_MAX characters (empty means none). */
export const cleanName = (s) => s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// ---- WebAuthn ----

/** Whether this browser can plausibly do passkey sign-in (PRF). */
export async function passkeySupported() {
  if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential) return false;
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) return Boolean(caps['extension:prf']);
  } catch {
    /* unknown: try it and fail gracefully */
  }
  return true;
}

function friendly(e) {
  if (e instanceof PasskeyError) return e;
  switch (e?.name) {
    case 'NotAllowedError':
      return new PasskeyError('The passkey request was cancelled or timed out.');
    case 'SecurityError':
      return new PasskeyError('Passkeys only work over HTTPS on this site’s own address.');
    case 'InvalidStateError':
      return new PasskeyError('That passkey is already registered.');
    default:
      return new PasskeyError(e?.message || 'The passkey request failed.');
  }
}

const prfFirst = (cred) => {
  const r = cred?.getClientExtensionResults?.().prf?.results?.first;
  return r ? new Uint8Array(r) : null;
};

/**
 * What the browser said about PRF right after creating the passkey. Only
 * diagnostic: many password managers (hardware keys, and third-party
 * providers on iOS) report nothing — or even "not enabled" — at creation
 * yet produce the secret on a sign-in, so creation alone never decides.
 */
export function describeCreation(ext) {
  if (ext?.results?.first) return 'secret returned';
  if (ext?.enabled === true) return 'supported, no secret yet';
  if (ext?.enabled === false) return 'reported unsupported';
  return 'not reported';
}

/** The error when a sign-in returns no PRF secret; its details say what each step reported. */
function noPrfError(creation) {
  return new PasskeyError(
    'This password manager didn’t give Plim what it needs to sign in with a passkey. ' +
      'Updating it may help; otherwise use a different one (for example iCloud Keychain, ' +
      'Google Password Manager or 1Password), or your recovery phrase.',
    { details: creation ? `Creation: ${creation}; sign-in: no secret.` : 'Sign-in: no secret.' },
  );
}

/**
 * Sign in with a passkey and get its PRF secret. Call straight from a tap.
 * With `allowIds` (credential IDs), the prompt goes straight to those
 * passkeys; without, the browser lets the user pick any passkey for this site.
 * Returns { credentialId, prf }.
 */
export async function signInWithPasskey(allowIds = null, creation = null) {
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: location.hostname,
        ...(allowIds ? { allowCredentials: allowIds.map((id) => ({ type: 'public-key', id })) } : {}),
        userVerification: 'required',
        timeout: TIMEOUT,
        extensions: { prf: { eval: { first: SIGNIN_SALT } } },
      },
    });
  } catch (e) {
    throw friendly(e);
  }
  const prf = prfFirst(cred);
  if (!prf) throw noPrfError(creation);
  return { credentialId: new Uint8Array(cred.rawId), prf };
}

/**
 * Create a passkey. Call straight from a tap. Creation only asks the passkey
 * to *support* PRF (`prf: {}`); the secret itself comes from the confirming
 * sign-in, so this returns { pending }: finish with completePasskey(pending)
 * from a second tap. (Asking for a secret during creation — `prf.eval` at
 * create — is newer and optional, and some password managers, e.g. Proton
 * Pass on iOS, then create the passkey without PRF at all.) If a browser
 * returns a secret at creation anyway, this returns { credentialId, prf }.
 */
export async function createPasskey(accountId) {
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Plim', id: location.hostname }, // (the name shown only; the id is what's bound)
        user: {
          id: randomBytes(16),
          name: `Plim vault ${accountId.slice(0, 8)}`,
          displayName: `Plim (${location.hostname})`,
        },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        // Discoverable, so a new device can sign in without knowing which passkey.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        timeout: TIMEOUT,
        extensions: { prf: {} }, // ask for PRF support only; the secret comes on sign-in
      },
    });
  } catch (e) {
    throw friendly(e);
  }
  const credentialId = new Uint8Array(cred.rawId);
  const authData = cred.response?.getAuthenticatorData?.();
  const aaguid = aaguidOf(authData ? new Uint8Array(authData) : null); // for its default name
  const prf = prfFirst(cred);
  if (prf) return { credentialId, prf, aaguid };
  const creation = describeCreation(cred.getClientExtensionResults?.().prf);
  return { pending: { credentialId, creation, aaguid } };
}

/** Second step of creation: sign in and ask for the PRF secret. Call from a tap. Returns { credentialId, prf, aaguid }. */
export async function completePasskey(pending) {
  try {
    return { ...(await signInWithPasskey([pending.credentialId], pending.creation)), aaguid: pending.aaguid };
  } catch (e) {
    // The passkey can't sign in to Plim: ask its manager to drop it (where supported).
    if (e instanceof PasskeyError && e.message.startsWith('This password manager')) {
      await forgetCredential(pending.credentialId);
    }
    throw e;
  }
}

/** Where supported (Chrome 132+), tell the passkey manager this credential is gone. */
export async function forgetCredential(credentialId) {
  try {
    const id = b64(credentialId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await PublicKeyCredential.signalUnknownCredential?.({ rpId: location.hostname, credentialId: id });
  } catch {
    /* best effort */
  }
}
