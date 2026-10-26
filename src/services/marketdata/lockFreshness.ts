/** A quote older than this is not trusted for the 09:20 strike lock. */
export const LOCK_MAX_QUOTE_AGE_MS = 6000;
/** How long after 09:20:00 the lock keeps waiting for fresh quotes before it fails. */
export const LOCK_RETRY_WINDOW_SEC = 20;
/** Strikes on each side of spot whose contracts are streamed and ranked. */
export const RANK_WINDOW_STRIKES = 10;

/** NIFTY OOBTST locks this many seconds after 09:20:00, once the 09:20 candle has opened and its open can be read. */
export const OOBTST_LOCK_DELAY_SEC = 5;
/** Seconds after 09:20:00 by which the 09:20 candle opens must be available, otherwise the lock fails. */
export const OOBTST_CANDLE_DEADLINE_SEC = 65;
/** A locked OOBTST leg must have a 09:20 candle open inside this premium band. */
export const OOBTST_BAND_MIN = 50;
export const OOBTST_BAND_MAX = 75;

export type LockFreshness = 'FRESH' | 'WAIT' | 'STALE';

export function assessLockFreshness(
  quoteAgesMs: Array<number | undefined>,
  secondsPastLock: number
): LockFreshness {
  const fresh = quoteAgesMs.every((age) => age !== undefined && age <= LOCK_MAX_QUOTE_AGE_MS);
  if (fresh) return 'FRESH';
  return secondsPastLock < LOCK_RETRY_WINDOW_SEC ? 'WAIT' : 'STALE';
}
