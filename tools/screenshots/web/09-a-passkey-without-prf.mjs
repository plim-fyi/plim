import { confirmWords, newPage, openSettings, passkeyFirstTap, phraseWords, ROOT, s, server, until, URL, LOGIN, waitView } from './harness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TestServer, freePort } from '../server.mjs';

/** Flow 9: A passkey without PRF. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow9(shared) {
  const { profile } = shared;
  let { D, dWords } = shared;
  try {
    // 9. A passkey without PRF: Plim says so, and the 12 words are the way in
    D = await newPage(profile, { prf: false, device: 'Device D, its passkey without PRF' });
    await D.goto(LOGIN);
    await waitView(D, 'view-welcome');
    await D.click('#btn-create');
    await waitView(D, 'view-passkey');
    await passkeyFirstTap(D);
    await D.click('#passkey-go');
    await until(D, () => document.querySelector('#passkey-error').textContent);
    await s(D, '09-no-prf-1-error');
    await D.click('#passkey-alt');
    await waitView(D, 'view-phrase');
    dWords = await phraseWords(D);
    await D.click('#phrase-saved');
    await s(D, '09-no-prf-2-phrase');
    await D.click('#phrase-continue');
    await waitView(D, 'view-confirm');
    await confirmWords(D, dWords);
    await waitView(D, 'view-notes', 60000);

    // Delete the account (#51), on device D: confirm by typing DELETE; then nothing of it on the
    // server, and this device back at the welcome screen saying so.
    {
      await openSettings(D, 'account');
      const id = await D.$eval('#settings-account', (e) => e.textContent);
      await D.click('#settings-delete');
      await until(D, () => document.getElementById('delete-dialog').open && document.getElementById('delete-go').disabled);
      await D.type('#delete-confirm', 'delete');
      if (!(await D.$eval('#delete-go', (b) => b.disabled))) throw new Error('"delete" in lower case shouldn\u2019t enable Delete my account');
      await D.click('#delete-confirm', { count: 3 });
      await D.type('#delete-confirm', 'DELETE');
      await until(D, () => !document.getElementById('delete-go').disabled);
      await s(D, '05-settings-6-delete');
      await D.click('#delete-go');
      await waitView(D, 'view-welcome', 20000).catch(async (e) => {
        throw new Error(`after Delete my account: ${e.message}; dialog says ${JSON.stringify(await D.$eval('#delete-error', (x) => x.textContent).catch(() => '?'))}; errors ${D.errors.join(' | ')}`);
      });
      await until(D, () => !document.getElementById('welcome-note').hidden && document.getElementById('welcome-note').textContent.startsWith('Your account was deleted'));
      await s(D, '05-settings-7-deleted');
      const db = new DatabaseSync(server.db);
      const left = db.prepare(`SELECT (SELECT COUNT(*) FROM accounts WHERE id = ?1) + (SELECT COUNT(*) FROM updates WHERE account_id = ?1)
        + (SELECT COUNT(*) FROM snapshots WHERE account_id = ?1) + (SELECT COUNT(*) FROM keyring WHERE account_id = ?1)
        + (SELECT COUNT(*) FROM sessions WHERE account_id = ?1) + (SELECT COUNT(*) FROM passkeys WHERE account_id = ?1) AS n`).get(id).n;
      db.close();
      if (left) throw new Error(`after deleting the account, ${left} rows of it are left on the server`);
    }

    // A server at its account limit (PLIM_MAX_ACCOUNTS): no "Create a new vault", but signing in still offered.
    {
      const closedDir = mkdtempSync(join(tmpdir(), 'plim-closed-'));
      const closed = new TestServer({ root: ROOT, dataDir: closedDir, port: await freePort(), adminPort: await freePort(), env: { PLIM_MAX_ACCOUNTS: '0' } });
      await closed.start();
      try {
        const P = await newPage(profile, { device: 'A new browser, on a server taking no new vaults' });
        await P.goto(`${closed.url}/`);
        await waitView(P, 'view-welcome');
        await until(P, () => !document.getElementById('signups-closed').hidden && document.getElementById('btn-create').hidden
          && !document.getElementById('btn-restore').hidden);
        await s(P, '01-create-5-closed');
        await P.browserContext().close();
      } finally {
        await closed.stop();
        rmSync(closedDir, { recursive: true, force: true });
      }
    }
  } finally {
    Object.assign(shared, { D, dWords });
  }
}
