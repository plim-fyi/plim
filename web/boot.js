// Loaded before the page's modules, as a plain script: if they fail before the
// page has started (a file that didn't load, or one that doesn't fit the
// others), it says so, with a Reload button, instead of leaving a blank page
// (#134). The page sets `window.plimStarted` once its modules have run, and
// can call `window.plimFatal(title, error)` itself for a failure later on.

// The theme (#21, Settings → Appearance): light, dark, or as the system has it, this device only.
// It's set on <html> as data-theme from here, in <head>, before anything is painted, so a page
// never flashes the other one (style.css's dark colours follow data-theme first, then the
// system). The browser's own bars (theme-color) and form controls (color-scheme) follow too, and
// another tab's choice is taken up as it's made. Settings calls window.plimTheme.
(() => {
  const KEY = 'plim-theme';
  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system'; // (no storage here: as the system has it)
    }
  };
  // (Each theme-color meta's own colour, by the scheme in its media query: what a choice uses.)
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({ m, own: m.content, media: m.media }));
  const colour = (scheme) => metas.find((x) => x.media.includes(scheme))?.own;
  const apply = (choice) => {
    const root = document.documentElement;
    if (choice === 'system') delete root.dataset.theme;
    else root.dataset.theme = choice;
    for (const x of metas) x.m.content = choice === 'system' ? x.own : colour(choice) ?? x.own;
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = choice === 'system' ? 'light dark' : choice;
  };
  apply(read());
  addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) apply(read());
  });
  window.plimTheme = {
    get: read,
    set(choice) {
      try {
        if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice);
        else localStorage.removeItem(KEY);
      } catch {
        // (no storage: it holds until this page closes)
      }
      apply(choice === 'light' || choice === 'dark' ? choice : 'system');
    },
  };
})();

(() => {
  function show(title, detail) {
    const render = () => {
      if (document.getElementById('fatal')) return; // (the first failure is the one to show)
      const box = document.createElement('div');
      box.id = 'fatal';
      box.className = 'fatal';
      box.setAttribute('role', 'alert');
      const h = document.createElement('h2');
      h.textContent = title;
      const p = document.createElement('p');
      p.textContent = 'Your notes are safe: what you wrote is kept on this device until it reaches the server. Reloading usually fixes this.';
      const d = document.createElement('p');
      d.className = 'fatal-detail';
      d.textContent = detail;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'primary';
      b.textContent = 'Reload';
      b.addEventListener('click', () => location.reload());
      box.append(h, p, d, b);
      document.body.append(box);
    };
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  window.plimFatal = (title, err) => {
    console.error(err);
    show(title, String(err?.message ?? err ?? ''));
  };

  // (Capturing: a script or stylesheet that fails to load reports on its element, not the window.)
  addEventListener(
    'error',
    (e) => {
      if (window.plimStarted) return;
      // Only Plim's own scripts. Others aren't its: a proxy in front can add one (Cloudflare's
      // Web Analytics beacon), which the page's CSP then refuses, and the page is fine without it.
      const own = (url) => {
        try {
          return new URL(url, location.href).origin === location.origin;
        } catch {
          return false;
        }
      };
      const el = e.target;
      if (el instanceof HTMLScriptElement) {
        if (own(el.src)) show('Plim couldn’t start', `Couldn’t load ${new URL(el.src).pathname}`);
        return;
      }
      if (e instanceof ErrorEvent && (!e.filename || own(e.filename))) show('Plim couldn’t start', e.message || 'A script failed.');
      // (Other elements failing, e.g. an image, don't stop the page.)
    },
    true,
  );
})();
