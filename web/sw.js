// Service worker: lets Plim open without a connection.
//
// - The page (/, and a note's address /n/<id>, #299: the same page), and a
//   shared note's page (/s/<id>), are fetched from the network first, so an
//   update shows up as soon as it's deployed; the last good copy is used when
//   the server can't be reached (no network, or a proxy error page such as
//   Cloudflare's 502): a bookmarked note opens offline.
// - Files under /v/<hash>/ never change for a given hash, so they're served
//   from the cache once fetched. Only the current and previous hash are kept.
// - Nothing else is cached: the API always goes to the network.
//
// Served unversioned at /sw.js, so its scope is the whole site.

const PAGE_CACHE = 'tiro-page';
const ASSET_PREFIX = 'tiro-v-';
const ASSET_PATH = /^\/v\/([0-9a-f]+)\//; // a request for a versioned file
const PAGE_HASH = /\/v\/([0-9a-f]+)\//; // the version a page links to

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // A shared note's page (/s/<id>): one page for every share, kept apart from the app's.
  if (url.pathname.startsWith('/s/')) {
    e.respondWith(sharePage(req));
    return;
  }
  // The app's page: at / and at a note's address (any navigation that isn't a share's: one page, cached once).
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/n/')) {
    e.respondWith(page(req));
    return;
  }
  const m = url.pathname.match(ASSET_PATH);
  if (m) e.respondWith(asset(req, m[1]));
});

// On the first visit the page loads before this worker exists, so nothing
// went through it: the page sends what it loaded, to be cached now.
// (`page`: which page sent it, the app's or a shared note's.)
self.addEventListener('message', (e) => {
  if (e.data?.type === 'precache') e.waitUntil(precache(e.data.urls ?? [], e.data.page));
});

async function precache(urls, path = '/') {
  const share = path.startsWith('/s/');
  const cache = await caches.open(PAGE_CACHE);
  if (!(await cache.match(share ? '/s/' : '/'))) await (share ? sharePage : page)(new Request(path)).catch(() => {});
  for (const url of urls) {
    const m = new URL(url, self.location.origin).pathname.match(ASSET_PATH);
    if (m) await asset(new Request(url), m[1]).catch(() => {});
  }
}

/**
 * A shared note's page: from the network first; offline, the last one saved
 * (the same page serves every share — the share ID and key are in the URL).
 * Never stored as the app's page.
 */
const sharePage = (req) => networkFirst(req, '/s/');
const page = (req) => networkFirst(req, '/');

async function networkFirst(req, key) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) {
      const previous = await cache.match(key);
      await cache.put(key, res.clone());
      await prune(versionOf(await previous?.text()));
      return res;
    }
    // A proxy's error page (server down behind it): prefer the saved page.
    return (await cache.match(key)) ?? res;
  } catch (err) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw err;
  }
}

const versionOf = (html) => html?.match(PAGE_HASH)?.[1];

async function asset(req, hash) {
  const cache = await caches.open(ASSET_PREFIX + hash);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

/**
 * Drop asset caches no saved page uses: the app's, the shared-note page's,
 * and `previous` (a page that's still open may be from the version before).
 */
async function prune(previous) {
  const cache = await caches.open(PAGE_CACHE);
  const keep = [previous];
  for (const key of ['/', '/s/']) keep.push(versionOf(await (await cache.match(key))?.text()));
  for (const name of await caches.keys()) {
    if (name.startsWith(ASSET_PREFIX) && !keep.includes(name.slice(ASSET_PREFIX.length))) await caches.delete(name);
  }
}
