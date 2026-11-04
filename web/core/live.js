// Live sync: one WebSocket that pushes what other devices store, for the docs
// open here (the note index and the open note), so their edits show up at
// once. Uploads still go over HTTP (sync.js). While the socket is down, this
// polls instead (`onPoll`, #261): soon after something happens here, backing
// off while nothing changes; while it's up, a safety poll now and then.
// Protocol: see server/src/live.rs.

import { sawVersion } from './api.js';

const WATCHDOG_MS = 15_000;
const SILENT_MS = 75_000; // the server pings every 30 s: this long without anything, the connection is dead
const CONNECT_MS = 20_000; // a connection that hasn't signed in by then won't
const RETRY_MAX_MS = 30_000;
// Polling, with the socket down: every 5 s after activity, backing off to once a minute while
// nothing changes. With it up: a safety poll every 5 minutes (what's missed is pushed anyway).
const POLL_MIN_MS = 5000;
const POLL_MAX_MS = 60_000;
const POLL_SAFETY_MS = 5 * 60_000;

export class Live {
  /**
   * onChange(connected) is called when the connection comes up or goes down.
   * onPoll() pulls what the socket would have pushed: whether anything came (true), nothing
   * (false: polling slows down), or it couldn't say (undefined: as it was).
   * `guest`: no account (a shared note's page): only shared notes can be followed.
   * `intervals`: { min, max, safety } ms, for the tests.
   */
  constructor(api, { onChange = () => {}, onPoll = null, guest = false, intervals = {} } = {}) {
    this.api = api;
    this.onChange = onChange;
    this.onPoll = onPoll;
    this.guest = guest;
    this.docs = new Map(); // docId → DocSync
    this.ws = null;
    this.ready = false;
    this.stopped = true;
    this.retryMs = 1000;
    this.lastMessage = 0;
    this.pollMin = intervals.min ?? POLL_MIN_MS;
    this.pollMax = intervals.max ?? POLL_MAX_MS;
    this.pollSafety = intervals.safety ?? POLL_SAFETY_MS;
    this.pollDelay = this.pollMin;
    this.pollDue = 0;
    this.polling = false;
    // The tab shown again: a dead connection dropped, and a poll now (what happened meanwhile).
    this.onVisible = () => {
      if (document.hidden) return;
      this.check({ now: true });
      this.wake({ now: true });
    };
  }

  get connected() {
    return this.ready;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdog = setInterval(() => this.check(), WATCHDOG_MS);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
    this.pollDelay = this.pollMin;
    this.schedulePoll(this.pollMin);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    clearTimeout(this.pollTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close();
  }

  // ---- polling, the fallback ----

  schedulePoll(delay) {
    if (this.ready) delay = Math.max(delay, this.pollSafety); // (pushed live: only the safety net)
    clearTimeout(this.pollTimer);
    this.pollDue = Date.now() + delay;
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  /** Something happened here: poll soon (at once with `now`). */
  wake({ now = false } = {}) {
    if (this.stopped) return;
    this.pollDelay = this.pollMin;
    if (now) return this.poll();
    const due = this.pollDue - Date.now();
    if (!this.polling && !(due > 0 && due <= this.pollMin)) this.schedulePoll(this.pollMin);
  }

  /** One poll, then the next scheduled. A hidden tab stops polling until it's shown again. */
  async poll() {
    clearTimeout(this.pollTimer);
    if (this.stopped || !this.onPoll || this.polling || document.hidden) return;
    this.polling = true;
    let changed;
    try {
      changed = await this.onPoll();
    } catch (e) {
      console.warn('poll failed', e);
      changed = false;
    } finally {
      this.polling = false;
    }
    if (changed === true) this.pollDelay = this.pollMin;
    else if (changed === false) this.pollDelay = Math.min(this.pollDelay * 2, this.pollMax);
    if (!this.stopped && !document.hidden) this.schedulePoll(this.pollDelay);
  }

  /** Push this doc's changes from now on (and catch up from its lastSeq). */
  watch(sync) {
    this.docs.set(sync.docId, sync);
    if (this.ready) this.subscribe(sync);
  }

  /** Stop following a doc (only if `sync`, when given, is still the one followed: the doc may have been reopened since). */
  unwatch(docId, sync) {
    if (sync && this.docs.get(docId) !== sync) return;
    if (this.docs.delete(docId) && this.ready) this.send({ unsub: docId });
  }

  connect() {
    if (this.stopped || this.ws) return;
    // No session yet (opened offline): try again later; the app signs in when back online.
    if (!this.guest && !this.api.token) return this.retry();
    const url = new URL('/api/live', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    this.connectedAt = Date.now();
    ws.onopen = () => {
      // Signed in with the first message, not the URL (which ends up in logs);
      // a guest (a shared note's page, no account) only says so.
      if (this.guest) return ws.send(JSON.stringify({ guest: true }));
      this.token = this.api.token;
      ws.send(JSON.stringify({ auth: this.token }));
    };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data));
    ws.onclose = (e) => this.closed(ws, e.code);
  }

  receive(m) {
    this.lastMessage = Date.now();
    const sync = this.docs.get(m.doc);
    if (m.type === 'ready' || m.type === 'ping') sawVersion(m.v); // (is this page out of date: api.js)
    if (m.type === 'ready') {
      this.ready = true;
      this.retryMs = 1000;
      for (const s of this.docs.values()) this.subscribe(s);
      this.onChange(true);
      // Caught up once (a vault opened offline finishes going online here), then pushed: the
      // next poll is the safety net, far off.
      this.wake({ now: true });
    } else if (m.type === 'doc') {
      sync?.applyServer(m).catch((e) => console.warn('live: could not apply', m.doc, e));
      sync?.presence?.resubscribed(); // (re)joined a shared note: say we're here
    } else if (m.type === 'presence') {
      sync?.presence?.receive(m.data); // someone else in a shared note (presence.js)
    } else if (m.type === 'update' || m.type === 'snapshot') {
      sync?.push(m).catch((e) => console.warn('live: could not apply', m.doc, e));
    } else if (m.type === 'resync') {
      sync?.pull().catch(() => {});
    } else if (m.type === 'revoked' || m.type === 'denied') {
      // A shared note's link stopped working (sharesync.js).
      sync?.linkGone?.(m.type);
    } else if (m.type === 'reauth') {
      // The session expired (they last 15 minutes): sign in again and hand over the new token.
      this.renew();
    }
  }

  async renew() {
    await this.api.reauth?.().catch(() => {});
    if (this.ready && this.api.token) {
      this.token = this.api.token;
      this.send({ auth: this.token });
    }
  }

  subscribe(sync) {
    this.send({ ...sync.liveSubscription(), after: sync.lastSeq });
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  async closed(ws, code) {
    if (this.ws !== ws) return;
    this.ws = null;
    const was = this.ready;
    this.ready = false;
    if (was) this.onChange(false);
    if (this.stopped) return;
    if (was) {
      this.pollDelay = this.pollMin; // (polling takes over, soon)
      this.schedulePoll(this.pollMin);
    }
    // The session ended (expired, or the phrase changed): sign in again before reconnecting.
    if (code === 4401) await this.api.reauth?.().catch(() => {});
    this.retry();
  }

  retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  /**
   * Give up on a socket without waiting for it to finish closing. A
   * connection that died silently (a proxy or tunnel dropped it without a
   * word) can take minutes to report that it closed; until then nothing
   * would reconnect.
   */
  drop(ws) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    this.closed(ws, 1006);
  }

  /** Every few seconds, and when the tab comes back: drop a dead connection, follow a new session token. */
  check({ now = false } = {}) {
    if (this.stopped) return;
    if (this.ws && this.ready && Date.now() - this.lastMessage > SILENT_MS) this.drop(this.ws);
    else if (this.ws && !this.ready && Date.now() - this.connectedAt > CONNECT_MS) this.drop(this.ws);
    if (this.ready && this.api.token && this.api.token !== this.token) {
      this.token = this.api.token;
      this.send({ auth: this.token });
    }
    if (!this.ws && now) {
      this.retryMs = 1000;
      clearTimeout(this.retryTimer);
      this.connect();
    }
  }
}
