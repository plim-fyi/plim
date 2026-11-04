import { closeSettings, lock, openSettings, s, until, waitStorage, waitView } from './harness.mjs';

/** Flow 7: Forget this device. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow7(shared) {
  const { A } = shared;
  // 7. Forget this device (the browser's own confirm box can't be captured), then sign in with
  // the passkey as a new device would: from the server's copy, re-wrapped with the new phrase
  await lock(A);
  await s(A, '07-forget-1-locked');
  await A.click('#forget-device');
  await waitView(A, 'view-welcome');
  await s(A, '07-forget-2-welcome');
  // (Forgetting keeps "I've saved my recovery phrase" on the device: drop it too, as on a brand-new device.)
  await A.evaluate(() => new Promise((done, fail) => {
    const open = indexedDB.open('tiro'); // (the app's database keeps its name from before the rename: vault.js)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      store.getAllKeys().onsuccess = (e) => e.target.result.filter((k) => String(k).startsWith('phrase-saved:')).forEach((k) => store.delete(k));
      tx.oncomplete = () => (open.result.close(), done());
      tx.onerror = fail;
    };
    open.onerror = fail;
  }));
  await A.click('#btn-signin-passkey');
  await waitView(A, 'view-notes', 30000);
  await waitStorage(A);
  await s(A, '02-sign-in-4-passkey');
  // "I've saved my recovery phrase" is the account's (#46), not the device's (forgetting it cleared
  // this one's): no reminder, and Settings doesn't ask again.
  {
    await openSettings(A);
    await A.click('#settings-show-phrase');
    await until(A, () => !document.querySelector('#settings-phrase').hidden);
    const asks = await A.evaluate(() => [!document.getElementById('settings-phrase-saved').hidden, !document.getElementById('phrase-banner').hidden]);
    if (asks.some(Boolean)) throw new Error(`a new device should know the phrase was saved: [settings asks, banner] = ${asks}`);
    await closeSettings(A);
  }
}
