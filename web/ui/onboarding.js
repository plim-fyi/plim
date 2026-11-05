// Onboarding (#259): the Welcome screen, the multi-screen flows (creating a vault, restoring
// one, changing the phrase), the recovery phrase shown and confirmed, the passkey screen and
// what it does with passkeys. The rest of the app it needs comes through init().
import { generateMnemonic, normalize, validateMnemonic } from '../core/bip39.js';
import { b64, unb64 } from '../core/crypto.js';
import { ApiError, isOffline } from '../core/api.js';
import {
  createAccount, fetchPasskey, identityFromEntropy, identityFromMnemonic, newAccountId, openPasskeyCopy, refreshSession, rotatePhrase,
  uploadPasskey, workerSolver, wrapPasskey,
} from '../core/account.js';
import {
  PasskeyError, completePasskey, createPasskey, credHash, defaultPasskeyName, forgetCredential, passkeySupported,
  signInWithPasskey,
} from '../core/passkey.js';
import { clearOfflineData, passkeyCache, phraseSaved, sessionStore } from '../core/vault.js';
import { guestPath, holderGuestPath, parseHolderLink, parseShareLink } from '../core/share.js';
import { markPhraseSaved, passkeyNames } from './vault-data.js';
import { $, busy, setError, show, state } from './shared.js';
import {
  abandon, at, awaitingConfirmation, begin, confirmationDone, creation, created, current, end, forgetVault, keepPasskeys, keptPasskeys, madePasskey,
  inFlow, newVaultFor, passkeyMade, passkeyScreen, passkeyScreenFor, passkeyStepDone, pendingPasskey, phrase, phraseDropped, phraseFor,
  phrasePurpose, phraseShown, phraseTaken, vaultAccountId, vaultMade,
} from './flow.js';

// From app.js (init): the server, the reasons a reload may carry, opening the notes once
// signed in, this device's passkeys changed, starting a session, and the phrase changed.
let api, DELETED_KEY, LOCK_REASON_KEY, enterNotes, passkeysChanged, phraseChanged, reloadPasskeys, startSession;
export function init(deps) {
  ({ api, DELETED_KEY, LOCK_REASON_KEY, enterNotes, passkeysChanged, phraseChanged, reloadPasskeys, startSession } = deps);
}

/** Start a flow; `passkey: false` leaves out the passkey step (this browser can't use one). */
export function startFlow(name, { passkey = true } = {}) {
  const flow = begin(name, { passkey }); // (flow.js has each flow's steps)
  if (!flow) return; // (a single screen needs no stepper)
  $('stepper').querySelector('ol').replaceChildren(...flow.steps.map(([label], i) => {
    const li = document.createElement('li');
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'step-name';
    name.textContent = label;
    name.addEventListener('click', () => goToStep(i));
    li.append(name);
    return li;
  }));
}

export function endFlow() {
  end();
  $('stepper').hidden = true;
}

/** Show a screen; within a flow, move the stepper along to its step. */
function showStep(view) {
  const flow = current();
  const index = flow?.steps.findIndex(([, v]) => v === view) ?? -1;
  if (index < 0) {
    $('stepper').hidden = true;
    return show(view);
  }
  const el = $('stepper');
  $(`view-${view}`).querySelector('.card').prepend(el);
  el.hidden = false;
  // Draw where it was, then where it is, so the bars fill or empty as you move.
  renderSteps(flow.index ?? index);
  show(view);
  void el.offsetWidth;
  at(index);
  renderSteps(index);
}

function renderSteps(index) {
  const { final, steps } = current();
  [...$('stepper').querySelectorAll('li')].forEach((li, i) => {
    li.className = i < index ? 'done' : i === index ? 'current' : '';
    const name = li.firstChild;
    // Steps before the current one can be revisited until the flow passes the point of no return.
    name.disabled = !(i < index && index < final);
    if (i === index) name.setAttribute('aria-current', 'step');
    else name.removeAttribute('aria-current');
    name.setAttribute('aria-label', `${steps[i][0]}${i < index ? ' (done)' : ''}, step ${i + 1} of ${steps.length}`);
  });
}

function goToStep(i) {
  const flow = current();
  if (!flow || i >= flow.index || flow.index >= flow.final) return;
  showStep(flow.steps[i][1]);
}

// ---------- welcome ----------

export async function showWelcome() {
  const [, supported] = await Promise.all([reloadPasskeys(), passkeySupported()]);
  const passkeys = state.passkeys;
  $('btn-signin-passkey').hidden = !supported;
  let reason = null;
  try {
    reason = sessionStorage.getItem(LOCK_REASON_KEY);
    sessionStorage.removeItem(LOCK_REASON_KEY);
  } catch {
    /* no note then */
  }
  $('lock-note').hidden = !reason;
  // Just deleted the account (#51): say so, and where its passkeys still are.
  let deleted = false;
  try {
    deleted = sessionStorage.getItem(DELETED_KEY) === '1';
    sessionStorage.removeItem(DELETED_KEY);
  } catch {
    /* no note then */
  }
  $('welcome-note').hidden = !deleted;
  $('welcome-note').textContent = deleted ? 'Your account was deleted. Your passkeys are still in your password manager: you can delete them there.' : '';
  if (reason) {
    const m = Number(reason);
    $('lock-note').textContent = `Locked after ${m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`} without activity. Your notes were saved.`;
  }
  // A device that has used a passkey gets the "Welcome back" screen; creating
  // another vault is only offered once it's forgotten.
  if (!passkeys.length) {
    // A shared note's link (/n/<id>#k=…, #299) with no vault here: the note's page, as a guest.
    const link = location.hash.startsWith('#k=') ? parseShareLink(location.pathname, location.hash) : null;
    if (link) return location.replace(guestPath(link, location.hash));
    const held = location.hash.startsWith('#h=') ? parseHolderLink(location.pathname, location.hash) : null; // (someone's own link, #369)
    if (held) return location.replace(holderGuestPath(held, location.hash));
    // (Whether it can make a vault, known before it shows, so the card doesn't change size under you;
    // a slow answer: shown meanwhile, and put right when it comes.)
    await Promise.race([renderSignups(), new Promise((r) => setTimeout(r, 1500))]);
    // plim.fyi/ itself: a short overview, its way in to /login; anywhere else (/login, a note's
    // address, an app asking to connect), or with something to say (the account just deleted):
    // the card to make or open a vault.
    return show(location.pathname === '/' && !deleted ? 'home' : 'welcome');
  }
  show('locked');
  $('locked-offline').hidden = true;
  serverReachable().then((ok) => ($('locked-offline').hidden = ok));
}

/** A quick check that the server answers (not just that the network is up). */
function serverReachable() {
  return fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
}

/**
 * Ask the browser to keep this site's storage (the offline copy and outbox)
 * rather than clearing it when space is low or — in Safari — after a week
 * without a visit. Asked once a device has used a passkey, i.e. is kept.
 */
async function keepStorage() {
  try {
    if (await navigator.storage?.persisted?.()) return;
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
}

/**
 * Open the vault with a passkey's secret: from this device's copy (which
 * works offline), or the server's when this device has none or its copy is
 * out of date (the recovery phrase was changed, and the passkey kept, on
 * another device). Then remember the copy for next time.
 */
async function openWithPasskey({ credentialId, prf }) {
  const hash = await credHash(credentialId);
  const cached = state.passkeys.find((r) => r.credHash === hash);
  if (cached) {
    try {
      return await openWithCopy(prf, credentialId, cached);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
  }
  const copy = await fetchPasskey(api, credentialId);
  if (!copy) {
    if (cached) await passkeyCache.remove((r) => r.credHash === hash);
    throw new PasskeyError(cached
      ? 'This passkey no longer opens your vault: the recovery phrase was changed. Sign in with your recovery phrase.'
      : 'This passkey isn’t set up to sign in to Plim. Use your recovery phrase, then add the passkey in Settings.');
  }
  await openWithCopy(prf, credentialId, { credentialId: b64(credentialId), credHash: hash, ...copy, synced: true });
}

async function openWithCopy(prf, credentialId, rec) {
  const entropy = await openPasskeyCopy(prf, credentialId, rec);
  const { identity } = await identityFromEntropy(entropy);
  const finishedChange = await startSession(entropy, identity);
  // (A phrase change finished on the way in: this passkey held the old phrase, so the server
  // dropped its copy; kept, with the new one, from the sign-in it just made.)
  if (finishedChange) return addPasskey({ credentialId, prf });
  await passkeyCache.put({ ...rec, accountId: state.ctx.accountId });
  await passkeysChanged();
  keepStorage();
}

/** A failed passkey sign-in or unlock: back to the screen it started from, saying why. */
async function passkeyFailed(err) {
  await showWelcome();
  let msg = err;
  if (err instanceof ApiError && err.status === 401) msg = 'This passkey’s copy no longer works (was the recovery phrase changed?). Sign in with your recovery phrase.';
  else if (isOffline(err)) msg = 'Can’t reach the server.';
  setError(state.passkeys.length ? 'unlock-error' : 'welcome-error', msg);
}

$('unlock-passkey').addEventListener('click', async () => {
  setError('unlock-error');
  let got;
  try {
    got = await signInWithPasskey(state.passkeys.map((r) => unb64(r.credentialId))); // prompts first thing, inside the tap
  } catch (err) {
    return setError('unlock-error', err);
  }
  busy('Unlocking…');
  try {
    await openWithPasskey(got);
    enterNotes();
  } catch (err) {
    await passkeyFailed(err);
  }
});

$('btn-signin-passkey').addEventListener('click', async () => {
  setError('welcome-error');
  let got;
  try {
    got = await signInWithPasskey(); // any passkey for this site; prompts first thing, inside the tap
  } catch (err) {
    return setError('welcome-error', err);
  }
  busy('Signing in…');
  try {
    await openWithPasskey(got);
    enterNotes();
  } catch (err) {
    await passkeyFailed(err);
  }
});

$('forget-device').addEventListener('click', async () => {
  if (!confirm('Forget this device? Its saved copy of your notes is removed, and you’ll sign in again with a passkey or your recovery phrase. Your passkeys keep working. Changes not yet uploaded are kept.')) return;
  await clearOfflineData();
  showWelcome();
});

/**
 * Whether new vaults can be made (the server's account limit, PLIM_MAX_ACCOUNTS):
 * if not, the welcome screen says so instead of offering one. Offline or
 * unknown counts as open (creating one says what's wrong then).
 */
async function signupsOpen() {
  try {
    return (await api.get('/signups')).open !== false;
  } catch {
    return true;
  }
}
async function renderSignups(open) {
  open ??= await signupsOpen();
  $('btn-create').hidden = !open;
  $('signups-closed').hidden = open;
}
const signupsClosed = (err) => err instanceof ApiError && err.status === 403 && err.message === 'signups are closed';

/** Closed while making one (the last place went meanwhile): back to the welcome screen, which says so. */
function closedMeanwhile() {
  endFlow();
  forgetVault();
  renderSignups(false);
  show('welcome');
}

$('btn-create').addEventListener('click', async () => {
  setError('welcome-error');
  // (Before a passkey is made for it: not one for an account that can't be.)
  if (!(await signupsOpen())) return renderSignups(false);
  if (await passkeySupported()) showPasskeyStep('create');
  else startPhraseCreate();
});

/** Creating a vault with the 12 words instead of a passkey. */
async function startPhraseCreate() {
  phraseFor('create');
  startFlow('create');
  await showPhrase(await generateMnemonic());
}

function showRestore() {
  setError('restore-error');
  showStep('restore');
  $('restore-input').focus();
}

$('btn-restore').addEventListener('click', async () => {
  startFlow('restore', { passkey: await passkeySupported() });
  showRestore();
});
// Unlocking with the 12 words instead of the passkey: a single screen.
$('unlock-use-phrase').addEventListener('click', () => {
  endFlow();
  showRestore();
});

// ---------- phrase display & confirmation ----------

export async function showPhrase(mnemonic) {
  phraseShown(mnemonic);
  $('phrase-title').textContent = phrasePurpose() === 'rotate' ? 'Your new recovery phrase' : 'Your recovery phrase';
  const list = $('phrase-words');
  list.replaceChildren(...mnemonic.split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  $('phrase-saved').checked = false;
  $('phrase-continue').disabled = true;
  showStep('phrase');
}

$('phrase-saved').addEventListener('change', (e) => ($('phrase-continue').disabled = !e.target.checked));

$('btn-copy-phrase').addEventListener('click', async () => {
  await navigator.clipboard.writeText(phrase());
  $('btn-copy-phrase').textContent = 'Copied — clear your clipboard after saving it';
});

$('phrase-back').addEventListener('click', () => {
  phraseDropped();
  endFlow();
  if (phrasePurpose() === 'rotate') show('notes');
  else showWelcome();
});

$('phrase-continue').addEventListener('click', () => {
  const picks = new Set();
  while (picks.size < 3) picks.add(Math.floor(Math.random() * 12));
  const fields = [...picks].sort((a, b) => a - b).map((i) => {
    const label = document.createElement('label');
    label.textContent = `Word #${i + 1}`;
    const input = Object.assign(document.createElement('input'), {
      autocomplete: 'off', autocapitalize: 'off', spellcheck: false, required: true,
    });
    input.dataset.index = i;
    label.append(input);
    return label;
  });
  $('confirm-fields').replaceChildren(...fields);
  setError('confirm-error');
  showStep('confirm');
  fields[0].querySelector('input').focus();
});

$('confirm-back').addEventListener('click', () => showStep('phrase'));

/**
 * The new phrase confirmed (Settings' Change the recovery phrase, #446: here, with the rest of its
 * flow): every note re-encrypted, the keys swapped, the passkey step next if this browser has one.
 */
async function doRotate(mnemonic) {
  const { entropy, identity } = await identityFromMnemonic(mnemonic);
  return rotateTo(entropy, identity);
}

/**
 * The phrase change itself, from a new phrase just confirmed, or `resume`d (the version a change
 * that was interrupted had registered, opened with the new phrase: askNewPhrase).
 */
async function rotateTo(entropy, identity, { resume = null } = {}) {
  state.busy = true;
  busy('Saving pending changes…');
  try {
    await Promise.all([state.index.flush(), state.note?.sync.flush()]);
    const { accountId, identity: oldIdentity } = state.ctx;
    await rotatePhrase(state.ctx, identity, { prune: true, resume, onProgress: (t) => ($('busy-text').textContent = t) });
    phraseChanged(entropy, identity);
    await markPhraseSaved(true); // just confirmed
    // The server dropped every passkey's copy (they held the old phrase); so does this
    // device. The passkeys it used can be kept, wrapping the new phrase instead.
    const mine = state.passkeys.filter((r) => r.accountId === accountId);
    keepPasskeys(mine.map((r) => unb64(r.credentialId)));
    // Names of passkeys this device can't keep go with them; its own stay for "Keep using your passkey".
    const kept = new Set(mine.map((r) => r.credHash));
    for (const hash of [...passkeyNames().keys()]) if (!kept.has(hash)) passkeyNames().delete(hash);
    await passkeyCache.remove((r) => r.accountId === accountId);
    await passkeysChanged();
    // The saved sign-in for offline use follows the phrase too.
    await sessionStore.delete(oldIdentity.pubkeyHash);
    await refreshSession(api, identity, state.ctx.keyring, sessionStore);
    state.busy = false;
    if (resume) return passkeyStepDone(); // (finishing at sign-in: the sign-in goes on to the notes)
    if (inFlow('passkey')) showPasskeyStep('rotate');
    else leavePasskeyStep();
  } catch (e) {
    state.busy = false;
    console.error(e);
    // (Past step 1: the new key is registered, under the new phrase. Signing in with the old
    // phrase asks for the new one and finishes the change; nothing is lost either way.)
    const then = e.registered
      ? 'The change isn’t finished: Plim asks for the new phrase the next time you sign in with the old one, and finishes it then. Keep both.'
      : 'Nothing changed: your old phrase still works.';
    alert(`Changing the phrase failed: ${e.message}\n${then}`);
    endFlow();
    show('notes');
  }
}

// ---------- a phrase change left unfinished (#7v4r) ----------

/**
 * The old phrase signed in, but the keyring holds a key only the new phrase opens (the change was
 * interrupted after registering it). Asks for the new phrase until it opens that key, and gives
 * its identity and entropy; the caller (app.js startSession) then finishes the change with
 * finishRotation. Lock is the way out.
 */
export function askNewPhrase(keyring, accountId) {
  return new Promise((resolve) => {
    const form = $('finish-phrase-form');
    const onSubmit = async (e) => {
      e.preventDefault();
      const phrase = $('finish-phrase-input').value;
      const problem = await validateMnemonic(phrase);
      if (problem) return setError('finish-phrase-error', problem);
      const { entropy, identity } = await identityFromMnemonic(phrase);
      try {
        await keyring.unlock(identity, accountId);
      } catch {
        return setError('finish-phrase-error', 'That isn’t the new phrase: it doesn’t open the key the change registered.');
      }
      $('finish-phrase-input').value = '';
      form.removeEventListener('submit', onSubmit);
      resolve({ entropy, identity });
    };
    form.addEventListener('submit', onSubmit);
    setError('finish-phrase-error');
    show('finish-phrase');
    $('finish-phrase-input').focus();
  });
}
$('finish-phrase-lock').addEventListener('click', () => location.reload()); // (nothing of the vault is open yet)

/** Steps 2 to 4 of an interrupted change, with the key it registered (its version) now open. */
export function finishRotation(entropy, identity, version) {
  return rotateTo(entropy, identity, { resume: version });
}


$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const words = phrase().split(' ');
  const wrong = [...$('confirm-fields').querySelectorAll('input')].some(
    (input) => normalize(input.value) !== words[input.dataset.index],
  );
  if (wrong) return setError('confirm-error', 'Those words don’t match. Check your written copy.');
  const mnemonic = phraseTaken();
  if (phrasePurpose() === 'rotate') return doRotate(mnemonic);

  busy('Creating your vault… (a few seconds of proof-of-work)');
  try {
    const { entropy, identity } = await identityFromMnemonic(mnemonic);
    await createAccount(api, identity);
    await startSession(entropy, identity);
    await markPhraseSaved(true);
    enterNotes();
  } catch (err) {
    if (signupsClosed(err)) return closedMeanwhile();
    show('confirm');
    setError('confirm-error', isOffline(err) ? 'You’re offline. Creating a vault needs a connection.' : err);
  }
});

// ---------- restore ----------

$('restore-back').addEventListener('click', () => {
  endFlow();
  showWelcome();
});

$('restore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phrase = $('restore-input').value;
  const problem = await validateMnemonic(phrase);
  if (problem) return setError('restore-error', problem);
  busy('Opening your vault…');
  try {
    const { entropy, identity } = await identityFromMnemonic(phrase);
    $('restore-input').value = '';
    await startSession(entropy, identity);
    await markPhraseSaved(true); // they just typed it
    if (inFlow('passkey')) showPasskeyStep('add');
    else enterNotes();
  } catch (err) {
    show('restore');
    if (err instanceof ApiError && err.status === 401) setError('restore-error', 'No vault found for this phrase.');
    else setError('restore-error', isOffline(err) ? 'Can’t reach the server.' : err);
  }
});

// ---------- passkey screen ----------

export const PASSKEY_SUB = 'Face ID, Touch ID, fingerprint or Windows Hello';

// What the screen is for. `alt` is the way past it without a passkey.
const PASSKEY_SCREENS = {
  create: {
    title: 'Secure your vault with a passkey',
    lede: 'Your passkey opens Plim here, and on your other devices where it syncs (iCloud Keychain, Google Password Manager, 1Password…). There’s no password to remember.',
    go: 'Create a passkey',
    alt: 'Use a recovery phrase instead',
  },
  add: {
    title: 'Add a passkey?',
    lede: 'Next time, sign in with biometrics instead of typing your 12 words: here, and on your other devices where the passkey syncs.',
    go: 'Add a passkey',
    alt: 'Not now',
  },
  rotate: {
    title: 'Keep signing in with a passkey',
    lede: 'Your recovery phrase changed, so passkeys set up with the old one stopped working. Set one up again to skip typing your new 12 words.',
    go: 'Add a passkey',
    alt: 'Not now',
  },
};

const passkeyGoLabel = (context) =>
  context === 'rotate' && keptPasskeys().length ? 'Keep using your passkey' : PASSKEY_SCREENS[context].go;

/**
 * The passkey screen: create a vault with a passkey (before the account
 * exists), or add one to the open vault after signing in with the 12 words or
 * changing them.
 */
function showPasskeyStep(context) {
  const s = PASSKEY_SCREENS[context];
  passkeyScreen(context);
  $('passkey-title').textContent = s.title;
  $('passkey-lede').textContent = s.lede;
  $('passkey-go-title').textContent = passkeyGoLabel(context);
  $('passkey-go-sub').textContent = PASSKEY_SUB;
  $('passkey-alt').textContent = s.alt;
  $('passkey-back').hidden = context !== 'create';
  setError('passkey-error');
  if (context === 'create') {
    endFlow();
    abandonCreatedPasskey();
    newVaultFor(newAccountId());
  }
  showStep('passkey');
}

/**
 * Leaving vault creation without a vault (Back, the 12 words instead): a
 * passkey made for it would open nothing, so ask its password manager to
 * drop it (where supported, see forgetCredential).
 */
function abandonCreatedPasskey() {
  const id = abandon();
  if (id) forgetCredential(id);
}

/** Done or skipped: on to the notes. */
function leavePasskeyStep() {
  passkeyStepDone();
  enterNotes();
}

/**
 * Create a passkey from a tap. Some authenticators reveal their PRF secret
 * only on a sign-in, which needs a second tap: `label` turns into "Confirm
 * passkey" and this returns null until then. Returns { credentialId, prf }.
 */
export async function createOrConfirm(accountId, label, onNote) {
  if (pendingPasskey()) {
    try {
      const got = await completePasskey(pendingPasskey());
      confirmationDone();
      return got;
    } catch (err) {
      // This password manager can't do it (completePasskey dropped the passkey): start over.
      if (err.message?.startsWith('This password manager')) confirmationDone();
      throw err;
    }
  }
  const r = await createPasskey(accountId);
  if (!r.pending) return r;
  awaitingConfirmation(r.pending);
  label.textContent = 'Confirm passkey';
  onNote('One more step: tap “Confirm passkey” to finish setting it up.');
  return null;
}

/** Save a passkey for the open vault: on this device first (so it unlocks here, even offline), then on the server. */
export async function addPasskey({ credentialId, prf, aaguid }) {
  const rec = await wrapPasskey(state.ctx.accountId, credentialId, prf, state.entropy);
  await passkeyCache.put(rec);
  await passkeysChanged();
  // A starting name (renamed in Settings); kept as it was when an existing passkey is re-added.
  if (!passkeyNames().has(rec.credHash)) passkeyNames().set(rec.credHash, defaultPasskeyName(aaguid));
  keepStorage();
  try {
    await uploadPasskey(state.ctx, rec);
    await passkeyCache.put(rec);
  } catch (err) {
    if (!isOffline(err)) throw err; // offline: uploaded once back (uploadPendingPasskeys)
  }
}

/** Upload passkeys this device saved while offline. */
export async function uploadPendingPasskeys() {
  for (const rec of state.passkeys.filter((r) => !r.synced && r.accountId === state.ctx.accountId)) {
    try {
      await uploadPasskey(state.ctx, rec);
      await passkeyCache.put(rec);
    } catch (err) {
      console.warn('passkey upload failed', err);
    }
  }
}

$('passkey-go').addEventListener('click', async () => {
  setError('passkey-error');
  const context = passkeyScreenFor();
  // Creating the vault failed after the passkey was made: try again with the same passkey.
  if (context === 'create' && passkeyMade()) return createWithPasskey(passkeyMade());
  let got;
  try {
    // After a phrase change, the passkey this device used can be kept: one sign-in, no new passkey.
    if (context === 'rotate' && keptPasskeys().length) got = await signInWithPasskey(keptPasskeys());
    else got = await createOrConfirm(state.ctx?.accountId ?? vaultAccountId(), $('passkey-go-title'), (t) => ($('passkey-go-sub').textContent = t));
  } catch (err) {
    if (!pendingPasskey()) $('passkey-go-title').textContent = passkeyGoLabel(context);
    return setError('passkey-error', err);
  }
  if (!got) return; // waiting for the confirming tap
  if (context === 'create') return createWithPasskey(got);
  try {
    await addPasskey(got);
    leavePasskeyStep();
  } catch (err) {
    setError('passkey-error', err);
  }
});

/**
 * Create the vault for a passkey just made: new 12 words (shown later, in
 * Settings), the account, then the passkey's copy of the words.
 */
async function createWithPasskey(got) {
  madePasskey(got);
  busy('Creating your vault… (a few seconds of proof-of-work)');
  const accountId = vaultAccountId();
  // Kept until signed in, so a retry after a dropped connection reuses the account it may have created.
  const pending = creation();
  try {
    const { identity } = await identityFromEntropy(pending.entropy);
    if (!pending.created) {
      await createAccount(api, identity, workerSolver, accountId);
      pending.created = true;
    }
    await startSession(pending.entropy, identity);
    created();
  } catch (err) {
    if (signupsClosed(err)) return closedMeanwhile();
    showStep('passkey');
    $('passkey-go-title').textContent = 'Try again';
    $('passkey-go-sub').textContent = 'With the passkey you just made';
    return setError('passkey-error', isOffline(err) ? 'You’re offline. Creating a vault needs a connection.' : err);
  }
  vaultMade();
  await phraseSaved.set(accountId, false); // (onto the account once its note list loads: mergePhraseSaved)
  try {
    await addPasskey(got);
  } catch (err) {
    // Saved on this device already; the upload is retried at the next sign-in.
    console.warn('passkey upload failed', err);
  }
  enterNotes();
}

$('passkey-alt').addEventListener('click', () => {
  if (passkeyScreenFor() !== 'create') return leavePasskeyStep();
  abandonCreatedPasskey();
  startPhraseCreate();
});

$('passkey-back').addEventListener('click', () => {
  abandonCreatedPasskey();
  showWelcome();
});
