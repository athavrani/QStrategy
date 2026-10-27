/**
 * Shared by the NIFTY and SENSEX 09:20 OOBTST locks: reads the 09:20 one-minute candle open of option contracts
 * and plans the automatic lock retry. Both locks rank strikes on that candle open, never on a live price.
 */

import {
  OOBTST_LOCK_RETRY_SEC,
  OOBTST_RETRY_CUTOFF_SEC,
} from './lockFreshness';

const CANDLE_0920_IST_SEC = 9 * 3600 + 20 * 60;
export const CANDLE_FETCH_RETRY_MS = 2000;
export const CANDLE_FETCH_CONCURRENCY = 4;

export interface CandleBars {
  open?: number[];
  start_Time?: number[];
}

/**
 * Open of the 09:20 one-minute candle from a Dhan intraday response, or 0 when that candle is absent.
 * start_Time is epoch seconds, so a 09:20 IST bar is 09:20 after the 5h30 shift.
 */
export function candleOpenAt0920(data: CandleBars | null): number {
  if (!data || !Array.isArray(data.open) || !Array.isArray(data.start_Time)) return 0;
  for (let i = 0; i < data.start_Time.length; i++) {
    const ts = data.start_Time[i];
    const open = data.open[i];
    if (typeof ts === 'number' && typeof open === 'number' && open > 0 && (ts + 19800) % 86400 === CANDLE_0920_IST_SEC) {
      return open;
    }
  }
  return 0;
}

/** opens: above 0 is the 09:20 open, 0 is a confirmed no-trade minute, and a missing key is not known yet. */
export interface CandleOpenState {
  date: string;
  opens: Record<string, number>;
  pending: number;
}

export interface CandleContract {
  key: string;
  secId: string;
  /** Live price, used only to decide what to fetch first and what can be skipped. */
  liveLtp: number;
}

/**
 * The contracts worth fetching, nearest to the target first. Contracts whose live price is far outside the band cannot
 * open inside it, so they are skipped unless `wide`. A contract with no live price is always kept.
 */
export function chooseCandleContracts(
  all: CandleContract[],
  band: { min: number; max: number },
  target: number,
  wide: boolean
): CandleContract[] {
  const lo = band.min * 0.5;
  const hi = band.max * 2;
  const keep = wide ? all : all.filter((c) => !(c.liveLtp > 0) || (c.liveLtp >= lo && c.liveLtp <= hi));
  const distance = (c: CandleContract) => (c.liveLtp > 0 ? Math.abs(c.liveLtp - target) : Number.MAX_SAFE_INTEGER);
  return [...keep].sort((a, b) => distance(a) - distance(b));
}

/**
 * Fetches the 09:20 open of every contract that has no answer yet. A failed request stays unknown and is retried.
 * A response without a 09:20 bar is recorded as 0 (no trade) only once `zeroIsFinal`: before the minute has closed
 * the bar may simply not be published yet, and a permanent 0 would wrongly fail the lock.
 */
export async function fetchCandleOpens(args: {
  state: CandleOpenState;
  contracts: CandleContract[];
  load: (secId: string) => Promise<CandleBars | null>;
  zeroIsFinal: boolean;
  concurrency?: number;
}): Promise<boolean> {
  const { state, contracts, load, zeroIsFinal } = args;
  const size = args.concurrency ?? CANDLE_FETCH_CONCURRENCY;
  const todo = contracts.filter((c) => state.opens[c.key] === undefined);
  for (let i = 0; i < todo.length; i += size) {
    await Promise.all(
      todo.slice(i, i + size).map(async (c) => {
        try {
          const data = await load(c.secId);
          if (!data) return;
          const open = candleOpenAt0920(data);
          if (open > 0) state.opens[c.key] = open;
          else if (zeroIsFinal) state.opens[c.key] = 0;
        } catch {}
      })
    );
  }
  state.pending = contracts.filter((c) => state.opens[c.key] === undefined).length;
  return contracts.length > 0 && state.pending === 0;
}

/** HH:MM:SS IST for a number of seconds after 09:20:00. */
export function clockAfter0920(secsPast: number): string {
  const total = CANDLE_0920_IST_SEC + secsPast;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

/**
 * Plans the automatic retry of a failed lock: one retry 30 s after the failure, and none that would start after 09:21:00.
 * A retry widens the search to every contract in the window.
 */
export class LockRetry {
  private date = '';
  private failedAtSec: number | null = null;
  attempt = 1;
  wide = false;

  sync(date: string): void {
    if (this.date === date) return;
    this.date = date;
    this.attempt = 1;
    this.failedAtSec = null;
    this.wide = false;
  }

  /** Records a failure and returns the text that tells the user when the next attempt happens, if there is one. */
  onFailure(secsPast: number): string {
    if (this.failedAtSec === null) this.failedAtSec = secsPast;
    const at = this.nextRetryAt();
    return at === null ? '' : ` Retrying at ${clockAfter0920(at)} IST.`;
  }

  /** True once, when the retry time has come. */
  due(secsPast: number): boolean {
    const at = this.nextRetryAt();
    if (at === null || secsPast < at) return false;
    this.attempt += 1;
    this.wide = true;
    this.failedAtSec = null;
    return true;
  }

  private nextRetryAt(): number | null {
    if (this.failedAtSec === null) return null;
    const at = this.failedAtSec + OOBTST_LOCK_RETRY_SEC;
    return at <= OOBTST_RETRY_CUTOFF_SEC ? at : null;
  }
}
