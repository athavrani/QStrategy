import { ExecutionService } from '../execution/ExecutionService';
import { PositionManager } from '../execution/PositionManager';
import { defaultExecutionSettings } from '../execution/executionSettings';
import { positionRepository } from '../services/PositionRepository';
import { orderRepository } from '../services/OrderRepository';
import { dbManager } from '../db/database';
import type { DhanOrder, OrderRequest } from '../services/dhan/DhanOrderClient';
import type { ExecutableSignal, ExecutionSettings } from '../execution/types';

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    getTokenRemainingSeconds: jest.fn(() => null),
    authenticateStrict: jest.fn(async () => true),
    updateTelemetry: jest.fn(),
  },
}));

// Friday 2026-10-23, 11:00 IST
const OPEN_HOURS = new Date('2026-10-23T05:30:00Z');

/** A tiny stand-in for Dhan: it keeps an order book and can fail the ways the real thing can. */
class FakeExchange {
  orders: DhanOrder[] = [];
  holdings: any[] = [];
  ipOk = true;
  tokenOk = true;
  online = true;
  /** When true, the next entry order reaches the exchange but the reply is lost. */
  loseNextReply = false;
  private seq = 1;
  placed: OrderRequest[] = [];

  private add(req: OrderRequest): DhanOrder {
    const order: DhanOrder = {
      orderId: `X${this.seq++}`, correlationId: req.correlationId ?? null, status: 'PENDING', transactionType: req.transactionType,
      exchangeSegment: req.exchangeSegment, productType: req.productType, orderType: req.orderType, validity: req.validity,
      securityId: req.securityId, tradingSymbol: 'NIFTY 24850 CE', quantity: req.quantity, price: req.price ?? 0,
      triggerPrice: req.triggerPrice ?? 0, filledQty: 0, remainingQuantity: req.quantity, averageTradedPrice: 0,
      createTime: null, updateTime: null, errorCode: null, errorMessage: null,
    };
    this.orders.push(order);
    this.placed.push(req);
    return order;
  }

  find(corrOrId: string) {
    return this.orders.find((o) => o.correlationId === corrOrId || o.orderId === corrOrId)!;
  }

  fill(corr: string, qty: number, avg: number) {
    const o = this.find(corr);
    o.filledQty = qty;
    o.averageTradedPrice = avg;
    o.remainingQuantity = o.quantity - qty;
    o.status = qty >= o.quantity ? 'TRADED' : 'PART_TRADED';
  }

  // Entry orders, as used by the execution service
  placeAndConfirm = async (req: OrderRequest) => {
    if (!this.online) return { kind: 'UNKNOWN' as const, error: 'offline', correlationId: req.correlationId as string };
    const order = this.add(req);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      return { kind: 'UNKNOWN' as const, error: 'Request timed out.', correlationId: req.correlationId as string };
    }
    return { kind: 'PLACED' as const, orderId: order.orderId, status: 'TRANSIT', correlationId: req.correlationId as string };
  };

  // Closing orders and reads, as used by the position manager
  getOrders = async () =>
    this.tokenOk && this.online
      ? { ok: true as const, data: this.orders.map((o) => ({ ...o })) }
      : { ok: false as const, status: this.tokenOk ? 0 : 401, error: this.tokenOk ? 'offline' : 'Access token expired', code: null };
  getPositions = async () => ({ ok: true as const, data: this.holdings });
  cancelOrder = async (id: string) => {
    const o = this.find(id);
    if (!o || o.status === 'TRADED') return { ok: false as const, status: 400, error: 'Order already traded', code: null };
    o.status = 'CANCELLED';
    return { ok: true as const, data: { orderId: o.orderId, status: 'CANCELLED' } };
  };
  placeClosingOrder = async (req: OrderRequest, held: number) => {
    if (req.transactionType !== 'SELL' || req.quantity > held) return { kind: 'REJECTED' as const, error: 'refused by client rules', code: null, correlationId: req.correlationId as string };
    if (!this.ipOk) return { kind: 'REJECTED' as const, error: 'IP is not whitelisted', code: 'DH-906', correlationId: req.correlationId as string };
    const o = this.add(req);
    return { kind: 'PLACED' as const, orderId: o.orderId, status: 'TRANSIT', correlationId: o.correlationId as string };
  };
  modifyClosingOrder = async (id: string, change: any) => {
    this.find(id).quantity = change.quantity ?? this.find(id).quantity;
    return { ok: true as const, data: { orderId: id, status: 'PENDING' } };
  };
}

const signal = (): ExecutableSignal => ({
  journalId: 'sig-breakout-1730000000000', strategyId: 'NIFTY_BREAKOUT_180', symbol: 'NIFTY 24850 CE', side: 'BUY',
  entryPrice: 180, stopLoss: 160, target: 220, timestamp: '09:31:00',
  hint: { securityId: '55555', exchangeSegment: 'NSE_FNO', tradingSymbol: 'NIFTY 24850 CE', lotSize: 65, productType: 'INTRADAY' },
});
const CORR = 'QSP-sig-breakout-1730000000000';

function boot(ex: FakeExchange, settings: ExecutionSettings, flags: { armed: boolean }) {
  const alerts: Array<[string, string]> = [];
  const mkService = () =>
    new ExecutionService({
      liveClient: ex as any, loadSettings: async () => settings, isArmed: () => flags.armed,
      authenticate: async () => true, checkIp: async () => (ex.ipOk ? null : 'IP is not whitelisted'), notify: jest.fn(),
    });
  const mkManager = () => new PositionManager({ client: ex as any, alert: (t, b) => alerts.push([t, b]), retryMs: 60_000, tokenSecondsLeft: async () => null });
  return { svc: mkService(), mgr: mkManager(), alerts, mkService, mkManager };
}

function liveSettings(): ExecutionSettings {
  const s = defaultExecutionSettings();
  s.mode = 'CONFIRM';
  s.strategies.NIFTY_BREAKOUT_180.enabled = true;
  return s;
}

const position = async () => (await positionRepository.get(CORR))!;

beforeEach(async () => {
  jest.useFakeTimers({ now: OPEN_HOURS, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  ((await dbManager.getDatabase()) as any).tables?.clear();
});
afterEach(() => jest.useRealTimers());

describe('failure drill: the whole path against a fake exchange', () => {
  test('signal to proposal to entry to stop-loss to stop-loss hit, with every record agreeing', async () => {
    const ex = new FakeExchange();
    const { svc, mgr, alerts } = boot(ex, liveSettings(), { armed: true });

    expect((await svc.onSignal(signal())).kind).toBe('PROPOSED');
    expect(ex.orders).toHaveLength(0); // nothing sent until confirmed
    expect(await svc.confirmProposal(CORR)).toMatchObject({ ok: true });
    expect(ex.orders).toHaveLength(1);
    expect(ex.orders[0]).toMatchObject({ transactionType: 'BUY', orderType: 'LIMIT', quantity: 65, price: 181.8 });

    await mgr.reconcile();
    expect((await position()).state).toBe('ENTRY_SENT'); // not filled yet, so nothing to protect

    ex.fill(CORR, 65, 181);
    await mgr.reconcile();
    expect(await position()).toMatchObject({ state: 'PROTECTED', filledQty: 65, entryAvg: 181 });
    const sl = ex.orders.find((o) => o.orderType === 'STOP_LOSS')!;
    expect(sl).toMatchObject({ transactionType: 'SELL', quantity: 65, triggerPrice: 160, price: 155.2 });

    ex.fill(sl.orderId, 65, 157);
    await mgr.reconcile();
    expect(await position()).toMatchObject({ state: 'CLOSED', exitAvg: 157, pnl: -1560 });
    expect(alerts.some(([t]) => t.includes('Stop-loss hit'))).toBe(true);
    expect(ex.orders.filter((o) => o.transactionType === 'SELL')).toHaveLength(1);
  });

  test('the app restarts after the entry is sent: a new manager picks the position up and protects it', async () => {
    const ex = new FakeExchange();
    const first = boot(ex, liveSettings(), { armed: true });
    await first.svc.onSignal(signal());
    await first.svc.confirmProposal(CORR);

    // "Restart": everything in memory is gone; only the database remains.
    const second = boot(ex, liveSettings(), { armed: false });
    ex.fill(CORR, 65, 181);
    await second.mgr.reconcile();
    expect((await position()).state).toBe('PROTECTED'); // protection does not need the arm switch
    expect(ex.orders.filter((o) => o.orderType === 'STOP_LOSS')).toHaveLength(1);
  });

  test('the phone IP changes after the entry: stop-loss refused, user alerted once, protected after the fix', async () => {
    const ex = new FakeExchange();
    const { svc, mgr, alerts } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    await svc.confirmProposal(CORR);
    ex.fill(CORR, 65, 181);

    ex.ipOk = false;
    await mgr.reconcile();
    await mgr.reconcile();
    expect(await position()).toMatchObject({ state: 'OPEN_UNPROTECTED', note: expect.stringContaining('IP is not whitelisted') });
    expect(alerts.filter(([t]) => t.includes('NO STOP-LOSS'))).toHaveLength(1);
    expect(ex.orders.some((o) => o.orderType === 'STOP_LOSS')).toBe(false);

    ex.ipOk = true;
    await mgr.protectNow(CORR);
    expect((await position()).state).toBe('PROTECTED');
  });

  test('the token expires while a position is held: the user is told, the exchange stop-loss is untouched, and recovery is announced', async () => {
    const ex = new FakeExchange();
    const { svc, mgr, alerts } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    await svc.confirmProposal(CORR);
    ex.fill(CORR, 65, 181);
    await mgr.reconcile();
    const slBefore = ex.orders.find((o) => o.orderType === 'STOP_LOSS')!;

    ex.tokenOk = false;
    await mgr.reconcile();
    expect(alerts.map(([t]) => t)).toContain('Dhan access token expired');
    expect((await position()).state).toBe('PROTECTED'); // state is not guessed while Dhan cannot be read
    expect(slBefore.status).toBe('PENDING'); // the stop-loss at the exchange is still working

    ex.tokenOk = true;
    await mgr.reconcile();
    expect(alerts.map(([t]) => t)).toContain('Connection to Dhan restored');
    expect(ex.orders.filter((o) => o.orderType === 'STOP_LOSS')).toHaveLength(1);
  });

  test('exit now sells once: the stop-loss is cancelled first and the total sold is exactly what was held', async () => {
    const ex = new FakeExchange();
    const { svc, mgr } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    await svc.confirmProposal(CORR);
    ex.fill(CORR, 65, 181);
    await mgr.reconcile();
    const sl = ex.orders.find((o) => o.orderType === 'STOP_LOSS')!;

    expect(await mgr.exitPosition(CORR)).toEqual({ ok: true });
    expect(sl.status).toBe('CANCELLED');
    const market = ex.orders.find((o) => o.orderType === 'MARKET')!;
    expect(market).toMatchObject({ transactionType: 'SELL', quantity: 65 });

    ex.fill(market.orderId, 65, 200);
    await mgr.reconcile();
    expect(await position()).toMatchObject({ state: 'CLOSED', exitAvg: 200, pnl: 1235 });
    const soldQty = ex.orders.filter((o) => o.transactionType === 'SELL').reduce((n, o) => n + o.filledQty, 0);
    expect(soldQty).toBe(65);
  });

  test('exit is refused while the stop-loss has already traded, so the shares are not sold twice', async () => {
    const ex = new FakeExchange();
    const { svc, mgr } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    await svc.confirmProposal(CORR);
    ex.fill(CORR, 65, 181);
    await mgr.reconcile();
    const sl = ex.orders.find((o) => o.orderType === 'STOP_LOSS')!;
    ex.fill(sl.orderId, 65, 157); // the stop-loss traded, but the app has not noticed yet

    expect(await mgr.exitPosition(CORR)).toMatchObject({ ok: false, error: expect.stringContaining('Not selling') });
    expect(ex.orders.some((o) => o.orderType === 'MARKET')).toBe(false);
    await mgr.reconcile();
    expect((await position()).state).toBe('CLOSED');
  });

  test('the kill switch stops new signals but never strands a position that is already open', async () => {
    const ex = new FakeExchange();
    const settings = liveSettings();
    const { svc, mgr } = boot(ex, settings, { armed: true });
    await svc.onSignal(signal());
    await svc.confirmProposal(CORR);
    ex.fill(CORR, 65, 181);

    settings.killSwitch = true;
    await mgr.reconcile();
    expect((await position()).state).toBe('PROTECTED'); // still protected
    expect(await mgr.exitPosition(CORR)).toEqual({ ok: true }); // and still exitable

    const other = { ...signal(), journalId: 'sig-breakout-1730000099999' };
    expect(await svc.onSignal(other)).toMatchObject({ kind: 'BLOCKED', reason: 'Kill switch is on.' });
  });

  test('without the arm switch nothing reaches the exchange; once armed the same proposal can be sent', async () => {
    const ex = new FakeExchange();
    const flags = { armed: false };
    const { svc } = boot(ex, liveSettings(), flags);
    await svc.onSignal(signal());
    expect(await svc.confirmProposal(CORR)).toMatchObject({ ok: false, error: expect.stringContaining('not armed') });
    expect(ex.orders).toHaveLength(0);

    flags.armed = true;
    expect(await svc.confirmProposal(CORR)).toMatchObject({ ok: true });
    expect(ex.orders).toHaveLength(1);
  });

  test('a wrong IP at confirmation stops the order before it is sent', async () => {
    const ex = new FakeExchange();
    ex.ipOk = false;
    const { svc } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    expect(await svc.confirmProposal(CORR)).toMatchObject({ ok: false, error: expect.stringContaining('not whitelisted') });
    expect(ex.orders).toHaveLength(0);
  });

  test('a reply lost after the order reached the exchange: tracked, never duplicated, protected once it fills', async () => {
    const ex = new FakeExchange();
    ex.loseNextReply = true;
    const { svc, mgr } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    const res = await svc.confirmProposal(CORR);
    expect(res).toMatchObject({ ok: false, uncertain: true });
    expect(ex.orders).toHaveLength(1);

    // Trying again is refused: the proposal is no longer confirmable, so no second entry can be sent.
    expect(await svc.confirmProposal(CORR)).toMatchObject({ ok: false });
    expect(ex.orders).toHaveLength(1);

    ex.fill(CORR, 65, 181);
    await mgr.reconcile();
    expect((await position()).state).toBe('PROTECTED');
    expect(ex.orders.filter((o) => o.transactionType === 'BUY')).toHaveLength(1);
  });

  test('a reply lost before the order reached the exchange: the position is dropped after ten minutes, with nothing left behind', async () => {
    const ex = new FakeExchange();
    ex.online = false;
    const { svc, mgr } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    expect(await svc.confirmProposal(CORR)).toMatchObject({ ok: false, uncertain: true });
    expect(ex.orders).toHaveLength(0);

    ex.online = true;
    jest.setSystemTime(new Date(OPEN_HOURS.getTime() + 11 * 60_000));
    await mgr.reconcile();
    expect(await position()).toMatchObject({ state: 'ENTRY_FAILED', note: expect.stringContaining('never appeared') });
  });

  test('an overnight position the next morning is protected only if Dhan still shows it as held', async () => {
    const ex = new FakeExchange();
    const settings = liveSettings();
    const { svc, mgr } = boot(ex, settings, { armed: true });
    const overnight = { ...signal(), hint: { ...signal().hint!, productType: 'MARGIN' as const } };
    await svc.onSignal(overnight);
    await svc.confirmProposal(CORR);
    ex.fill(CORR, 65, 181);
    await mgr.reconcile();
    expect((await position()).state).toBe('PROTECTED');

    // Next morning: yesterday's orders are gone from the book, and Dhan reports what is held.
    jest.setSystemTime(new Date('2026-10-26T04:00:00Z')); // Monday 09:30 IST
    ex.orders = [];
    ex.holdings = [{ securityId: '55555', exchangeSegment: 'NSE_FNO', productType: 'MARGIN', netQty: 65 }];
    // Nothing is edited by hand: yesterday's stop-loss has simply expired, so it is no longer in the order book.
    await mgr.reconcile();
    expect((await position()).state).toBe('PROTECTED');
    expect(ex.orders.filter((o) => o.orderType === 'STOP_LOSS')).toHaveLength(1);
    expect(ex.orders[0].quantity).toBe(65);

    // And if it was sold elsewhere meanwhile, nothing is sold against it.
    ex.orders = [];
    ex.holdings = [];
    await positionRepository.update(CORR, { state: 'OPEN_UNPROTECTED', slOrderId: null, slCorrelationId: null, slPlacedAt: null });
    await mgr.reconcile();
    expect(ex.orders).toHaveLength(0);
    expect((await position()).state).toBe('CLOSED');
  });

  test('records stay consistent: the order list holds the entry as live and the proposal as confirmed', async () => {
    const ex = new FakeExchange();
    const { svc } = boot(ex, liveSettings(), { armed: true });
    await svc.onSignal(signal());
    await svc.confirmProposal(CORR);
    const live = await orderRepository.loadForDate('LIVE', '2026-10-23');
    const paper = await orderRepository.loadForDate('PAPER', '2026-10-23');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ source: 'APP', correlationId: CORR });
    expect(paper[0].status).toBe('CONFIRMED');
  });
});
