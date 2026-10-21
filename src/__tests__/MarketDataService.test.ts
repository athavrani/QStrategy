import { MarketDataService, FRESH_MAX_AGE_MS, AGING_MAX_AGE_MS } from '../services/marketdata/MarketDataService';
import { SnapshotStore } from '../services/marketdata/SnapshotStore';
import { instrumentKey } from '../services/marketdata/types';
import type { DhanParsedPacket } from '../services/dhan/DhanBinaryCodec';

jest.mock('../services/dhan/DhanHqFeedSocket', () => ({ dhanHqFeedSocket: {} }));

const quotePkt = (segment: number, securityId: number, ltp: number, volume = 100): DhanParsedPacket =>
  ({
    responseCode: 4, messageLength: 50, exchangeSegment: segment, securityId,
    ltp, ltq: 1, ltt: 1729321200, atp: ltp, volume, totalSellQty: 1, totalBuyQty: 1,
    dayOpen: ltp, dayClose: 0, dayHigh: ltp, dayLow: ltp,
  }) as DhanParsedPacket;

const prevClosePkt = (segment: number, securityId: number, prevClose: number): DhanParsedPacket =>
  ({ responseCode: 6, messageLength: 16, exchangeSegment: segment, securityId, prevClose, prevOI: 0 }) as DhanParsedPacket;

function makeFeed() {
  let tickListener: ((b: Record<string, DhanParsedPacket>) => void) | null = null;
  return {
    connected: true,
    subscribeOwned: jest.fn(),
    unsubscribeOwned: jest.fn(),
    isConnected() { return this.connected; },
    addTickListener: jest.fn((l: any) => {
      tickListener = l;
      return () => { tickListener = null; };
    }),
    emit(batch: Record<string, DhanParsedPacket>) { tickListener?.(batch); },
    hasListener: () => tickListener !== null,
  };
}

describe('SnapshotStore', () => {
  test('merges partial packets without erasing earlier fields', () => {
    const store = new SnapshotStore();
    store.apply('1:25', quotePkt(1, 25, 2650, 5000), 1000);
    const q = store.apply('1:25', prevClosePkt(1, 25, 2600), 2000);
    expect(q.ltp).toBe(2650);
    expect(q.volume).toBe(5000);
    expect(q.prevClose).toBe(2600);
    expect(q.recvTs).toBe(2000);
  });

  test('zero values do not overwrite and quotes are immutable', () => {
    const store = new SnapshotStore();
    const first = store.apply('1:25', quotePkt(1, 25, 2650), 1);
    const second = store.apply('1:25', { ...quotePkt(1, 25, 0, 0) } as DhanParsedPacket, 2);
    expect(second.ltp).toBe(2650);
    expect(second).not.toBe(first);
    expect(first.recvTs).toBe(1);
  });
});

describe('MarketDataService', () => {
  let feed: ReturnType<typeof makeFeed>;
  let clock: number;
  let svc: MarketDataService;

  beforeEach(() => {
    feed = makeFeed();
    clock = 1_000_000;
    svc = new MarketDataService(feed as any, () => clock);
    svc.start();
  });

  test('start is idempotent', () => {
    svc.start();
    expect(feed.addTickListener).toHaveBeenCalledTimes(1);
  });

  test('ignores bare-id aliases and keeps index and equity with the same id separate', () => {
    const idx = quotePkt(0, 25, 54850);
    const eq = quotePkt(1, 25, 2650);
    const seen: string[][] = [];
    svc.onBatch((b) => seen.push(Object.keys(b)));
    feed.emit({ '0:25': idx, '1:25': eq, '25': eq });

    expect(seen).toEqual([['0:25', '1:25']]);
    expect(svc.getQuote('IDX_I', 25)?.ltp).toBe(54850);
    expect(svc.getQuote('NSE_EQ', 25)?.ltp).toBe(2650);
  });

  test('watch delivers only its instruments and ref-counts feed subscriptions', () => {
    const got: string[][] = [];
    const release = svc.watch('chain', [{ exchangeSegment: 'NSE_FNO', securityId: '5001' }], (b) => got.push(Object.keys(b)));
    expect(feed.subscribeOwned).toHaveBeenCalledWith('chain', [{ exchangeSegment: 'NSE_FNO', securityId: '5001' }]);

    feed.emit({ '2:5001': quotePkt(2, 5001, 80), '2:9999': quotePkt(2, 9999, 10) });
    expect(got).toEqual([['2:5001']]);

    release();
    release();
    expect(feed.unsubscribeOwned).toHaveBeenCalledTimes(1);
    feed.emit({ '2:5001': quotePkt(2, 5001, 81) });
    expect(got).toHaveLength(1);
  });

  test('a throwing listener does not block others', () => {
    const ok = jest.fn();
    svc.onBatch(() => { throw new Error('boom'); });
    svc.onBatch(ok);
    feed.emit({ '1:1': quotePkt(1, 1, 5) });
    expect(ok).toHaveBeenCalled();
  });

  test('freshness follows quote age and connection state', () => {
    const key = instrumentKey('NSE_EQ', 1);
    expect(svc.getFreshness(key)).toBe('STALE');

    feed.emit({ '1:1': quotePkt(1, 1, 5) });
    expect(svc.getFreshness(key)).toBe('FRESH');
    clock += FRESH_MAX_AGE_MS;
    expect(svc.getFreshness(key)).toBe('AGING');
    clock += AGING_MAX_AGE_MS;
    expect(svc.getFreshness(key)).toBe('STALE');

    feed.connected = false;
    expect(svc.getFreshness(key)).toBe('DISCONNECTED');
  });

  test('stop detaches from the feed', () => {
    svc.stop();
    expect(feed.hasListener()).toBe(false);
  });
});

describe('instrumentKey', () => {
  test('maps segment names to feed codes', () => {
    expect(instrumentKey('IDX_I', 13)).toBe('0:13');
    expect(instrumentKey('NSE_EQ', '1333')).toBe('1:1333');
    expect(instrumentKey('BSE_FNO', 7)).toBe('8:7');
    expect(instrumentKey(2, 5)).toBe('2:5');
  });
});
