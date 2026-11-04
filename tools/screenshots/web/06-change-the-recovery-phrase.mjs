import { closeSettings, confirmWords, openSettings, phraseWords, s, server, until, waitView } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';

/** Flow 6: Change the recovery phrase. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow6(shared) {
  const { A, B } = shared;
  let { titles, versionRows, historyBefore, newWords, afterRotate } = shared;
  try {
    // 6. Change the recovery phrase (on A). First: B's name for its passkey reached A.
    await openSettings(A);
    titles = (p) => p.$$eval('#settings-passkey-list .setting-title', (e) => e.map((t) => t.textContent));
    if (!(await titles(A)).includes('Work laptop')) throw new Error(`A doesn't see B's passkey name: ${await titles(A)}`);
    // Notes' history so far (#60): kept through the phrase change, re-encrypted under the new key.
    versionRows = () => {
      const db = new DatabaseSync(server.db);
      const rows = db.prepare('SELECT id, key_version FROM versions ORDER BY id').all();
      const top = db.prepare('SELECT MAX(key_version) AS v FROM keyring').get().v;
      db.close();
      return { ids: rows.map((r) => r.id).join(), keys: [...new Set(rows.map((r) => r.key_version))], top };
    };
    historyBefore = versionRows();
    if (!historyBefore.ids) throw new Error('the notes edited so far should have kept some versions');
    await A.click('#settings-rotate');
    await waitView(A, 'view-phrase');
    // (The new words, not a phrase screen from before: showPhrase sets this title as it shows them.)
    await until(A, () => document.getElementById('phrase-title').textContent === 'Your new recovery phrase');
    newWords = await phraseWords(A);
    await A.click('#phrase-saved');
    await until(A, () => !document.getElementById('phrase-continue').disabled);
    await s(A, '06-phrase-1-new-words');
    await A.click('#phrase-continue');
    await waitView(A, 'view-confirm');
    await confirmWords(A, newWords, { wrong: true });
    await until(A, () => document.querySelector('#confirm-error').textContent);
    await s(A, '06-phrase-2-confirm-mistake');
    await confirmWords(A, newWords);
    await waitView(A, 'view-passkey', 60000);
    await s(A, '06-phrase-3-keep-passkey');
    await A.click('#passkey-go'); // one sign-in with the same passkey: no new one
    await waitView(A, 'view-notes');
    {
      // (Every version from before is still there, all under the new key. One more may have
      // landed meanwhile: a flow's last edit, versioned 2 s later.)
      const after = versionRows();
      const kept = historyBefore.ids.split(',').every((id) => after.ids.split(',').includes(id));
      if (!kept || after.keys.join() !== String(after.top)) {
        throw new Error(`the phrase change should keep every version, under the new key: before ${JSON.stringify(historyBefore)}, after ${JSON.stringify(after)}`);
      }
    }
    // The kept passkey keeps its name; B's (dropped by the phrase change) is gone.
    await openSettings(A);
    afterRotate = await titles(A);
    if (afterRotate.length !== 1 || ['Passkey', 'Work laptop'].includes(afterRotate[0])) {
      throw new Error(`after the phrase change, expected A's named passkey only, got ${afterRotate}`);
    }
    await closeSettings(A);
    // B's passkey held the old phrase, so the server dropped it: B says so.
    await B.reload();
    await waitView(B, 'view-locked');
    await B.click('#unlock-passkey');
    await until(B, () => /recovery phrase was changed/.test(document.querySelector('#welcome-error').textContent + document.querySelector('#unlock-error').textContent));
    await s(B, '06-phrase-4-other-device');
  } finally {
    Object.assign(shared, { titles, versionRows, historyBefore, newWords, afterRotate });
  }
}
