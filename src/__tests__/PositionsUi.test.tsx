import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OrdersScreen } from '../screens/OrdersScreen';
import { useOrdersStore } from '../store/useOrdersStore';
import { positionRepository, type PositionState } from '../services/PositionRepository';
import { positionManager } from '../execution/PositionManager';
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

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<OrdersScreen />);
  });
  mounted.push(tree);
  await flush();
  return tree;
}

async function seed(id: string, state: PositionState, patch: Record<string, any> = {}) {
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

describe('Orders tab: positions', () => {
  test('lists active and finished positions with plain state labels, and leaves out unsent proposals', async () => {
    await seed('P1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    await seed('P2', 'OPEN_UNPROTECTED', { filledQty: 65, entryAvg: 180, note: 'Stop-loss was rejected: IP not whitelisted' });
    await seed('P3', 'ENTRY_SENT');
    await seed('P4', 'CLOSED', { filledQty: 65, entryAvg: 180, exitAvg: 158, pnl: -1430, note: 'Stop-loss hit.' });
    await seed('P5', 'PROPOSED');

    const tree = await mount();
    expect(allText(tree)).toContain('POSITIONS (4)');
    expect(textOf(tree.root.findByProps({ testID: 'position-state-P1' }))).toBe('PROTECTED');
    expect(textOf(tree.root.findByProps({ testID: 'position-state-P2' }))).toBe('NO STOP-LOSS');
    expect(textOf(tree.root.findByProps({ testID: 'position-state-P3' }))).toBe('ENTRY PENDING');
    expect(textOf(tree.root.findByProps({ testID: 'position-state-P4' }))).toBe('CLOSED');
    expect(tree.root.findAllByProps({ testID: 'position-P5' })).toHaveLength(0);
    expect(allText(tree)).toContain('Stop-loss was rejected: IP not whitelisted');
    expect(allText(tree)).toContain('P&L -1430');
  });

  test('only held positions offer an exit; pending, closed and exiting ones do not', async () => {
    await seed('H1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    await seed('H2', 'ENTRY_SENT');
    await seed('H3', 'CLOSED', { filledQty: 65, entryAvg: 180, pnl: 10, exitAvg: 180.2 });
    await seed('H4', 'CLOSING', { filledQty: 65, entryAvg: 180 });
    const tree = await mount();
    expect(tree.root.findAllByProps({ testID: 'exit-H1' }).length).toBeGreaterThan(0);
    for (const id of ['H2', 'H3', 'H4']) expect(tree.root.findAllByProps({ testID: `exit-${id}` })).toHaveLength(0);
  });

  test('exiting asks first and only sells after the prompt, then shows a refusal on that position', async () => {
    await seed('X1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    const exit = jest.spyOn(positionManager, 'exitPosition').mockResolvedValue({ ok: false, error: 'Market closed' });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount();

    await act(async () => tree.root.findAllByProps({ testID: 'exit-X1' })[0].props.onPress());
    expect(alertSpy.mock.calls[0][0]).toBe('Exit position?');
    expect(String(alertSpy.mock.calls[0][1])).toContain('stop-loss order is cancelled first');
    expect(exit).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0][2] as any[];
    expect(buttons.find((b) => b.text === 'Keep').style).toBe('cancel');
    await act(async () => {
      buttons.find((b) => b.text === 'Exit now').onPress();
    });
    await flush();
    expect(exit).toHaveBeenCalledWith('X1');
    expect(textOf(tree.root.findByProps({ testID: 'position-error-X1' }))).toBe('Market closed');
  });

  test('choosing Keep in the exit prompt sells nothing', async () => {
    await seed('K1', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    const exit = jest.spyOn(positionManager, 'exitPosition');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount();
    await act(async () => tree.root.findAllByProps({ testID: 'exit-K1' })[0].props.onPress());
    expect(exit).not.toHaveBeenCalled();
    expect((alertSpy.mock.calls[0][2] as any[]).find((b) => b.text === 'Keep')).toBeTruthy();
  });

  test('an unprotected position with a stop-loss price offers to place it; one without does not', async () => {
    await seed('U1', 'OPEN_UNPROTECTED', { filledQty: 65, entryAvg: 180 });
    await seed('U2', 'OPEN_UNPROTECTED', { filledQty: 65, entryAvg: 180, slPrice: null });
    const protect = jest.spyOn(positionManager, 'protectNow').mockResolvedValue({ checked: 1 });
    const tree = await mount();
    expect(tree.root.findAllByProps({ testID: 'protect-U2' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'exit-U2' }).length).toBeGreaterThan(0); // can still be exited by hand
    await act(async () => tree.root.findAllByProps({ testID: 'protect-U1' })[0].props.onPress());
    await flush();
    expect(protect).toHaveBeenCalledWith('U1');
  });

  test('a strategy exit suggestion is shown on the position it belongs to', async () => {
    await seed('S1', 'PROTECTED', { filledQty: 65, entryAvg: 180, exitHint: 'Target hit' });
    await seed('S2', 'PROTECTED', { filledQty: 65, entryAvg: 180 });
    const tree = await mount();
    expect(textOf(tree.root.findByProps({ testID: 'position-hint-S1' }))).toContain('Target hit');
    expect(tree.root.findAllByProps({ testID: 'position-hint-S2' })).toHaveLength(0);
  });
});
