import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { AppNavigator } from '../navigation/AppNavigator';
import { OrdersScreen } from '../screens/OrdersScreen';
import { OrderExecutionCard } from '../components/settings/OrderExecutionCard';
import { secureVault } from '../services/SecureCredentialVault';

jest.mock('../components/common/FirstRunOnboarding', () => ({ FirstRunOnboarding: () => null }));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const textOf = (node: renderer.ReactTestInstance) => {
  const c = node.props.children;
  return Array.isArray(c) ? c.join('') : String(c ?? '');
};

describe('Orders tab', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('sits between Journal and Settings in the tab bar', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<AppNavigator />);
    });
    const labels = tree.root.findAllByType(Text).map(textOf);
    const journal = labels.indexOf('Journal');
    const orders = labels.indexOf('Orders');
    const settings = labels.indexOf('Settings');
    expect(journal).toBeGreaterThan(-1);
    expect(orders).toBeGreaterThan(journal);
    expect(settings).toBeGreaterThan(orders);
    act(() => tree.unmount());
  });

  test('shows the empty state and a shortcut to Settings', () => {
    const onOpen = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<OrdersScreen onOpenSettings={onOpen} />);
    });
    expect(tree.root.findByProps({ testID: 'orders-empty' })).toBeTruthy();
    act(() => tree.root.findByProps({ testID: 'orders-open-settings' }).props.onPress());
    expect(onOpen).toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('OrderExecutionCard', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
    jest.spyOn(secureVault, 'getEffectiveCredentials').mockResolvedValue({
      clientId: '1100345678',
      token: 'tok',
      tabId: '1',
      isStreamerEnabled: true,
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const respond = (config: any) =>
    fetchMock.mockImplementation(async (url: string) => {
      const body = url.includes('ipify')
        ? { ip: '49.36.10.200' }
        : url.includes('getIP')
          ? config
          : { message: 'IP saved' };
      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    });

  async function mount() {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OrderExecutionCard />);
    });
    await flush();
    return tree;
  }

  test('shows MATCH when the device IP is whitelisted and MISMATCH when it is not', async () => {
    respond({ primaryIP: '49.36.10.200' });
    let tree = await mount();
    expect(textOf(tree.root.findByProps({ testID: 'ip-guard' }))).toBe('MATCH');
    expect(textOf(tree.root.findByProps({ testID: 'detected-ip' }))).toBe('49.36.10.200');
    act(() => tree.unmount());

    respond({ primaryIP: '1.2.3.4' });
    tree = await mount();
    expect(textOf(tree.root.findByProps({ testID: 'ip-guard' }))).toBe('MISMATCH');
    act(() => tree.unmount());
  });

  test('whitelisting needs the acknowledgement and a strict biometric pass before calling Dhan', async () => {
    respond({});
    const strict = jest.spyOn(secureVault, 'authenticateStrict').mockResolvedValue(false);
    const tree = await mount();
    expect(textOf(tree.root.findByProps({ testID: 'ip-guard' }))).toBe('NOT WHITELISTED');

    await act(async () => tree.root.findByProps({ testID: 'whitelist-PRIMARY' }).props.onPress());
    const confirm = () => tree.root.findByProps({ testID: 'ip-confirm' });
    expect(confirm().props.disabled).toBe(true);
    act(() => tree.root.findByProps({ testID: 'ip-ack' }).props.onValueChange(true));
    expect(confirm().props.disabled).toBe(false);

    await act(async () => confirm().props.onPress());
    expect(strict).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('setIP'))).toBe(false);

    strict.mockResolvedValue(true);
    await act(async () => tree.root.findByProps({ testID: 'whitelist-PRIMARY' }).props.onPress());
    act(() => tree.root.findByProps({ testID: 'ip-ack' }).props.onValueChange(true));
    await act(async () => confirm().props.onPress());
    await flush();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('setIP'))).toBe(true);
    act(() => tree.unmount());
  });
});
