/**
 * Live option-chain state shared by every index strategy service: latest REST chain snapshot,
 * tick-driven LTP updates, quote freshness and the ref-counted feed subscriptions of the candidate contracts.
 */

import { dhanDirectService } from '../dhanDirectService';
import { marketData } from './MarketDataService';
import type { MarketDataService } from './MarketDataService';
import type { InstrumentSubscription } from '../dhan/DhanBinaryCodec';
import { Freshness } from './types';

export interface OptionChainRow {
  ceLtp: number;
  peLtp: number;
  ceOi: number;
  peOi: number;
  ceIv?: number;
  peIv?: number;
  ceBid?: number;
  ceAsk?: number;
  peBid?: number;
  peAsk?: number;
  ceSecId?: string;
  peSecId?: string;
  ceUpdatedTime?: number;
  peUpdatedTime?: number;
}

export type OptionChainRows = Record<number, OptionChainRow>;

interface ChainFetchResult {
  spotPrice?: number;
  oc: OptionChainRows;
}

export interface OptionChainFeedConfig {
  /** Subscription owner id on the feed, e.g. 'nifty-options'. */
  owner: string;
  underlying: string;
  optionSegment: 'NSE_FNO' | 'BSE_FNO';
  /** Spot used to pick candidate contracts to stream when no live spot is known yet. */
  fallbackSpot: number;
  /** Also streams every contract within `strikes` steps of spot so candidate ranking compares live prices. */
  streamWindow?: { step: number; strikes: number };
  resolveExpiryYmd: () => string;
  selectCandidates: (spot: number) => {
    ceCandidates: Array<{ securityId?: string | number }>;
    peCandidates: Array<{ securityId?: string | number }>;
  };
}

export interface OptionChainFeedDeps {
  fetchChain?: (expiryYmd: string, underlying: string) => Promise<ChainFetchResult | null>;
  market?: Pick<MarketDataService, 'acquire' | 'release' | 'isConnected'>;
  now?: () => number;
}

export const CHAIN_FRESH_MAX_AGE_MS = 5000;
export const CHAIN_AGING_MAX_AGE_MS = 15000;

export class OptionChainFeed {
  chain: OptionChainRows | null = null;
  lastSpot: number | null = null;
  lastSyncTime = 0;

  private streamed = new Map<string, InstrumentSubscription>();
  private inflight: Promise<boolean> | null = null;
  private readonly fetchChain: NonNullable<OptionChainFeedDeps['fetchChain']>;
  private readonly market: NonNullable<OptionChainFeedDeps['market']>;
  private readonly now: () => number;

  constructor(private readonly config: OptionChainFeedConfig, deps: OptionChainFeedDeps = {}) {
    this.fetchChain = deps.fetchChain ?? ((expiry, underlying) => dhanDirectService.fetchOptionChain(expiry, underlying));
    this.market = deps.market ?? marketData;
    this.now = deps.now ?? Date.now;
  }

  /** Concurrent callers share one in-flight sync. Other underlyings are fetched but never stored here. */
  sync(ticker: string = this.config.underlying): Promise<boolean> {
    if (ticker.toUpperCase() !== this.config.underlying) {
      return this.fetchOnly(ticker);
    }
    if (!this.inflight) {
      this.inflight = this.doSync().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  getLiveOptionPrice(strike: number, type: 'CE' | 'PE'): number {
    const row = this.chain?.[strike];
    if (!row) return 0;
    const price = type === 'CE' ? row.ceLtp : row.peLtp;
    return price > 0 ? price : 0;
  }

  getQuoteFreshness(): Freshness {
    if (!this.market.isConnected()) return 'DISCONNECTED';
    if (!this.lastSyncTime) return 'STALE';
    const age = this.now() - this.lastSyncTime;
    if (age < CHAIN_FRESH_MAX_AGE_MS) return 'FRESH';
    if (age < CHAIN_AGING_MAX_AGE_MS) return 'AGING';
    return 'STALE';
  }

  updateFromTick(securityId: string, ltp: number, bid?: number, ask?: number): void {
    if (!this.chain || ltp <= 0) return;
    const now = this.now();
    for (const row of Object.values(this.chain)) {
      if (row.ceSecId && row.ceSecId === securityId) {
        row.ceLtp = ltp;
        if (bid !== undefined && bid > 0) row.ceBid = bid;
        if (ask !== undefined && ask > 0) row.ceAsk = ask;
        row.ceUpdatedTime = now;
        break;
      }
      if (row.peSecId && row.peSecId === securityId) {
        row.peLtp = ltp;
        if (bid !== undefined && bid > 0) row.peBid = bid;
        if (ask !== undefined && ask > 0) row.peAsk = ask;
        row.peUpdatedTime = now;
        break;
      }
    }
  }

  /** Clears the chain and releases every contract this feed was streaming (day rollover). */
  reset(): void {
    this.chain = null;
    this.lastSyncTime = 0;
    this.releaseStreamed([...this.streamed.keys()]);
  }

  private async fetchOnly(ticker: string): Promise<boolean> {
    try {
      const res = await this.fetchChain(this.config.resolveExpiryYmd(), ticker);
      return Boolean(res && res.oc && Object.keys(res.oc).length > 0);
    } catch {
      return false;
    }
  }

  private async doSync(): Promise<boolean> {
    try {
      const startedAt = this.now();
      const res = await this.fetchChain(this.config.resolveExpiryYmd(), this.config.underlying);
      if (!res || !res.oc || Object.keys(res.oc).length === 0) return false;

      const now = this.now();
      const previous = this.chain;
      for (const [strikeKey, row] of Object.entries(res.oc)) {
        row.ceUpdatedTime = now;
        row.peUpdatedTime = now;
        // A tick that landed while the request was in flight is newer than the REST snapshot.
        const old = previous?.[Number(strikeKey)];
        if (old) {
          if (old.ceUpdatedTime !== undefined && old.ceUpdatedTime >= startedAt && old.ceLtp > 0) {
            row.ceLtp = old.ceLtp;
            row.ceUpdatedTime = old.ceUpdatedTime;
          }
          if (old.peUpdatedTime !== undefined && old.peUpdatedTime >= startedAt && old.peLtp > 0) {
            row.peLtp = old.peLtp;
            row.peUpdatedTime = old.peUpdatedTime;
          }
        }
      }
      this.chain = res.oc;
      if (res.spotPrice && res.spotPrice > 0) this.lastSpot = res.spotPrice;
      this.lastSyncTime = now;

      try {
        this.streamCandidates();
      } catch {
        // Streaming is best-effort; the REST snapshot is already stored.
      }
      return true;
    } catch {
      return false;
    }
  }

  // Streams only the current candidates; contracts that dropped out are released.
  private streamCandidates(): void {
    const { ceCandidates, peCandidates } = this.config.selectCandidates(this.lastSpot || this.config.fallbackSpot);
    const wanted = new Map<string, InstrumentSubscription>();
    const add = (securityId?: string | number) => {
      if (!securityId) return;
      const sub = { exchangeSegment: this.config.optionSegment, securityId: String(securityId) };
      wanted.set(`${sub.exchangeSegment}:${sub.securityId}`, sub);
    };
    for (const c of [...ceCandidates, ...peCandidates]) add(c.securityId);

    const win = this.config.streamWindow;
    if (win && this.chain) {
      const spot = this.lastSpot || this.config.fallbackSpot;
      const reach = win.strikes * win.step;
      for (const [strikeKey, row] of Object.entries(this.chain)) {
        if (Math.abs(Number(strikeKey) - spot) > reach) continue;
        add(row.ceSecId);
        add(row.peSecId);
      }
    }

    const toAdd = [...wanted].filter(([key]) => !this.streamed.has(key));
    const toDrop = [...this.streamed.keys()].filter((key) => !wanted.has(key));

    if (toAdd.length > 0) {
      this.market.acquire(this.config.owner, toAdd.map(([, sub]) => sub));
      toAdd.forEach(([key, sub]) => this.streamed.set(key, sub));
    }
    this.releaseStreamed(toDrop);
  }

  private releaseStreamed(keys: string[]): void {
    const subs = keys.map((key) => this.streamed.get(key)).filter((s): s is InstrumentSubscription => Boolean(s));
    keys.forEach((key) => this.streamed.delete(key));
    if (subs.length > 0) this.market.release(this.config.owner, subs);
  }
}
