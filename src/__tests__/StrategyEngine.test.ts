import { SignalPipeline, LatchPort } from '../engine/SignalPipeline';
import { StrategyEngine } from '../engine/StrategyEngine';
import {
  createVolumeCrossoverStrategy,
  createBreakout180Strategy,
  createNiftyOobtstStrategy,
  createSensexOobtstStrategy,
  STRATEGY_IDS,
  StrategyDeps,
} from '../engine/strategies';
import type { EngineContext, SignalEvent } from '../engine/types';

function fakeLatch(): LatchPort & { taken: Set<string> } {
  const taken = new Set<string>();
  return {
    taken,
    isAlertLatched: (key, side) => taken.has(`${key}|${side}`),
    acquireAlertLatch: async (key, side) => {
      const k = `${key}|${side}`;
      if (taken.has(k)) return false;
      taken.add(k);
      return true;
    },
  };
}

function makeDeps() {
  const notifier = {
    notify20DCrossover: jest.fn(),
    notify180BreakoutTriggered: jest.fn(),
    notify0920StrangleEntry: jest.fn(),
  };
  const tacticalStrike = jest.fn(() => ({ recommendedCeStrike: 2700 }));
  const deps: StrategyDeps = { notifier, tacticalStrike };
  return { deps, notifier, tacticalStrike };
}

const stock = (over: Record<string, unknown> = {}) =>
  ({
    ticker: 'RELIANCE', spotPrice: 2650, todayTradedShares: 6_000_000, avg20DTradedShares: 5_000_000,
    volumeRatio: 1.2, hasCrossed20D: true, circleIndicator: 'GREEN', crossoverTime: '10:01:00',
    ...over,
  }) as any;

const oobtst = (over: Record<string, unknown> = {}) =>
  ({
    status: 'ACTIVE', activeLeg: 'CE', lastUpdated: '09:31:00',
    ceLeg: { symbol: 'NIFTY 24850 CE', strike: 24850, openPrice: 60, currentLtp: 92 },
    peLeg: { symbol: 'NIFTY 24800 PE', strike: 24800, openPrice: 64, currentLtp: 40 },
    ...over,
  }) as any;

function setup() {
  const latch = fakeLatch();
  const { deps, notifier, tacticalStrike } = makeDeps();
  const engine = new StrategyEngine(new SignalPipeline(latch, () => 123));
  engine.register(createVolumeCrossoverStrategy(deps));
  engine.register(createBreakout180Strategy(deps));
  engine.register(createNiftyOobtstStrategy(deps));
  engine.register(createSensexOobtstStrategy(deps));
  return { engine, latch, notifier, tacticalStrike };
}

describe('SignalPipeline', () => {
  const event = (over: Partial<SignalEvent> = {}): SignalEvent => ({
    idPrefix: 'sig-x', strategyId: 'S', strategyName: 'S', symbol: 'X', signalType: 'BUY', entryPrice: 10,
    timestamp: 't', latch: { key: 'K', side: 'GREEN', details: { spotPrice: 1, todayTradedShares: 0, avg20DTradedShares: 0, volumeRatio: 1 } },
    materialize: () => ({ notes: 'n' }),
    ...over,
  });

  test('fires once per latch key and records a journal entry', async () => {
    const pipeline = new SignalPipeline(fakeLatch(), () => 7);
    const first = await pipeline.process([event(), event()]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 'sig-x-7', outcome: 'OPEN', notes: 'n', symbol: 'X' });
    expect(await pipeline.process([event()])).toHaveLength(0);
  });

  test('materialize runs only after the latch is acquired', async () => {
    const latch = fakeLatch();
    const materialize = jest.fn(() => ({ notes: 'n' }));
    const pipeline = new SignalPipeline(latch);
    await pipeline.process([event({ materialize })]);
    await pipeline.process([event({ materialize })]);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  test('a failing notification still produces the journal entry', async () => {
    const pipeline = new SignalPipeline(fakeLatch());
    const out = await pipeline.process([event({ materialize: () => ({ notes: 'n', notify: () => { throw new Error('x'); } }) })]);
    expect(out).toHaveLength(1);
  });

  test('a latch acquire failure skips the event without throwing', async () => {
    const latch = fakeLatch();
    latch.acquireAlertLatch = async () => { throw new Error('db'); };
    expect(await new SignalPipeline(latch).process([event()])).toEqual([]);
  });
});

describe('StrategyEngine with default strategies', () => {
  test('20D crossover: GREEN notifies with tactical strike, RED journals without notifying', async () => {
    const { engine, notifier, tacticalStrike } = setup();
    const ctx: EngineContext = {
      istTime: '10:01:05',
      stocks: [stock(), stock({ ticker: 'TCS', circleIndicator: 'RED' }), stock({ ticker: 'INFY', hasCrossed20D: false })],
    };
    const out = await engine.evaluate(ctx);

    expect(out.map((e) => [e.symbol, e.signalType])).toEqual([['RELIANCE', 'BUY'], ['TCS', 'SELL']]);
    expect(out[0].notes).toBe('🟢 Crossed 100% of 20D Avg (120.0% Vol). Bullish LTP > Open. Tactical: 2700 CE.');
    expect(out[1].notes).toContain('Bearish LTP < Open');
    expect(notifier.notify20DCrossover).toHaveBeenCalledTimes(1);
    expect(notifier.notify20DCrossover).toHaveBeenCalledWith('RELIANCE', 1.2, 2650, 2700);
    expect(tacticalStrike).toHaveBeenCalledTimes(1);

    expect(await engine.evaluate(ctx)).toHaveLength(0);
    expect(notifier.notify20DCrossover).toHaveBeenCalledTimes(1);
  });

  test('breakout 180 fires once when IN_TRADE with target and stop-loss', async () => {
    const { engine, notifier } = setup();
    const breakout = {
      status: 'IN_TRADE', activeContract: 'PE', ceCandidate: { strike: 24900 }, peCandidate: { strike: 24800 },
      entryPrice: 181.5, entryTime: '09:31:10', currentPrice: 183, fixedTarget: 220, fixedStopLoss: 160,
    } as any;
    const out = await engine.evaluate({ istTime: '09:32:00', breakout });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      strategyId: STRATEGY_IDS.BREAKOUT_180, symbol: 'NIFTY 24800 PE', entryPrice: 181.5, stopLoss: 160, target: 220, timestamp: '09:31:10',
    });
    expect(notifier.notify180BreakoutTriggered).toHaveBeenCalledWith('PE', 24800, 181.5, 220, 160);
    expect(await engine.evaluate({ istTime: '09:33:00', breakout })).toHaveLength(0);
  });

  test('OOBTST NIFTY and SENSEX use separate latch keys and labels', async () => {
    const { engine, notifier } = setup();
    const out = await engine.evaluate({
      istTime: '09:31:00',
      niftyOobtst: oobtst(),
      sensexOobtst: oobtst({ ceLeg: { symbol: 'SENSEX 81000 CE', strike: 81000, openPrice: 100, currentLtp: 160 } }),
    });
    expect(out.map((e) => e.strategyId)).toEqual([STRATEGY_IDS.OOBTST_NIFTY, STRATEGY_IDS.OOBTST_SENSEX]);
    expect(out[0]).toMatchObject({ entryPrice: 90, stopLoss: 60 });
    expect(out[0].notes).toBe('⚡ 09:20 1.5X Trigger Breached for NIFTY 24850 CE (Open: ₹60.00, Trigger: ₹90.00). SL: ₹60.00.');
    expect(out[1].notes).toContain('⚡ Sensex 09:20 1.5X Trigger Breached for SENSEX 81000 CE');
    expect(notifier.notify0920StrangleEntry).toHaveBeenCalledWith(24850, 24800, 60, 64);
  });

  test('inactive or incomplete states produce no signals', async () => {
    const { engine } = setup();
    const out = await engine.evaluate({
      istTime: '09:10:00',
      niftyOobtst: oobtst({ status: 'ARMED' }),
      sensexOobtst: oobtst({ activeLeg: null }),
      breakout: { status: 'MONITORING_BREAKOUT' } as any,
      stocks: [],
    });
    expect(out).toEqual([]);
  });

  test('"only" restricts which strategies run', async () => {
    const { engine } = setup();
    const out = await engine.evaluate(
      { istTime: 't', stocks: [stock()], niftyOobtst: oobtst() },
      [STRATEGY_IDS.OOBTST_NIFTY]
    );
    expect(out.map((e) => e.strategyId)).toEqual([STRATEGY_IDS.OOBTST_NIFTY]);
  });

  test('a throwing strategy does not block the others and overlapping runs never double-fire', async () => {
    const { engine, notifier } = setup();
    engine.register({ id: 'BAD', detect: () => { throw new Error('boom'); } });
    const ctx: EngineContext = { istTime: 't', niftyOobtst: oobtst() };
    const [a, b] = await Promise.all([engine.evaluate(ctx), engine.evaluate(ctx)]);
    expect(a.length + b.length).toBe(1);
    expect(notifier.notify0920StrangleEntry).toHaveBeenCalledTimes(1);
  });
});
