import { PositionManager } from '../execution/PositionManager';
import type { Position } from '../services/PositionRepository';
import type { DhanOrder } from '../services/dhan/DhanOrderClient';
import { roundDownToTick } from '../execution/orderMapping';

// Friday 2026-10-23, 11:00 IST
const START = new Date('2026-10-23T05:30:00Z').getTime();
const TODAY = '2026-10-23';

const pos = (over: Partial<Position> = {}): Position => ({
  id: 'QSP-entry-1',
  tradeDate: TODAY,
  strategyId: 'NIFTY_BREAKOUT_180',
  securityId: '55555',
  exchangeSegment: 'NSE_FNO',
  productType: 'INTRADAY',
  tradingSymbol: 'NIFTY 24850 CE',
  state: 'ENTRY_SENT',
  requestedQty: 65,
  filledQty: 0,
  entryAvg: 0,
  entryOrderId: 'E1',
  slPrice: 160,
  targetPrice: 220,
  slOrderId: null,
  slCorrelationId: null,
  slPlacedAt: null,
  exitOrderId: null,
  exitCorrelationId: null,
  exitPlacedAt: null,
  exitAvg: null,
  pnl: null,
  exitHint: null,
  note: null,
  createdAt: new Date(START - 60_000).toISOString(),
  updatedAt: new Date(START - 60_000).toISOString(),
  ...over,
});

const ord = (over: Partial<DhanOrder> = {}): DhanOrder => ({
  orderId: 'E1',
  correlationId: 'QSP-entry-1',
  status: 'TRADED',
  transactionType: 'BUY',
  exchangeSegment: 'NSE_FNO',
  productType: 'INTRADAY',
  orderType: 'LIMIT',
  validity: 'DAY',
  securityId: '55555',
  tradingSymbol: 'NIFTY 24850 CE',
  quantity: 65,
  price: 181.8,
  triggerPrice: 0,
  filledQty: 65,
  remainingQuantity: 0,
  averageTradedPrice: 180,
  createTime: null,
  updateTime: null,
  errorCode: null,
  errorMessage: null,
  ...over,
});

function build(initial: Position[] = [pos()], book: DhanOrder[] = [], extra: Record<string, any> = {}) {
  let nowMs = START;
  const store = new Map<string, Position>(initial.map((p) => [p.id, p]));
  const positions = {
    get: jest.fn(async (id: string) => store.get(id) ?? null),
    update: jest.fn(async (id: string, patch: Partial<Position>) => {
      const cur = store.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, id };
      store.set(id, next);
      return next;
    }),
    loadActive: jest.fn(async () => [...store.values()].filter((p) => ['ENTRY_SENT', 'OPEN_UNPROTECTED', 'PROTECTED', 'CLOSING'].includes(p.state))),
    loadVisible: jest.fn(async () => [...store.values()]),
  };
  const state = { book, broker: [] as any[], brokerOk: true, ordersOk: true };
  const calls: string[] = [];
  const client = {
    getOrders: jest.fn(async () => (state.ordersOk ? { ok: true as const, data: state.book } : { ok: false as const, status: 500, error: 'down', code: null })),
    getPositions: jest.fn(async () => (state.brokerOk ? { ok: true as const, data: state.broker } : { ok: false as const, status: 500, error: 'down', code: null })),
    cancelOrder: jest.fn(async (id: string) => {
      calls.push(`cancel:${id}`);
      return { ok: true as const, data: { orderId: id, status: 'CANCELLED' } };
    }),
    placeClosingOrder: jest.fn(async (req: any, _held: number) => {
      calls.push(`place:${req.orderType}`);
      return { kind: 'PLACED' as const, orderId: `O-${req.orderType}`, status: 'TRANSIT', correlationId: req.correlationId };
    }),
    modifyClosingOrder: jest.fn(async (id: string) => ({ ok: true as const, data: { orderId: id, status: 'PENDING' } })),
  };
  const alerts: Array<[string, string]> = [];
  const mgr = new PositionManager({
    positions: positions as any,
    client: client as any,
    now: () => new Date(nowMs),
    alert: (t, b) => alerts.push([t, b]),
    retryMs: 60_000,
    tokenSecondsLeft: async () => null,
    ...extra,
  });
  return { mgr, store, positions, client, state, alerts, calls, advance: (ms: number) => (nowMs += ms), get: () => store.get('QSP-entry-1')! };
}

describe('tick rounding', () => {
  test('a sell stop-loss limit price rounds down to the tick', () => {
    expect(roundDownToTick(155.2)).toBe(155.2);
    expect(roundDownToTick(155.24)).toBe(155.2);
    expect(roundDownToTick(160 * 0.97)).toBe(155.2);
  });
});

describe('entry and stop-loss placement', () => {
  test('a filled entry gets an exchange-side stop-loss for exactly the filled quantity', async () => {
    const b = build([pos()], [ord()]);
    await b.mgr.reconcile();

    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);
    const [req, held] = b.client.placeClosingOrder.mock.calls[0];
    expect(held).toBe(65);
    expect(req).toMatchObject({
      transactionType: 'SELL',
      orderType: 'STOP_LOSS',
      validity: 'DAY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      securityId: '55555',
      quantity: 65,
      triggerPrice: 160,
      price: 155.2,
    });
    expect(req.correlationId).toMatch(/^QSS-[a-zA-Z0-9_.-]+$/);
    expect(req.correlationId.length).toBeLessThanOrEqual(30);
    expect(b.get()).toMatchObject({ state: 'PROTECTED', filledQty: 65, entryAvg: 180, slOrderId: 'O-STOP_LOSS', note: null });
  });

  test('an entry that has not filled yet places nothing', async () => {
    const b = build([pos()], [ord({ status: 'PENDING', filledQty: 0, averageTradedPrice: 0, remainingQuantity: 65 })]);
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
    expect(b.get().state).toBe('ENTRY_SENT');
  });

  test('a rejected or cancelled entry with no fill ends the position with the reason', async () => {
    const b = build([pos()], [ord({ status: 'REJECTED', filledQty: 0, averageTradedPrice: 0, errorMessage: 'Insufficient funds' })]);
    await b.mgr.reconcile();
    expect(b.get()).toMatchObject({ state: 'ENTRY_FAILED', note: 'Insufficient funds' });
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
  });

  test('a partial fill is protected for what filled, and the stop-loss grows as the entry fills more', async () => {
    const b = build([pos()], [ord({ status: 'PART_TRADED', filledQty: 20, remainingQuantity: 45 })]);
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder.mock.calls[0][0].quantity).toBe(20);

    b.state.book = [
      ord({ status: 'TRADED', filledQty: 65 }),
      ord({ orderId: 'O-STOP_LOSS', correlationId: b.get().slCorrelationId, status: 'PENDING', transactionType: 'SELL', orderType: 'STOP_LOSS', quantity: 20, price: 155.2, triggerPrice: 160, filledQty: 0 }),
    ];
    await b.mgr.reconcile();
    expect(b.client.modifyClosingOrder).toHaveBeenCalledWith(
      'O-STOP_LOSS',
      { orderType: 'STOP_LOSS', validity: 'DAY', quantity: 65, price: 155.2, triggerPrice: 160 },
      65
    );
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);
  });

  test('reconciling twice with a working stop-loss never places a second one', async () => {
    const b = build([pos()], [ord()]);
    await b.mgr.reconcile();
    b.state.book = [ord(), ord({ orderId: 'O-STOP_LOSS', correlationId: b.get().slCorrelationId, status: 'PENDING', transactionType: 'SELL', orderType: 'STOP_LOSS', quantity: 65, price: 155.2, triggerPrice: 160, filledQty: 0 })];
    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);
    expect(b.get().state).toBe('PROTECTED');
  });

  test('concurrent reconciles are run one at a time, so only one stop-loss is placed', async () => {
    const b = build([pos()], [ord()]);
    await Promise.all([b.mgr.reconcile(), b.mgr.reconcile(), b.mgr.reconcile()]);
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);
  });

  test('when Dhan rejects the stop-loss the position is flagged, alerted once, and retried only after a pause', async () => {
    const b = build([pos()], [ord()]);
    b.client.placeClosingOrder.mockResolvedValue({ kind: 'REJECTED', error: 'IP not whitelisted', code: 'DH-906', correlationId: 'x' } as any);
    await b.mgr.reconcile();
    expect(b.get()).toMatchObject({ state: 'OPEN_UNPROTECTED', note: 'Stop-loss was rejected: IP not whitelisted' });
    expect(b.alerts).toHaveLength(1);
    expect(b.alerts[0][0]).toContain('NO STOP-LOSS');

    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1); // cool-down
    expect(b.alerts).toHaveLength(1);

    b.advance(61_000);
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(2);
    expect(b.alerts).toHaveLength(1); // same problem, no repeat alert
  });

  test('protectNow skips the cool-down', async () => {
    const b = build([pos()], [ord()]);
    b.client.placeClosingOrder.mockResolvedValueOnce({ kind: 'REJECTED', error: 'IP not whitelisted', code: null, correlationId: 'x' } as any);
    await b.mgr.reconcile();
    await b.mgr.protectNow('QSP-entry-1');
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(2);
    expect(b.get().state).toBe('PROTECTED');
  });

  test('an unknown placement result is looked up in the order book, not sent again', async () => {
    const b = build([pos()], [ord()]);
    b.client.placeClosingOrder.mockResolvedValueOnce({ kind: 'UNKNOWN', error: 'timeout', correlationId: 'x' } as any);
    await b.mgr.reconcile();
    const corr = b.get().slCorrelationId!;
    expect(corr).toBeTruthy();
    expect(b.get().state).not.toBe('PROTECTED');

    b.advance(10_000);
    await b.mgr.reconcile(); // still within the wait: nothing new is sent
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);

    b.state.book = [ord(), ord({ orderId: 'S9', correlationId: corr, status: 'PENDING', transactionType: 'SELL', orderType: 'STOP_LOSS', quantity: 65, price: 155.2, triggerPrice: 160, filledQty: 0 })];
    await b.mgr.reconcile();
    expect(b.get()).toMatchObject({ state: 'PROTECTED', slOrderId: 'S9' });
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);
  });

  test('an unknown result that never appears at Dhan is replaced after the wait', async () => {
    const b = build([pos()], [ord()]);
    b.client.placeClosingOrder.mockResolvedValueOnce({ kind: 'UNKNOWN', error: 'timeout', correlationId: 'x' } as any);
    await b.mgr.reconcile();
    const first = b.get().slCorrelationId;
    b.advance(61_000);
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(2);
    expect(b.get().slCorrelationId).not.toBe(first);
    expect(b.get().state).toBe('PROTECTED');
  });

  test('a stop-loss cancelled or rejected by someone else is put back', async () => {
    const b = build([pos({ state: 'PROTECTED', filledQty: 65, entryAvg: 180, slOrderId: 'S1', slCorrelationId: 'QSS-old' })], [
      ord(),
      ord({ orderId: 'S1', correlationId: 'QSS-old', status: 'CANCELLED', transactionType: 'SELL', orderType: 'STOP_LOSS', filledQty: 0 }),
    ]);
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).toHaveBeenCalledTimes(1);
    expect(b.get()).toMatchObject({ state: 'PROTECTED', slOrderId: 'O-STOP_LOSS' });
  });

  test('a position with no stop-loss price is flagged and alerted once, and nothing is sent', async () => {
    const b = build([pos({ slPrice: null })], [ord()]);
    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
    expect(b.get()).toMatchObject({ state: 'OPEN_UNPROTECTED', note: expect.stringContaining('No stop-loss price') });
    expect(b.alerts).toHaveLength(1);
  });
});

describe('stop-loss and exit fills', () => {
  const protectedPos = () => pos({ state: 'PROTECTED', filledQty: 65, entryAvg: 180, slOrderId: 'S1', slCorrelationId: 'QSS-1' });
  const slOrder = (over: Partial<DhanOrder> = {}) =>
    ord({ orderId: 'S1', correlationId: 'QSS-1', transactionType: 'SELL', orderType: 'STOP_LOSS', quantity: 65, price: 155.2, triggerPrice: 160, filledQty: 65, averageTradedPrice: 158, ...over });

  test('a traded stop-loss closes the position with its profit and loss and alerts', async () => {
    const b = build([protectedPos()], [ord(), slOrder()]);
    await b.mgr.reconcile();
    expect(b.get()).toMatchObject({ state: 'CLOSED', exitAvg: 158, pnl: -1430, note: 'Stop-loss hit.' });
    expect(b.alerts[0][0]).toContain('Stop-loss hit');
    expect(b.alerts[0][1]).toContain('-1430');
  });

  test('closing also cancels an entry order that is still working, so it cannot fill later', async () => {
    const b = build([protectedPos()], [ord({ status: 'PART_TRADED', filledQty: 65, remainingQuantity: 10, quantity: 75 }), slOrder()]);
    await b.mgr.reconcile();
    expect(b.calls).toContain('cancel:E1');
    expect(b.get().state).toBe('CLOSED');
  });

  test('exiting cancels the stop-loss first, then sells exactly the held quantity at market', async () => {
    const b = build([protectedPos()], [ord(), slOrder({ status: 'PENDING', filledQty: 0, averageTradedPrice: 0 })]);
    const res = await b.mgr.exitPosition('QSP-entry-1');
    expect(res).toEqual({ ok: true });
    expect(b.calls).toEqual(['cancel:S1', 'place:MARKET']);
    const [req, held] = b.client.placeClosingOrder.mock.calls[0];
    expect(held).toBe(65);
    expect(req).toMatchObject({ transactionType: 'SELL', orderType: 'MARKET', quantity: 65, securityId: '55555' });
    expect(b.get()).toMatchObject({ state: 'CLOSING', slOrderId: null, exitOrderId: 'O-MARKET' });
  });

  test('exiting does nothing if the stop-loss cannot be cancelled, so the shares are never sold twice', async () => {
    const b = build([protectedPos()], [ord(), slOrder({ status: 'PENDING', filledQty: 0 })]);
    b.client.cancelOrder.mockResolvedValueOnce({ ok: false, status: 400, error: 'Order already traded', code: null } as any);
    const res = await b.mgr.exitPosition('QSP-entry-1');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Not selling') });
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
    expect(b.get().state).toBe('PROTECTED');
  });

  test('a rejected exit puts the position back to needing protection and re-protects it', async () => {
    const b = build([protectedPos()], [ord(), slOrder({ status: 'PENDING', filledQty: 0 })]);
    b.client.placeClosingOrder.mockResolvedValueOnce({ kind: 'REJECTED', error: 'Market closed', code: null, correlationId: 'x' } as any);
    const res = await b.mgr.exitPosition('QSP-entry-1');
    expect(res).toEqual({ ok: false, error: 'Market closed', uncertain: false });
    expect(b.alerts.some(([t]) => t.includes('Exit failed'))).toBe(true);
    // The stop-loss was cancelled for the exit, so a new one is placed straight away.
    expect(b.get()).toMatchObject({ state: 'PROTECTED', exitCorrelationId: null, slOrderId: 'O-STOP_LOSS' });
    expect(b.client.placeClosingOrder.mock.calls.map((c: any[]) => c[0].orderType)).toEqual(['MARKET', 'STOP_LOSS']);
    expect(b.calls).toEqual(['cancel:S1', 'place:STOP_LOSS']); // only the successful placement is recorded by the mock
  });

  test('an unknown exit result stays EXITING and is flagged uncertain', async () => {
    const b = build([protectedPos()], [ord(), slOrder({ status: 'PENDING', filledQty: 0 })]);
    b.client.placeClosingOrder.mockResolvedValueOnce({ kind: 'UNKNOWN', error: 'timeout', correlationId: 'x' } as any);
    const res = await b.mgr.exitPosition('QSP-entry-1');
    expect(res).toMatchObject({ ok: false, uncertain: true });
    expect(b.get().state).toBe('CLOSING');
  });

  test('a traded exit order closes the position; a dead one re-protects it; a missing one reverts after the wait', async () => {
    const closing = () => pos({ state: 'CLOSING', filledQty: 65, entryAvg: 180, exitCorrelationId: 'QSX-1', exitPlacedAt: new Date(START).toISOString() });
    const exitOrd = (over: Partial<DhanOrder> = {}) =>
      ord({ orderId: 'X1', correlationId: 'QSX-1', transactionType: 'SELL', orderType: 'MARKET', quantity: 65, filledQty: 65, averageTradedPrice: 200, ...over });

    const done = build([closing()], [ord(), exitOrd()]);
    await done.mgr.reconcile();
    expect(done.get()).toMatchObject({ state: 'CLOSED', exitAvg: 200, pnl: 1300 });

    const dead = build([closing()], [ord(), exitOrd({ status: 'REJECTED', filledQty: 0, errorMessage: 'RMS' })]);
    await dead.mgr.reconcile();
    expect(dead.get().state).toBe('PROTECTED'); // rejected exit, then a fresh stop-loss in the same pass
    expect(dead.alerts.some(([t]) => t.includes('Exit failed'))).toBe(true);

    const missing = build([closing()], [ord()]);
    await missing.mgr.reconcile();
    expect(missing.get().state).toBe('CLOSING');
    missing.advance(61_000);
    await missing.mgr.reconcile();
    expect(missing.get().state).toBe('PROTECTED');
  });

  test('only positions that are held and not already exiting can be exited', async () => {
    expect(await build([pos()]).mgr.exitPosition('QSP-entry-1')).toMatchObject({ ok: false });
    expect(await build([pos({ state: 'PROTECTED', filledQty: 0 })]).mgr.exitPosition('QSP-entry-1')).toMatchObject({ ok: false, error: expect.stringContaining('Nothing has been bought') });
    expect(await build([pos({ state: 'CLOSING', filledQty: 65 })]).mgr.exitPosition('QSP-entry-1')).toMatchObject({ ok: false });
    expect(await build([]).mgr.exitPosition('missing')).toMatchObject({ ok: false });
  });
});

describe('earlier days and missing data', () => {
  const yesterday = { tradeDate: '2026-10-22' };

  test('an overnight position is only protected after Dhan confirms the shares are still held, and for no more than held', async () => {
    const b = build([pos({ ...yesterday, state: 'OPEN_UNPROTECTED', filledQty: 65, entryAvg: 180, productType: 'MARGIN' })], []);
    b.state.broker = [{ securityId: '55555', exchangeSegment: 'NSE_FNO', productType: 'MARGIN', netQty: 40 }];
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder.mock.calls[0][0].quantity).toBe(40);
    expect(b.get().state).toBe('PROTECTED');
  });

  test('an overnight position that is no longer held is closed without selling anything', async () => {
    const b = build([pos({ ...yesterday, state: 'OPEN_UNPROTECTED', filledQty: 65, entryAvg: 180, productType: 'MARGIN' })], []);
    b.state.broker = [];
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
    expect(b.get()).toMatchObject({ state: 'CLOSED', note: expect.stringContaining('No longer held') });
  });

  test('if the holdings cannot be checked nothing is sold, and it is tried again later', async () => {
    const b = build([pos({ ...yesterday, state: 'OPEN_UNPROTECTED', filledQty: 65, entryAvg: 180, productType: 'MARGIN' })], []);
    b.state.brokerOk = false;
    await b.mgr.reconcile();
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
    expect(b.get().state).toBe('OPEN_UNPROTECTED');
  });

  test('an entry left over from an earlier day is resolved from Dhan holdings', async () => {
    const held = build([pos({ ...yesterday, productType: 'MARGIN' })], []);
    held.state.broker = [{ securityId: '55555', exchangeSegment: 'NSE_FNO', productType: 'MARGIN', netQty: 65, buyAvg: 181 }];
    await held.mgr.reconcile();
    expect(held.get()).toMatchObject({ state: 'PROTECTED', filledQty: 65, entryAvg: 181 });

    const none = build([pos({ ...yesterday, productType: 'MARGIN' })], []);
    await none.mgr.reconcile();
    expect(none.get().state).toBe('ENTRY_FAILED');
  });

  test('an entry order missing from the book fails only after ten minutes', async () => {
    const b = build([pos()], []);
    await b.mgr.reconcile();
    expect(b.get().state).toBe('ENTRY_SENT');
    b.advance(11 * 60_000);
    await b.mgr.reconcile();
    expect(b.get()).toMatchObject({ state: 'ENTRY_FAILED', note: expect.stringContaining('never appeared') });
  });

  test('when the order book cannot be read nothing changes and the error is reported', async () => {
    const b = build([pos()], [ord()]);
    b.state.ordersOk = false;
    expect(await b.mgr.reconcile()).toEqual({ checked: 1, error: 'down' });
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
    expect(b.get().state).toBe('ENTRY_SENT');
  });

  test('with no active positions it makes no calls at all', async () => {
    const b = build([pos({ state: 'CLOSED' })], []);
    expect(await b.mgr.reconcile()).toEqual({ checked: 0 });
    expect(b.client.getOrders).not.toHaveBeenCalled();
  });
});

describe('strategy exit hints', () => {
  const held = () => pos({ state: 'PROTECTED', filledQty: 65, entryAvg: 180, slOrderId: 'S1', slCorrelationId: 'QSS-1' });
  const trade = (over: any = {}) => ({ strategyId: 'NIFTY_BREAKOUT_180', symbol: 'NIFTY  24850 ce', outcome: 'WIN', exitPrice: 220, pnlPoints: 40, timestamp: 't', notes: 'n', ...over });

  test('a target or time exit flags the matching position and alerts, but sells nothing', async () => {
    const b = build([held()]);
    await b.mgr.onTradesClosed([trade()]);
    expect(b.get().exitHint).toBe('Target hit');
    expect(b.alerts[0][0]).toContain('Target hit');
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();

    await b.mgr.onTradesClosed([trade({ outcome: 'TIME_EXIT' })]);
    expect(b.get().exitHint).toBe('Target hit'); // already flagged, no second alert
    expect(b.alerts).toHaveLength(1);
  });

  test('losses, other strategies and other contracts are ignored', async () => {
    const b = build([held()]);
    await b.mgr.onTradesClosed([trade({ outcome: 'LOSS' }), trade({ strategyId: 'OOBTST_NIFTY' }), trade({ symbol: 'NIFTY 24900 CE' })]);
    expect(b.get().exitHint).toBeNull();
    expect(b.alerts).toHaveLength(0);
  });
});

describe('health alerts', () => {
  const held = () => pos({ state: 'PROTECTED', filledQty: 65, entryAvg: 180, slOrderId: 'S1', slCorrelationId: 'QSS-1' });
  const withSl = () => [ord(), ord({ orderId: 'S1', correlationId: 'QSS-1', status: 'PENDING', transactionType: 'SELL', orderType: 'STOP_LOSS', quantity: 65, price: 155.2, triggerPrice: 160, filledQty: 0 })];

  test('a single failed read is not alarming, but repeated failures tell the user once', async () => {
    const b = build([held()], withSl());
    b.state.ordersOk = false;
    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.alerts).toHaveLength(0);
    await b.mgr.reconcile();
    expect(b.alerts).toHaveLength(1);
    expect(b.alerts[0][0]).toBe('Cannot manage your positions');
    expect(b.alerts[0][1]).toContain('Dhan app');
    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.alerts).toHaveLength(1); // not repeated
  });

  test('an expired token is reported straight away', async () => {
    const b = build([held()], withSl());
    b.client.getOrders.mockResolvedValue({ ok: false, status: 401, error: 'Access token expired', code: 'DH-901' } as any);
    await b.mgr.reconcile();
    expect(b.alerts).toHaveLength(1);
    expect(b.alerts[0][0]).toBe('Dhan access token expired');
  });

  test('coming back is announced once, and the failure count starts again', async () => {
    const b = build([held()], withSl());
    b.state.ordersOk = false;
    for (let i = 0; i < 3; i++) await b.mgr.reconcile();
    b.state.ordersOk = true;
    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.alerts.map((a) => a[0])).toEqual(['Cannot manage your positions', 'Connection to Dhan restored']);

    b.state.ordersOk = false;
    await b.mgr.reconcile();
    expect(b.alerts).toHaveLength(2); // one failure alone does not alert again
  });

  test('a token that ends within half an hour is flagged once while a position is held, and re-armed after renewal', async () => {
    let left: number | null = 20 * 60;
    const b = build([held()], withSl(), { tokenSecondsLeft: async () => left });
    await b.mgr.reconcile();
    await b.mgr.reconcile();
    expect(b.alerts.filter(([t]) => t.includes('ends soon'))).toHaveLength(1);

    left = 8 * 3600;
    await b.mgr.reconcile();
    left = 10 * 60;
    await b.mgr.reconcile();
    expect(b.alerts.filter(([t]) => t.includes('ends soon'))).toHaveLength(2);
  });

  test('no token warning when no position is held, and an unreadable expiry is ignored', async () => {
    const none = build([pos({ state: 'CLOSED' })], [], { tokenSecondsLeft: async () => 60 });
    await none.mgr.reconcile();
    expect(none.alerts).toHaveLength(0);

    const unknown = build([held()], withSl(), { tokenSecondsLeft: async () => null });
    await unknown.mgr.reconcile();
    expect(unknown.alerts).toHaveLength(0);
  });
});

describe('exit all', () => {
  const heldPos = (id: string, over: Partial<Position> = {}) =>
    pos({ id, state: 'PROTECTED', filledQty: 65, entryAvg: 180, slOrderId: `S-${id}`, slCorrelationId: `QSS-${id}`, ...over });

  test('exits every held position, one at a time, and skips ones that are not held', async () => {
    const b = build([heldPos('A'), heldPos('B', { state: 'OPEN_UNPROTECTED', slOrderId: null, slCorrelationId: null }), pos({ id: 'C', state: 'ENTRY_SENT' }), pos({ id: 'D', state: 'CLOSED' })]);
    const result = await b.mgr.exitAll();
    expect(result).toEqual({ attempted: 2, failed: [] });
    const markets = b.client.placeClosingOrder.mock.calls.filter((c: any[]) => c[0].orderType === 'MARKET');
    expect(markets).toHaveLength(2);
    expect(b.calls).toEqual(['cancel:S-A', 'place:MARKET', 'place:MARKET']); // B had no stop-loss to cancel
    expect(b.store.get('A')!.state).toBe('CLOSING');
    expect(b.store.get('B')!.state).toBe('CLOSING');
    expect(b.store.get('C')!.state).toBe('ENTRY_SENT');
  });

  test('one position failing to exit does not stop the others, and is reported by name', async () => {
    const b = build([heldPos('A'), heldPos('B')]);
    b.client.cancelOrder.mockResolvedValueOnce({ ok: false, status: 400, error: 'Order already traded', code: null } as any);
    const result = await b.mgr.exitAll();
    expect(result.attempted).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: 'A', symbol: 'NIFTY 24850 CE' });
    expect(b.store.get('A')!.state).toBe('PROTECTED'); // untouched, still protected
    expect(b.store.get('B')!.state).toBe('CLOSING');
  });

  test('with nothing held it does nothing', async () => {
    const b = build([pos({ state: 'CLOSED' })]);
    expect(await b.mgr.exitAll()).toEqual({ attempted: 0, failed: [] });
    expect(b.client.placeClosingOrder).not.toHaveBeenCalled();
  });
});
