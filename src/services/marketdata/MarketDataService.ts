/**
 * Single in-app distribution point for Dhan market data.
 * Consumers watch instruments through here instead of touching the feed socket directly:
 * subscriptions are ref-counted per owner, and the latest merged quote is readable at any time.
 */

import { dhanHqFeedSocket } from '../dhan/DhanHqFeedSocket';
import type { DhanHqFeedSocket } from '../dhan/DhanHqFeedSocket';
import type { InstrumentSubscription } from '../dhan/DhanBinaryCodec';
import { SnapshotStore } from './SnapshotStore';
import { Freshness, InstrumentKey, MarketBatch, Quote, Unsubscribe, instrumentKey } from './types';

export const FRESH_MAX_AGE_MS = 5000;
export const AGING_MAX_AGE_MS = 15000;

type FeedLike = Pick<
  DhanHqFeedSocket,
  'addTickListener' | 'subscribeOwned' | 'unsubscribeOwned' | 'releaseOwner' | 'isConnected'
>;

type BatchListener = (batch: MarketBatch) => void;

interface KeyedListener {
  keys: Set<InstrumentKey>;
  listener: BatchListener;
}

export class MarketDataService {
  private readonly snapshots = new SnapshotStore();
  private readonly globalListeners = new Set<BatchListener>();
  private readonly keyedListeners = new Set<KeyedListener>();
  private detachFeed: Unsubscribe | null = null;

  constructor(private readonly feed: FeedLike, private readonly now: () => number = Date.now) {}

  /** Idempotent: attaches to the feed once. */
  start(): void {
    if (this.detachFeed) return;
    this.detachFeed = this.feed.addTickListener(this.handleBatch);
  }

  stop(): void {
    this.detachFeed?.();
    this.detachFeed = null;
  }

  /** Receives every changed instrument in each 250 ms batch. */
  onBatch(listener: BatchListener): Unsubscribe {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * Subscribes the instruments on the feed under `owner` and optionally receives only their updates.
   * Calling the returned function releases them; the feed drops an instrument once no owner remains.
   */
  watch(owner: string, instruments: InstrumentSubscription[], listener?: BatchListener): Unsubscribe {
    this.feed.subscribeOwned(owner, instruments);

    let entry: KeyedListener | null = null;
    if (listener) {
      entry = {
        keys: new Set(instruments.map((i) => instrumentKey(i.exchangeSegment, i.securityId))),
        listener,
      };
      this.keyedListeners.add(entry);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (entry) this.keyedListeners.delete(entry);
      this.feed.unsubscribeOwned(owner, instruments);
    };
  }

  getQuote(segment: string | number, securityId: string | number): Quote | undefined {
    return this.snapshots.get(instrumentKey(segment, securityId));
  }

  /** Subscribes instruments under `owner` without a listener; pair with `release`. */
  acquire(owner: string, instruments: InstrumentSubscription[]): void {
    this.feed.subscribeOwned(owner, instruments);
  }

  release(owner: string, instruments: InstrumentSubscription[]): void {
    this.feed.unsubscribeOwned(owner, instruments);
  }

  isConnected(): boolean {
    return this.feed.isConnected();
  }

  /** Drops every instrument held by `owner` (e.g. on day rollover). */
  releaseOwner(owner: string): void {
    this.feed.releaseOwner(owner);
  }

  getQuoteByKey(key: InstrumentKey): Quote | undefined {
    return this.snapshots.get(key);
  }

  getFreshness(key: InstrumentKey): Freshness {
    if (!this.feed.isConnected()) return 'DISCONNECTED';
    const quote = this.snapshots.get(key);
    if (!quote) return 'STALE';
    const age = this.now() - quote.recvTs;
    if (age < FRESH_MAX_AGE_MS) return 'FRESH';
    if (age < AGING_MAX_AGE_MS) return 'AGING';
    return 'STALE';
  }

  clearSnapshots(): void {
    this.snapshots.clear();
  }

  private handleBatch = (raw: MarketBatch): void => {
    const recvTs = this.now();
    // The socket also emits a legacy bare-securityId alias; only composite keys are authoritative.
    const batch: MarketBatch = {};
    let count = 0;
    for (const key of Object.keys(raw)) {
      if (!key.includes(':')) continue;
      batch[key] = raw[key];
      this.snapshots.apply(key, raw[key], recvTs);
      count++;
    }
    if (count === 0) return;

    this.globalListeners.forEach((listener) => this.safeCall(listener, batch));

    this.keyedListeners.forEach(({ keys, listener }) => {
      let subset: MarketBatch | null = null;
      for (const key of Object.keys(batch)) {
        if (keys.has(key)) {
          subset = subset ?? {};
          subset[key] = batch[key];
        }
      }
      if (subset) this.safeCall(listener, subset);
    });
  };

  private safeCall(listener: BatchListener, batch: MarketBatch): void {
    try {
      listener(batch);
    } catch {
      // One failing consumer must not block the others.
    }
  }
}

export const marketData = new MarketDataService(dhanHqFeedSocket);
