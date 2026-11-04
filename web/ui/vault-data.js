// What the account keeps in its note list besides notes, that more than one screen uses: its
// passkeys' names, and whether its recovery phrase was saved (#446: Settings and onboarding both
// use them; here, beneath both, rather than one importing the other).
import { phraseSaved } from '../core/vault.js';
import { profile } from './shares.js';
import { state } from './shared.js';

/** Passkeys' names, by credential hash (kept on the account, for every device to show). */
export const passkeyNames = () => state.index.ydoc.getMap('passkeys');

/** Saved, explicitly not yet, or unknown (undefined). */
export async function isPhraseSaved() {
  const onAccount = state.index ? profile().get('phraseSaved') : undefined;
  return onAccount ?? (state.ctx ? await phraseSaved.get(state.ctx.accountId).catch(() => undefined) : undefined);
}

export async function markPhraseSaved(saved) {
  await phraseSaved.set(state.ctx.accountId, saved);
  if (state.index) profile().set('phraseSaved', saved);
}

/** The note list just loaded: merge this device's flag into the account's. */
export async function mergePhraseSaved() {
  const here = await phraseSaved.get(state.ctx.accountId).catch(() => undefined);
  const there = profile().get('phraseSaved');
  if (here === true && there !== true) profile().set('phraseSaved', true);
  else if (here === false && there === undefined) profile().set('phraseSaved', false);
  const now = profile().get('phraseSaved');
  if (now !== undefined && now !== here) await phraseSaved.set(state.ctx.accountId, now).catch(() => {});
}
