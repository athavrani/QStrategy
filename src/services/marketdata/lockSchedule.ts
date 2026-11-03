/** Wall-clock helpers for the 09:20 lock, so it never depends on a stored time that a paused timer left behind. */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const LOCK_BUSY_START_SEC = 9 * 3600 + 19 * 60 + 50;
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
