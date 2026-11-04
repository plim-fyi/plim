import { backToList, closeSettings, lock, newPage, openNote, openSettings, passkeyFirstTap, pushedWithin, s, signInWithWords, startServer, stopServer, typeAtEnd, unlockWithPasskey, until, LOGIN, waitView } from './harness.mjs';

/** Flow 8: Offline. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow8(shared) {
  const { A, words, B, profile } = shared;
  let { C, credentials } = shared;
  try {
    // 8. Offline (device C is open on the welcome screen before the server goes away)
    C = await newPage(profile, { device: 'Device C' });
    await C.goto(LOGIN);
    await waitView(C, 'view-welcome');
    await stopServer();
    await lock(A);
    await until(A, () => !document.querySelector('#locked-offline').hidden, undefined, 10000);
    await s(A, '08-offline-1-locked');
    await unlockWithPasskey(A); // from this device's copy
    await until(A, () => !document.querySelector('#offline-bar').hidden, undefined, 15000);
    await backToList(A);
    await s(A, '08-offline-2-notes');
    await openNote(A, 'Lisbon trip');
    await typeAtEnd(A, '\n- Fado night in Alfama (written offline)');
    await until(A, () => document.querySelector('#save-status').dataset.state === 'offline', undefined, 15000);
    await s(A, '08-offline-3-editing');
    await openSettings(A);
    await s(A, '08-offline-4-settings');
    await closeSettings(A);
    await signInWithWords(C, words);
    await until(C, () => /needs a connection/.test(document.querySelector('#restore-error').textContent));
    await waitView(C, 'view-restore');
    await s(C, '08-offline-5-first-sign-in');
    await C.click('#restore-back');
    await waitView(C, 'view-welcome');
    await C.click('#btn-create');
    await waitView(C, 'view-passkey');
    await passkeyFirstTap(C);
    await C.click('#passkey-go');
    await until(C, () => /needs a connection/.test(document.querySelector('#passkey-error').textContent), undefined, 20000);
    await s(C, '08-offline-6-new-vault');
    await startServer();
    await until(A, () => document.querySelector('#offline-bar').hidden, undefined, 30000);
    await until(A, () => document.querySelector('#save-status').dataset.state === 'saved', undefined, 20000);
    await s(A, '08-offline-7-back-online');
    // After the server restart, live sync reconnects on its own and pushes again.
    console.log(`  live push after restart A → B: ${(await pushedWithin(A, B, 'Groceries', 2000, 2)).join(', ')} ms`);

    // C couldn't create its vault offline; back online, "Try again" reuses the passkey it already made.
    await until(C, () => document.querySelector('#passkey-go-title').textContent === 'Try again');
    await C.click('#passkey-go');
    await waitView(C, 'view-notes', 60000);
    ({ credentials } = await C.cdp.send('WebAuthn.getCredentials', { authenticatorId: C.authenticatorId }));
    if (credentials.length !== 1) throw new Error(`expected C to have made 1 passkey, found ${credentials.length}`);
  } finally {
    Object.assign(shared, { C, credentials });
  }
}
