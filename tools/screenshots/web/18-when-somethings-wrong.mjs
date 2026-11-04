import { backToList, newPage, rowMenu, s, server, unlockWithPasskey, until } from './harness.mjs';
import { wait } from '../server.mjs';

/** Flow 18: When something's wrong. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow18(shared) {
  const { A, profile } = shared;
  // 18. When something's wrong (#134): a page out of date offers a reload; a note that can't
  // open says why, where it would be; scripts that don't load say so, not a blank page.
  {
    // Out of date: the server's answers name other web files than the page's (as after a deploy).
    await A.bringToFront();
    await backToList(A);
    const otherVersion = async (req) => {
      if (!req.url().includes('/api/')) return req.continue();
      try {
        const res = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() });
        const headers = Object.fromEntries(res.headers);
        delete headers['content-encoding'];
        delete headers['content-length'];
        headers['x-tiro-version'] = '0123456789ab';
        await req.respond({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
      } catch {
        await req.continue().catch(() => {});
      }
    };
    await A.setRequestInterception(true);
    A.on('request', otherVersion);
    // (A poll now: the tab "shown again". Again until one goes out, if one was already under way.)
    for (let tries = 0; await A.evaluate(() => document.getElementById('update-banner').hidden); tries++) {
      if (tries === 30) throw new Error('an out-of-date page should offer a reload');
      await A.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await wait(1000);
    }
    // A toast meanwhile ("Link copied") goes above the banner, not over it (#319).
    await A.evaluate(() => { navigator.clipboard.writeText = () => Promise.resolve(); });
    await rowMenu(A, '#note-list li[data-id]');
    await A.click('#note-menu-link');
    await until(A, () => !document.getElementById('toast').hidden, undefined, 5000);
    const stacked = await A.evaluate(() => {
      const t = document.getElementById('toast').getBoundingClientRect(), b = document.getElementById('update-banner').getBoundingClientRect();
      return { toast: [Math.round(t.top), Math.round(t.bottom)], banner: [Math.round(b.top), Math.round(b.bottom)], apart: t.bottom <= b.top || t.right <= b.left || t.left >= b.right };
    });
    if (!stacked.apart) throw new Error(`a toast with the update banner up should be above it: ${JSON.stringify(stacked)}`);
    await s(A, '18-trouble-1-updated');
    A.off('request', otherVersion);
    await A.setRequestInterception(false);

    // A note that can't open: here, a shared note whose keys are made to fail (from the next load on).
    await A.evaluateOnNewDocument(() => {
      if (!crypto.subtle) return; // (a plain-http page in the tab, like flow 32's stand-in connector: nothing to wrap)
      const importKey = crypto.subtle.importKey.bind(crypto.subtle);
      crypto.subtle.importKey = (...args) =>
        sessionStorage.getItem('test-fail-keys') && /shareKeys/.test(new Error().stack)
          ? Promise.reject(new Error('the note’s keys didn’t load (made to fail by the test)'))
          : importKey(...args);
    });
    await A.evaluate(() => sessionStorage.setItem('test-fail-keys', '1'));
    await Promise.all([A.waitForNavigation(), A.click('#update-reload')]);
    await unlockWithPasskey(A);
    if (await A.evaluate(() => !document.getElementById('update-banner').hidden)) throw new Error('the reload should bring the page up to date');
    for (const b of await A.$$('#note-list li > button:first-child')) {
      if ((await b.evaluate((e) => e.querySelector('.title').textContent)) === 'Reading list') await b.click();
    }
    await until(A, () => !document.getElementById('empty-detail').hidden && !document.getElementById('empty-reload').hidden, undefined, 15000)
      .catch(() => { throw new Error('a note that fails to open should say so'); });
    await s(A, '18-trouble-2-note-failed');
    await A.evaluate(() => sessionStorage.removeItem('test-fail-keys'));
    await Promise.all([A.waitForNavigation(), A.click('#empty-reload')]);
    await unlockWithPasskey(A);
    A.errors = A.errors.filter((e) => !e.includes('made to fail by the test'));

    // Scripts that don't load (here, one of the app's modules): a message and Reload, not a blank page.
    const P = await newPage(profile, { device: 'A browser that can\'t load a script' });
    await P.setRequestInterception(true);
    P.on('request', (r) => (/\/v\/[0-9a-f]+\/core\/history\.js$/.test(r.url()) ? r.abort() : r.continue()));
    await P.goto(server.url);
    await until(P, () => document.getElementById('fatal')?.getClientRects().length > 0, undefined, 15000)
      .catch(() => { throw new Error('a script that fails to load should say so'); });
    await s(P, '18-trouble-3-couldnt-start');
    await P.browserContext().close();
  }
}
