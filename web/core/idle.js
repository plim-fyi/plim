// Auto-lock after a period without user activity.
//
// Uses wall-clock time, so a laptop asleep or a phone tab in the background
// counts as idle; the check also runs whenever the tab becomes visible again,
// since background timers are throttled.

export const AUTO_LOCK_OPTIONS = [5, 15, 60, 0]; // minutes; 0 = never
export const DEFAULT_AUTO_LOCK = 15;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'];

export class AutoLock {
  /**
   * onLock() is called once when the limit passes. canLock() can postpone it
   * (e.g. during a phrase change); activity then restarts the countdown.
   */
  constructor({ onLock, canLock = () => true, onActivity = () => {}, now = () => Date.now(), checkEveryMs = 15_000 }) {
    this.onLock = onLock;
    this.canLock = canLock;
    this.now = now;
    this.checkEveryMs = checkEveryMs;
    this.minutes = 0;
    this.last = now();
    this.timer = null;
    this.activity = () => {
      this.touch();
      onActivity(); // e.g. tell other tabs
    };
    this.onVisible = () => !globalThis.document?.hidden && this.check();
  }

  start(minutes) {
    this.stop();
    this.minutes = minutes;
    this.last = this.now();
    if (globalThis.document) {
      for (const t of ACTIVITY_EVENTS) document.addEventListener(t, this.activity, { capture: true, passive: true });
      document.addEventListener('visibilitychange', this.onVisible);
    }
    this.timer = setInterval(() => this.check(), this.checkEveryMs);
  }

  /** Activity elsewhere (another tab): restart the countdown. */
  touch() {
    this.last = this.now();
  }

  setMinutes(minutes) {
    this.minutes = minutes;
    this.last = this.now();
  }

  /** Milliseconds until it locks, or Infinity when auto-lock is off. */
  remaining() {
    return this.minutes > 0 ? this.minutes * 60_000 - (this.now() - this.last) : Infinity;
  }

  check() {
    if (this.timer === null || this.remaining() > 0) return false; // stopped, or not yet
    if (!this.canLock()) {
      this.last = this.now();
      return false;
    }
    this.stop();
    this.onLock();
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (globalThis.document) {
      for (const t of ACTIVITY_EVENTS) document.removeEventListener(t, this.activity, { capture: true });
      document.removeEventListener('visibilitychange', this.onVisible);
    }
  }
}
