import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ExecutionSettingsCard } from '../components/settings/ExecutionSettingsCard';
import { OrdersScreen } from '../screens/OrdersScreen';
import { useOrdersStore } from '../store/useOrdersStore';
import { orderRepository } from '../services/OrderRepository';
import { loadExecutionSettings } from '../execution/executionSettings';
import { dbManager } from '../db/database';
import { normalizeOrder } from '../services/dhan/DhanOrderClient';

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    updateTelemetry: jest.fn(),
  },
}));

const mounted: renderer.ReactTestRenderer[] = [];
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
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

beforeEach(async () => {
  await AsyncStorage.clear();
  ((await dbManager.getDatabase()) as any).tables?.clear();
  useOrdersStore.setState({ orders: [], paperOrders: [], configured: false, syncing: false, error: null, lastSynced: null });
});

afterEach(() => {
  mounted.splice(0).forEach((t) => {
    try {
      t.unmount();
    } catch {
      // Already unmounted
    }
  });
});

describe('ExecutionSettingsCard', () => {
  test('starts off, and mode, kill switch, strategy toggles and lots are saved as they change', async () => {
    const tree = await mount(<ExecutionSettingsCard />);
    expect((await loadExecutionSettings()).mode).toBe('OFF');

    await act(async () => tree.root.findByProps({ testID: 'mode-PAPER' }).props.onPress());
    expect((await loadExecutionSettings()).mode).toBe('PAPER');

    await act(async () => tree.root.findByProps({ testID: 'strategy-OOBTST_NIFTY' }).props.onValueChange(true));
    await act(async () => tree.root.findByProps({ testID: 'lots-up-OOBTST_NIFTY' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'kill-switch' }).props.onValueChange(true));

    const saved = await loadExecutionSettings();
    expect(saved.strategies.OOBTST_NIFTY).toEqual({ enabled: true, lots: 2 });
    expect(saved.strategies.NIFTY_BREAKOUT_180.enabled).toBe(false);
    expect(saved.killSwitch).toBe(true);
    expect(allText(tree)).toContain('Kill switch on');
  });

  test('lots never go below one and limits are repaired when saved', async () => {
    const tree = await mount(<ExecutionSettingsCard />);
    await act(async () => tree.root.findByProps({ testID: 'lots-down-OOBTST_SENSEX' }).props.onPress());
    expect((await loadExecutionSettings()).strategies.OOBTST_SENSEX.lots).toBe(1);

    act(() => tree.root.findByProps({ testID: 'limit-orders' }).props.onChangeText('5'));
    act(() => tree.root.findByProps({ testID: 'limit-daily' }).props.onChangeText('abc'));
    await act(async () => tree.root.findByProps({ testID: 'limits-save' }).props.onPress());

    const saved = await loadExecutionSettings();
    expect(saved.limits.maxOrdersPerDay).toBe(5);
    expect(saved.limits.maxDailyValue).toBe(100000); // bad input falls back to the default
    expect(tree.root.findByProps({ testID: 'limit-daily' }).props.value).toBe('100000'); // field shows the repaired value
  });
});

describe('Orders tab paper section', () => {
  const paper = (id: string, status: string, over: any = {}) =>
    normalizeOrder({
      orderId: `paper-${id}`,
      correlationId: `QSP-${id}`,
      orderStatus: status,
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: '55555',
      tradingSymbol: 'NIFTY 24850 CE',
      quantity: 65,
      price: 181.8,
      ...over,
    });

  test('shows planned and blocked paper orders even when no sandbox is set up, and says only confirmed orders are sent', async () => {
    await orderRepository.upsert('PAPER', paper('a', 'PAPER_PLANNED'), { source: 'APP', strategyId: 'NIFTY_BREAKOUT_180' });
    await orderRepository.upsert('PAPER', paper('b', 'PAPER_BLOCKED', { omsErrorDescription: 'Kill switch is on.' }), { source: 'APP' });

    const tree = await mount(<OrdersScreen />);
    const text = allText(tree);
    expect(text).toContain('SIGNAL ORDER LOG (2)');
    expect(text).toContain('Only orders you confirm are sent to Dhan');
    expect(text).toContain('PLANNED');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('Kill switch is on.');
    expect(text).toContain('qty 65');
    expect(tree.root.findAllByProps({ testID: 'orders-empty' }).length).toBeGreaterThan(0); // sandbox setup prompt remains
  });

  test('paper orders never count as open orders and have no cancel button', async () => {
    await orderRepository.upsert('PAPER', paper('c', 'PAPER_PLANNED'), { source: 'APP' });
    const tree = await mount(<OrdersScreen />);
    expect(tree.root.findAllByProps({ testID: 'cancel-paper-QSP-c' })).toHaveLength(0);
    expect(useOrdersStore.getState().orders).toHaveLength(0);
  });

  test('says so when there are no paper orders', async () => {
    const tree = await mount(<OrdersScreen />);
    expect(tree.root.findAllByProps({ testID: 'paper-none' }).length).toBeGreaterThan(0);
  });
});
