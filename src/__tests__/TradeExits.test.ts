import { SignalPipeline, LatchPort } from '../engine/SignalPipeline';
import { StrategyEngine } from '../engine/StrategyEngine';
import { createBreakout180Strategy, createNiftyOobtstStrategy, STRATEGY_IDS, StrategyDeps } from '../engine/strategies';
import { applyClosedTrades, sumPoints } from '../engine/journalMath';
import { JournalRepository } from '../services/JournalRepository';
import type { ClosedTrade } from '../engine/types';
import type { SignalJournalItem } from '../types/mobile';

function fakeLatch(): LatchPort {
  const taken = new Set<string>();
  return {
    isAlertLatched: (k, s) => taken.has(`${k}|${s}`),
    acquireAlertLatch: async (k, s) => {
      const key = `${k}|${s}`;
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    },
  };
}

const notifier = () => ({
  notify20DCrossover: jest.fn(),
  notify180BreakoutTriggered: jest.fn(),
  notify0920StrangleEntry: jest.fn(),
  notify0920StopLossHit: jest.fn(),
  notify180TimeExit: jest.fn(),
});

function setup() {
  const n = notifier();
  const deps: StrategyDeps = { notifier: n, tacticalStrike: () => ({ recommendedCeStrike: 0 }) };
  const closeSink = jest.fn(async () => {});
  const engine = new StrategyEngine(new SignalPipeline(fakeLatch(), () => 1, async () => {}, closeSink));
  engine.register(createBreakout180Strategy(deps));
  engine.register(createNiftyOobtstStrategy(deps));
  const closed: ClosedTrade[][] = [];
  engine.onClosed((t) => closed.push(t));
  return { engine, n, closeSink, closed };
}

const breakout = (status: string, over: Record<string, unknown> = {}) =>
  ({
    status, activeContract: 'CE', ceCandidate: { strike: 24900 }, peCandidate: { strike: 24800 },
    entryPrice: 182, entryTime: '09:31:10', currentPrice: 190, fixedTarget: 220, fixedStopLoss: 160,
    ...over,
  }) as any;

const oobtst = (status: string, over: Record<string, unknown> = {}) =>
  ({
    status, activeLeg: 'CE', lastUpdated: '10:05:00', executedPrice: 90, slPrice: 45,
    ceLeg: { symbol: 'NIFTY 24850 CE', strike: 24850, openPrice: 60, currentLtp: 44 },
    peLeg: { symbol: 'NIFTY 24800 PE', strike: 24800, openPrice: 64, currentLtp: 40 },
    ...over,
  }) as any;

describe('trade exits', () => {
  test('breakout target hit closes the trade as a WIN once', async () => {
    const { engine, closeSink, closed } = setup();
    const ctx = { istTime: '09:40:00', breakout: breakout('TARGET_HIT') };
    await engine.evaluate(ctx);
    await engine.evaluate(ctx);

    expect(closeSink).toHaveBeenCalledTimes(1);
    expect(closed).toHaveLength(1);
    expect(closed[0][0]).toMatchObject({
      strategyId: STRATEGY_IDS.BREAKOUT_180, symbol: 'NIFTY 24900 CE', outcome: 'WIN', exitPrice: 220, pnlPoints: 38,
    });
  });

  test('breakout stop-loss is a LOSS at the fixed stop, time exit uses the last price and notifies', async () => {
    const sl = setup();
    await sl.engine.evaluate({ istTime: 't', breakout: breakout('SL_HIT') });
    expect(sl.closed[0][0]).toMatchObject({ outcome: 'LOSS', exitPrice: 160, pnlPoints: -22 });

    const te = setup();
    await te.engine.evaluate({ istTime: 't', breakout: breakout('TIME_EXIT', { activeContract: 'PE', currentPrice: 185 }) });
    expect(te.closed[0][0]).toMatchObject({ symbol: 'NIFTY 24800 PE', outcome: 'TIME_EXIT', exitPrice: 185, pnlPoints: 3 });
    expect(te.n.notify180TimeExit).toHaveBeenCalledWith(24800, 'PE');
  });

  test('breakout with no trade or still in trade emits no exit', async () => {
    const { engine, closed } = setup();
    await engine.evaluate({ istTime: 't', breakout: breakout('IN_TRADE') });
    await engine.evaluate({ istTime: 't', breakout: breakout('NO_TRADE_TODAY', { activeContract: null }) });
    expect(closed).toEqual([]);
  });

  test('OOBTST stop-loss closes at the stop price with the loss in points and notifies', async () => {
    const { engine, n, closed } = setup();
    await engine.evaluate({ istTime: 't', niftyOobtst: oobtst('SL_HIT') });

    expect(closed[0][0]).toMatchObject({
      strategyId: STRATEGY_IDS.OOBTST_NIFTY, symbol: 'NIFTY 24850 CE', outcome: 'LOSS', exitPrice: 45, pnlPoints: -45,
    });
    expect(n.notify0920StopLossHit).toHaveBeenCalledWith('CE', 24850, 45);
  });

  test('OOBTST BTST hold is not an exit', async () => {
    const { engine, closed } = setup();
    await engine.evaluate({ istTime: 't', niftyOobtst: oobtst('BTST_HOLD') });
    expect(closed).toEqual([]);
  });

  test('a failing close sink or listener does not break the evaluation', async () => {
    const n = notifier();
    const engine = new StrategyEngine(
      new SignalPipeline(fakeLatch(), () => 1, undefined, async () => {
        throw new Error('disk');
      })
    );
    engine.register(createNiftyOobtstStrategy({ notifier: n, tacticalStrike: () => ({ recommendedCeStrike: 0 }) }));
    engine.onClosed(() => {
      throw new Error('listener');
    });
    await expect(engine.evaluate({ istTime: 't', niftyOobtst: oobtst('SL_HIT') })).resolves.toBeDefined();
  });
});

describe('journal math', () => {
  const entry = (id: string, over: Partial<SignalJournalItem> = {}): SignalJournalItem => ({
    id, timestamp: 't', strategyId: 'S', strategyName: 'S', symbol: 'X', signalType: 'BUY', entryPrice: 10, outcome: 'OPEN', notes: 'in',
    ...over,
  });
  const trade: ClosedTrade = { strategyId: 'S', symbol: 'X', outcome: 'LOSS', exitPrice: 5, pnlPoints: -5, timestamp: 't', notes: 'SL' };

  test('applyClosedTrades closes the matching open row only', () => {
    const journal = [entry('a'), entry('b', { symbol: 'Y' }), entry('c', { outcome: 'WIN', pnlPoints: 3 })];
    const out = applyClosedTrades(journal, [trade]);
    expect(out[0]).toMatchObject({ outcome: 'LOSS', exitPrice: 5, pnlPoints: -5, notes: 'in SL' });
    expect(out[1]).toBe(journal[1]);
    expect(out[2]).toBe(journal[2]);
    expect(applyClosedTrades(journal, [])).toBe(journal);
  });

  test('sumPoints totals results and ignores open rows', () => {
    expect(sumPoints([entry('a', { pnlPoints: 38 }), entry('b', { pnlPoints: -22.5 }), entry('c')])).toBe(15.5);
    expect(sumPoints([])).toBe(0);
  });
});

describe('JournalRepository.closeTrade', () => {
  const day = '2099-03-03';
  const repo = new JournalRepository();
  const open: SignalJournalItem = {
    id: 'sig-x-1', timestamp: '09:31', strategyId: 'S1', strategyName: 'S1', symbol: 'NIFTY 24850 CE',
    signalType: 'BUY', entryPrice: 90, outcome: 'OPEN', notes: 'entry',
  };
  const trade: ClosedTrade = {
    strategyId: 'S1', symbol: 'NIFTY 24850 CE', outcome: 'LOSS', exitPrice: 45, pnlPoints: -45, timestamp: '10:05', notes: 'SL hit',
  };

  test('updates the open row and survives a restart; a second close is a no-op', async () => {
    await repo.save(open, day);
    await repo.closeTrade(trade, day);
    await repo.closeTrade({ ...trade, outcome: 'WIN', pnlPoints: 99 }, day);

    const [row] = await new JournalRepository().loadForDate(day);
    expect(row).toMatchObject({ outcome: 'LOSS', exitPrice: 45, pnlPoints: -45 });
    expect(row.notes).toBe('entry SL hit');
  });

  test('does nothing when there is no matching open entry', async () => {
    await repo.closeTrade({ ...trade, symbol: 'NIFTY 1 CE' }, '2099-03-04');
    expect(await repo.loadForDate('2099-03-04')).toEqual([]);
  });
});
