import {
  buildOrderRequest,
  checkLimits,
  marketHoursBlock,
  paperCorrelationId,
  roundUpToTick,
} from '../execution/orderMapping';
import { defaultExecutionSettings, sanitizeExecutionSettings } from '../execution/executionSettings';
import { ExecutionService, PAPER_BLOCKED, PAPER_PLANNED } from '../execution/ExecutionService';
import type { ExecutableSignal, ExecutionSettings } from '../execution/types';
import { SignalPipeline, type LatchPort } from '../engine/SignalPipeline';
import { StrategyEngine } from '../engine/StrategyEngine';
import { createBreakout180Strategy, createNiftyOobtstStrategy, createSensexOobtstStrategy } from '../engine/strategies';
import type { StoredOrder } from '../services/OrderRepository';
import type { DhanOrder } from '../services/dhan/DhanOrderClient';

const hint = { securityId: '55555', exchangeSegment: 'NSE_FNO' as const, tradingSymbol: 'NIFTY 24850 CE', lotSize: 65, productType: 'INTRADAY' as const };

const signal = (over: Partial<ExecutableSignal> = {}): ExecutableSignal => ({
  journalId: 'sig-breakout-1730000000000',
  strategyId: 'NIFTY_BREAKOUT_180',
  symbol: 'NIFTY 24850 CE',
  side: 'BUY',
  entryPrice: 180,
  stopLoss: 160,
  target: 220,
  timestamp: '09:31:00',
  hint,
  ...over,
});

function settings(over: Partial<ExecutionSettings> = {}): ExecutionSettings {
  const s = defaultExecutionSettings();
  s.mode = 'PAPER';
  s.strategies.NIFTY_BREAKOUT_180.enabled = true;
  return { ...s, ...over };
}

// 2026-10-23 is a Friday. 05:30 UTC is 11:00 IST.
const OPEN_HOURS = new Date('2026-10-23T05:30:00Z');

function fakeRepo() {
  const rows = new Map<string, StoredOrder>();
  return {
    rows,
    upsert: jest.fn(async (env: string, order: DhanOrder, meta: any = {}) => {
      rows.set(`${env}:${order.correlationId}`, { ...order, id: `${env}:${order.correlationId}`, env: env as any, tradeDate: '2026-10-23', source: meta.source ?? 'APP', strategyId: meta.strategyId ?? null });
    }),
    loadForDate: jest.fn(async (env: string) => [...rows.values()].filter((r) => r.env === env)),
  };
}

function service(s: ExecutionSettings, over: { now?: Date; isTradingDay?: (d: Date) => boolean } = {}) {
  const repo = fakeRepo();
  const svc = new ExecutionService({
    repo: repo as any,
    loadSettings: async () => s,
    now: () => over.now ?? OPEN_HOURS,
    isTradingDay: over.isTradingDay ?? (() => true),
  });
  return { svc, repo };
}

describe('order mapping', () => {
  test('rounds a price up to the 0.05 tick', () => {
    expect(roundUpToTick(181.8)).toBe(181.8);
    expect(roundUpToTick(181.81)).toBe(181.85);
    expect(roundUpToTick(100.0001)).toBe(100.05);
    expect(roundUpToTick(99.95)).toBe(99.95);
  });

  test('correlation ids are stable per signal and valid for Dhan', () => {
    const id = paperCorrelationId('sig-oobtst-nifty-1730000000000');
    expect(id).toBe(paperCorrelationId('sig-oobtst-nifty-1730000000000'));
    expect(id).toMatch(/^[a-zA-Z0-9_.-]{1,30}$/);
    expect(paperCorrelationId('sig-a b/c-1')).toMatch(/^QSP-/);
    expect(paperCorrelationId('x'.repeat(60))).toHaveLength(30);
  });

  test('builds a buffered buy limit order sized in lots', () => {
    const s = settings();
    s.strategies.NIFTY_BREAKOUT_180.lots = 2;
    const out = buildOrderRequest(signal(), s);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.lots).toBe(2);
      expect(out.request).toMatchObject({
        transactionType: 'BUY',
        orderType: 'LIMIT',
        validity: 'DAY',
        exchangeSegment: 'NSE_FNO',
        productType: 'INTRADAY',
        securityId: '55555',
        quantity: 130,
        price: 181.8,
      });
    }
  });

  test('refuses signals it cannot or should not turn into orders', () => {
    const s = settings();
    expect(buildOrderRequest(signal({ hint: undefined }), s)).toEqual({ ok: false, reason: expect.stringContaining('security ID') });
    expect(buildOrderRequest(signal({ side: 'SELL' }), s)).toMatchObject({ ok: false });
    expect(buildOrderRequest(signal({ strategyId: '20D_CROSSOVER' }), s)).toEqual({ ok: false, reason: 'This strategy is alert-only.' });
    expect(buildOrderRequest(signal({ entryPrice: 0 }), s)).toMatchObject({ ok: false });
  });

  test('limits are checked in order and report which one was hit', () => {
    const s = settings();
    const req = { price: 100, quantity: 65 } as any; // value 6500
    expect(checkLimits(req, 1, { orders: 0, value: 0 }, s)).toBeNull();
    expect(checkLimits(req, 3, { orders: 0, value: 0 }, s)).toMatch(/lot limit/);
    expect(checkLimits(req, 1, { orders: 3, value: 0 }, s)).toMatch(/Daily limit of 3 orders/);
    expect(checkLimits({ price: 1000, quantity: 65 } as any, 1, { orders: 0, value: 0 }, s)).toMatch(/per-order limit/);
    expect(checkLimits(req, 1, { orders: 1, value: 95000 }, s)).toMatch(/daily limit/);
  });

  test('order hours are 09:15 to 15:25 IST on trading days', () => {
    const open = () => true;
    expect(marketHoursBlock(new Date('2026-10-23T03:45:00Z'), open)).toBeNull(); // 09:15 IST
    expect(marketHoursBlock(new Date('2026-10-23T03:44:00Z'), open)).toMatch(/Outside order hours/); // 09:14
    expect(marketHoursBlock(new Date('2026-10-23T09:54:00Z'), open)).toBeNull(); // 15:24
    expect(marketHoursBlock(new Date('2026-10-23T09:55:00Z'), open)).toMatch(/Outside order hours/); // 15:25
    expect(marketHoursBlock(OPEN_HOURS, () => false)).toBe('The market is closed today.');
  });
});

describe('execution settings', () => {
  test('defaults are safe: off, nothing enabled, small limits', () => {
    const d = defaultExecutionSettings();
    expect(d.mode).toBe('OFF');
    expect(d.killSwitch).toBe(false);
    expect(Object.values(d.strategies).every((s) => !s.enabled && s.lots === 1)).toBe(true);
  });

  test('repairs unknown modes, bad numbers and missing fields', () => {
    expect(sanitizeExecutionSettings(null).mode).toBe('OFF');
    const s = sanitizeExecutionSettings({
      mode: 'AUTO',
      killSwitch: 'yes',
      limitBufferPct: 99,
      limits: { maxLotsPerOrder: -2, maxOrdersPerDay: '4', maxOrderValue: 'x', maxDailyValue: 70000 },
      strategies: { OOBTST_NIFTY: { enabled: true, lots: 2.7 } },
    });
    expect(s.mode).toBe('OFF');
    expect(s.killSwitch).toBe(false);
    expect(s.limitBufferPct).toBe(10);
    expect(s.limits).toEqual({ maxLotsPerOrder: 2, maxOrdersPerDay: 4, maxOrderValue: 50000, maxDailyValue: 70000 });
    expect(s.strategies.OOBTST_NIFTY).toEqual({ enabled: true, lots: 2 });
    expect(s.strategies.NIFTY_BREAKOUT_180.enabled).toBe(false);
  });
});

describe('ExecutionService (paper mode)', () => {
  test('does nothing when execution is off or the strategy is not enabled', async () => {
    const off = service({ ...settings(), mode: 'OFF' });
    expect(await off.svc.onSignal(signal())).toEqual({ kind: 'SKIPPED' });
    expect(off.repo.upsert).not.toHaveBeenCalled();

    const notEnabled = service(settings());
    expect(await notEnabled.svc.onSignal(signal({ strategyId: 'OOBTST_NIFTY' }))).toEqual({ kind: 'SKIPPED' });
    expect(await notEnabled.svc.onSignal(signal({ strategyId: '20D_CROSSOVER' }))).toEqual({ kind: 'SKIPPED' });
    expect(notEnabled.repo.upsert).not.toHaveBeenCalled();
  });

  test('records the planned order without sending anything', async () => {
    const { svc, repo } = service(settings());
    const out = await svc.onSignal(signal());
    expect(out.kind).toBe('PLANNED');
    const row = [...repo.rows.values()][0];
    expect(row).toMatchObject({
      env: 'PAPER',
      status: PAPER_PLANNED,
      transactionType: 'BUY',
      securityId: '55555',
      quantity: 65,
      price: 181.8,
      productType: 'INTRADAY',
      strategyId: 'NIFTY_BREAKOUT_180',
      errorMessage: null,
    });
  });

  test('records a blocked order with its reason for each rule', async () => {
    const killed = service({ ...settings(), killSwitch: true });
    expect(await killed.svc.onSignal(signal())).toMatchObject({ kind: 'BLOCKED', reason: 'Kill switch is on.' });
    expect([...killed.repo.rows.values()][0]).toMatchObject({ status: PAPER_BLOCKED, errorMessage: 'Kill switch is on.' });

    const closed = service(settings(), { now: new Date('2026-10-23T11:00:00Z') });
    expect(await closed.svc.onSignal(signal())).toMatchObject({ kind: 'BLOCKED', reason: expect.stringContaining('Outside order hours') });

    const noHint = service(settings());
    expect(await noHint.svc.onSignal(signal({ hint: undefined }))).toMatchObject({ kind: 'BLOCKED', reason: expect.stringContaining('security ID') });
    expect([...noHint.repo.rows.values()][0].securityId).toBe('');
  });

  test('enforces daily order count and value limits across signals', async () => {
    const s = settings();
    s.limits.maxOrdersPerDay = 2;
    const { svc } = service(s);
    expect((await svc.onSignal(signal({ journalId: 'sig-a-1' }))).kind).toBe('PLANNED');
    expect((await svc.onSignal(signal({ journalId: 'sig-b-2' }))).kind).toBe('PLANNED');
    expect(await svc.onSignal(signal({ journalId: 'sig-c-3' }))).toMatchObject({ kind: 'BLOCKED', reason: expect.stringContaining('Daily limit of 2') });

    const v = settings();
    v.limits.maxOrderValue = 10000; // one lot at 181.8 x 65 = 11817
    expect(await service(v).svc.onSignal(signal())).toMatchObject({ kind: 'BLOCKED', reason: expect.stringContaining('per-order limit') });
  });

  test('replaying the same signal updates one record instead of adding another or blocking itself', async () => {
    const s = settings();
    s.limits.maxOrdersPerDay = 1;
    const { svc, repo } = service(s);
    expect((await svc.onSignal(signal())).kind).toBe('PLANNED');
    expect((await svc.onSignal(signal())).kind).toBe('PLANNED');
    expect(repo.rows.size).toBe(1);
  });
});

describe('engine integration', () => {
  const latch = (): LatchPort => {
    const taken = new Set<string>();
    return {
      isAlertLatched: (k, s) => taken.has(`${k}|${s}`),
      acquireAlertLatch: async (k, s) => {
        if (taken.has(`${k}|${s}`)) return false;
        taken.add(`${k}|${s}`);
        return true;
      },
    };
  };
  const deps = { notifier: { notify20DCrossover: jest.fn(), notify180BreakoutTriggered: jest.fn(), notify0920StrangleEntry: jest.fn() }, tacticalStrike: () => ({ recommendedCeStrike: 1 }) } as any;

  const breakout = (securityId?: string) =>
    ({
      status: 'IN_TRADE', activeContract: 'CE', entryPrice: 180, fixedTarget: 220, fixedStopLoss: 160, entryTime: '09:31:00',
      ceCandidate: { strike: 24850, securityId }, peCandidate: { strike: 24800 },
    }) as any;

  const oobtst = (strike: number, securityId?: string) =>
    ({
      status: 'ACTIVE', activeLeg: 'CE', lastUpdated: '09:31:00',
      ceLeg: { symbol: `X ${strike} CE`, strike, openPrice: 60, currentLtp: 92 },
      peLeg: { symbol: `X ${strike} PE`, strike, openPrice: 64, currentLtp: 40 },
      ceCandidates: [{ strike, securityId }], peCandidates: [],
    }) as any;

  test('the pipeline hands each journaled signal to the execution port, with instrument data', async () => {
    const onSignal = jest.fn(async () => ({ kind: 'SKIPPED' as const }));
    const engine = new StrategyEngine(new SignalPipeline(latch(), () => 1, undefined, undefined, { onSignal }));
    engine.register(createBreakout180Strategy(deps));
    engine.register(createNiftyOobtstStrategy(deps));
    engine.register(createSensexOobtstStrategy(deps));

    await engine.evaluate({ istTime: '09:31:00', breakout: breakout('111'), niftyOobtst: oobtst(24850, '222'), sensexOobtst: oobtst(80000, '333') });

    const calls = (onSignal.mock.calls as unknown as Array<[ExecutableSignal]>).map((c) => c[0]);
    const by = (id: string) => calls.find((c) => c.strategyId === id)!;
    expect(by('NIFTY_BREAKOUT_180').hint).toEqual({ securityId: '111', exchangeSegment: 'NSE_FNO', tradingSymbol: 'NIFTY 24850 CE', lotSize: 65, productType: 'INTRADAY' });
    expect(by('OOBTST_NIFTY').hint).toMatchObject({ securityId: '222', exchangeSegment: 'NSE_FNO', lotSize: 65, productType: 'MARGIN' });
    expect(by('OOBTST_SENSEX').hint).toMatchObject({ securityId: '333', exchangeSegment: 'BSE_FNO', lotSize: 20, productType: 'MARGIN' });
    expect(by('NIFTY_BREAKOUT_180')).toMatchObject({ side: 'BUY', entryPrice: 180, stopLoss: 160, target: 220 });
  });

  test('a contract without a known security ID still produces its signal, just without a hint', async () => {
    const onSignal = jest.fn(async () => ({ kind: 'SKIPPED' as const }));
    const engine = new StrategyEngine(new SignalPipeline(latch(), () => 1, undefined, undefined, { onSignal }));
    engine.register(createBreakout180Strategy(deps));
    const out = await engine.evaluate({ istTime: '09:31:00', breakout: breakout(undefined) });
    expect(out).toHaveLength(1);
    expect((onSignal.mock.calls[0] as unknown as [ExecutableSignal])[0].hint).toBeUndefined();
  });

  test('an execution failure never hides or undoes a journaled signal', async () => {
    const onSignal = jest.fn(async () => {
      throw new Error('db down');
    });
    const engine = new StrategyEngine(new SignalPipeline(latch(), () => 1, undefined, undefined, { onSignal }));
    engine.register(createBreakout180Strategy(deps));
    const out = await engine.evaluate({ istTime: '09:31:00', breakout: breakout('111') });
    expect(out).toHaveLength(1);
    expect(onSignal).toHaveBeenCalledTimes(1);
  });

  test('a duplicate signal is suppressed by the latch before it can reach execution', async () => {
    const onSignal = jest.fn(async () => ({ kind: 'SKIPPED' as const }));
    const engine = new StrategyEngine(new SignalPipeline(latch(), () => 1, undefined, undefined, { onSignal }));
    engine.register(createBreakout180Strategy(deps));
    await engine.evaluate({ istTime: '09:31:00', breakout: breakout('111') });
    await engine.evaluate({ istTime: '09:31:01', breakout: breakout('111') });
    expect(onSignal).toHaveBeenCalledTimes(1);
  });
});
