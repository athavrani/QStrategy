/** Wall-clock helpers for the 09:20 lock, so it never depends on a stored time that a paused timer left behind. */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const LOCK_BUSY_START_SEC = 9 * 3600 + 18 * 60 + 50;
const LOCK_BUSY_END_SEC = 9 * 3600 + 22 * 60;

export function istSecondsOfDay(now: Date = new Date()): number {
  return Math.floor(((now.getTime() + IST_OFFSET_MS) % 86400000) / 1000);
}

/** "HH:MM:SS IST", the format the clock store and the strategy services read. */
export function istClockString(now: Date = new Date()): string {
  const sec = istSecondsOfDay(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)} IST`;
}

/** Around the 09:20 lock the background task wakes every second; the rest of the day every five. */
export function backgroundTickDelayMs(now: Date = new Date()): number {
  const sec = istSecondsOfDay(now);
  return sec >= LOCK_BUSY_START_SEC && sec <= LOCK_BUSY_END_SEC ? 1000 : 5000;
}

/** The option chains are refreshed from 09:19:00, so the 09:20 lock never starts from a quote that aged while the app was in the background. */
export const LOCK_SYNC_START_SEC = 9 * 3600 + 19 * 60;
export const LOCK_SYNC_END_SEC = 9 * 3600 + 21 * 60 + 10;
export const LOCK_SYNC_INTERVAL_MS = 2000;
/** Outside the lock window the background loop refreshes the chains this often, so quotes stay inside the freshness limit. */
export const BACKGROUND_SYNC_INTERVAL_MS = 8000;

const MARKET_OPEN_SEC = 9 * 3600;
const MARKET_CLOSE_SEC = 15 * 3600 + 30 * 60;

/** True from 09:00 to 15:30 IST on weekdays; the feed is expected to be streaming then. */
export function isMarketHoursIst(now: Date = new Date()): boolean {
  const day = new Date(now.getTime() + IST_OFFSET_MS).getUTCDay();
  if (day === 0 || day === 6) return false;
  const sec = istSecondsOfDay(now);
  return sec >= MARKET_OPEN_SEC && sec <= MARKET_CLOSE_SEC;
}

/** Minimum gap between chain refreshes at this IST second of day, or null when no refresh is due. */
export function chainSyncIntervalMs(sec: number | null): number | null {
  if (sec === null) return null;
  if (sec >= LOCK_SYNC_START_SEC && sec <= LOCK_SYNC_END_SEC) return LOCK_SYNC_INTERVAL_MS;
  if (sec >= MARKET_OPEN_SEC && sec <= MARKET_CLOSE_SEC) return BACKGROUND_SYNC_INTERVAL_MS;
  return null;
}
