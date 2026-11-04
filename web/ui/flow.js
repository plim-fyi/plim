// Signing up, signing in and changing the phrase (#446): which screens a flow has and where it's
// got to, the recovery phrase being shown, and a passkey being made. Only this module changes
// it, through the steps below; onboarding.js and settings.js show the screens and call them.
// (No page here: both import it, and it imports neither.)
import { randomBytes } from '../core/crypto.js';

/**
 * Each flow's steps and the screen that shows each one. From step `final` on, earlier steps
 * can't be revisited: the vault exists, you're signed in, or the phrase has changed.
 * (Short labels, so three fit on one line on a phone.)
 */
const FLOWS = {
  // Creating a vault with the 12 words instead of a passkey.
  create: { final: 2, steps: [['Phrase', 'phrase'], ['Confirm', 'confirm']] },
  restore: { final: 1, steps: [['Phrase', 'restore'], ['Passkey', 'passkey']] },
  rotate: { final: 2, steps: [['New phrase', 'phrase'], ['Confirm', 'confirm'], ['Passkey', 'passkey']] },
};

let steps = null; // { final, steps, index } during a multi-screen flow
let purpose = 'create'; // what the phrase screens are for: 'create' | 'rotate'
let words = null; // the phrase being shown and confirmed
let screen = null; // what the passkey screen is for: 'create' | 'add' | 'rotate'
let pending = null; // a passkey made, waiting for its confirming second tap
let accountId = null; // the account a passkey is being made for, before it exists
let creating = null; // { entropy, created } while that account is being made
let made = null; // { credentialId, prf } made for it, kept for a retry until it exists
let keep = []; // after a phrase change: this device's passkeys, to keep using with the new one

// ---- a flow's steps ----

/** Start a flow (`passkey: false`: without the passkey step). Its steps, or null for a single screen. */
export function begin(name, { passkey = true } = {}) {
  const { final, steps: all } = FLOWS[name];
  const kept = passkey ? all : all.filter(([, view]) => view !== 'passkey');
  steps = kept.length > 1 ? { final, steps: kept, index: null } : null;
  return steps;
}

export function end() {
  steps = null;
}

/** The flow under way: { final, steps, index }, or null. */
export const current = () => steps;

/** The flow is at its step `index`. */
export function at(index) {
  steps.index = index;
}

/** Whether the current flow has a step on this screen. */
export const inFlow = (view) => Boolean(steps?.steps.some(([, v]) => v === view));

// ---- the recovery phrase ----

/** What the phrase screens are for: a new vault, or a new phrase for the open one. */
export function phraseFor(p) {
  purpose = p;
}
export const phrasePurpose = () => purpose;

export function phraseShown(mnemonic) {
  words = mnemonic;
}
export const phrase = () => words;
/** Confirmed: the phrase, forgotten here. */
export function phraseTaken() {
  const m = words;
  words = null;
  return m;
}
export function phraseDropped() {
  words = null;
}

// ---- the passkey screen ----

/** The passkey screen, for `context`: nothing waiting for a second tap yet. */
export function passkeyScreen(context) {
  screen = context;
  pending = null;
}
export const passkeyScreenFor = () => screen;

/** A passkey that needs a second tap to finish (createOrConfirm), or null. */
export const pendingPasskey = () => pending;
export function awaitingConfirmation(p) {
  pending = p;
}
export function confirmationDone() {
  pending = null;
}

// Creating a vault with a passkey: the account's id comes first, the passkey for it, then the
// account (kept, with its entropy, until signed in: a retry reuses what may have been made).
export function newVaultFor(id) {
  accountId = id;
}
export const vaultAccountId = () => accountId;
export function madePasskey(got) {
  made = got;
}
export const passkeyMade = () => made;
/** The account being made: its entropy, and whether the server has it yet. */
export function creation() {
  return (creating ??= { entropy: randomBytes(16), created: false });
}
/** Signed in to it. */
export function created() {
  creating = null;
}
/** The vault exists and its passkey is saved: nothing kept for a retry. */
export function vaultMade() {
  accountId = made = null;
}
/** Leaving without a vault: the passkey made for it (to forget), and nothing kept. */
export function abandon() {
  const id = made?.credentialId ?? pending?.credentialId;
  made = pending = creating = null;
  return id;
}
/** Sign-ups closed meanwhile: nothing of it kept. */
export function forgetVault() {
  creating = accountId = made = null;
}

// After a phrase change: the passkeys this device used can be kept, wrapping the new phrase.
export function keepPasskeys(ids) {
  keep = ids;
}
export const keptPasskeys = () => keep;

/** The passkey screen done or skipped. */
export function passkeyStepDone() {
  pending = null;
  keep = [];
}
