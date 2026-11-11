/**
 * Records one-minute candles (open, high, low, close, volume, OI) of the four indexes and of the options around them.
 *
 * Capture is hybrid: during the session candles are built from live ticks (LIVE); after 15:30 the exchange candles are
 * read from Dhan and replace them (API), which also fills any minute the app missed while it was in the background.
 * Nothing here owns a timer: `tick()` is called from the app clock, which also runs from the background service.
 */

import { CandleAggregator, type LiveBar } from './CandleAggregator';
import type { CandleInstrument } from './CandleRepository';
import { isCandleSession, istDateKey, istDayStartEpoch, istSecOfDay } from './candleTime';
import { instrumentKey } from '../marketdata/types';
import type { MarketDataService } from '../marketdata/MarketDataService';
import type { CandleRepository } from './CandleRepository';

export const CANDLE_OWNER = 'candles';
/** Strikes on each side of the money whose options are recorded. */
export const WINDOW_STRIKES = 5;

const FLUSH_EVERY_MS = 5000;
/** Until every index has a chain, selection runs this often (the option chain API allows one request per 3 s). */
const SELECT_WARMUP_MS = 5000;
const SELECT_STEADY_MS = 15000;
const CHAIN_MIN_GAP_MS = 3500;
const CHAIN_REFETCH_MS = 30 * 60 * 1000;
const RECONCILE_START_SEC = 15 * 3600 + 31 * 60;
const RECONCILE_RETRY_MS = 5 * 60 * 1000;
const RECONCILE_MAX_ATTEMPTS = 3;
const RECONCILE_GAP_MS = 250;
const DAY_SECONDS = 86400;

interface UnderlyingConfig {
  name: string;
  scripId: string;
  optionSegment: 'NSE_FNO' | 'BSE_FNO';
  step: number;
}

export const CANDLE_UNDERLYINGS: UnderlyingConfig[] = [
  { name: 'NIFTY', scripId: '13', optionSegment: 'NSE_FNO', step: 50 },
  { name: 'BANKNIFTY', scripId: '25', optionSegment: 'NSE_FNO', step: 100 },
  { name: 'FINNIFTY', scripId: '27', optionSegment: 'NSE_FNO', step: 50 },
  { name: 'SENSEX', scripId: '51', optionSegment: 'BSE_FNO', step: 100 },
];

export interface IntradayBars {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  start_Time?: number[];
  open_interest?: number[];
}

export interface LockedContract {
  underlying: string;
  segment: 'NSE_FNO' | 'BSE_FNO';
  type: 'CE' | 'PE';
  strike: number;
  secId: string;
  expiry: string;
}

type ChainRows = Record<number, { ceSecId?: string; peSecId?: string }>;

export interface CandleRecorderDeps {
  repo: Pick<CandleRepository, 'upsertLive' | 'replaceApi' | 'saveInstruments' | 'getInstruments' | 'pruneBefore'>;
  market: Pick<MarketDataService, 'acquire' | 'releaseOwner' | 'onBatch' | 'getQuote'>;
  fetchExpiryList: (underlying: string) => Promise<string[] | null>;
  fetchChain: (expiry: string, underlying: string) => Promise<{ oc: ChainRows } | null>;
  fetchCandles: (
    secId: string,
    segment: string,
    instrument: 'INDEX' | 'OPTIDX',
    fromDate: string,
    toDate: string,
    withOi: boolean
  ) => Promise<IntradayBars | null>;
  getLockedContracts: () => LockedContract[];
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ReconcileResult {
  instruments: number;
  rows: number;
  failed: number;
}

/** Converts Dhan's intraday response into bars of one instrument, keeping only minutes inside [fromTs, toTs). */
export function parseIntradayBars(instKey: string, data: IntradayBars | null, fromTs: number, toTs: number): LiveBar[] {
  if (!data || !Array.isArray(data.start_Time) || !Array.isArray(data.open)) return [];
  const bars: LiveBar[] = [];
  for (let i = 0; i < data.start_Time.length; i++) {
    const ts = data.start_Time[i];
    const open = data.open[i];
    const high = data.high?.[i];
    const low = data.low?.[i];
    const close = data.close?.[i];
    if (typeof ts !== 'number' || ts < fromTs || ts >= toTs) continue;
    if (![open, high, low, close].every((v) => typeof v === 'number' && v > 0)) continue;
    bars.push({
      instKey,
      ts,
      open,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: Math.max(0, Number(data.volume?.[i] ?? 0) || 0),
      oi: Math.max(0, Number(data.open_interest?.[i] ?? 0) || 0),
    });
  }
  return bars;
}

/** The nearest expiry that has not passed; an expiry falling today still counts. */
export function pickNearestExpiry(list: string[], todayKey: string): string | null {
  if (list.length === 0) return null;
  const upcoming = list.filter((d) => d >= todayKey).sort();
  return upcoming[0] ?? [...list].sort()[0];
}

interface TrackedContract extends Omit<CandleInstrument, 'tradeDate'> {}

export class CandleRecorder {
  private readonly aggregator = new CandleAggregator();
  private readonly contracts = new Map<string, TrackedContract>();
  private readonly chains = new Map<string, { expiry: string; rows: ChainRows; fetchedAt: number }>();
  private readonly expiries = new Map<string, string>();
  private tradeDate = '';
  private ready = false;
  private starting: Promise<void> | null = null;
  private detach: (() => void) | null = null;
  private lastFlushAt = 0;
  private flushing = false;
  private lastSelectAt = 0;
  private selecting = false;
  private lastChainFetchAt = 0;
  private reconciling = false;
  private reconciled = false;
  private reconcileAttempts = 0;
  private nextReconcileAt = 0;

  constructor(private readonly deps: CandleRecorderDeps) {}

  /** Idempotent. Restores today's instruments after a restart and starts listening to ticks. */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.initDay(this.deps.now()).then(() => {
        this.detach = this.deps.market.onBatch(this.handleBatch);
      });
    }
    return this.starting;
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
    this.deps.market.releaseOwner(CANDLE_OWNER);
    this.contracts.clear();
    this.aggregator.reset();
    this.ready = false;
    this.starting = null;
  }

  getTrackedKeys(): string[] {
    return [...this.contracts.keys()];
  }

  /** Called every second from the app clock; decides what is due. */
  tick(): void {
    if (!this.ready) return;
    const now = this.deps.now();
    const today = istDateKey(now);
    if (today !== this.tradeDate) {
      this.ready = false;
      void this.initDay(now).catch(() => {});
      return;
    }
    if (now - this.lastFlushAt >= FLUSH_EVERY_MS) void this.flush().catch(() => {});

    const sec = istSecOfDay(now);
    const warm = this.chains.size < CANDLE_UNDERLYINGS.length;
    const selectEvery = warm ? SELECT_WARMUP_MS : SELECT_STEADY_MS;
    if (sec >= 9 * 3600 && sec < RECONCILE_START_SEC && now - this.lastSelectAt >= selectEvery) {
      void this.refreshSelection().catch(() => {});
    }
    if (sec >= RECONCILE_START_SEC && !this.reconciled && now >= this.nextReconcileAt) {
      void this.reconcileDay().catch(() => {});
    }
  }

  /** Writes the bars that changed since the last flush. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    this.lastFlushAt = this.deps.now();
    const bars = this.aggregator.takeDirty();
    try {
      if (bars.length > 0) await this.deps.repo.upsertLive(bars);
    } catch {
      this.aggregator.requeue(bars);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Picks the contracts to record: the indexes, the options within WINDOW_STRIKES of the money, and the locked
   * strikes. A contract stays recorded for the rest of the day even after the money moves away from it.
   */
  async refreshSelection(): Promise<void> {
    if (this.selecting) return;
    this.selecting = true;
    this.lastSelectAt = this.deps.now();
    try {
      const today = this.tradeDate;
      const wanted: TrackedContract[] = [];
      let fetchedThisPass = false;

      for (const u of CANDLE_UNDERLYINGS) {
        const spot = this.deps.market.getQuote('IDX_I', u.scripId)?.ltp;
        if (!(spot && spot > 0)) continue;
        const atm = Math.round(spot / u.step) * u.step;
        let cache = this.chains.get(u.name);
        const stale = !cache || this.deps.now() - cache.fetchedAt > CHAIN_REFETCH_MS || !cache.rows[atm];
        if (stale && !fetchedThisPass && this.deps.now() - this.lastChainFetchAt >= CHAIN_MIN_GAP_MS) {
          fetchedThisPass = true;
          this.lastChainFetchAt = this.deps.now();
          const fresh = await this.loadChain(u, today);
          if (fresh) {
            cache = fresh;
            this.chains.set(u.name, fresh);
          }
        }
        if (!cache) continue;
        for (let i = -WINDOW_STRIKES; i <= WINDOW_STRIKES; i++) {
          const strike = atm + i * u.step;
          const row = cache.rows[strike];
          if (!row) continue;
          if (row.ceSecId) wanted.push(this.option(u.name, u.optionSegment, 'CE', strike, row.ceSecId, cache.expiry));
          if (row.peSecId) wanted.push(this.option(u.name, u.optionSegment, 'PE', strike, row.peSecId, cache.expiry));
        }
      }

      for (const l of this.deps.getLockedContracts()) {
        wanted.push(this.option(l.underlying, l.segment, l.type, l.strike, l.secId, l.expiry));
      }
      await this.register(wanted);
    } finally {
      this.selecting = false;
    }
  }

  /** Replaces the tick-built candles with Dhan's exchange candles for today. Safe to repeat. */
  async reconcileDay(): Promise<ReconcileResult> {
    const result: ReconcileResult = { instruments: 0, rows: 0, failed: 0 };
    if (this.reconciling) return result;
    this.reconciling = true;
    try {
      await this.flush();
      const date = this.tradeDate;
      const dayStart = istDayStartEpoch(this.deps.now());
      for (const c of [...this.contracts.values()]) {
        result.instruments++;
        const isIndex = c.kind === 'INDEX';
        const data = await this.deps.fetchCandles(
          c.securityId,
          c.segment,
          isIndex ? 'INDEX' : 'OPTIDX',
          `${date} 09:15:00`,
          `${date} 15:30:00`,
          !isIndex
        );
        if (data === null) {
          result.failed++;
        } else {
          const bars = parseIntradayBars(c.instKey, data, dayStart, dayStart + DAY_SECONDS);
          await this.deps.repo.replaceApi(bars);
          result.rows += bars.length;
        }
        await this.deps.sleep(RECONCILE_GAP_MS);
      }

      this.reconcileAttempts++;
      if (result.failed === 0 || this.reconcileAttempts >= RECONCILE_MAX_ATTEMPTS) {
        this.reconciled = true;
        if (result.failed === 0) await this.deps.storage.setItem(this.reconcileKey(date), '1').catch(() => {});
      } else {
        this.nextReconcileAt = this.deps.now() + RECONCILE_RETRY_MS;
      }
      if (result.failed > 0) {
        console.warn(`[Candles] end-of-day reconcile: ${result.failed} of ${result.instruments} instruments failed`);
      }
      return result;
    } finally {
      this.reconciling = false;
    }
  }

  private async initDay(now: number): Promise<void> {
    this.tradeDate = istDateKey(now);
    this.deps.market.releaseOwner(CANDLE_OWNER);
    this.contracts.clear();
    this.chains.clear();
    this.expiries.clear();
    this.aggregator.reset();
    this.reconciled = false;
    this.reconcileAttempts = 0;
    this.nextReconcileAt = 0;

    await this.deps.repo.pruneBefore(istDayStartEpoch(now), this.tradeDate).catch(() => {});
    this.reconciled = (await this.deps.storage.getItem(this.reconcileKey(this.tradeDate)).catch(() => null)) === '1';

    const indexes: TrackedContract[] = CANDLE_UNDERLYINGS.map((u) => ({
      instKey: instrumentKey('IDX_I', u.scripId),
      segment: 'IDX_I',
      securityId: u.scripId,
      underlying: u.name,
      kind: 'INDEX',
      strike: null,
      expiry: null,
      symbol: u.name,
    }));
    const saved = await this.deps.repo.getInstruments(this.tradeDate).catch(() => [] as CandleInstrument[]);
    await this.register([...indexes, ...saved], false);
    this.ready = true;
  }

  private async loadChain(u: UnderlyingConfig, today: string) {
    let expiry = this.expiries.get(u.name);
    if (!expiry) {
      const list = await this.deps.fetchExpiryList(u.name);
      expiry = (list && pickNearestExpiry(list, today)) || undefined;
      if (!expiry) return null;
      this.expiries.set(u.name, expiry);
    }
    const res = await this.deps.fetchChain(expiry, u.name);
    if (!res || !res.oc || Object.keys(res.oc).length === 0) return null;
    return { expiry, rows: res.oc, fetchedAt: this.deps.now() };
  }

  private option(
    underlying: string,
    segment: string,
    kind: 'CE' | 'PE',
    strike: number,
    secId: string,
    expiry: string
  ): TrackedContract {
    return {
      instKey: instrumentKey(segment, secId),
      segment,
      securityId: String(secId),
      underlying,
      kind,
      strike,
      expiry,
      symbol: `${underlying} ${strike} ${kind}`,
    };
  }

  /** Subscribes contracts not yet tracked and remembers them so a restart can pick them up again. */
  private async register(list: TrackedContract[], persist = true): Promise<void> {
    const fresh: TrackedContract[] = [];
    for (const c of list) {
      if (this.contracts.has(c.instKey)) continue;
      this.contracts.set(c.instKey, c);
      fresh.push(c);
    }
    if (fresh.length === 0) return;
    this.deps.market.acquire(
      CANDLE_OWNER,
      fresh.map((c) => ({ exchangeSegment: c.segment, securityId: c.securityId }))
    );
    if (persist) {
      await this.deps.repo
        .saveInstruments(fresh.map((c) => ({ ...c, tradeDate: this.tradeDate })))
        .catch(() => {});
    }
  }

  private reconcileKey(date: string): string {
    return `@qstrategy_candles_reconciled_${date}`;
  }

  private handleBatch = (batch: Record<string, unknown>): void => {
    const now = this.deps.now();
    if (!isCandleSession(now)) return;
    for (const key of Object.keys(batch)) {
      if (!this.contracts.has(key)) continue;
      const p = batch[key] as { ltp?: number; volume?: number; oi?: number };
      if (p.ltp !== undefined && p.ltp > 0) this.aggregator.ingest(key, p.ltp, now, p.volume, p.oi);
      else if (p.oi !== undefined) this.aggregator.noteOi(key, p.oi);
    }
  };
}
