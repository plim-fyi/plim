import { closeSettings, mobile, newPage, passkeyFirstTap, s, until, URL, waitView } from './harness.mjs';

/** Flow 1: Create a vault. `shared`: what one flow leaves for the next (web.mjs). */
export default async function flow1(shared) {
  const { profile } = shared;
  let { A, words } = shared;
  try {
    // 1. Create a vault with a passkey (device A)
    A = await newPage(profile, { device: 'Device A' });
    // plim.fyi/ without a vault: a short overview (the long one: about.plim.fyi); Get started: /login.
    await A.goto(URL);
    await waitView(A, 'view-home');
    const home = await A.evaluate(() => ({
      links: [...document.querySelectorAll('#view-home a')].map((a) => `${a.textContent.trim()}→${a.getAttribute('href')}`),
      points: document.querySelectorAll('#view-home .home-points li').length,
    }));
    if (home.points !== 3 || !home.links.includes('Get started→/login') || !home.links.includes('Sign in→/login') || !home.links.some((l) => l.endsWith('→https://about.plim.fyi'))) {
      throw new Error(`the home page: ${JSON.stringify(home)}`);
    }
    await s(A, '01-create-0-home');
    await A.click('#view-home a.button.primary');
    await waitView(A, 'view-welcome');
    if (new globalThis.URL(A.url()).pathname !== '/login') throw new Error(`Get started should open /login: ${A.url()}`);
    await s(A, '01-create-1-welcome');
    await A.click('#btn-create');
    await waitView(A, 'view-passkey');
    await s(A, '01-create-2-passkey');
    await passkeyFirstTap(A);
    await s(A, '01-create-3-confirm-passkey');
    // Signup's proof-of-work runs in the app's WebAssembly (#499): the worker fetches it.
    const wasmFetched = [];
    const onWasm = (r) => r.url().endsWith('/wasm/plim.wasm') && wasmFetched.push(`${r.status()} ${r.headers()['content-type']}`);
    A.on('response', onWasm);
    await A.click('#passkey-go');
    await waitView(A, 'view-notes', 60000);
    A.off('response', onWasm);
    if (wasmFetched[0] !== '200 application/wasm') throw new Error(`signup's worker fetched web/wasm/plim.wasm: ${JSON.stringify(wasmFetched)}`);
    // …and the page's CSP lets it compile (else wasm.js gives null and the JS solver runs).
    const viaWasm = await A.evaluate(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const wasm = await (await import(new URL('core/wasm.js', app))).loadWasm();
      return wasm && wasm.powSolve(new Uint8Array(16), 8);
    });
    if (typeof viaWasm !== 'number') throw new Error(`the app's WebAssembly didn't load under its CSP: ${viaWasm}`);
    // Where it can't load, signup's worker solves in JS instead. Its fetch blocked at the service
    // worker (which fetches for the worker), and the copy the service worker kept dropped. (Not with a
    // second session on the page itself: detaching one there loses the page's virtual passkey.)
    const targets = A.browser().targets().filter((t) => t.type() === 'service_worker');
    if (!targets.length) throw new Error('no service worker to block the WebAssembly at');
    const blocking = await Promise.all(targets.map(async (t) => {
      const c = await t.createCDPSession();
      await c.send('Network.enable');
      await c.send('Network.setBlockedURLs', { urls: ['*/wasm/plim.wasm'] });
      return c;
    }));
    const fallback = await A.evaluate(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const wasmUrl = new URL('wasm/plim.wasm', app).href;
      for (const name of await caches.keys()) await (await caches.open(name)).delete(wasmUrl);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const got = await new Promise((resolve, reject) => {
        const w = new Worker(new URL('core/pow-worker.js', app), { type: 'module' });
        w.onmessage = (e) => (w.terminate(), resolve(e.data));
        w.onerror = (e) => (w.terminate(), reject(new Error(e.message)));
        w.postMessage({ salt, difficulty: 8 });
      });
      const { solve } = await import(new URL('core/pow-worker.js', app));
      return { ...got, right: got.nonce === solve(salt, 8) };
    });
    await Promise.all(blocking.map((c) => c.detach()));
    if (fallback.via !== 'js' || !fallback.right) throw new Error(`signup's worker without its WebAssembly: ${JSON.stringify(fallback)}`);
    await until(A, () => !document.querySelector('#phrase-banner').hidden);
    // New note and your account stay in reach with the banner up (#319: on a phone it covered them).
    const reach = await A.evaluate(() => ['btn-new-foot', 'btn-new', 'btn-account'].map((id) => {
      const b = document.getElementById(id);
      const r = b.getBoundingClientRect();
      if (!r.width) return null; // (not on this screen size)
      const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return b.contains(at) ? null : `${id} is under ${at?.id || at?.className}`;
    }).filter(Boolean));
    if (reach.length) throw new Error(`with "Save your recovery phrase" up: ${reach.join(', ')}`);
    await s(A, '01-create-4-empty');
    // The 12 words it made, from the banner's "Show phrase"
    await A.click('#phrase-banner-show');
    await until(A, () => !document.querySelector('#settings-phrase').hidden);
    words = await A.$$eval('#settings-phrase-words li', (e) => e.map((x) => x.textContent));
    if (words.length !== 12) throw new Error(`expected 12 words, got ${words.length}`);
    await s(A, '05-settings-1-phrase');
    if (mobile(A)) {
      // A phone (#361): the section scrolled to its words, its header still at the top, ‹ Settings and × tappable.
      // (Once the dialog has finished opening: it slides up 6 px and grows to full size, 0.16 s.)
      await until(A, () => getComputedStyle(document.getElementById('settings')).transform === 'none', undefined, 5000);
      const head = await A.evaluate(() => {
        const d = document.getElementById('settings');
        d.scrollTop = d.scrollHeight; // (as far down as it goes)
        const at = (e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)); };
        return { scrolled: d.scrollTop > 0, top: Math.round(document.querySelector('#settings .settings-head').getBoundingClientRect().top),
          back: at(document.getElementById('settings-back')), close: at(document.querySelector('#settings .settings-head [value=close]')) };
      });
      if (!head.scrolled || head.top !== 0 || !head.back || !head.close) throw new Error(`Settings' header on a phone, scrolled: ${JSON.stringify(head)}`);
      await s(A, '05-settings-1b-phrase-scrolled');
    }
    await A.click('#settings-phrase-saved');
    await until(A, () => document.querySelector('#phrase-banner').hidden);
    await closeSettings(A);
  } finally {
    Object.assign(shared, { A, words });
  }
}
