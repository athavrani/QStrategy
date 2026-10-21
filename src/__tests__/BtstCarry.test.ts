import { SignalPipeline, LatchPort } from '../engine/SignalPipeline';
import { StrategyEngine } from '../engine/StrategyEngine';
import { createBtstCarryStrategy, STRATEGY_IDS } from '../engine/strategies';
import { applyClosedTrades } from '../engine/journalMath';
import { BtstCarryService } from '../services/BtstCarryService';
import { JournalRepository } from '../services/JournalRepository';
import { dailyStrategyLockService } from '../services/DailyStrategyLockService';
import { marketData } from '../services/marketdata/MarketDataService';
import type { CarryTrade, ClosedTrade } from '../engine/types';
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

const carry = (over: Partial<CarryTrade> = {}): CarryTrade => ({
  journalId: 'sig-oobtst-nifty-1', strategyId: 'OOBTST_NIFTY', symbol: 'NIFTY 24850 CE', tradeDate: '2099-05-01',
  entryPrice: 90, slPrice: 45, securityId: '5001', segment: 'NSE_FNO', ...over,
});

function setup(ltp: number | undefined) {
  const notify0920StopLossHit = jest.fn();
  const closeSink = jest.fn(async () => {});
  const engine = new StrategyEngine(new SignalPipeline(fakeLatch(), () => 1, undefined, closeSink));
  engine.register(
    createBtstCarryStrategy({
      notifier: { notify20DCrossover: jest.fn(), notify180BreakoutTriggered: jest.fn(), notify0920StrangleEntry: jest.fn(), notify0920StopLossHit },
      tacticalStrike: () => ({ recommendedCeStrike: 0 }),
      getLtp: () => ltp,
    })
  );
  const closed: ClosedTrade[][] = [];
  engine.onClosed((t) => closed.push(t));
  return { engine, closeSink, closed, notify0920StopLossHit };
}

describe('BTST morning exit strategy', () => {
  test('squares off at 09:25 with the live price, once', async () => {
    const { engine, closeSink, closed } = setup(120);
    const ctx = { istTime: '09:25:03 IST', carry: [carry()] };
    await engine.evaluate(ctx);
    await engine.evaluate(ctx);

    expect(closeSink).toHaveBeenCalledTimes(1);
    expect(closed[0][0]).toMatchObject({
      outcome: 'TIME_EXIT', exitPrice: 120, pnlPoints: 30, tradeDate: '2099-05-01', journalId: 'sig-oobtst-nifty-1',
    });
  });

  test('waits before 09:25 while the price is above the stop', async () => {
    const { engine, closed } = setup(100);
    await engine.evaluate({ istTime: '09:20:00 IST', carry: [carry()] });
    expect(closed).toEqual([]);
  });

  test('exits at the 50% stop from 09:15, with a notification', async () => {
    const { engine, closed, notify0920StopLossHit } = setup(40);
    await engine.evaluate({ istTime: '09:16:00 IST', carry: [carry()] });

    expect(closed[0][0]).toMatchObject({ outcome: 'LOSS', exitPrice: 45, pnlPoints: -45 });
    expect(notify0920StopLossHit).toHaveBeenCalledWith('CE', 24850, 45);
  });

  test('does nothing before 09:15, without a price, or without carried trades', async () => {
    const early = setup(10);
    await early.engine.evaluate({ istTime: '09:10:00 IST', carry: [carry()] });
    const noPrice = setup(undefined);
    await noPrice.engine.evaluate({ istTime: '09:30:00 IST', carry: [carry()] });
    const none = setup(120);
    await none.engine.evaluate({ istTime: '09:30:00 IST' });
    expect([early.closed, noPrice.closed, none.closed]).toEqual([[], [], []]);
  });

  test('ids stay unique for the same symbol on different carry dates', async () => {
    const { engine, closed } = setup(120);
    await engine.evaluate({
      istTime: '09:30:00 IST',
      carry: [carry(), carry({ journalId: 'sig-other', tradeDate: '2099-04-30' })],
    });
    expect(closed[0]).toHaveLength(2);
  });
});

describe('applyClosedTrades with a carried row', () => {
  const row = (id: string): SignalJournalItem => ({
    id, timestamp: 't', strategyId: 'OOBTST_NIFTY', strategyName: 'N', symbol: 'NIFTY 24850 CE', signalType: 'BUY',
    entryPrice: 90, outcome: 'OPEN', notes: 'in',
  });

  test('matches by journal id so today\'s identical symbol is not closed by mistake', () => {
    const journal = [row('today-1'), row('carried-1')];
    const trade: ClosedTrade = {
      strategyId: 'OOBTST_NIFTY', symbol: 'NIFTY 24850 CE', outcome: 'TIME_EXIT', exitPrice: 120, pnlPoints: 30,
      timestamp: 't', notes: 'exit', journalId: 'carried-1', tradeDate: '2099-05-01',
    };
    const out = applyClosedTrades(journal, [trade]);
    expect(out[0].outcome).toBe('OPEN');
    expect(out[1]).toMatchObject({ outcome: 'TIME_EXIT', pnlPoints: 30 });
  });
});

describe('BtstCarryService and repository', () => {
  const today = '2099-06-10';
  const repo = new JournalRepository();
  const open = (id: string, strategyId: string, symbol: string, entryPrice: number): SignalJournalItem => ({
    id, timestamp: '09:31', strategyId, strategyName: strategyId, symbol, signalType: 'BUY', entryPrice, outcome: 'OPEN',
  });

  beforeEach(() => jest.restoreAllMocks());

  test('loads yesterday\'s open OOBTST trades with security id, stop and segment', async () => {
    await repo.save(open('n-1', 'OOBTST_NIFTY', 'NIFTY 24850 CE', 90), '2099-06-09');
    await repo.save(open('s-1', 'OOBTST_SENSEX', 'SENSEX 81000 PE', 150), '2099-06-09');
    await repo.save(open('x-1', '20D_CROSSOVER', 'RELIANCE', 10), '2099-06-09');
    await repo.save(open('old-1', 'OOBTST_NIFTY', 'NIFTY 24000 CE', 80), '2099-05-01');
    await repo.save({ ...open('done-1', 'OOBTST_NIFTY', 'NIFTY 24900 CE', 70), outcome: 'LOSS' }, '2099-06-09');

    jest.spyOn(dailyStrategyLockService, 'getLock').mockImplementation(async (_d, id) =>
      id === 'NIFTY_OOBTST'
        ? ({ ce_symbol: 'NIFTY 24850 CE', ce_sec_id: '5001', pe_symbol: 'NIFTY 24800 PE', pe_sec_id: '5002' } as any)
        : ({ ce_symbol: 'SENSEX 81000 CE', ce_sec_id: '9001', pe_symbol: 'SENSEX 81000 PE', pe_sec_id: '9002' } as any)
    );

    const { trades, journal } = await new BtstCarryService().load(today);
    expect(trades.map((t) => [t.journalId, t.securityId, t.segment, t.slPrice, t.tradeDate])).toEqual(
      expect.arrayContaining([
        ['n-1', '5001', 'NSE_FNO', 45, '2099-06-09'],
        ['s-1', '9002', 'BSE_FNO', 75, '2099-06-09'],
      ])
    );
    expect(trades).toHaveLength(2);
    expect(journal.map((j) => j.id).sort()).toEqual(['n-1', 's-1']);
  });

  test('skips trades whose contract cannot be priced', async () => {
    await repo.save(open('n-2', 'OOBTST_NIFTY', 'NIFTY 24700 CE', 90), '2099-07-09');
    jest.spyOn(dailyStrategyLockService, 'getLock').mockResolvedValue({ ce_symbol: 'NIFTY 24700 CE' } as any);
    expect((await new BtstCarryService().load('2099-07-10')).trades).toEqual([]);
  });

  test('closing by journal id updates the earlier session row and a second close is a no-op', async () => {
    await repo.save(open('n-3', 'OOBTST_NIFTY', 'NIFTY 24850 CE', 90), '2099-08-09');
    const trade: ClosedTrade = {
      strategyId: 'OOBTST_NIFTY', symbol: 'NIFTY 24850 CE', outcome: 'TIME_EXIT', exitPrice: 120, pnlPoints: 30,
      timestamp: 't', notes: 'BTST exit', journalId: 'n-3', tradeDate: '2099-08-09',
    };
    await repo.closeTrade(trade, '2099-08-10');
    await repo.closeTrade({ ...trade, outcome: 'LOSS', pnlPoints: -1 }, '2099-08-10');

    const [row] = await repo.loadForDate('2099-08-09');
    expect(row).toMatchObject({ outcome: 'TIME_EXIT', exitPrice: 120, pnlPoints: 30 });
    expect(await new BtstCarryService().load('2099-08-10').then((r) => r.trades)).toEqual([]);
  });

  test('watch subscribes only the carried contracts and releases dropped ones', () => {
    const acquire = jest.spyOn(marketData, 'acquire').mockImplementation(() => {});
    const release = jest.spyOn(marketData, 'release').mockImplementation(() => {});
    const svc = new BtstCarryService();
    const a = carry();
    const b = carry({ journalId: 'b', securityId: '9001', segment: 'BSE_FNO' });

    svc.watch([a, b]);
    expect(acquire).toHaveBeenCalledWith('btst-carry', [
      { exchangeSegment: 'NSE_FNO', securityId: '5001' },
      { exchangeSegment: 'BSE_FNO', securityId: '9001' },
    ]);
    svc.watch([b]);
    expect(release).toHaveBeenCalledWith('btst-carry', [{ exchangeSegment: 'NSE_FNO', securityId: '5001' }]);
    expect(STRATEGY_IDS.BTST_CARRY).toBe('BTST_CARRY');
  });
});
