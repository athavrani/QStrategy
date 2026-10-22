/** A quote older than this is not trusted for the 09:20 strike lock. */
export const LOCK_MAX_QUOTE_AGE_MS = 6000;
/** How long after 09:20:00 the lock keeps waiting for fresh quotes before it fails. */
export const LOCK_RETRY_WINDOW_SEC = 20;
/** Strikes on each side of spot whose contracts are streamed and ranked. */
export const RANK_WINDOW_STRIKES = 10;

export type LockFreshness = 'FRESH' | 'WAIT' | 'STALE';

export function assessLockFreshness(
  quoteAgesMs: Array<number | undefined>,
  secondsPastLock: number
): LockFreshness {
  const fresh = quoteAgesMs.every((age) => age !== undefined && age <= LOCK_MAX_QUOTE_AGE_MS);
  if (fresh) return 'FRESH';
  return secondsPastLock < LOCK_RETRY_WINDOW_SEC ? 'WAIT' : 'STALE';
}
