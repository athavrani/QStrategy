import { runReadinessChecks, summarizeReadiness, type ReadinessDeps } from '../execution/readiness';
import { buildExecutionReport } from '../execution/executionReport';
import { defaultExecutionSettings } from '../execution/executionSettings';
import type { Position } from '../services/PositionRepository';
import type { StoredOrder } from '../services/OrderRepository';

const b64 = (o: object) => btoa(JSON.stringify(o));
// A syntactically valid token (the checks only look at its shape; the expiry is injected separately).
const TOKEN = `eyJ${b64({ alg: 'HS256' })}.${b64({ dhanClientId: '1100345678', exp: 9999999999 })}.${'x'.repeat(60)}`;

// Friday 2026-10-23, 11:00 IST
const OPEN = new Date('2026-10-23T05:30:00Z');

function deps(over: Partial<ReadinessDeps> = {}): Partial<ReadinessDeps> {
  const settings = defaultExecutionSettings();
  settings.mode = 'CONFIRM';
  settings.strategies.NIFTY_BREAKOUT_180.enabled = true;
  return {
    loadSettings: async () => settings,
    token: async () => TOKEN,
    tokenSecondsLeft: () => 6 * 3600,
    checkIp: async () => null,
    isArmed: () => true,
    backgroundMonitoring: async () => true,
    activePositions: async () => [],
    now: () => OPEN,
    isTradingDay: () => true,
    ...over,
  };
}

const status = (checks: Awaited<ReturnType<typeof runReadinessChecks>>, id: string) => checks.find((c) => c.id === id)?.status;

describe('readiness checks', () => {
  test('everything in order is all clear', async () => {
    const checks = await runReadinessChecks(deps());
    expect(checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(summarizeReadiness(checks)).toEqual({ fails: 0, warns: 0, ready: true });
  });

  test('a missing token is a failure and hides the validity check', async () => {
    const checks = await runReadinessChecks(deps({ token: async () => '' }));
    expect(status(checks, 'token')).toBe('FAIL');
    expect(checks.find((c) => c.id === 'token-life')).toBeUndefined();
  });

  test('token validity: expired fails, under two hours warns, unknown warns', async () => {
    expect(status(await runReadinessChecks(deps({ tokenSecondsLeft: () => 0 })), 'token-life')).toBe('FAIL');
    const soon = await runReadinessChecks(deps({ tokenSecondsLeft: () => 45 * 60 }));
    expect(status(soon, 'token-life')).toBe('WARN');
    expect(soon.find((c) => c.id === 'token-life')!.detail).toContain('45 min');
    expect(status(await runReadinessChecks(deps({ tokenSecondsLeft: () => null })), 'token-life')).toBe('WARN');
  });

  test('an IP that does not match fails with the reason, and a crashing check also fails', async () => {
    const mismatch = await runReadinessChecks(deps({ checkIp: async () => 'This device IP is not whitelisted.' }));
    expect(status(mismatch, 'ip')).toBe('FAIL');
    expect(mismatch.find((c) => c.id === 'ip')!.detail).toContain('not whitelisted');
    const crashed = await runReadinessChecks(deps({ checkIp: async () => { throw new Error('boom'); } }));
    expect(status(crashed, 'ip')).toBe('FAIL');
  });

  test('mode, kill switch, arming, strategies and monitoring are each reported on their own', async () => {
    const s = defaultExecutionSettings();
    s.mode = 'PAPER';
    s.killSwitch = true;
    const checks = await runReadinessChecks(deps({ loadSettings: async () => s, isArmed: () => false, backgroundMonitoring: async () => false }));
    expect(status(checks, 'mode')).toBe('WARN');
    expect(status(checks, 'kill')).toBe('FAIL');
    expect(status(checks, 'strategies')).toBe('WARN');
    expect(status(checks, 'armed')).toBe('WARN');
    expect(status(checks, 'background')).toBe('WARN');
    const sum = summarizeReadiness(checks);
    expect(sum.ready).toBe(false);
    expect(sum.fails).toBe(1);
    expect(sum.warns).toBe(4);
  });

  test('a held position without a stop-loss is a failure; protected ones pass', async () => {
    const p = (state: Position['state']) => ({ state, filledQty: 65 }) as Position;
    expect(status(await runReadinessChecks(deps({ activePositions: async () => [p('PROTECTED')] })), 'positions')).toBe('PASS');
    const bad = await runReadinessChecks(deps({ activePositions: async () => [p('PROTECTED'), p('OPEN_UNPROTECTED')] }));
    expect(status(bad, 'positions')).toBe('FAIL');
    expect(bad.find((c) => c.id === 'positions')!.detail).toContain('1 held position has no stop-loss');
  });

  test('outside order hours is a warning with the hours', async () => {
    const checks = await runReadinessChecks(deps({ now: () => new Date('2026-10-23T11:00:00Z') }));
    expect(status(checks, 'hours')).toBe('WARN');
    expect(checks.find((c) => c.id === 'hours')!.detail).toContain('09:15');
  });

  test('settings that cannot be read fail instead of crashing the whole check', async () => {
    const checks = await runReadinessChecks(deps({ loadSettings: async () => { throw new Error('storage'); } }));
    expect(status(checks, 'settings')).toBe('FAIL');
    expect(checks.length).toBeGreaterThan(5);
  });
});

describe('execution report', () => {
  const order = (id: string, status: string, over: Partial<StoredOrder> = {}): StoredOrder =>
    ({ id, correlationId: id, status, strategyId: 'NIFTY_BREAKOUT_180', price: 181.8, quantity: 65, errorMessage: null, ...over }) as StoredOrder;
  const position = (id: string, over: Partial<Position> = {}): Position =>
    ({ id, strategyId: 'NIFTY_BREAKOUT_180', state: 'CLOSED', filledQty: 65, entryAvg: 180, pnl: null, ...over }) as Position;

  test('counts what happened to each signal and groups block reasons by their wording', async () => {
    const report = buildExecutionReport(
      [
        order('a', 'CONFIRMED'),
        order('b', 'PROPOSAL_EXPIRED'),
        order('c', 'PROPOSAL_DISMISSED'),
        order('d', 'CONFIRM_FAILED'),
        order('e', 'CONFIRM_UNCERTAIN'),
        order('f', 'PAPER_BLOCKED', { errorMessage: 'Daily limit of 3 orders reached.' }),
        order('g', 'PAPER_BLOCKED', { errorMessage: 'Daily limit of 5 orders reached.' }),
        order('h', 'PAPER_BLOCKED', { errorMessage: 'Kill switch is on.' }),
        order('t', 'CONFIRMED', { strategyId: 'MANUAL_TEST' }),
      ],
      []
    );
    expect(report).toMatchObject({ signals: 8, proposed: 5, sent: 1, missed: 1, dismissed: 1, failed: 1, uncertain: 1, blocked: 3 });
    expect(report.blockedReasons[0]).toEqual({ reason: 'Daily limit of # orders reached.', count: 2 });
  });

  test('fills are compared with the limit price, and closed trades add up', async () => {
    const report = buildExecutionReport(
      [order('p1', 'CONFIRMED'), order('p2', 'CONFIRMED', { price: 100 }), order('p3', 'CONFIRMED')],
      [
        position('p1', { entryAvg: 181, pnl: 500 }), // +(-0.8) vs 181.8
        position('p2', { entryAvg: 101, pnl: -200 }), // +1 vs 100
        position('p3', { state: 'PROTECTED', entryAvg: 180 }), // open
        position('t1', { strategyId: 'MANUAL_TEST', pnl: 99999 }),
        position('n1', { filledQty: 0, state: 'ENTRY_FAILED' }),
      ]
    );
    expect(report).toMatchObject({ filled: 3, open: 1, closed: 2, wins: 1, losses: 1, pnl: 300 });
    expect(report.avgFillVsLimit).toBe(-0.53); // mean of -0.8, +1 and -1.8, rounded to two places
  });

  test('an empty day reports zeros and no average', async () => {
    expect(buildExecutionReport([], [])).toMatchObject({ signals: 0, filled: 0, pnl: 0, avgFillVsLimit: null, blockedReasons: [] });
  });
});
