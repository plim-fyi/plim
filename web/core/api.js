// Thin JSON client for the server API.

import { sawServerDate } from './clock.js';

const TIMEOUT_MS = 20_000;

// The version of the web files this page runs, from its scripts' URLs
// (/v/<hash>/…; none when served some other way, e.g. by a test). Every API
// response says the server's (X-Tiro-Version, assets.rs): when they differ,
// the page is out of date — a tab left open across a deploy, or one the
// browser brought back from its back/forward cache — and offers a reload (#134).
const PAGE_VERSION = new URL(import.meta.url).pathname.match(/^\/v\/([0-9a-f]+)\//)?.[1] ?? null;
let outdated = false;
let onOutdated = null;

/** Call `fn` (once) when the server turns out to have a different version of Plim than this page. */
export function whenOutdated(fn) {
  onOutdated = fn;
  if (outdated) fn();
}

/** The server's version, seen somewhere other than an API response (the live socket: live.js). */
export function sawVersion(v) {
  if (outdated || !PAGE_VERSION || !v || v === PAGE_VERSION) return;
  outdated = true;
  onOutdated?.();
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The server can't be reached: fetch rejects with a TypeError (no network)
 * or times out, or a proxy in front answers for it — e.g. Cloudflare's
 * 502/503/504 and 520–530 when the server behind the tunnel is down.
 */
export const isOffline = (e) =>
  e instanceof TypeError ||
  e?.name === 'TimeoutError' ||
  (e instanceof ApiError && ((e.status >= 502 && e.status <= 504) || (e.status >= 520 && e.status <= 530)));

export class Api {
  constructor(base = '') {
    this.base = base;
    this.token = null;
    /**
     * Called on 401 to obtain a fresh session; set by the account layer
     * (also for a vault opened offline, which has no session yet).
     */
    this.reauth = null;
  }

  async request(method, path, body, { keepalive = false, retry = true, headers: extra = {} } = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const sentAt = Date.now();
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
      credentials: 'omit',
      // A connection that hangs (captive portal, dead tunnel) counts as offline.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    sawServerDate(res.headers.get('date'), sentAt, Date.now()); // (how far this device's clock is off: clock.js)
    sawVersion(res.headers.get('x-tiro-version'));
    // Sign in again and retry once — never for the sign-in requests themselves.
    if (res.status === 401 && retry && this.reauth && !path.startsWith('/auth/')) {
      await this.reauth();
      return this.request(method, path, body, { keepalive, retry: false, headers: extra });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body, opts) {
    return this.request('POST', path, body, opts);
  }
}
