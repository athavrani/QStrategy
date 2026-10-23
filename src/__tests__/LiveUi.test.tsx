import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ExecutionSettingsCard } from '../components/settings/ExecutionSettingsCard';
import { LiveTradingCard } from '../components/settings/LiveTradingCard';
import { OrdersScreen } from '../screens/OrdersScreen';
import { useOrdersStore } from '../store/useOrdersStore';
import { orderRepository } from '../services/OrderRepository';
import { loadExecutionSettings, defaultExecutionSettings, saveExecutionSettings } from '../execution/executionSettings';
import { executionService } from '../execution/ExecutionService';
import { useLiveArm } from '../execution/liveArm';
import { dbManager } from '../db/database';
import { normalizeOrder } from '../services/dhan/DhanOrderClient';

let mockLiveCreds = { clientId: '', token: '' };
let mockStrictAuth = true;

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    getEffectiveCredentials: jest.fn(async () => mockLiveCreds),
    authenticateStrict: jest.fn(async () => mockStrictAuth),
    updateTelemetry: jest.fn(),
  },
}));

const fetchMock = jest.fn();
const mounted: renderer.ReactTestRenderer[] = [];

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

// Arming lasts until 15:30 IST, so these tests run at a fixed time inside market hours (Friday 11:00 IST).
const MARKET_HOURS = new Date('2026-10-23T05:30:00Z');

beforeEach(async () => {
  jest.useFakeTimers({ now: MARKET_HOURS, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
  mockLiveCreds = { clientId: '', token: '' };
  mockStrictAuth = true;
  useLiveArm.getState().disarm();
  await AsyncStorage.clear();
  ((await dbManager.getDatabase()) as any).tables?.clear();
  useOrdersStore.setState({ orders: [], liveOrders: [], paperOrders: [], configured: false, liveConfigured: false, syncing: false, error: null, lastSynced: null, proposalErrors: {} });
});

afterEach(() => {
  mounted.splice(0).forEach((t) => {
    try {
      t.unmount();
    } catch {
      // Already unmounted
    }
  });
  jest.useRealTimers();
});

describe('Orders tab: proposals awaiting confirmation', () => {
  const corr = 'QSP-prop-1';
  const seed = (status = 'PENDING_CONFIRM', over: any = {}) =>
    orderRepository.upsert(
      'PAPER',
      normalizeOrder({
        orderId: `paper-${corr}`,
        correlationId: corr,
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
        createTime: new Date().toISOString(),
        ...over,
      }),
      { source: 'APP', strategyId: 'NIFTY_BREAKOUT_180' }
    );

  test('a proposal shows its details and a real-money warning, and is not in the log', async () => {
    await seed();
    const tree = await mount(<OrdersScreen />);
    const text = allText(tree);
    expect(text).toContain('AWAITING YOUR CONFIRMATION (1)');
    expect(text).toContain('LIMIT 181.8');
    expect(text).toContain('qty 65');
    expect(text).toContain('REAL MONEY');
    expect(text).toContain('SIGNAL ORDER LOG (0)');
  });

  test('confirming asks first, and only after the prompt does it call the execution service', async () => {
    await seed();
    const confirm = jest
      .spyOn(executionService, 'confirmProposal')
      .mockResolvedValue({ ok: false, error: 'Live trading is not armed. Arm it in Settings first.' });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount(<OrdersScreen />);

    await act(async () => tree.root.findByProps({ testID: `confirm-${corr}` }).props.onPress());
    expect(alertSpy.mock.calls[0][0]).toBe('Send LIVE order?');
    expect(confirm).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0][2] as any[];
    await act(async () => {
      buttons.find((x) => x.text === 'Send live order').onPress();
    });
    await flush();
    expect(confirm).toHaveBeenCalledWith(corr);
    expect(textOf(tree.root.findByProps({ testID: `proposal-error-${corr}` }))).toContain('not armed');
    confirm.mockRestore();
    alertSpy.mockRestore();
  });

  test('choosing Cancel in the prompt sends nothing', async () => {
    await seed();
    const confirm = jest.spyOn(executionService, 'confirmProposal');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await mount(<OrdersScreen />);
    await act(async () => tree.root.findByProps({ testID: `confirm-${corr}` }).props.onPress());
    const buttons = alertSpy.mock.calls[0][2] as any[];
    expect(buttons.find((x) => x.text === 'Cancel').style).toBe('cancel');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
    alertSpy.mockRestore();
  });

  test('dismissing removes it from the waiting list and records it in the log', async () => {
    await seed();
    const tree = await mount(<OrdersScreen />);
    await act(async () => tree.root.findByProps({ testID: `dismiss-${corr}` }).props.onPress());
    await flush();
    const text = allText(tree);
    expect(text).not.toContain('AWAITING YOUR CONFIRMATION');
    expect(text).toContain('SIGNAL ORDER LOG (1)');
    expect(text).toContain('DISMISSED');
  });

  test('an old proposal is expired on load and offers no confirm button', async () => {
    await seed('PENDING_CONFIRM', { createTime: new Date(Date.now() - 10 * 60_000).toISOString() });
    const tree = await mount(<OrdersScreen />);
    expect(tree.root.findAllByProps({ testID: `confirm-${corr}` })).toHaveLength(0);
    expect(allText(tree)).toContain('EXPIRED');
  });

  test('a sent proposal is listed in the log with a plain label and offers no confirm button', async () => {
    await seed('CONFIRMED');
    const tree = await mount(<OrdersScreen />);
    expect(allText(tree)).toContain('SENT');
    expect(tree.root.findAllByProps({ testID: `confirm-${corr}` })).toHaveLength(0);
  });
});

describe('Orders tab: live orders', () => {
  test('live orders from the Dhan book are listed and can be cancelled on the live API without arming', async () => {
    mockLiveCreds = { clientId: '1100345678', token: 'live-token' };
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      if (init.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ orderId: 'LV1', orderStatus: 'CANCELLED' }), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            orderId: 'LV1', correlationId: 'QSP-live-1', orderStatus: 'PENDING', transactionType: 'BUY', exchangeSegment: 'NSE_FNO',
            productType: 'INTRADAY', orderType: 'LIMIT', validity: 'DAY', securityId: '55555', tradingSymbol: 'NIFTY 24850 CE', quantity: 65, price: 181.8,
          },
        ],
        text: async () => '',
      };
    });
    const tree = await mount(<OrdersScreen />);
    expect(allText(tree)).toContain('LIVE ORDERS (1)');
    expect(fetchMock.mock.calls.every((c) => String(c[0]).startsWith('https://api.dhan.co/v2/'))).toBe(true);

    await act(async () => tree.root.findAllByProps({ testID: 'cancel-LV1' })[0].props.onPress());
    const buttons = alertSpy.mock.calls[0][2] as any[];
    await act(async () => {
      buttons.find((x) => x.text === 'Cancel order').onPress();
    });
    await flush();
    const del = fetchMock.mock.calls.find((c) => c[1].method === 'DELETE')!;
    expect(del[0]).toBe('https://api.dhan.co/v2/orders/LV1');
    expect(del[1].headers['access-token']).toBe('live-token');
    alertSpy.mockRestore();
  });

  test('the header shows whether live trading is armed', async () => {
    const tree = await mount(<OrdersScreen />);
    expect(textOf(tree.root.findByProps({ testID: 'live-pill' }))).toBe('LIVE OFF');
    act(() => useLiveArm.getState().arm());
    expect(textOf(tree.root.findByProps({ testID: 'live-pill' }))).toBe('LIVE ARMED');
  });
});

describe('LiveTradingCard', () => {
  test('arming needs a successful strict biometric check, disarming does not', async () => {
    const tree = await mount(<LiveTradingCard />);
    expect(textOf(tree.root.findByProps({ testID: 'live-status' }))).toBe('DISARMED');

    mockStrictAuth = false;
    await act(async () => tree.root.findByProps({ testID: 'live-arm' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'live-status' }))).toBe('DISARMED');
    expect(allText(tree)).toContain('Biometric verification is required');

    mockStrictAuth = true;
    await act(async () => tree.root.findByProps({ testID: 'live-arm' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'live-status' }))).toBe('ARMED');

    await act(async () => tree.root.findByProps({ testID: 'live-disarm' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'live-status' }))).toBe('DISARMED');
  });

  test('after the 15:30 IST close it explains that arming is not possible instead of claiming success', async () => {
    jest.setSystemTime(new Date('2026-10-23T10:30:00Z')); // 16:00 IST
    const tree = await mount(<LiveTradingCard />);
    await act(async () => tree.root.findByProps({ testID: 'live-arm' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'live-status' }))).toBe('DISARMED');
    expect(allText(tree)).toContain('market has closed');
    expect(allText(tree)).not.toContain('is armed until');
  });
});

describe('Orders tab: live test order panel', () => {
  const emptyBook = () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [], text: async () => '' });

  test('is only offered once a live token exists', async () => {
    const tree = await mount(<OrdersScreen />);
    expect(tree.root.findAllByProps({ testID: 'livetest-create' })).toHaveLength(0);
  });

  test('explains what to fix when Confirm mode is not on, and creates nothing', async () => {
    mockLiveCreds = { clientId: '1100345678', token: 'live-token' };
    emptyBook();
    const tree = await mount(<OrdersScreen />);
    act(() => tree.root.findByProps({ testID: 'livetest-price' }).props.onChangeText('1400'));
    await act(async () => tree.root.findByProps({ testID: 'livetest-create' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'livetest-result' }))).toBe('Set the mode to Confirm in Settings first.');
    expect(allText(tree)).not.toContain('AWAITING YOUR CONFIRMATION');
  });

  test('with Confirm mode on, a small order becomes a proposal waiting for confirmation, and nothing is sent', async () => {
    mockLiveCreds = { clientId: '1100345678', token: 'live-token' };
    emptyBook();
    await saveExecutionSettings({ ...defaultExecutionSettings(), mode: 'CONFIRM' });
    const tree = await mount(<OrdersScreen />);

    act(() => tree.root.findByProps({ testID: 'livetest-price' }).props.onChangeText('1400'));
    await act(async () => tree.root.findByProps({ testID: 'livetest-create' }).props.onPress());
    await flush();

    expect(textOf(tree.root.findByProps({ testID: 'livetest-result' }))).toContain('Confirm it there');
    const text = allText(tree);
    expect(text).toContain('AWAITING YOUR CONFIRMATION (1)');
    expect(text).toContain('LIMIT 1400');
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'POST')).toBe(false);
  });

  test('an order above the size cap is refused with the reason', async () => {
    mockLiveCreds = { clientId: '1100345678', token: 'live-token' };
    emptyBook();
    await saveExecutionSettings({ ...defaultExecutionSettings(), mode: 'CONFIRM' });
    const tree = await mount(<OrdersScreen />);
    act(() => tree.root.findByProps({ testID: 'livetest-qty' }).props.onChangeText('5'));
    act(() => tree.root.findByProps({ testID: 'livetest-price' }).props.onChangeText('1400'));
    await act(async () => tree.root.findByProps({ testID: 'livetest-create' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'livetest-result' }))).toContain('limited to');
    expect(allText(tree)).not.toContain('AWAITING YOUR CONFIRMATION');
  });
});

describe('Confirm mode in Settings', () => {
  test('can be selected and is saved', async () => {
    const tree = await mount(<ExecutionSettingsCard />);
    await act(async () => tree.root.findByProps({ testID: 'mode-CONFIRM' }).props.onPress());
    expect((await loadExecutionSettings()).mode).toBe('CONFIRM');
  });
});
