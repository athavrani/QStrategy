import { DhanOrderClient, type OrderRequest } from '../services/dhan/DhanOrderClient';
import { PositionRepository, isActivePosition } from '../services/PositionRepository';
import { ExecutionService } from '../execution/ExecutionService';
import { defaultExecutionSettings } from '../execution/executionSettings';
import type { ExecutableSignal, ExecutionSettings } from '../execution/types';
import type { StoredOrder } from '../services/OrderRepository';
import type { DhanOrder } from '../services/dhan/DhanOrderClient';
import { dbManager } from '../db/database';

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => ({ clientId: '2000000001', token: 'sandbox-token' })),
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '1100345678', token: 'live-token' })),
    updateTelemetry: jest.fn(),
  },
}));

const res = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });

const SELL: OrderRequest = {
  correlationId: 'QSS-test',
  transactionType: 'SELL',
  exchangeSegment: 'NSE_FNO',
  productType: 'INTRADAY',
  orderType: 'STOP_LOSS',
  validity: 'DAY',
  securityId: '55555',
  quantity: 65,
  price: 155.2,
  triggerPrice: 160,
};

describe('closing orders on the live client', () => {
  const fetchMock = jest.fn();
  const refusing = () => new DhanOrderClient('LIVE', { gate: () => 'Not armed.', sleep: async () => {}, lookupDelayMs: 0 });

  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
    fetchMock.mockResolvedValue(res({ orderId: 'S1', orderStatus: 'TRANSIT' }));
  });

  test('a closing sell goes through even when the arm gate would refuse a new order', async () => {
    const live = refusing();
    expect(await live.placeOrder({ ...SELL, transactionType: 'BUY' })).toMatchObject({ kind: 'REJECTED', error: 'Not armed.' });

    const out = await live.placeClosingOrder(SELL, 65);
    expect(out).toEqual({ kind: 'PLACED', orderId: 'S1', status: 'TRANSIT', correlationId: 'QSS-test' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.dhan.co/v2/orders');
    expect(JSON.parse(init.body)).toMatchObject({ transactionType: 'SELL', orderType: 'STOP_LOSS', quantity: 65, triggerPrice: 160, price: 155.2 });
  });

  test('a closing order can never be a buy, larger than what is held, or placed with nothing held', async () => {
    const live = refusing();
    expect(await live.placeClosingOrder({ ...SELL, transactionType: 'BUY' }, 65)).toMatchObject({ kind: 'REJECTED', error: 'A closing order must be a SELL.' });
    expect(await live.placeClosingOrder({ ...SELL, quantity: 66 }, 65)).toMatchObject({ kind: 'REJECTED', error: expect.stringContaining('cannot be larger') });
    expect(await live.placeClosingOrder(SELL, 0)).toMatchObject({ kind: 'REJECTED', error: 'There is nothing held to close.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a disabled environment still refuses closing orders', async () => {
    const { ORDER_ENVIRONMENTS_ENABLED } = require('../config/orderConfig');
    ORDER_ENVIRONMENTS_ENABLED.LIVE = false;
    try {
      expect(await refusing().placeClosingOrder(SELL, 65)).toMatchObject({ kind: 'REJECTED', error: expect.stringContaining('switched off') });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      ORDER_ENVIRONMENTS_ENABLED.LIVE = true;
    }
  });

  test('a timeout on a closing order is looked up by its reference, never sent twice', async () => {
    const live = refusing();
    fetchMock.mockImplementation(async (_u: string, init: any) => {
      if (init.method === 'POST') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return res({ orderId: 'S2', correlationId: 'QSS-test', orderStatus: 'PENDING' });
    });
    const out = await live.placeClosingOrder(SELL, 65);
    expect(out).toMatchObject({ kind: 'PLACED', orderId: 'S2' });
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(1);
  });

  test('modifying a closing order bypasses the gate but never exceeds the quantity held', async () => {
    const live = refusing();
    fetchMock.mockResolvedValue(res({ orderId: 'S1', orderStatus: 'PENDING' }));
    expect(await live.modifyOrder('S1', { orderType: 'STOP_LOSS', validity: 'DAY', quantity: 10 })).toMatchObject({ ok: false, error: 'Not armed.' });
    expect(await live.modifyClosingOrder('S1', { orderType: 'STOP_LOSS', validity: 'DAY', quantity: 65, price: 155.2, triggerPrice: 160 }, 65)).toMatchObject({ ok: true });
    expect(await live.modifyClosingOrder('S1', { orderType: 'STOP_LOSS', validity: 'DAY', quantity: 70 }, 65)).toMatchObject({ ok: false, error: expect.stringContaining('cannot be larger') });
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'PUT')).toHaveLength(1);
  });
});

describe('PositionRepository', () => {
  const repo = new PositionRepository();
  const base = { strategyId: 'NIFTY_BREAKOUT_180', securityId: '55555', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', tradingSymbol: 'NIFTY 24850 CE', requestedQty: 65 };

  beforeEach(async () => {
    ((await dbManager.getDatabase()) as any).tables?.clear();
  });

  test('creates a proposed position that is inert, remembers stop-loss and target, and merges updates', async () => {
    const p = await repo.create({ ...base, id: 'P1', slPrice: 160, targetPrice: 220 });
    expect(p).toMatchObject({ state: 'PROPOSED', filledQty: 0, slPrice: 160, targetPrice: 220, slOrderId: null });
    expect(isActivePosition(p.state)).toBe(false);
    expect(await repo.loadActive()).toHaveLength(0);
    expect(await repo.loadVisible()).toHaveLength(0);

    const sent = await repo.update('P1', { state: 'ENTRY_SENT', entryOrderId: 'E1' });
    expect(sent).toMatchObject({ state: 'ENTRY_SENT', entryOrderId: 'E1', slPrice: 160 });
    expect((await repo.loadActive()).map((x) => x.id)).toEqual(['P1']);
    expect(await repo.update('missing', { state: 'CLOSED' })).toBeNull();
  });

  test('visible positions are the active ones plus today\'s finished ones', async () => {
    await repo.create({ ...base, id: 'A', state: 'PROTECTED' });
    await repo.create({ ...base, id: 'B', state: 'CLOSED' });
    await repo.create({ ...base, id: 'C', state: 'CLOSED', tradeDate: '2026-01-01' });
    await repo.create({ ...base, id: 'D', state: 'PROPOSED' });
    const visible = (await repo.loadVisible()).map((x) => x.id).sort();
    expect(visible).toEqual(['A', 'B']);
  });

  test('stored values survive a round trip', async () => {
    await repo.create({ ...base, id: 'R' });
    await repo.update('R', { state: 'CLOSED', filledQty: 65, entryAvg: 180.5, exitAvg: 158, pnl: -1462.5, note: 'Stop-loss hit.', exitHint: 'Target hit' });
    expect(await repo.get('R')).toMatchObject({ state: 'CLOSED', filledQty: 65, entryAvg: 180.5, exitAvg: 158, pnl: -1462.5, note: 'Stop-loss hit.', exitHint: 'Target hit', slPrice: null });
  });
});

describe('execution tracking of positions', () => {
  const hint = { securityId: '55555', exchangeSegment: 'NSE_FNO' as const, tradingSymbol: 'NIFTY 24850 CE', lotSize: 65, productType: 'INTRADAY' as const };
  const signal = (over: Partial<ExecutableSignal> = {}): ExecutableSignal => ({
    journalId: 'sig-breakout-1730000000000', strategyId: 'NIFTY_BREAKOUT_180', symbol: 'NIFTY 24850 CE', side: 'BUY',
    entryPrice: 180, stopLoss: 160, target: 220, timestamp: '09:31:00', hint, ...over,
  });
  const corr = 'QSP-' + 'sig-breakout-1730000000000'.slice(-26);
  const OPEN_HOURS = new Date('2026-10-23T05:30:00Z').getTime();

  function build(over: Record<string, any> = {}) {
    const rows = new Map<string, StoredOrder>();
    const repo = {
      upsert: jest.fn(async (env: string, order: DhanOrder, meta: any = {}) => {
        const key = `${env}:${order.correlationId}`;
        rows.set(key, { ...order, id: key, env: env as any, tradeDate: '2026-10-23', source: meta.source ?? 'APP', strategyId: meta.strategyId ?? null });
      }),
      loadForDate: jest.fn(async (env: string) => [...rows.values()].filter((r) => r.env === env)),
    };
    const created: any[] = [];
    const updates: Array<[string, any]> = [];
    const positions = {
      create: jest.fn(async (p: any) => { created.push(p); return p; }),
      update: jest.fn(async (id: string, patch: any) => { updates.push([id, patch]); return created.find((c) => c.id === id) ? { ...patch } : null; }),
    };
    const settings: ExecutionSettings = { ...defaultExecutionSettings(), mode: 'CONFIRM' };
    settings.strategies.NIFTY_BREAKOUT_180.enabled = true;
    const liveClient = { placeAndConfirm: jest.fn(async (r: any) => ({ kind: 'PLACED' as const, orderId: 'L1', status: 'TRANSIT', correlationId: r.correlationId })) };
    const svc = new ExecutionService({
      repo: repo as any, positions: positions as any, liveClient: liveClient as any, loadSettings: async () => settings,
      now: () => new Date(OPEN_HOURS), isTradingDay: () => true, isArmed: () => true, authenticate: async () => true, checkIp: async () => null, notify: jest.fn(),
      ...over,
    });
    return { svc, positions, created, updates, liveClient };
  }

  test('a proposal remembers the signal\'s stop-loss and target, inert until sent', async () => {
    const { svc, created } = build();
    await svc.onSignal(signal());
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id: corr, strategyId: 'NIFTY_BREAKOUT_180', securityId: '55555', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', requestedQty: 65, slPrice: 160, targetPrice: 220 });
    expect(created[0].state).toBeUndefined(); // starts as PROPOSED
  });

  test('confirming marks the position as having an entry out, with its order id', async () => {
    const { svc, updates } = build();
    await svc.onSignal(signal());
    await svc.confirmProposal(corr);
    expect(updates).toContainEqual([corr, { state: 'ENTRY_SENT', entryOrderId: 'L1', requestedQty: 65 }]);
  });

  test('an uncertain send is tracked too, because it may be live and fill', async () => {
    const { svc, updates } = build({
      liveClient: { placeAndConfirm: jest.fn(async (r: any) => ({ kind: 'UNKNOWN', error: 'timeout', correlationId: r.correlationId })) },
    });
    await svc.onSignal(signal());
    expect(await svc.confirmProposal(corr)).toMatchObject({ ok: false, uncertain: true });
    expect(updates).toContainEqual([corr, { state: 'ENTRY_SENT', entryOrderId: null, requestedQty: 65 }]);
  });

  test('a rejected send does not create or advance a position', async () => {
    const { svc, updates } = build({
      liveClient: { placeAndConfirm: jest.fn(async (r: any) => ({ kind: 'REJECTED', error: 'No funds', code: null, correlationId: r.correlationId })) },
    });
    await svc.onSignal(signal());
    await svc.confirmProposal(corr);
    expect(updates.filter(([, p]) => p.state === 'ENTRY_SENT')).toHaveLength(0);
  });

  test('a proposal that predates tracking gets a position when it is sent, so it is still watched', async () => {
    const { svc, positions, created } = build();
    await svc.onSignal(signal());
    created.length = 0; // simulate no remembered row
    positions.update.mockResolvedValueOnce(null as any);
    await svc.confirmProposal(corr);
    const made = created.find((c) => c.id === corr);
    expect(made).toMatchObject({ state: 'ENTRY_SENT', requestedQty: 65 });
    expect(made.slPrice).toBeUndefined(); // no remembered stop-loss price; the manager will flag it as unprotected
  });

  test('a failing position store never blocks the order from being sent', async () => {
    const { svc, liveClient } = build({
      positions: { create: jest.fn(async () => { throw new Error('db'); }), update: jest.fn(async () => { throw new Error('db'); }) },
    });
    expect((await svc.onSignal(signal())).kind).toBe('PROPOSED');
    expect(await svc.confirmProposal(corr)).toMatchObject({ ok: true });
    expect(liveClient.placeAndConfirm).toHaveBeenCalledTimes(1);
  });
});
