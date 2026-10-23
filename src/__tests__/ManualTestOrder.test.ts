import { ExecutionService, PENDING_CONFIRM, CONFIRMED } from '../execution/ExecutionService';
import { defaultExecutionSettings } from '../execution/executionSettings';
import type { ExecutionSettings } from '../execution/types';
import type { StoredOrder } from '../services/OrderRepository';
import type { DhanOrder } from '../services/dhan/DhanOrderClient';
import { MANUAL_TEST_ID, MANUAL_TEST_MAX_QTY, MANUAL_TEST_MAX_VALUE } from '../config/orderConfig';

// 2026-10-23 is a Friday; 05:30 UTC is 11:00 IST.
const OPEN_HOURS = new Date('2026-10-23T05:30:00Z').getTime();

function fakeRepo() {
  const rows = new Map<string, StoredOrder>();
  return {
    rows,
    upsert: jest.fn(async (env: string, order: DhanOrder, meta: any = {}) => {
      const key = `${env}:${order.correlationId}`;
      const prev = rows.get(key);
      rows.set(key, { ...order, id: key, env: env as any, tradeDate: '2026-10-23', source: prev?.source ?? meta.source ?? 'DHAN', strategyId: meta.strategyId ?? prev?.strategyId ?? null });
    }),
    loadForDate: jest.fn(async (env: string) => [...rows.values()].filter((r) => r.env === env)),
  };
}

function confirmSettings(): ExecutionSettings {
  const s = defaultExecutionSettings();
  s.mode = 'CONFIRM'; // note: no strategy is enabled
  return s;
}

function build(settings: ExecutionSettings = confirmSettings(), over: Record<string, any> = {}) {
  const repo = fakeRepo();
  const liveClient = {
    placeAndConfirm: jest.fn(async (req: any) => ({ kind: 'PLACED' as const, orderId: 'M1', status: 'TRANSIT', correlationId: req.correlationId })),
  };
  const deps = {
    authenticate: jest.fn(async () => true),
    checkIp: jest.fn(async () => null as string | null),
    isArmed: jest.fn(() => true),
    notify: jest.fn(),
  };
  const svc = new ExecutionService({
    repo: repo as any,
    loadSettings: async () => settings,
    now: () => new Date(OPEN_HOURS),
    isTradingDay: () => true,
    liveClient: liveClient as any,
    ...deps,
    ...over,
  });
  return { svc, repo, liveClient, ...deps };
}

const input = { securityId: '1333', quantity: 1, price: 1400 };
const row = (repo: ReturnType<typeof fakeRepo>) => [...repo.rows.values()].find((r) => r.env === 'PAPER')!;

describe('manual test order: creating the proposal', () => {
  test('creates a small pending proposal without sending or notifying, even with no strategy enabled', async () => {
    const { svc, repo, liveClient, notify } = build();
    const res = await svc.createManualProposal(input);
    expect(res.ok).toBe(true);
    expect(row(repo)).toMatchObject({
      status: PENDING_CONFIRM,
      env: 'PAPER',
      strategyId: MANUAL_TEST_ID,
      exchangeSegment: 'NSE_EQ',
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      transactionType: 'BUY',
      securityId: '1333',
      quantity: 1,
      price: 1400,
    });
    expect(row(repo).correlationId).toMatch(/^QSM-[a-zA-Z0-9_.-]+$/);
    expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('needs Confirm mode, and respects the kill switch and order hours', async () => {
    const paper = confirmSettings();
    paper.mode = 'PAPER';
    expect(await build(paper).svc.createManualProposal(input)).toEqual({ ok: false, error: 'Set the mode to Confirm in Settings first.' });

    const killed = confirmSettings();
    killed.killSwitch = true;
    expect(await build(killed).svc.createManualProposal(input)).toEqual({ ok: false, error: 'Kill switch is on.' });

    const closed = build(confirmSettings(), { isTradingDay: () => false });
    expect(await closed.svc.createManualProposal(input)).toEqual({ ok: false, error: 'The market is closed today.' });
    expect(closed.repo.rows.size).toBe(0);
  });

  test('is capped in quantity and in value, and rejects malformed input', async () => {
    const { svc, repo } = build();
    expect(await svc.createManualProposal({ ...input, quantity: MANUAL_TEST_MAX_QTY + 1, price: 10 })).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${MANUAL_TEST_MAX_QTY} shares`),
    });
    expect(await svc.createManualProposal({ ...input, quantity: 5, price: MANUAL_TEST_MAX_VALUE / 5 + 1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('limited to ₹'),
    });
    expect(await svc.createManualProposal({ ...input, quantity: 0 })).toMatchObject({ ok: false });
    expect(await svc.createManualProposal({ ...input, price: NaN })).toMatchObject({ ok: false });
    expect(await svc.createManualProposal({ ...input, securityId: 'abc' })).toMatchObject({ ok: false });
    expect(repo.rows.size).toBe(0);
  });

  test('counts against the daily order limit like any live order', async () => {
    const s = confirmSettings();
    s.limits.maxOrdersPerDay = 1;
    const { svc, repo } = build(s);
    repo.rows.set('LIVE:x', { id: 'LIVE:x', env: 'LIVE', source: 'APP', status: 'PENDING', price: 100, quantity: 1, correlationId: 'x' } as any);
    expect(await svc.createManualProposal(input)).toMatchObject({ ok: false, error: expect.stringContaining('Daily limit') });
  });
});

describe('manual test order: confirming it', () => {
  async function created(over: Record<string, any> = {}) {
    const b = build(confirmSettings(), over);
    const res = await b.svc.createManualProposal(input);
    if (!res.ok) throw new Error(res.error);
    return { ...b, corr: res.correlationId };
  }

  test('sends one NSE equity order through the same live client and records it as ours', async () => {
    const { svc, repo, liveClient, corr, authenticate, checkIp } = await created();
    const out = await svc.confirmProposal(corr);
    expect(out).toEqual({ ok: true, orderId: 'M1', status: 'TRANSIT' });
    expect(liveClient.placeAndConfirm).toHaveBeenCalledTimes(1);
    expect(liveClient.placeAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: corr, exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', securityId: '1333', quantity: 1, price: 1400, transactionType: 'BUY', orderType: 'LIMIT' })
    );
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(checkIp).toHaveBeenCalledTimes(1);
    expect(repo.rows.get(`LIVE:${corr}`)).toMatchObject({ orderId: 'M1', source: 'APP', env: 'LIVE' });
    expect(row(repo).status).toBe(CONFIRMED);
  });

  test('is refused when live trading is not armed, the IP is wrong, or biometrics fail', async () => {
    for (const over of [
      { isArmed: jest.fn(() => false) },
      { checkIp: jest.fn(async () => 'IP mismatch') },
      { authenticate: jest.fn(async () => false) },
    ]) {
      const { svc, liveClient, corr } = await created(over);
      expect(await svc.confirmProposal(corr)).toMatchObject({ ok: false });
      expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
    }
  });

  test('is refused if Confirm mode is switched off after it was created', async () => {
    const s = confirmSettings();
    const b = build(s);
    const res = await b.svc.createManualProposal(input);
    if (!res.ok) throw new Error(res.error);
    s.mode = 'OFF';
    expect(await b.svc.confirmProposal(res.correlationId)).toEqual({ ok: false, error: 'Confirm mode is not on.' });
    expect(b.liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });
});
