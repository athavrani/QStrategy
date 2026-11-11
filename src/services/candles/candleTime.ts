/** IST helpers for candle bucketing. Everything takes epoch milliseconds so tests can drive the clock. */

export const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export const SESSION_OPEN_SEC = 9 * 3600 + 15 * 60;
export const SESSION_CLOSE_SEC = 15 * 3600 + 30 * 60;

/** YYYY-MM-DD of the IST calendar day. */
export function istDateKey(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Seconds after IST midnight. */
export function istSecOfDay(nowMs: number): number {
  return Math.floor(((nowMs + IST_OFFSET_MS) % 86400000) / 1000);
}

/** Epoch seconds of IST midnight for the day containing `nowMs`. */
export function istDayStartEpoch(nowMs: number): number {
  return Math.floor((nowMs + IST_OFFSET_MS) / 86400000) * 86400 - IST_OFFSET_MS / 1000;
}

/** Epoch seconds at which the minute containing `nowMs` started. */
export function minuteStartEpoch(nowMs: number): number {
  return Math.floor(nowMs / 60000) * 60;
}

/** True on weekdays from 09:15:00 to 15:29:59 IST, the minutes that have a candle. */
export function isCandleSession(nowMs: number): boolean {
  const day = new Date(nowMs + IST_OFFSET_MS).getUTCDay();
  if (day === 0 || day === 6) return false;
  const sec = istSecOfDay(nowMs);
  return sec >= SESSION_OPEN_SEC && sec < SESSION_CLOSE_SEC;
}
