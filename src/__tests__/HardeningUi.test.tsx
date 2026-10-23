import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OrdersScreen } from '../screens/OrdersScreen';
import { LiveReadinessCard } from '../components/settings/LiveReadinessCard';
import { useOrdersStore } from '../store/useOrdersStore';
import { positionRepository, type PositionState } from '../services/PositionRepository';
import { orderRepository } from '../services/OrderRepository';
import { positionManager } from '../execution/PositionManager';
import * as readiness from '../execution/readiness';
import { normalizeOrder } from '../services/dhan/DhanOrderClient';
import { dbManager } from '../db/database';

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    authenticateStrict: jest.fn(async () => true),
    updateTelemetry: jest.fn(),
  },
}));

const mounted: renderer.ReactTestRenderer[] = [];
const MARKET_HOURS = new Date('2026-10-23T05:30:00Z');

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const textOf = (n: renderer.ReactTestInstance) => {
  const c = n.props.children;
  return Array.isArray(c) ? c.join('') : String(c ?? '');
};
const allText = (t: renderer.ReactTestRenderer) => t.root.findAllByType(Text).map(textOf).join(' | ');

async function mount(el: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(el);
  });
  mounted.push(tree);
  await flush();
  return tree;
}

async function seedPosition(id: string, state: PositionState, patch: Record<string, any> = {}) {
  await positionRepository.create({
    id,
    strategyId: 'NIFTY_BREAKOUT_180',
    securityId: '55555',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    tradingSymbol: 'NIFTY 24850 CE',
    requestedQty: 65,
    slPrice: 160,
    targetPrice: 220,
  });
  await positionRepository.update(id, { state, ...patch });
}

const seedOrder = (corr: string, status: string, over: any = {}) =>
  orderRepository.upsert(
    'PAPER',
    normalizeOrder({
      orderId: `paper-${corr}`, correlationId: corr, orderStatus: status, transactionType: 'BUY', exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY', orderType: 'LIMIT', validity: 'DAY', securityId: '55555', tradingSymbol: 'NIFTY 24850 CE',
      quantity: 65, price: 181.8, createTime: new Date().toISOString(), ...over,
    }),
    { source: 'APP', strategyId: 'NIFTY_BREAKOUT_180' }
  );

beforeEach(async () => {
  jest.useFakeTimers({ now: MARKET_HOURS, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  (global as any).fetch = jest.fn();
  await AsyncStorage.clear();
  ((await dbManager.getDatabase()) as any).tables?.clear();
  useOrdersStore.setState({ orders: [], liveOrders: [], paperOrders: [], positions: [], positionErrors: {}, configured: false, liveConfigured: false, syncing: false, error: null, lastSynced: null, proposalErrors: {} });
});

afterEach(() => {
  mounted.splice(0).forEach((t) => {
    try {
      t.unmount();
    } catch {
      // Already unmounted
    }
  });
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Exit all positions', () => {
  test('is only offered when something is held', async () => {
    await seedPosition('N1', 'ENTRY_SENT');
    await seedPosition('N2', 'CLOSED', { filledQty: 65, entryAvg: 180, pnl: 5, exitAvg: 180.1 });
    const tree = await mount(<OrdersScreen />);
    expect(tree.root.findAllByProps({ testID: 'exit-all' })).toHaveLength(0);
  });

  test('asks first, then exits everything and reports how many were sent', async () => {
    await seedPosition('E1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    await seedPosition('E2', 'OPEN_UNPROTECTED', { filledQty: 65, entryAvg: 180 });
    const exitAll = jest.spyOn(positionManager, 'exitAll').mockResolvedValue({ attempted: 2, failed: [] });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount(<OrdersScreen />);
    expect(allText(tree)).toContain('Exit ALL positions (2)');

    await act(async () => tree.root.findAllByProps({ testID: 'exit-all' })[0].props.onPress());
    expect(alertSpy.mock.calls[0][0]).toBe('Exit ALL positions?');
    expect(exitAll).not.toHaveBeenCalled();

    await act(async () => {
      (alertSpy.mock.calls[0][2] as any[]).find((b) => b.text === 'Exit all now').onPress();
    });
    await flush();
    expect(exitAll).toHaveBeenCalledTimes(1);
    expect(textOf(tree.root.findByProps({ testID: 'exit-all-result' }))).toBe('Exit sent for 2 positions.');
  });

  test('names the positions that could not be exited and shows the reason on each', async () => {
    await seedPosition('F1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    jest.spyOn(positionManager, 'exitAll').mockResolvedValue({ attempted: 1, failed: [{ id: 'F1', symbol: 'NIFTY 24850 CE', error: 'Could not cancel the stop-loss' }] });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount(<OrdersScreen />);
    await act(async () => tree.root.findAllByProps({ testID: 'exit-all' })[0].props.onPress());
    await act(async () => {
      (alertSpy.mock.calls[0][2] as any[]).find((b) => b.text === 'Exit all now').onPress();
    });
    await flush();
    expect(textOf(tree.root.findByProps({ testID: 'exit-all-result' }))).toContain('0 of 1 exits sent');
    expect(textOf(tree.root.findByProps({ testID: 'exit-all-result' }))).toContain('NIFTY 24850 CE (Could not cancel the stop-loss)');
    expect(textOf(tree.root.findByProps({ testID: 'position-error-F1' }))).toBe('Could not cancel the stop-loss');
  });

  test('choosing Keep exits nothing', async () => {
    await seedPosition('G1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    const exitAll = jest.spyOn(positionManager, 'exitAll');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount(<OrdersScreen />);
    await act(async () => tree.root.findAllByProps({ testID: 'exit-all' })[0].props.onPress());
    expect((alertSpy.mock.calls[0][2] as any[]).find((b) => b.text === 'Keep').style).toBe('cancel');
    expect(exitAll).not.toHaveBeenCalled();
  });
});

describe('Execution report on the Orders tab', () => {
  test('is hidden until there is something to report', async () => {
    const tree = await mount(<OrdersScreen />);
    expect(tree.root.findAllByProps({ testID: 'exec-report' })).toHaveLength(0);
  });

  test('summarises signals, fills against the limit price and closed profit and loss', async () => {
    await seedOrder('QSP-r1', 'CONFIRMED');
    await seedOrder('QSP-r2', 'PROPOSAL_EXPIRED');
    await seedOrder('QSP-r3', 'PAPER_BLOCKED', { omsErrorDescription: 'Kill switch is on.' });
    await seedPosition('QSP-r1', 'CLOSED', { filledQty: 65, entryAvg: 181, exitAvg: 158, pnl: -1495 });
    const tree = await mount(<OrdersScreen />);
    expect(textOf(tree.root.findByProps({ testID: 'report-signals' }))).toContain('3 signals: 1 sent, 1 missed (expired), 0 dismissed, 1 blocked');
    expect(allText(tree)).toContain('Blocked 1x: Kill switch is on.');
    expect(textOf(tree.root.findByProps({ testID: 'report-fills' }))).toContain('1 filled, on average -0.8 per share against the limit price');
    expect(textOf(tree.root.findByProps({ testID: 'report-pnl' }))).toContain('1 closed (0 won, 1 lost): -1495');
  });
});

describe('LiveReadinessCard', () => {
  test('runs the checks and shows each one with its status and a summary', async () => {
    jest.spyOn(readiness, 'runReadinessChecks').mockResolvedValue([
      { id: 'token', label: 'Live Dhan token', status: 'PASS', detail: 'A token is saved.' },
      { id: 'ip', label: 'Device IP matches the Dhan whitelist', status: 'FAIL', detail: 'IP mismatch.' },
      { id: 'armed', label: 'Live trading armed', status: 'WARN', detail: 'Not armed.' },
    ]);
    const tree = await mount(<LiveReadinessCard />);
    expect(tree.root.findAllByProps({ testID: 'readiness-summary' })).toHaveLength(0);

    await act(async () => tree.root.findByProps({ testID: 'readiness-run' }).props.onPress());
    await flush();
    expect(textOf(tree.root.findByProps({ testID: 'readiness-summary' }))).toBe('1 to fix, 1 to check');
    expect(textOf(tree.root.findByProps({ testID: 'check-status-token' }))).toBe('OK');
    expect(textOf(tree.root.findByProps({ testID: 'check-status-ip' }))).toBe('FIX');
    expect(textOf(tree.root.findByProps({ testID: 'check-status-armed' }))).toBe('CHECK');
    expect(allText(tree)).toContain('IP mismatch.');
  });

  test('says all clear when every check passes', async () => {
    jest.spyOn(readiness, 'runReadinessChecks').mockResolvedValue([{ id: 'token', label: 'Live Dhan token', status: 'PASS', detail: 'ok' }]);
    const tree = await mount(<LiveReadinessCard />);
    await act(async () => tree.root.findByProps({ testID: 'readiness-run' }).props.onPress());
    await flush();
    expect(textOf(tree.root.findByProps({ testID: 'readiness-summary' }))).toBe('All clear');
  });
});
