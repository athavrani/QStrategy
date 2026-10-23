import { ExecutionService, PENDING_CONFIRM, CONFIRMED, CONFIRMING, CONFIRM_FAILED, CONFIRM_UNCERTAIN, PROPOSAL_EXPIRED, PROPOSAL_DISMISSED, PAPER_BLOCKED, isProposalStatus } from '../execution/ExecutionService';
import { defaultExecutionSettings } from '../execution/executionSettings';
import { isLiveArmed, useLiveArm } from '../execution/liveArm';
import { ipPreflight } from '../execution/ipPreflight';
import type { ExecutableSignal, ExecutionSettings } from '../execution/types';
import type { StoredOrder } from '../services/OrderRepository';
import type { DhanOrder } from '../services/dhan/DhanOrderClient';
import { LIVE_MAX_LOTS, PROPOSAL_TTL_MS } from '../config/orderConfig';

jest.mock('../services/PublicIpService', () => ({
  ...jest.requireActual('../services/PublicIpService'),
  detectPublicIp: jest.fn(),
}));
jest.mock('../services/dhan/DhanIpService', () => ({
  ...jest.requireActual('../services/dhan/DhanIpService'),
  dhanIpService: { getIp: jest.fn() },
}));
import { detectPublicIp } from '../services/PublicIpService';
import { dhanIpService } from '../services/dhan/DhanIpService';

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

function confirmSettings(): ExecutionSettings {
  const s = defaultExecutionSettings();
  s.mode = 'CONFIRM';
  s.strategies.NIFTY_BREAKOUT_180.enabled = true;
  return s;
}

// 2026-10-23 is a Friday; 05:30 UTC is 11:00 IST.
const OPEN_HOURS = new Date('2026-10-23T05:30:00Z').getTime();

function fakeRepo() {
  const rows = new Map<string, StoredOrder>();
  return {
    rows,
    upsert: jest.fn(async (env: string, order: DhanOrder, meta: any = {}) => {
      const key = `${env}:${order.correlationId}`;
      const prev = rows.get(key);
      rows.set(key, { ...order, createTime: order.createTime ?? prev?.createTime ?? null, id: key, env: env as any, tradeDate: '2026-10-23', source: prev?.source ?? meta.source ?? 'DHAN', strategyId: meta.strategyId ?? prev?.strategyId ?? null });
    }),
    loadForDate: jest.fn(async (env: string) => [...rows.values()].filter((r) => r.env === env)),
  };
}

function build(over: Record<string, any> = {}, settings: ExecutionSettings = confirmSettings()) {
  let nowMs = OPEN_HOURS;
  const repo = fakeRepo();
  const liveClient = {
    placeAndConfirm: jest.fn(async (req: any) => ({ kind: 'PLACED' as const, orderId: 'L1', status: 'TRANSIT', correlationId: req.correlationId })),
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
    now: () => new Date(nowMs),
    isTradingDay: () => true,
    liveClient: liveClient as any,
    ...deps,
    ...over,
  });
  return { svc, repo, liveClient, settings, ...deps, advance: (ms: number) => (nowMs += ms) };
}

const proposal = (repo: ReturnType<typeof fakeRepo>) => [...repo.rows.values()].find((r) => r.env === 'PAPER')!;

describe('live arm switch', () => {
  beforeEach(() => useLiveArm.getState().disarm());

  test('is off until armed, and ends at the close and the next day', () => {
    const morning = new Date('2026-10-23T05:30:00Z'); // 11:00 IST
    expect(isLiveArmed(morning)).toBe(false);
    useLiveArm.getState().arm(morning);
    expect(isLiveArmed(morning)).toBe(true);
    expect(isLiveArmed(new Date('2026-10-23T09:59:00Z'))).toBe(true); // 15:29 IST
    expect(isLiveArmed(new Date('2026-10-23T10:00:00Z'))).toBe(false); // 15:30 IST
    expect(isLiveArmed(new Date('2026-10-24T05:30:00Z'))).toBe(false); // next day
    useLiveArm.getState().disarm();
    expect(isLiveArmed(morning)).toBe(false);
  });
});

describe('ipPreflight', () => {
  const cfg = (primaryIP: string | null, secondaryIP: string | null = null) => ({
    ok: true as const,
    data: { primaryIP, secondaryIP, modifyDatePrimary: null, modifyDateSecondary: null },
  });

  test('passes only when the device IP is one of the whitelisted IPs', async () => {
    (detectPublicIp as jest.Mock).mockResolvedValue({ ok: true, ip: '49.36.10.200' });
    (dhanIpService.getIp as jest.Mock).mockResolvedValue(cfg('1.1.1.1', '49.36.10.200'));
    expect(await ipPreflight()).toBeNull();
  });

  test('refuses on a mismatch, an empty whitelist, and any lookup failure', async () => {
    (detectPublicIp as jest.Mock).mockResolvedValue({ ok: true, ip: '49.36.10.200' });
    (dhanIpService.getIp as jest.Mock).mockResolvedValue(cfg('1.1.1.1'));
    expect(await ipPreflight()).toContain('not the IP whitelisted');

    (dhanIpService.getIp as jest.Mock).mockResolvedValue(cfg(null, null));
    expect(await ipPreflight()).toContain('No IP is whitelisted');

    (dhanIpService.getIp as jest.Mock).mockResolvedValue({ ok: false, status: 401, error: 'expired' });
    expect(await ipPreflight()).toContain('Could not read the Dhan IP whitelist');

    (detectPublicIp as jest.Mock).mockResolvedValue({ ok: false, error: 'offline' });
    (dhanIpService.getIp as jest.Mock).mockResolvedValue(cfg('49.36.10.200'));
    expect(await ipPreflight()).toContain("Could not check this device's IP");
  });
});

describe('Confirm mode: creating proposals', () => {
  test('a passing signal becomes a pending proposal and notifies, and nothing is sent', async () => {
    const { svc, repo, liveClient, notify } = build();
    const out = await svc.onSignal(signal());
    expect(out.kind).toBe('PROPOSED');
    expect(proposal(repo)).toMatchObject({ status: PENDING_CONFIRM, env: 'PAPER', quantity: 65, price: 181.8, securityId: '55555' });
    expect(notify).toHaveBeenCalledWith('NIFTY 24850 CE', 65, 181.8, PROPOSAL_TTL_MS / 1000);
    expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
    expect(isProposalStatus(PENDING_CONFIRM)).toBe(true);
  });

  test('a failing notification does not lose the proposal', async () => {
    const { svc, repo } = build({ notify: jest.fn(() => { throw new Error('no channel'); }) });
    expect((await svc.onSignal(signal())).kind).toBe('PROPOSED');
    expect(proposal(repo).status).toBe(PENDING_CONFIRM);
  });

  test('live orders are capped at the live lot limit even if the strategy is set higher', async () => {
    const s = confirmSettings();
    s.strategies.NIFTY_BREAKOUT_180.lots = LIVE_MAX_LOTS + 1;
    const { svc, repo } = build({}, s);
    expect(await svc.onSignal(signal())).toMatchObject({ kind: 'BLOCKED', reason: expect.stringContaining('capped') });
    expect(proposal(repo).status).toBe(PAPER_BLOCKED);
  });

  test('daily limits count live orders already sent by the app, not paper ones', async () => {
    const s = confirmSettings();
    s.limits.maxOrdersPerDay = 1;
    const { svc, repo } = build({}, s);
    repo.rows.set('LIVE:x', { id: 'LIVE:x', env: 'LIVE', source: 'APP', status: 'PENDING', price: 100, quantity: 65, correlationId: 'x' } as any);
    expect(await svc.onSignal(signal())).toMatchObject({ kind: 'BLOCKED', reason: expect.stringContaining('Daily limit') });

    repo.rows.set('LIVE:x', { id: 'LIVE:x', env: 'LIVE', source: 'APP', status: 'CANCELLED', price: 100, quantity: 65, correlationId: 'x' } as any);
    expect((await svc.onSignal(signal({ journalId: 'sig-other-1' }))).kind).toBe('PROPOSED');
  });

  test('a replayed signal neither restarts the timer of a pending proposal nor revives a handled one', async () => {
    const { svc, repo, advance } = build();
    await svc.onSignal(signal());
    const created = proposal(repo).createTime;
    advance(30_000);
    await svc.onSignal(signal());
    expect(proposal(repo).createTime).toBe(created);

    await svc.dismissProposal('QSP-' + 'sig-breakout-1730000000000'.slice(-26));
    expect(await svc.onSignal(signal())).toEqual({ kind: 'SKIPPED' });
    expect(proposal(repo).status).toBe(PROPOSAL_DISMISSED);
  });

  test('stale proposals are expired, fresh ones kept', async () => {
    const { svc, repo, advance } = build();
    await svc.onSignal(signal());
    advance(PROPOSAL_TTL_MS - 1000);
    await svc.expireStale();
    expect(proposal(repo).status).toBe(PENDING_CONFIRM);
    advance(2000);
    await svc.expireStale();
    expect(proposal(repo).status).toBe(PROPOSAL_EXPIRED);
  });
});

describe('Confirm mode: confirming a proposal', () => {
  const corr = 'QSP-' + 'sig-breakout-1730000000000'.slice(-26);

  async function proposed(over: Record<string, any> = {}, settings?: ExecutionSettings) {
    const b = build(over, settings);
    await b.svc.onSignal(signal());
    return b;
  }

  test('sends exactly one live order and records it as ours, then marks the proposal confirmed', async () => {
    const { svc, repo, liveClient, authenticate, checkIp } = await proposed();
    const res = await svc.confirmProposal(corr);

    expect(res).toEqual({ ok: true, orderId: 'L1', status: 'TRANSIT' });
    expect(liveClient.placeAndConfirm).toHaveBeenCalledTimes(1);
    expect(liveClient.placeAndConfirm).toHaveBeenCalledWith({
      correlationId: corr,
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: '55555',
      quantity: 65,
      price: 181.8,
    });
    expect(checkIp).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(proposal(repo).status).toBe(CONFIRMED);
    expect(repo.rows.get(`LIVE:${corr}`)).toMatchObject({ env: 'LIVE', orderId: 'L1', source: 'APP', status: 'TRANSIT', quantity: 65 });
  });

  test('a second confirmation of the same proposal never sends again, including two taps at once', async () => {
    const { svc, liveClient } = await proposed();
    const [a, b] = await Promise.all([svc.confirmProposal(corr), svc.confirmProposal(corr)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const again = await svc.confirmProposal(corr);
    expect(again).toMatchObject({ ok: false });
    expect(liveClient.placeAndConfirm).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['live trading is not armed', { isArmed: jest.fn(() => false) }, 'not armed'],
    ['the IP does not match', { checkIp: jest.fn(async () => 'This device IP is not whitelisted.') }, 'not whitelisted'],
    ['biometrics fail', { authenticate: jest.fn(async () => false) }, 'Biometric'],
  ])('nothing is sent when %s', async (_name, over, expected) => {
    const { svc, liveClient, repo } = await proposed(over);
    const res = await svc.confirmProposal(corr);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining(expected) });
    expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
    expect(proposal(repo).status).toBe(PENDING_CONFIRM); // can be retried while still fresh
  });

  test('the IP check runs before the biometric prompt, so a wasted prompt is avoided', async () => {
    const order: string[] = [];
    const { svc } = await proposed({
      checkIp: jest.fn(async () => { order.push('ip'); return 'mismatch'; }),
      authenticate: jest.fn(async () => { order.push('bio'); return true; }),
    });
    await svc.confirmProposal(corr);
    expect(order).toEqual(['ip']);
  });

  test('an expired proposal is refused and marked expired without sending or prompting', async () => {
    const { svc, liveClient, authenticate, repo, advance } = await proposed();
    advance(PROPOSAL_TTL_MS + 1000);
    const res = await svc.confirmProposal(corr);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('expired') });
    expect(proposal(repo).status).toBe(PROPOSAL_EXPIRED);
    expect(authenticate).not.toHaveBeenCalled();
    expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });

  test('a proposal that expires while the biometric prompt is open is not sent', async () => {
    let advanceFn: (ms: number) => number = () => 0;
    const authenticate = jest.fn(async () => {
      advanceFn(PROPOSAL_TTL_MS + 1000);
      return true;
    });
    const b = await proposed({ authenticate });
    advanceFn = b.advance;
    const res = await b.svc.confirmProposal(corr);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('expired while waiting') });
    expect(b.liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });

  test('disarming while the prompt is open also stops the order', async () => {
    let armed = true;
    const { svc, liveClient } = await proposed({
      isArmed: jest.fn(() => armed),
      authenticate: jest.fn(async () => {
        armed = false;
        return true;
      }),
    });
    expect(await svc.confirmProposal(corr)).toMatchObject({ ok: false });
    expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });

  test('settings changed after the proposal still apply: kill switch, mode, strategy switch and limits', async () => {
    const s = confirmSettings();
    const b = await proposed({}, s);

    s.killSwitch = true;
    expect(await b.svc.confirmProposal(corr)).toMatchObject({ ok: false, error: 'Kill switch is on.' });
    s.killSwitch = false;

    s.mode = 'PAPER';
    expect(await b.svc.confirmProposal(corr)).toMatchObject({ ok: false, error: 'Confirm mode is not on.' });
    s.mode = 'CONFIRM';

    s.strategies.NIFTY_BREAKOUT_180.enabled = false;
    expect(await b.svc.confirmProposal(corr)).toMatchObject({ ok: false, error: expect.stringContaining('not enabled') });
    s.strategies.NIFTY_BREAKOUT_180.enabled = true;

    s.limits.maxOrdersPerDay = 1;
    b.repo.rows.set('LIVE:y', { id: 'LIVE:y', env: 'LIVE', source: 'APP', status: 'TRADED', price: 10, quantity: 1, correlationId: 'y' } as any);
    expect(await b.svc.confirmProposal(corr)).toMatchObject({ ok: false, error: expect.stringContaining('Daily limit') });

    expect(b.liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });

  test('outside order hours nothing is sent', async () => {
    const b = build();
    b.advance(4 * 3600_000 + 24 * 60_000); // 15:24 IST, the last minute orders are allowed
    expect((await b.svc.onSignal(signal())).kind).toBe('PROPOSED');
    b.advance(90_000); // 15:25:30, still inside the proposal time limit but past order hours
    expect(await b.svc.confirmProposal(corr)).toMatchObject({ ok: false, error: expect.stringContaining('Outside order hours') });
    expect(b.liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });

  test('a rejection by Dhan is recorded on the proposal with its reason', async () => {
    const { svc, repo } = await proposed({
      liveClient: { placeAndConfirm: jest.fn(async (r: any) => ({ kind: 'REJECTED', error: 'Insufficient funds (HTTP 400)', code: 'DH-907', correlationId: r.correlationId })) },
    });
    expect(await svc.confirmProposal(corr)).toEqual({ ok: false, error: 'Insufficient funds (HTTP 400)' });
    expect(proposal(repo)).toMatchObject({ status: CONFIRM_FAILED, errorMessage: 'Insufficient funds (HTTP 400)' });
    expect(repo.rows.has(`LIVE:${corr}`)).toBe(false);
  });

  test('an unknown outcome is flagged as uncertain and can never be confirmed again', async () => {
    const { svc, repo } = await proposed({
      liveClient: { placeAndConfirm: jest.fn(async (r: any) => ({ kind: 'UNKNOWN', error: 'Request timed out.', correlationId: r.correlationId })) },
    });
    const res = await svc.confirmProposal(corr);
    expect(res).toMatchObject({ ok: false, uncertain: true });
    expect(proposal(repo).status).toBe(CONFIRM_UNCERTAIN);
    expect(proposal(repo).errorMessage).toContain('Check the Dhan order book');
    expect(await svc.confirmProposal(corr)).toMatchObject({ ok: false });
  });

  test('the proposal is marked as sending while the order is in flight', async () => {
    let seen = '';
    const b = build();
    await b.svc.onSignal(signal());
    b.liveClient.placeAndConfirm.mockImplementation(async (r: any) => {
      seen = proposal(b.repo).status;
      return { kind: 'PLACED' as const, orderId: 'L2', status: 'TRANSIT', correlationId: r.correlationId };
    });
    await b.svc.confirmProposal(corr);
    expect(seen).toBe(CONFIRMING);
  });

  test('an unknown or dismissed proposal cannot be confirmed', async () => {
    const { svc, liveClient } = await proposed();
    expect(await svc.confirmProposal('QSP-nope')).toMatchObject({ ok: false, error: 'Order proposal not found.' });
    expect(await svc.dismissProposal(corr)).toBe(true);
    expect(await svc.confirmProposal(corr)).toMatchObject({ ok: false });
    expect(await svc.dismissProposal(corr)).toBe(false);
    expect(liveClient.placeAndConfirm).not.toHaveBeenCalled();
  });
});
