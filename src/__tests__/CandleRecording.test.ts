import { CandleAggregator } from '../services/candles/CandleAggregator';
import { CandleRepository } from '../services/candles/CandleRepository';
import {
  CANDLE_OWNER,
  CandleRecorder,
  parseIntradayBars,
  pickNearestExpiry,
  type CandleRecorderDeps,
  type IntradayBars,
  type LockedContract,
} from '../services/candles/CandleRecorder';
import { isCandleSession, istDateKey, istDayStartEpoch, istSecOfDay, minuteStartEpoch } from '../services/candles/candleTime';

// Wednesday 11 Nov 2026, 10:00:30 IST
const T0 = Date.UTC(2026, 10, 11, 4, 30, 30);
const MIN = 60_000;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('candle time helpers', () => {
  it('buckets by minute and by IST day', () => {
    expect(minuteStartEpoch(T0)).toBe(Math.floor(T0 / 60000) * 60);
    expect(istDateKey(T0)).toBe('2026-11-11');
    expect(istSecOfDay(T0)).toBe(10 * 3600 + 30);
    // 00:30 IST on the 12th is still the 11th in UTC
    const justAfterMidnight = Date.UTC(2026, 10, 11, 19, 0, 0);
    expect(istDateKey(justAfterMidnight)).toBe('2026-11-12');
    expect(istDayStartEpoch(justAfterMidnight)).toBe(Date.UTC(2026, 10, 11, 18, 30, 0) / 1000);
  });

  it('is in session from 09:15:00 to 15:29:59 on weekdays only', () => {
    const at = (h: number, m: number, s: number, day = 11) => Date.UTC(2026, 10, day, h - 5 - (m < 30 ? 1 : 0), (m + 30) % 60, s);
    expect(isCandleSession(at(9, 14, 59))).toBe(false);
    expect(isCandleSession(at(9, 15, 0))).toBe(true);
    expect(isCandleSession(at(15, 29, 59))).toBe(true);
    expect(isCandleSession(at(15, 30, 0))).toBe(false);
    expect(isCandleSession(at(11, 0, 0, 14))).toBe(false); // Saturday
  });
});

describe('CandleAggregator', () => {
  it('builds open, high, low and close inside a minute', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0);
    agg.ingest('2:A', 105, T0 + 5000);
    agg.ingest('2:A', 98, T0 + 10000);
    agg.ingest('2:A', 102, T0 + 20000);
    expect(agg.takeDirty()).toEqual([
      { instKey: '2:A', ts: minuteStartEpoch(T0), open: 100, high: 105, low: 98, close: 102, volume: 0, oi: 0 },
    ]);
    expect(agg.takeDirty()).toEqual([]);
  });

  it('hands out the closed bar once, then starts the next minute at its first price', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0);
    agg.ingest('2:A', 110, T0 + MIN);
    const bars = agg.takeDirty();
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ ts: minuteStartEpoch(T0), open: 100, close: 100 });
    expect(bars[1]).toMatchObject({ ts: minuteStartEpoch(T0 + MIN), open: 110, high: 110, low: 110 });
  });

  it('does not resend a closed bar that was already flushed', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0);
    agg.takeDirty();
    agg.ingest('2:A', 101, T0 + MIN);
    expect(agg.takeDirty().map((b) => b.ts)).toEqual([minuteStartEpoch(T0 + MIN)]);
  });

  it('ignores a late tick from an earlier minute and non-positive prices', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0 + MIN);
    agg.takeDirty();
    agg.ingest('2:A', 90, T0);
    agg.ingest('2:A', 0, T0 + MIN);
    expect(agg.takeDirty()).toEqual([]);
  });

  it('takes volume as the growth of the day total and carries it across minutes', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0, 1000);
    agg.ingest('2:A', 101, T0 + 10000, 1300);
    agg.ingest('2:A', 102, T0 + MIN, 1500);
    agg.ingest('2:A', 103, T0 + MIN + 5000, 1800);
    const [first, second] = agg.takeDirty();
    expect(first.volume).toBe(300);
    expect(second.volume).toBe(500);
  });

  it('carries open interest forward and lets a price-less OI update through', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0, undefined, 5000);
    agg.ingest('2:A', 101, T0 + MIN);
    agg.noteOi('2:A', 5200);
    const bars = agg.takeDirty();
    expect(bars[0].oi).toBe(5000);
    expect(bars[1].oi).toBe(5200);
  });

  it('puts bars back after a failed write', () => {
    const agg = new CandleAggregator();
    agg.ingest('2:A', 100, T0);
    const bars = agg.takeDirty();
    agg.requeue(bars);
    expect(agg.takeDirty()).toEqual(bars);
  });
});

describe('parseIntradayBars and pickNearestExpiry', () => {
  const dayStart = istDayStartEpoch(T0);

  it('reads bars, keeps volume and OI, and drops bad or out-of-day rows', () => {
    const data: IntradayBars = {
      start_Time: [dayStart + 36000, dayStart + 36060, dayStart - 60, dayStart + 36120],
      open: [10, 11, 12, 0],
      high: [12, 13, 14, 5],
      low: [9, 10, 11, 5],
      close: [11, 12, 13, 5],
      volume: [100, 200, 300, 400],
      open_interest: [5000, 5100, 5200, 5300],
    };
    expect(parseIntradayBars('2:X', data, dayStart, dayStart + 86400)).toEqual([
      { instKey: '2:X', ts: dayStart + 36000, open: 10, high: 12, low: 9, close: 11, volume: 100, oi: 5000 },
      { instKey: '2:X', ts: dayStart + 36060, open: 11, high: 13, low: 10, close: 12, volume: 200, oi: 5100 },
    ]);
    expect(parseIntradayBars('2:X', null, 0, 1)).toEqual([]);
    expect(parseIntradayBars('2:X', {}, 0, 1)).toEqual([]);
  });

  it('picks the nearest expiry that has not passed, counting an expiry today', () => {
    expect(pickNearestExpiry(['2026-11-19', '2026-11-04', '2026-11-12'], '2026-11-11')).toBe('2026-11-12');
    expect(pickNearestExpiry(['2026-11-04', '2026-11-11'], '2026-11-11')).toBe('2026-11-11');
    expect(pickNearestExpiry(['2026-11-04'], '2026-11-11')).toBe('2026-11-04');
    expect(pickNearestExpiry([], '2026-11-11')).toBeNull();
  });
});

describe('CandleRepository', () => {
  const repo = new CandleRepository();
  const ts = minuteStartEpoch(T0);
  const bar = (over: Partial<Parameters<CandleRepository['upsertLive']>[0][number]> = {}) => ({
    instKey: '2:R',
    ts,
    open: 100,
    high: 105,
    low: 99,
    close: 104,
    volume: 50,
    oi: 10,
    ...over,
  });

  beforeEach(async () => {
    await repo.pruneBefore(Number.MAX_SAFE_INTEGER, '9999-12-31');
  });

  it('keeps the original open and widens the range when a restart rewrites a minute', async () => {
    await repo.upsertLive([bar()]);
    await repo.upsertLive([bar({ open: 104, high: 110, low: 103, close: 108, volume: 70, oi: 0 })]);
    expect(await repo.getCandles('2:R')).toEqual([
      { instKey: '2:R', ts, open: 100, high: 110, low: 99, close: 108, volume: 70, oi: 10, source: 'LIVE' },
    ]);
  });

  it('lets the API candle replace a live one and then protects it from live writes', async () => {
    await repo.upsertLive([bar()]);
    await repo.replaceApi([bar({ open: 100.5, high: 106, low: 98.5, close: 104.5, volume: 60, oi: 12 })]);
    await repo.upsertLive([bar({ high: 200, low: 1, close: 150 })]);
    expect(await repo.getCandles('2:R')).toEqual([
      { instKey: '2:R', ts, open: 100.5, high: 106, low: 98.5, close: 104.5, volume: 60, oi: 12, source: 'API' },
    ]);
  });

  it('writes more rows than one statement holds and reads a time range oldest first', async () => {
    const bars = Array.from({ length: 120 }, (_, i) => bar({ ts: ts + i * 60, open: 100 + i }));
    await repo.upsertLive(bars.slice().reverse());
    const rows = await repo.getCandles('2:R', ts + 60, ts + 180);
    expect(rows.map((r) => r.ts)).toEqual([ts + 60, ts + 120]);
    expect(await repo.getCandles('2:R')).toHaveLength(120);
  });

  it('prunes candles and instruments from before today', async () => {
    const dayStart = istDayStartEpoch(T0);
    await repo.upsertLive([bar({ ts: dayStart - 60 }), bar({ ts: dayStart + 36000 })]);
    const inst = (tradeDate: string, instKey: string) => ({
      instKey,
      segment: 'NSE_FNO',
      securityId: instKey,
      underlying: 'NIFTY',
      kind: 'CE' as const,
      strike: 24000,
      expiry: '2026-11-12',
      symbol: 'NIFTY 24000 CE',
      tradeDate,
    });
    await repo.saveInstruments([inst('2026-11-10', 'old'), inst('2026-11-11', 'new')]);
    await repo.pruneBefore(dayStart, '2026-11-11');
    expect((await repo.getCandles('2:R')).map((r) => r.ts)).toEqual([dayStart + 36000]);
    expect(await repo.getInstruments('2026-11-10')).toEqual([]);
    expect((await repo.getInstruments('2026-11-11')).map((i) => i.instKey)).toEqual(['new']);
  });
});

describe('CandleRecorder', () => {
  const SPOTS: Record<string, number> = { '13': 24012, '25': 52040, '27': 25010, '51': 79520 };
  const STEPS: Record<string, number> = { '13': 50, '25': 100, '27': 50, '51': 100 };
  const PREFIX: Record<string, string> = { '13': 'N', '25': 'B', '27': 'F', '51': 'S' };
  const NAMES: Record<string, string> = { NIFTY: '13', BANKNIFTY: '25', FINNIFTY: '27', SENSEX: '51' };

  let clock = T0;
  let listener: ((batch: Record<string, unknown>) => void) | null;
  let storage: Map<string, string>;
  let deps: CandleRecorderDeps;
  let repo: CandleRepository;
  let locked: LockedContract[];
  let fetchCandles: jest.Mock;

  const chainFor = (name: string) => {
    const id = NAMES[name];
    const step = STEPS[id];
    const atm = Math.round(SPOTS[id] / step) * step;
    const oc: Record<number, { ceSecId: string; peSecId: string }> = {};
    for (let i = -20; i <= 20; i++) {
      const strike = atm + i * step;
      oc[strike] = { ceSecId: `${PREFIX[id]}C${strike}`, peSecId: `${PREFIX[id]}P${strike}` };
    }
    return { oc };
  };

  const make = () => {
    const recorder = new CandleRecorder(deps);
    return recorder;
  };

  const selectAll = async (recorder: CandleRecorder) => {
    for (let i = 0; i < 4; i++) {
      await recorder.refreshSelection();
      clock += 4000;
    }
  };

  beforeEach(async () => {
    clock = T0;
    listener = null;
    storage = new Map();
    locked = [];
    repo = new CandleRepository();
    await repo.pruneBefore(Number.MAX_SAFE_INTEGER, '9999-12-31');
    fetchCandles = jest.fn(async () => ({}) as IntradayBars);
    deps = {
      repo,
      market: {
        acquire: jest.fn(),
        releaseOwner: jest.fn(),
        onBatch: jest.fn((l: any) => {
          listener = l;
          return () => {
            listener = null;
          };
        }),
        getQuote: jest.fn((_seg: any, id: any) => ({ ltp: SPOTS[String(id)] }) as any),
      },
      fetchExpiryList: jest.fn(async () => ['2026-11-04', '2026-11-12', '2026-11-19']),
      fetchChain: jest.fn(async (_expiry: string, underlying: string) => chainFor(underlying)),
      fetchCandles: (...args: any[]) => (fetchCandles as any)(...args),
      getLockedContracts: () => locked,
      storage: {
        getItem: async (k: string) => storage.get(k) ?? null,
        setItem: async (k: string, v: string) => {
          storage.set(k, v);
        },
      },
      now: () => clock,
      sleep: async () => {},
    };
  });

  it('records the four indexes from the start', async () => {
    const recorder = make();
    await recorder.start();
    expect(recorder.getTrackedKeys().sort()).toEqual(['0:13', '0:25', '0:27', '0:51']);
    expect(deps.market.acquire).toHaveBeenCalledWith(
      CANDLE_OWNER,
      expect.arrayContaining([{ exchangeSegment: 'IDX_I', securityId: '13' }])
    );
  });

  it('selects the options within five strikes of the money on every index, on the nearest expiry', async () => {
    const recorder = make();
    await recorder.start();
    await selectAll(recorder);
    const keys = recorder.getTrackedKeys();

    // 4 indexes + 4 underlyings x 11 strikes x 2 sides
    expect(keys).toHaveLength(4 + 4 * 11 * 2);
    expect(keys).toEqual(expect.arrayContaining(['2:NC24000', '2:NP24250', '2:NC23750', '2:BC52500', '2:FP25250', '8:SC79500']));
    expect(keys).not.toContain('2:NC24300'); // six strikes away
    expect(keys).not.toContain('8:SC80100'); // six strikes away
    expect(deps.fetchChain).toHaveBeenCalledWith('2026-11-12', 'NIFTY');
    expect(deps.fetchChain).toHaveBeenCalledTimes(4);
  });

  it('fetches at most one chain per pass so the option chain rate limit holds', async () => {
    const recorder = make();
    await recorder.start();
    await recorder.refreshSelection();
    expect(deps.fetchChain).toHaveBeenCalledTimes(1);
    await recorder.refreshSelection(); // too soon for another
    expect(deps.fetchChain).toHaveBeenCalledTimes(1);
  });

  it('always records the locked strikes, even far from the money', async () => {
    const recorder = make();
    await recorder.start();
    await selectAll(recorder);
    locked = [{ underlying: 'SENSEX', segment: 'BSE_FNO', type: 'CE', strike: 80500, secId: 'SC80500', expiry: '2026-11-12' }];
    await recorder.refreshSelection();
    expect(recorder.getTrackedKeys()).toContain('8:SC80500');
    expect((await repo.getInstruments('2026-11-11')).find((i) => i.instKey === '8:SC80500')).toMatchObject({
      underlying: 'SENSEX',
      kind: 'CE',
      strike: 80500,
      symbol: 'SENSEX 80500 CE',
    });
  });

  it('keeps a contract after the money moves away from it', async () => {
    const recorder = make();
    await recorder.start();
    await selectAll(recorder);
    SPOTS['13'] = 24512;
    await recorder.refreshSelection();
    const keys = recorder.getTrackedKeys();
    expect(keys).toContain('2:NC23750');
    expect(keys).toContain('2:NC24750');
    SPOTS['13'] = 24012;
  });

  it('builds candles from tracked ticks inside the session and writes them on flush', async () => {
    const recorder = make();
    await recorder.start();
    await selectAll(recorder);
    clock = T0;
    listener!({ '0:13': { ltp: 24010 }, '2:NC24000': { ltp: 101.5, volume: 1000, oi: 5000 }, '2:ZZZ': { ltp: 5 } });
    clock = T0 + 20000;
    listener!({ '2:NC24000': { ltp: 104, volume: 1400 } });
    await recorder.flush();

    const option = await repo.getCandles('2:NC24000');
    expect(option).toEqual([
      expect.objectContaining({ open: 101.5, high: 104, low: 101.5, close: 104, volume: 400, oi: 5000, source: 'LIVE' }),
    ]);
    expect(await repo.getCandles('0:13')).toHaveLength(1);
    expect(await repo.getCandles('2:ZZZ')).toEqual([]);
  });

  it('ignores ticks outside 09:15-15:30', async () => {
    const recorder = make();
    await recorder.start();
    clock = Date.UTC(2026, 10, 11, 10, 0, 5); // 15:30:05 IST
    listener!({ '0:13': { ltp: 24010 } });
    await recorder.flush();
    expect(await repo.getCandles('0:13')).toEqual([]);
  });

  it('flushes from tick() only when the interval has passed', async () => {
    const recorder = make();
    await recorder.start();
    listener!({ '0:13': { ltp: 24010 } });
    recorder.tick();
    await settle();
    expect(await repo.getCandles('0:13')).toHaveLength(1);

    clock += 1000;
    listener!({ '0:13': { ltp: 24020 } });
    recorder.tick(); // 1 s later: not due
    await settle();
    expect((await repo.getCandles('0:13'))[0].close).toBe(24010);

    clock += 5000;
    recorder.tick();
    await settle();
    expect((await repo.getCandles('0:13'))[0].close).toBe(24020);
  });

  it('picks its instruments up again after a restart', async () => {
    const first = make();
    await first.start();
    await selectAll(first);
    const keys = first.getTrackedKeys().sort();
    first.stop();

    const second = make();
    await second.start();
    expect(second.getTrackedKeys().sort()).toEqual(keys);
  });

  describe('end-of-day reconcile', () => {
    const dayStart = () => istDayStartEpoch(T0);
    const apiBars = (open: number): IntradayBars => ({
      start_Time: [dayStart() + 36000, dayStart() + 36060],
      open: [open, open + 1],
      high: [open + 2, open + 3],
      low: [open - 1, open],
      close: [open + 1, open + 2],
      volume: [100, 200],
      open_interest: [7000, 7100],
    });

    it('replaces tick candles with Dhan candles and asks for OI on options only', async () => {
      const recorder = make();
      await recorder.start();
      locked = [{ underlying: 'NIFTY', segment: 'NSE_FNO', type: 'CE', strike: 24000, secId: 'NC24000', expiry: '2026-11-12' }];
      await recorder.refreshSelection();
      clock = T0; // 10:00:30 IST
      listener!({ '0:13': { ltp: 24010 } });
      await recorder.flush();

      fetchCandles.mockImplementation(async () => apiBars(24000));
      clock = Date.UTC(2026, 10, 11, 10, 1, 5); // 15:31:05 IST
      const result = await recorder.reconcileDay();

      // 4 indexes + the 22 NIFTY options near the money (the locked strike is one of them); each returns 2 bars
      expect(result).toEqual({ instruments: 26, rows: 52, failed: 0 });
      expect(fetchCandles).toHaveBeenCalledWith('13', 'IDX_I', 'INDEX', '2026-11-11 09:15:00', '2026-11-11 15:30:00', false);
      expect(fetchCandles).toHaveBeenCalledWith('NC24000', 'NSE_FNO', 'OPTIDX', '2026-11-11 09:15:00', '2026-11-11 15:30:00', true);

      const rows = await repo.getCandles('0:13');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ open: 24000, source: 'API' });
      const option = await repo.getCandles('2:NC24000');
      expect(option[0]).toMatchObject({ oi: 7000, volume: 100, source: 'API' });
      expect(storage.get('@qstrategy_candles_reconciled_2026-11-11')).toBe('1');
    });

    it('retries failed instruments after five minutes and stops once everything is in', async () => {
      const recorder = make();
      await recorder.start();
      let calls = 0;
      fetchCandles.mockImplementation(async (secId: string) => {
        calls++;
        return secId === '25' && calls <= 4 ? null : apiBars(100);
      });
      clock = Date.UTC(2026, 10, 11, 10, 1, 5);
      recorder.tick();
      await settle();
      await settle();
      expect(calls).toBe(4);
      expect(storage.has('@qstrategy_candles_reconciled_2026-11-11')).toBe(false);

      clock += 60_000;
      recorder.tick(); // not yet due
      await settle();
      expect(calls).toBe(4);

      clock += 5 * 60_000;
      recorder.tick();
      await settle();
      await settle();
      expect(calls).toBe(8);
      expect(storage.get('@qstrategy_candles_reconciled_2026-11-11')).toBe('1');

      clock += 10 * 60_000;
      recorder.tick();
      await settle();
      expect(calls).toBe(8);
    });

    it('does not reconcile again after a restart that finds the day already done', async () => {
      storage.set('@qstrategy_candles_reconciled_2026-11-11', '1');
      const recorder = make();
      await recorder.start();
      clock = Date.UTC(2026, 10, 11, 10, 1, 5);
      recorder.tick();
      await settle();
      expect(fetchCandles).not.toHaveBeenCalled();
    });

    it('treats an instrument with no trades as done, not failed', async () => {
      const recorder = make();
      await recorder.start();
      fetchCandles.mockImplementation(async () => ({}));
      clock = Date.UTC(2026, 10, 11, 10, 1, 5);
      expect(await recorder.reconcileDay()).toEqual({ instruments: 4, rows: 0, failed: 0 });
    });
  });

  it('keeps only the new day when the date rolls over', async () => {
    const recorder = make();
    await recorder.start();
    listener!({ '0:13': { ltp: 24010 } });
    await recorder.flush();
    expect(await repo.getCandles('0:13')).toHaveLength(1);

    clock = Date.UTC(2026, 10, 12, 4, 30, 30); // next day 10:00:30 IST
    recorder.tick();
    await settle();
    await settle();

    expect(deps.market.releaseOwner).toHaveBeenCalledWith(CANDLE_OWNER);
    expect(await repo.getCandles('0:13')).toEqual([]);
    expect(recorder.getTrackedKeys().sort()).toEqual(['0:13', '0:25', '0:27', '0:51']);
  });
});
