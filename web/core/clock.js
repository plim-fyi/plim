// The time, as the server's clock has it (#58).
//
// A note's created/updated times (and deletions, history versions) are written
// by the device, and its clock can be wrong: then its notes sort wrongly for
// everyone, and others see "in 5 min". So every API response's Date header
// (api.js) tells how far this clock is off, and times written use the server's.
// Under SKEW_MS off counts as right: Date has whole seconds, and the round trip blurs it.

const SKEW_MS = 10_000;
const MAX_ROUND_TRIP_MS = 10_000; // a slower answer says too little about when it was sent

let offset = 0; // the server's clock minus this device's, in ms

/**
 * The offset a response implies: its Date (whole seconds, so +500 ms) against
 * the middle of the round trip. `current` is kept if the answer was too slow
 * to tell, or the header is missing or garbled.
 */
export function offsetFrom(dateHeader, sentAt, receivedAt, current = 0) {
  const server = Date.parse(dateHeader ?? '');
  if (Number.isNaN(server) || receivedAt - sentAt > MAX_ROUND_TRIP_MS) return current;
  const off = server + 500 - (sentAt + receivedAt) / 2;
  return Math.abs(off) < SKEW_MS ? 0 : Math.round(off);
}

/** api.js: after each response. */
export function sawServerDate(dateHeader, sentAt, receivedAt) {
  offset = offsetFrom(dateHeader, sentAt, receivedAt, offset);
}

/** Now, in ms, by the server's clock (as far as we know it). */
export const now = () => Date.now() + offset;

/** Now, in whole seconds, by the server's clock. */
export const nowSecs = () => Math.floor(now() / 1000);

/** A time to show or sort by: never later than now (a wrong clock elsewhere wrote it). */
export const notAfterNow = (ts, at = now()) => Math.min(ts, at);
