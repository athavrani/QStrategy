import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import { OrdersScreen } from '../screens/OrdersScreen';
import { useOrdersStore } from '../store/useOrdersStore';
import { orderKey, orderRepository } from '../services/OrderRepository';
import { normalizeOrder } from '../services/dhan/DhanOrderClient';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { dbManager } from '../db/database';

let mockSandboxCreds = { clientId: '2000000001', token: 'sandbox-token' };

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => mockSandboxCreds),
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '', token: '' })),
    updateTelemetry: jest.fn(),
  },
}));

const fetchMock = jest.fn();

const row = (over: any = {}) => ({
  orderId: 'A1',
  correlationId: 'QS-a1',
  orderStatus: 'PENDING',
  transactionType: 'BUY',
  exchangeSegment: 'NSE_EQ',
  productType: 'INTRADAY',
  orderType: 'LIMIT',
  validity: 'DAY',
  securityId: '1333',
  tradingSymbol: 'HDFCBANK',
  quantity: 5,
  price: 1500,
  triggerPrice: 0,
  filledQty: 0,
  remainingQuantity: 5,
  averageTradedPrice: 0,
  createTime: '2026-10-23 10:00:00',
  ...over,
});

const ok = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
};

const textOf = (n: renderer.ReactTestInstance) => {
  const c = n.props.children;
  return Array.isArray(c) ? c.join('') : String(c ?? '');
};
const allText = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text).map(textOf).join(' | ');

const mounted: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  mounted.splice(0).forEach((t) => {
    try {
      t.unmount();
    } catch {
      // Already unmounted by the test
    }
  });
});

beforeEach(async () => {
  // The in-memory test driver keeps rows between tests; start each one empty.
  ((await dbManager.getDatabase()) as any).tables?.clear();
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
  mockSandboxCreds = { clientId: '2000000001', token: 'sandbox-token' };
  useOrdersStore.setState({ orders: [], configured: false, syncing: false, error: null, lastSynced: null });
});

describe('OrderRepository', () => {
  test('stores orders per environment, keeps ownership on re-read, and replaces by correlation id', async () => {
    const first = normalizeOrder(row({ orderId: 'R1', correlationId: 'QS-r1' }));
    await orderRepository.upsert('SANDBOX', first, { source: 'APP', strategyId: 'S1' });
    await orderRepository.upsert('SANDBOX', normalizeOrder(row({ orderId: 'R1', correlationId: 'QS-r1', orderStatus: 'TRADED', filledQty: 5 })), {
      source: 'DHAN',
    });
    await orderRepository.upsert('LIVE', normalizeOrder(row({ orderId: 'R2', correlationId: 'QS-r2' })), { source: 'APP' });

    const sandbox = await orderRepository.loadForDate('SANDBOX', formatDateKeyIST());
    const r1 = sandbox.filter((o) => o.orderId === 'R1');
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ status: 'TRADED', filledQty: 5, source: 'APP', strategyId: 'S1' });
    expect(sandbox.some((o) => o.orderId === 'R2')).toBe(false);
    expect((await orderRepository.loadOpen('SANDBOX')).some((o) => o.orderId === 'R1')).toBe(false);
  });

  test('orders without a correlation id are keyed by their Dhan order id', () => {
    expect(orderKey('SANDBOX', { orderId: '99', correlationId: null })).toBe('SANDBOX:dhan-99');
  });
});

describe('OrdersScreen', () => {
  async function mount(props: any = {}) {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OrdersScreen {...props} />);
    });
    mounted.push(tree);
    await flush();
    return tree;
  }

  test('without sandbox credentials it shows the setup state and never calls Dhan', async () => {
    mockSandboxCreds = { clientId: '', token: '' };
    const onOpen = jest.fn();
    const tree = await mount({ onOpenSettings: onOpen });
    expect(tree.root.findByProps({ testID: 'orders-empty' })).toBeTruthy();
    expect(textOf(tree.root.findByProps({ testID: 'orders-env' }))).toBe('SANDBOX');
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => tree.root.findByProps({ testID: 'orders-open-settings' }).props.onPress());
    expect(onOpen).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  test('lists active and completed orders from the Dhan order book', async () => {
    fetchMock.mockResolvedValue(
      ok([row({ orderId: 'L1', correlationId: 'QS-l1' }), row({ orderId: 'L2', correlationId: 'QS-l2', orderStatus: 'REJECTED', omsErrorDescription: 'Insufficient funds' })])
    );
    const tree = await mount();
    const text = allText(tree);
    expect(text).toContain('ACTIVE (1)');
    expect(text).toContain('TODAY (1)');
    expect(text).toContain('Insufficient funds');
    expect(tree.root.findAllByProps({ testID: 'cancel-L1' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'cancel-L2' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('shows a Dhan error instead of stale data when the refresh fails', async () => {
    fetchMock.mockResolvedValue(ok({ errorMessage: 'Invalid token' }, 401));
    const tree = await mount();
    expect(textOf(tree.root.findByProps({ testID: 'orders-error' }))).toContain('401');
    act(() => tree.unmount());
  });

  test('cancel asks for confirmation and then cancels at Dhan and refreshes', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init.method === 'DELETE') return ok({ orderId: 'C1', orderStatus: 'CANCELLED' });
      return ok([row({ orderId: 'C1', correlationId: 'QS-c1', orderStatus: fetchMock.mock.calls.some((c) => c[1].method === 'DELETE') ? 'CANCELLED' : 'PENDING' })]);
    });
    const tree = await mount();

    await act(async () => tree.root.findAllByProps({ testID: 'cancel-C1' })[0].props.onPress());
    expect(alertSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'DELETE')).toBe(false);

    const buttons = alertSpy.mock.calls[0][2] as any[];
    await act(async () => {
      buttons.find((b) => b.text === 'Cancel order').onPress();
    });
    await flush();
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'DELETE')).toBe(true);
    expect(allText(tree)).toContain('ACTIVE (0)');
    alertSpy.mockRestore();
    act(() => tree.unmount());
  });

  test('a TRANSIT order has no cancel button, explains why, and never calls Dhan to cancel', async () => {
    fetchMock.mockResolvedValue(ok([row({ orderId: 'X1', correlationId: 'QS-x1', orderStatus: 'TRANSIT' })]));
    const tree = await mount();
    expect(allText(tree)).toContain('ACTIVE (1)');
    expect(tree.root.findAllByProps({ testID: 'cancel-X1' })).toHaveLength(0);
    expect(textOf(tree.root.findByProps({ testID: 'transit-X1' }))).toContain('Waiting for the exchange');
    await act(async () => {
      expect(await useOrdersStore.getState().cancel(useOrdersStore.getState().orders[0])).toContain('TRANSIT');
    });
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'DELETE')).toBe(false);
  });

  test('a refused cancel shows Dhan reason on that order and leaves it open', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init.method === 'DELETE') {
        return ok({ errorType: 'Order_Error', errorCode: 'DH-906', errorMessage: 'Order is in transit' }, 400);
      }
      return ok([row({ orderId: 'T1', correlationId: 'QS-t1', orderStatus: 'PENDING' })]);
    });
    const tree = await mount();

    await act(async () => tree.root.findAllByProps({ testID: 'cancel-T1' })[0].props.onPress());
    const buttons = alertSpy.mock.calls[0][2] as any[];
    await act(async () => {
      buttons.find((b) => b.text === 'Cancel order').onPress();
    });
    await flush();

    expect(textOf(tree.root.findByProps({ testID: 'action-error-T1' }))).toBe('Cancel failed: Order is in transit (HTTP 400)');
    expect(allText(tree)).toContain('ACTIVE (1)');
    alertSpy.mockRestore();
  });

  test('a test order is validated, placed in the sandbox, and shown in the list', async () => {
    let placed = false;
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init.method === 'POST') {
        placed = true;
        return ok({ orderId: 'P1', orderStatus: 'TRANSIT' });
      }
      return ok(placed ? [row({ orderId: 'P1', correlationId: JSON.parse(fetchMock.mock.calls.find((c) => c[1].method === 'POST')![1].body).correlationId })] : []);
    });
    const tree = await mount();

    await act(async () => tree.root.findByProps({ testID: 'test-place' }).props.onPress());
    expect(textOf(tree.root.findByProps({ testID: 'test-result' }))).toContain('Rejected');
    expect(fetchMock.mock.calls.some((c) => c[1].method === 'POST')).toBe(false);

    act(() => tree.root.findByProps({ testID: 'test-price' }).props.onChangeText('1500'));
    await act(async () => tree.root.findByProps({ testID: 'test-place' }).props.onPress());
    await flush();

    const post = fetchMock.mock.calls.find((c) => c[1].method === 'POST')!;
    expect(post[0]).toBe('https://sandbox.dhan.co/v2/orders');
    expect(JSON.parse(post[1].body)).toMatchObject({ securityId: '1333', quantity: 1, price: 1500, transactionType: 'BUY' });
    expect(textOf(tree.root.findByProps({ testID: 'test-result' }))).toContain('Placed: order P1');
    expect(useOrdersStore.getState().orders.some((o) => o.orderId === 'P1' && o.source === 'APP')).toBe(true);
    act(() => tree.unmount());
  });
});
