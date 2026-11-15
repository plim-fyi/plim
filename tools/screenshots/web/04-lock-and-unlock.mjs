import { closeSettings, lock, openSettings, pageSeed, PROFILES, s, seedRandomness, server, unlockWithPasskey, until, URL, waitView, watchShiftsOn } from './harness.mjs';
import { DatabaseSync } from 'node:sqlite';
import { wait } from '../server.mjs';

/** Move this device's kept unlock back in time by `days` (as if Plim had gone unused that long). */
const ageKept = (p, days) =>
  p.evaluate((days) => new Promise((resolve, reject) => {
    const req = indexedDB.open('tiro');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const t = req.result.transaction('kv', 'readwrite');
      const kv = t.objectStore('kv');
      const get = kv.get('stay-unlocked');
      get.onsuccess = () => {
        if (!get.result) return reject(new Error('nothing kept unlocked on this device'));
        kv.put({ ...get.result, lastUsed: get.result.lastUsed - days * 24 * 3600 * 1000 }, 'stay-unlocked');
      };
      t.oncomplete = () => {
        req.result.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
  }), days);

/** Settings → This device → Stay unlocked, turned `on` or off; Auto-lock is off while it's on. */
async function stayUnlocked(p, on, shot) {
  await openSettings(p);
  if ((await p.$eval('#settings-stay', (b) => b.checked)) === on) throw new Error(`Stay unlocked should be ${on ? 'off' : 'on'} before it's turned ${on ? 'on' : 'off'}`);
  if ((await p.$eval('#settings-autolock', (b) => b.disabled)) === on) throw new Error('Auto-lock: only to be chosen while the device doesn’t stay unlocked');
  if (shot) await s(p, shot);
  await p.click('#settings-stay');
  await until(p, (on) => document.getElementById('settings-autolock').disabled === on, on, 3000)
    .catch(() => { throw new Error(`Stay unlocked ${on ? 'on' : 'off'}: Auto-lock should be ${on ? 'off' : 'back'}`); });
  await closeSettings(p);
}

/** Flow 4: Lock and unlock. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow4(shared) {
  const { A, words, profile } = shared;
  let { A2 } = shared;
  try {
    // 4. Lock and unlock: the passkey, staying unlocked, the auto-lock note, the 12 words instead
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

    // The device stays unlocked: a reload opens the notes, no passkey asked, and signs in afresh.
    await A.reload();
    await waitView(A, 'view-notes', 20000)
      .catch(() => { throw new Error('a reload should open the notes again (the device stays unlocked)'); });
    // 30 days without using Plim here: asked again.
    await ageKept(A, 31);
    await A.reload();
    await waitView(A, 'view-locked', 20000)
      .catch(() => { throw new Error('30 days unused: the device should ask for the passkey again'); });
    if (await A.evaluate(() => new Promise((r) => { const q = indexedDB.open('tiro'); q.onsuccess = () => { const g = q.result.transaction('kv').objectStore('kv').get('stay-unlocked'); g.onsuccess = () => r(Boolean(g.result)); }; }))) {
      throw new Error('an expired unlock should be deleted, not only refused');
    }
    await unlockWithPasskey(A);
    // 29 days unused: still open.
    await ageKept(A, 29);
    await A.reload();
    await waitView(A, 'view-notes', 20000).catch(() => { throw new Error('29 days unused: still unlocked'); });

    // Turned off on this device: a reload locks, and auto-lock is back.
    await stayUnlocked(A, false, '04-lock-0-stay-unlocked');
    await A.reload();
    await waitView(A, 'view-locked', 20000)
      .catch(() => { throw new Error('Stay unlocked off: a reload should lock'); });
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
    // On again, as a device starts (the flows after this one count on it).
    await stayUnlocked(A, true);
    await A.reload();
    await waitView(A, 'view-notes', 20000).catch(() => { throw new Error('Stay unlocked on again: a reload should open the notes'); });
  } finally {
    Object.assign(shared, { A2 });
  }
}
