import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { RelayCard } from '../components/settings/RelayCard';
import { OrderExecutionCard } from '../components/settings/OrderExecutionCard';
import { relayService } from '../services/relay/RelayService';
import { secureVault } from '../services/SecureCredentialVault';

const textOf = (node: renderer.ReactTestInstance) => {
  const c = node.props.children;
  return Array.isArray(c) ? c.join('') : String(c ?? '');
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const CONFIG = { url: 'https://relay.example.com', deviceId: 'd_abc' };

beforeEach(() => {
  jest.spyOn(secureVault, 'getEffectiveCredentials').mockResolvedValue({
    clientId: '1100345678',
    token: 'tok',
    tabId: '1',
    isStreamerEnabled: true,
  });
});
afterEach(() => jest.restoreAllMocks());

async function mount(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(element);
  });
  await flush();
  return tree;
}

describe('RelayCard', () => {
  test('registers with the typed address and invite, using the saved Dhan client id', async () => {
    jest.spyOn(relayService, 'getConfig').mockResolvedValueOnce(null).mockResolvedValue(CONFIG);
    const register = jest.spyOn(relayService, 'register').mockResolvedValue({ ok: true, deviceId: 'd_abc', egressIp: '203.0.113.7' });
    const tree = await mount(<RelayCard />);

    act(() => tree.root.findByProps({ testID: 'relay-url-input' }).props.onChangeText('https://relay.example.com'));
    act(() => tree.root.findByProps({ testID: 'relay-invite-input' }).props.onChangeText('aaaa-bbbb'));
    await act(async () => tree.root.findByProps({ testID: 'relay-connect' }).props.onPress());
    await flush();

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://relay.example.com', inviteCode: 'aaaa-bbbb', dhanClientId: '1100345678' }));
    expect(textOf(tree.root.findByProps({ testID: 'relay-url' }))).toBe('https://relay.example.com');
    act(() => tree.unmount());
  });

  test('shows the relay error and stays on the form when registration is refused', async () => {
    jest.spyOn(relayService, 'getConfig').mockResolvedValue(null);
    jest.spyOn(relayService, 'register').mockResolvedValue({ ok: false, error: 'The invite code is invalid, expired or already used. (RLY-INVITE)' });
    const tree = await mount(<RelayCard />);

    await act(async () => tree.root.findByProps({ testID: 'relay-connect' }).props.onPress());
    await flush();

    expect(JSON.stringify(tree.toJSON())).toContain('RLY-INVITE');
    expect(tree.root.findAllByProps({ testID: 'relay-url' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('checks the relay IP and disconnects back to the form', async () => {
    jest.spyOn(relayService, 'getConfig').mockResolvedValue(CONFIG);
    jest.spyOn(relayService, 'checkEgress').mockResolvedValue({ ok: true, egressIp: '203.0.113.7', dhan: { primaryIP: '203.0.113.7', secondaryIP: null }, match: true });
    const disconnect = jest.spyOn(relayService, 'disconnect').mockResolvedValue();
    const tree = await mount(<RelayCard />);

    await act(async () => tree.root.findByProps({ testID: 'relay-check' }).props.onPress());
    await flush();
    expect(JSON.stringify(tree.toJSON())).toContain('203.0.113.7');
    expect(JSON.stringify(tree.toJSON())).toContain('whitelisted');

    await act(async () => tree.root.findByProps({ testID: 'relay-disconnect' }).props.onPress());
    await flush();
    expect(disconnect).toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'relay-connect' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});

describe('OrderExecutionCard with an order relay', () => {
  test('shows and compares the relay IP instead of the phone IP', async () => {
    const fetchMock = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('getIP') ? { primaryIP: '203.0.113.7' } : { ip: '49.36.10.200' }),
      text: async () => '',
    }));
    (global as any).fetch = fetchMock;
    jest.spyOn(relayService, 'checkEgress').mockResolvedValue({ ok: true, egressIp: '203.0.113.7', dhan: null, match: null });

    const tree = await mount(<OrderExecutionCard />);
    expect(textOf(tree.root.findByProps({ testID: 'detected-ip' }))).toBe('203.0.113.7');
    expect(textOf(tree.root.findByProps({ testID: 'ip-guard' }))).toBe('MATCH');
    expect(JSON.stringify(tree.toJSON())).toContain('Order relay IP');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('ipify'))).toBe(false);
    act(() => tree.unmount());
  });
});
