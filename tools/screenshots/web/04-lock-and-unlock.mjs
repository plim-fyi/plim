import { lock, pageSeed, PROFILES, s, seedRandomness, server, unlockWithPasskey, URL, waitView, watchShiftsOn } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Flow 4: Lock and unlock. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow4(shared) {
  const { A, words, profile } = shared;
  let { A2 } = shared;
  try {
    // 4. Lock and unlock: the passkey, the auto-lock note, the 12 words instead
    // Locking ends the page's session on the server at once (#146), not 15 minutes later.
    const liveSessions = () => {
      const db = new DatabaseSync(server.db);
      const rows = db.prepare('SELECT hex(token_hash) AS h FROM sessions WHERE expires_at >= unixepoch()').all().map((r) => r.h);
      db.close();
      return new Set(rows);
    };
    const sessionsBefore = liveSessions();
    await lock(A);
    let ended = [];
    for (let i = 0; i < 80 && !ended.length; i++) {
      ended = [...sessionsBefore].filter((h) => !liveSessions().has(h));
      if (!ended.length) await wait(100);
    }
    if (!ended.length) throw new Error(`locking should end the page's session on the server: ${sessionsBefore.size} sessions before, none ended`);
    await s(A, '04-lock-1-passkey');
    await unlockWithPasskey(A);
    await lock(A);
    // What auto-lock leaves behind for the next page (the same note the app writes when it locks itself).
    await A.evaluate(() => sessionStorage.setItem('tiro-lock-reason', '15'));
    await A.reload();
    await waitView(A, 'view-locked');
    await s(A, '04-lock-2-auto-locked');
    await A.click('#unlock-use-phrase');
    await waitView(A, 'view-restore');
    await s(A, '04-lock-3-use-phrase');
    await A.click('#restore-back');
    await waitView(A, 'view-locked');
    await unlockWithPasskey(A);
    // A second tab of the same browser (unlocked with the 12 words): Lock in one tab locks both.
    A2 = await A.browserContext().newPage();
    await A2.evaluateOnNewDocument(seedRandomness, pageSeed(profile));
    await watchShiftsOn(A2);
    A2.device = 'Device A, a second tab';
    await A2.setViewport(PROFILES[profile].viewport);
    A2.on('dialog', (d) => d.accept());
    A2.on('pageerror', (e) => A.errors.push(`second tab: ${e.message}`));
    await A2.goto(URL);
    await waitView(A2, 'view-locked');
    await A2.click('#unlock-use-phrase');
    await waitView(A2, 'view-restore');
    await A2.type('#restore-input', words.join(' '));
    await A2.click('#restore-form button.primary');
    await waitView(A2, 'view-notes');
    await A.bringToFront();
    await lock(A);
    await waitView(A2, 'view-locked', 15000);
    await A2.close();
    await unlockWithPasskey(A);
  } finally {
    Object.assign(shared, { A2 });
  }
}
