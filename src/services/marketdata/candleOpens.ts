/**
 * Shared by the NIFTY and SENSEX 09:20 OOBTST locks: reads the 09:20 one-minute candle open of option contracts
 * and plans the automatic lock retry. Both locks rank strikes on that candle open, never on a live price.
 */

import {
  LOCK_MAX_QUOTE_AGE_MS,
  OOBTST_LOCK_DELAY_SEC,
  OOBTST_LOCK_RETRY_SEC,
  OOBTST_RETRY_CUTOFF_SEC,
} from './lockFreshness';
import type { OobtstCandidateStrike } from '../../strategies/types';

export const CANDLE_0920_IST_SEC = 9 * 3600 + 20 * 60;
export const CANDLE_0925_IST_SEC = 9 * 3600 + 25 * 60;
const BREAKOUT_CUTOFF_IST_SEC = 9 * 3600 + 45 * 60;
const MARKET_CLOSE_IST_SEC = 15 * 3600 + 30 * 60;
export const CANDLE_FETCH_RETRY_MS = 2000;
export const CANDLE_FETCH_CONCURRENCY = 4;

export interface CandleBars {
  open?: number[];
  start_Time?: number[];
}

/**
 * Open of the one-minute candle that starts at `istSec` (seconds after IST midnight), or 0 when that candle is absent.
 * start_Time is epoch seconds, so a 09:20 IST bar is 09:20 after the 5h30 shift.
 */
function candleOpenAtMinute(data: CandleBars | null, istSec: number): number {
  if (!data || !Array.isArray(data.open) || !Array.isArray(data.start_Time)) return 0;
  for (let i = 0; i < data.start_Time.length; i++) {
    const ts = data.start_Time[i];
    const open = data.open[i];
    if (typeof ts === 'number' && typeof open === 'number' && open > 0 && (ts + 19800) % 86400 === istSec) {
      return open;
    }
  }
  return 0;
}

/** Open of the 09:20 one-minute candle from a Dhan intraday response, or 0 when that candle is absent. */
export function candleOpenAt0920(data: CandleBars | null): number {
  return candleOpenAtMinute(data, CANDLE_0920_IST_SEC);
}

/** The Retry button's price: the open of the lock minute, else of the minute after it. */
export function openAtOrAfter(istSec: number): (data: CandleBars | null) => number {
  return (data) => candleOpenAtMinute(data, istSec) || candleOpenAtMinute(data, istSec + 60);
}

/** Both candle minutes of a Retry lookup have closed, so a missing bar means no trade rather than not yet published. */
export function zeroIsFinalAfter(totalSeconds: number, lockSec: number): boolean {
  return totalSeconds >= lockSec + 2 * 60 + 2;
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
  pick?: (data: CandleBars | null) => number;
}): Promise<boolean> {
  const { state, contracts, load, zeroIsFinal } = args;
  const pick = args.pick ?? candleOpenAt0920;
  const size = args.concurrency ?? CANDLE_FETCH_CONCURRENCY;
  const todo = contracts.filter((c) => state.opens[c.key] === undefined);
  for (let i = 0; i < todo.length; i += size) {
    await Promise.all(
      todo.slice(i, i + size).map(async (c) => {
        try {
          const data = await load(c.secId);
          if (!data) return;
          const open = pick(data);
          if (open > 0) state.opens[c.key] = open;
          else if (zeroIsFinal) state.opens[c.key] = 0;
        } catch {}
      })
    );
  }
  state.pending = contracts.filter((c) => state.opens[c.key] === undefined).length;
  return contracts.length > 0 && state.pending === 0;
}

/** Every contract's lock-time open for the Retry button, or null unless all of them answered (a failed request is tried once more). */
export async function fetchRetryOpens(args: {
  contracts: CandleContract[];
  load: (secId: string) => Promise<CandleBars | null>;
  pick: (data: CandleBars | null) => number;
  zeroIsFinal: boolean;
}): Promise<Record<string, number> | null> {
  const state: CandleOpenState = { date: '', opens: {}, pending: 0 };
  for (let pass = 0; pass < 2; pass++) {
    if (await fetchCandleOpens({ ...args, state })) return state.opens;
  }
  return null;
}

/** HH:MM:SS for seconds after IST midnight. */
export function istClock(totalSeconds: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(totalSeconds / 3600))}:${p(Math.floor((totalSeconds % 3600) / 60))}:${p(totalSeconds % 60)}`;
}

/** HH:MM:SS IST for a number of seconds after 09:20:00. */
export function clockAfter0920(secsPast: number): string {
  return istClock(CANDLE_0920_IST_SEC + secsPast);
}

export interface ManualLockResult {
  ok: boolean;
  message: string;
}

export const MANUAL_RETRY_WINDOW_MESSAGE = 'Retry is available from 09:20:05 until 15:30 IST.';
export const MANUAL_BREAKOUT_WINDOW_MESSAGE = 'Retry is available from 09:25 until 09:45 IST.';

/** A manual retry makes sense once the 09:20 lock has had its chance, until the market closes. */
export function canRetryLock(totalSeconds: number): boolean {
  return totalSeconds >= CANDLE_0920_IST_SEC + OOBTST_LOCK_DELAY_SEC && totalSeconds < MARKET_CLOSE_IST_SEC;
}

/** The breakout lock only matters while its entry window is open. */
export function canRetryBreakoutLock(totalSeconds: number): boolean {
  return totalSeconds >= CANDLE_0925_IST_SEC && totalSeconds < BREAKOUT_CUTOFF_IST_SEC;
}

/** The first candidate priced inside the band from a quote taken just now; a manual lock never uses an old price. */
export function pickFreshInBand(list: OobtstCandidateStrike[], band: { min: number; max: number }): OobtstCandidateStrike | null {
  return list.find((c) => c.quoteAgeMs <= LOCK_MAX_QUOTE_AGE_MS && c.ltp >= band.min && c.ltp <= band.max) ?? null;
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
