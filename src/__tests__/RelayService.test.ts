import { createHash, createPublicKey, verify } from 'crypto';

jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(require('crypto').randomBytes(n)) }));
jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: { getEffectiveCredentials: jest.fn(async () => ({ clientId: '1100012345', token: 'eyJ.tok.en' })) },
}));

import {
  RelayService,
  canonicalString,
  fromBase64,
  normalizeRelayUrl,
  toBase64,
  utf8,
  type KeyValueStore,
} from '../services/relay/RelayService';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

const res = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body });

/** Verifies a request the way the relay does, using Node's Ed25519 and the relay's canonical string. */
function verifiesAtRelay(publicKeyB64: string, headers: Record<string, string>, method: string, url: string, body = ''): boolean {
  const canonical = `v1\n${headers['x-relay-ts']}\n${headers['x-relay-nonce']}\n${method}\n${url}\n${createHash('sha256').update(body).digest('hex')}`;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(canonical), key, Buffer.from(headers['x-relay-sig'], 'base64'));
}

describe('encoding helpers', () => {
  test('base64 round-trips and matches Buffer', () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = new Uint8Array(require('crypto').randomBytes(len));
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  test('utf8 matches Buffer for ASCII, accented text, and emoji', () => {
    for (const s of ['', 'abc', 'caf\u00e9', '\u20b9 100', 'a\ud83d\ude80b']) {
      expect(Array.from(utf8(s))).toEqual(Array.from(Buffer.from(s, 'utf8')));
    }
  });

  test('canonicalString has the fields in the order the relay expects', () => {
    const body = '{"a":1}';
    expect(canonicalString({ ts: '1', nonce: 'n', method: 'post', url: '/dhan/v2/orders', body })).toBe(
      `v1\n1\nn\nPOST\n/dhan/v2/orders\n${createHash('sha256').update(body).digest('hex')}`
    );
  });

  test('normalizeRelayUrl accepts https origins and local http only', () => {
    expect(normalizeRelayUrl(' https://Relay.Example.com/ ')).toBe('https://relay.example.com');
    expect(normalizeRelayUrl('https://relay.example.com:8443')).toBe('https://relay.example.com:8443');
    expect(normalizeRelayUrl('http://10.0.2.2:8787')).toBe('http://10.0.2.2:8787');
    expect(normalizeRelayUrl('http://relay.example.com')).toBeNull();
    expect(normalizeRelayUrl('https://relay.example.com/path')).toBeNull();
    expect(normalizeRelayUrl('relay.example.com')).toBeNull();
  });
});

describe('RelayService', () => {
  const makeService = (fetchImpl: jest.Mock, store = memoryStore()) =>
    new RelayService(store, (n) => new Uint8Array(require('crypto').randomBytes(n)), () => 1_800_000_000_000, fetchImpl);

  test('registers with the invite, stores the key, and signs requests the relay can verify', async () => {
    const fetchMock = jest.fn(async () => res(200, { deviceId: 'd_abc', egressIp: '203.0.113.7' }));
    const store = memoryStore();
    const svc = makeService(fetchMock, store);

    const out = await svc.register({ url: 'https://relay.example.com', inviteCode: 'aaaa-bbbb', dhanClientId: '1100012345' });
    expect(out).toEqual({ ok: true, deviceId: 'd_abc', egressIp: '203.0.113.7' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('https://relay.example.com/v1/register');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ inviteCode: 'aaaa-bbbb', dhanClientId: '1100012345' });
    expect(Buffer.from(sent.publicKey, 'base64')).toHaveLength(32);
    expect(store.data.get('QSTRATEGY_RELAY_DEVICE_ID')).toBe('d_abc');

    const route = await svc.route();
    expect(route!.baseUrl).toBe('https://relay.example.com/dhan/v2');
    const body = JSON.stringify({ correlationId: 'QS-1', quantity: 75 });
    const headers = await route!.signer('POST', '/orders', body);
    expect(headers['x-relay-device']).toBe('d_abc');
    expect(verifiesAtRelay(sent.publicKey, headers, 'POST', '/dhan/v2/orders', body)).toBe(true);
    expect(verifiesAtRelay(sent.publicKey, headers, 'POST', '/dhan/v2/orders', body + ' ')).toBe(false);
  });

  test('a new service instance reads the saved registration', async () => {
    const store = memoryStore();
    await makeService(jest.fn(async () => res(200, { deviceId: 'd_1' })), store).register({
      url: 'https://relay.example.com',
      inviteCode: 'x',
      dhanClientId: '1100012345',
    });
    const again = makeService(jest.fn(), store);
    expect(await again.getConfig()).toEqual({ url: 'https://relay.example.com', deviceId: 'd_1' });
  });

  test('reports a refused invite and saves nothing', async () => {
    const store = memoryStore();
    const svc = makeService(jest.fn(async () => res(403, { errorCode: 'RLY-INVITE', errorMessage: 'The invite code is invalid.' })), store);
    const out = await svc.register({ url: 'https://relay.example.com', inviteCode: 'bad', dhanClientId: '1100012345' });
    expect(out).toEqual({ ok: false, error: 'The invite code is invalid. (RLY-INVITE)' });
    expect(store.data.size).toBe(0);
    expect(await svc.route()).toBeNull();
  });

  test('is not configured by default, so orders keep going straight to Dhan', async () => {
    const svc = makeService(jest.fn());
    expect(await svc.route()).toBeNull();
    expect(await svc.checkEgress()).toBeNull();
    expect(await svc.preflight()).toEqual({ configured: false });
  });

  test('preflight allows a matching relay IP and explains every refusal', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(res(200, { deviceId: 'd_1' }));
    const svc = makeService(fetchMock);
    await svc.register({ url: 'https://relay.example.com', inviteCode: 'x', dhanClientId: '1100012345' });

    fetchMock.mockResolvedValueOnce(res(200, { egressIp: '203.0.113.7', dhan: { primaryIP: '203.0.113.7' }, match: true }));
    expect(await svc.preflight()).toEqual({ configured: true, problem: null });

    fetchMock.mockResolvedValueOnce(res(200, { egressIp: '203.0.113.7', dhan: { primaryIP: '198.51.100.1' }, match: false }));
    expect(((await svc.preflight()) as any).problem).toContain('not the IP whitelisted');

    fetchMock.mockResolvedValueOnce(res(200, { egressIp: '203.0.113.7', dhan: { primaryIP: null, secondaryIP: null }, match: false }));
    expect(((await svc.preflight()) as any).problem).toContain('No IP is whitelisted');

    fetchMock.mockResolvedValueOnce(res(200, { egressIp: '203.0.113.7', dhan: null, match: null }));
    expect(((await svc.preflight()) as any).problem).toContain('Could not read the Dhan IP whitelist');

    fetchMock.mockResolvedValueOnce(res(403, { errorCode: 'RLY-AUTH', errorMessage: 'Request signature is not valid.' }));
    expect(((await svc.preflight()) as any).problem).toContain('Could not check the order relay');
  });

  test('disconnect removes the registration', async () => {
    const store = memoryStore();
    const svc = makeService(jest.fn(async () => res(200, { deviceId: 'd_1' })), store);
    await svc.register({ url: 'https://relay.example.com', inviteCode: 'x', dhanClientId: '1100012345' });
    await svc.disconnect();
    expect(store.data.size).toBe(0);
    expect(await svc.route()).toBeNull();
  });
});
