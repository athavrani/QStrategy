import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { RelayDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { UpstreamError, type Upstream, type UpstreamRequest, type UpstreamResponse } from '../src/upstream.js';
import { isSafeTarget, matchRoute } from '../src/policy.js';

const CLIENT = '1100012345';
const TOKEN = 'eyJ.token.value';
const NOW = 1_800_000_000_000;

class FakeUpstream implements Upstream {
  calls: UpstreamRequest[] = [];
  handler: (req: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse> = () => json(200, {});
  async forward(req: UpstreamRequest) {
    this.calls.push(req);
    return this.handler(req);
  }
  async egressIp() {
    return '203.0.113.7';
  }
  cachedEgressIp() {
    return '203.0.113.7';
  }
}

const json = (status: number, body: unknown): UpstreamResponse => ({
  status,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(body)),
});

function rawPublicKey(key: KeyObject): string {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const db = new RelayDb(':memory:');
  const upstream = new FakeUpstream();
  let now = NOW;
  const app = buildApp({ config: loadConfig(env), db, upstream, now: () => now, sleep: async () => {} });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const invite = () => db.createInvite({ hours: 1, now });
  const register = async (code = invite(), clientId = CLIENT, key = publicKey) =>
    app.inject({
      method: 'POST',
      url: '/v1/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ inviteCode: code, publicKey: rawPublicKey(key), dhanClientId: clientId, label: 'Test' }),
    });

  const call = async (
    deviceId: string,
    method: string,
    url: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; ts?: number; nonce?: string; key?: KeyObject } = {}
  ) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const ts = String(opts.ts ?? now);
    const nonce = opts.nonce ?? randomBytes(12).toString('hex');
    const canonical = `v1\n${ts}\n${nonce}\n${method}\n${url}\n${createHash('sha256').update(payload).digest('hex')}`;
    const signature = sign(null, Buffer.from(canonical), opts.key ?? privateKey).toString('base64');
    return app.inject({
      method: method as any,
      url,
      payload: payload || undefined,
      headers: {
        'content-type': 'application/json',
        'access-token': TOKEN,
        'client-id': CLIENT,
        dhanClientId: CLIENT,
        'x-relay-device': deviceId,
        'x-relay-ts': ts,
        'x-relay-nonce': nonce,
        'x-relay-sig': signature,
        ...opts.headers,
      },
    });
  };

  return { app, db, upstream, register, call, privateKey, setNow: (n: number) => (now = n), invite };
}

const order = (correlationId = 'QS-abc-1') => ({
  correlationId,
  transactionType: 'BUY',
  exchangeSegment: 'NSE_FNO',
  productType: 'INTRADAY',
  orderType: 'LIMIT',
  validity: 'DAY',
  securityId: '12345',
  quantity: 75,
  price: 100,
});

describe('registration', () => {
  it('registers a device with a valid invite and refuses a reused or unknown one', async () => {
    const s = setup();
    const code = s.invite();
    const ok = await s.register(code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().deviceId).toMatch(/^d_/);
    expect((await s.register(code)).statusCode).toBe(403);
    expect((await s.register('0000-0000-0000-0000-0000-0000-0000-0000')).statusCode).toBe(403);
  });

  it('rejects an invite locked to another Dhan account', async () => {
    const s = setup();
    const code = s.db.createInvite({ hours: 1, now: NOW, dhanClientId: '999999999' });
    const res = await s.register(code);
    expect(res.statusCode).toBe(403);
    expect(res.json().errorMessage).toContain('different Dhan account');
  });

  it('stops at the configured number of Dhan accounts but still adds devices to existing ones', async () => {
    const s = setup({ MAX_ACCOUNTS: '2' });
    expect((await s.register(s.invite(), '1100000001')).statusCode).toBe(200);
    expect((await s.register(s.invite(), '1100000002')).statusCode).toBe(200);
    const third = await s.register(s.invite(), '1100000003');
    expect(third.statusCode).toBe(403);
    expect(third.json().errorMessage).toContain('already serves 2 Dhan accounts');
    expect((await s.register(s.invite(), '1100000002')).statusCode).toBe(200);
  });

  it('rejects a malformed public key', async () => {
    const s = setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ inviteCode: s.invite(), publicKey: 'AAAA', dhanClientId: CLIENT }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('request authentication', () => {
  let s: ReturnType<typeof setup>;
  let deviceId: string;
  beforeEach(async () => {
    s = setup();
    deviceId = (await s.register()).json().deviceId;
  });

  it('refuses a request without signature headers', async () => {
    const res = await s.app.inject({ method: 'GET', url: '/dhan/v2/orders', headers: { 'access-token': TOKEN, 'client-id': CLIENT } });
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('RLY-AUTH');
  });

  it('refuses a signature made with another key', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const res = await s.call(deviceId, 'GET', '/dhan/v2/orders', undefined, { key: other });
    expect(res.statusCode).toBe(403);
    expect(s.upstream.calls).toHaveLength(0);
  });

  it('refuses a tampered body', async () => {
    const payload = JSON.stringify(order());
    const ts = String(NOW);
    const nonce = randomBytes(12).toString('hex');
    const canonical = `v1\n${ts}\n${nonce}\nPOST\n/dhan/v2/orders\n${createHash('sha256').update(payload).digest('hex')}`;
    const res = await s.app.inject({
      method: 'POST',
      url: '/dhan/v2/orders',
      payload: payload.replace('75', '7500'),
      headers: {
        'content-type': 'application/json',
        'access-token': TOKEN,
        'client-id': CLIENT,
        'x-relay-device': deviceId,
        'x-relay-ts': ts,
        'x-relay-nonce': nonce,
        'x-relay-sig': sign(null, Buffer.from(canonical), s.privateKey).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a replayed nonce and a stale timestamp', async () => {
    const nonce = 'a'.repeat(24);
    expect((await s.call(deviceId, 'GET', '/dhan/v2/orders', undefined, { nonce })).statusCode).toBe(200);
    const replay = await s.call(deviceId, 'GET', '/dhan/v2/orders', undefined, { nonce });
    expect(replay.json().errorCode).toBe('RLY-REPLAY');
    const stale = await s.call(deviceId, 'GET', '/dhan/v2/orders', undefined, { ts: NOW - 120_000 });
    expect(stale.json().errorCode).toBe('RLY-CLOCK');
  });

  it('refuses revoked devices and suspended accounts', async () => {
    s.db.setDeviceStatus(deviceId, 'revoked');
    expect((await s.call(deviceId, 'GET', '/dhan/v2/orders')).statusCode).toBe(403);
    s.db.setDeviceStatus(deviceId, 'active');
    s.db.setTenantStatus(CLIENT, 'suspended');
    expect((await s.call(deviceId, 'GET', '/dhan/v2/orders')).json().errorCode).toBe('RLY-SUSPENDED');
  });
});

describe('proxying', () => {
  let s: ReturnType<typeof setup>;
  let deviceId: string;
  beforeEach(async () => {
    s = setup();
    deviceId = (await s.register()).json().deviceId;
  });

  it('forwards an order with only the allowed headers and returns Dhan\'s answer plus relay headers', async () => {
    s.upstream.handler = () => json(200, { orderId: '112', orderStatus: 'TRANSIT' });
    const res = await s.call(deviceId, 'POST', '/dhan/v2/orders', order());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orderId: '112', orderStatus: 'TRANSIT' });
    expect(res.headers['x-relay-egress-ip']).toBe('203.0.113.7');
    expect(res.headers['x-relay-request-id']).toBeTruthy();

    const sent = s.upstream.calls[0];
    expect(sent.path).toBe('/orders');
    expect(sent.headers['access-token']).toBe(TOKEN);
    expect(Object.keys(sent.headers).sort()).toEqual(['access-token', 'accept', 'client-id', 'content-type', 'dhanClientId'].sort());
    expect(JSON.parse(sent.body!.toString()).dhanClientId).toBe(CLIENT);
  });

  it('passes Dhan error responses through unchanged', async () => {
    s.upstream.handler = () => json(400, { errorType: 'Order_Error', errorCode: 'DH-906', errorMessage: 'Market is Closed!' });
    const res = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-rej-1'));
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('DH-906');
  });

  it('refuses a different client id in the header or the body', async () => {
    const header = await s.call(deviceId, 'GET', '/dhan/v2/orders', undefined, { headers: { 'client-id': '999999999' } });
    expect(header.json().errorCode).toBe('RLY-CLIENT');
    const body = await s.call(deviceId, 'POST', '/dhan/v2/orders', { ...order(), dhanClientId: '999999999' });
    expect(body.json().errorCode).toBe('RLY-CLIENT');
    expect(s.upstream.calls).toHaveLength(0);
  });

  it('refuses endpoints outside the allowlist', async () => {
    for (const [method, url] of [
      ['GET', '/dhan/v2/ip/getIP'],
      ['POST', '/dhan/v2/marketfeed/ltp'],
      ['GET', '/dhan/v2/orders/../ledger'],
      ['DELETE', '/dhan/v2/orders'],
    ] as const) {
      const res = await s.call(deviceId, method, url);
      expect(res.statusCode, url).toBe(403);
    }
    expect(s.upstream.calls).toHaveLength(0);
  });

  it('answers a repeated order from the stored result without calling Dhan again', async () => {
    s.upstream.handler = () => json(200, { orderId: '500', orderStatus: 'PENDING' });
    const first = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-dup-1'));
    const second = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-dup-1'));
    expect(second.json()).toEqual(first.json());
    expect(second.headers['x-relay-note']).toBe('replay');
    expect(s.upstream.calls).toHaveLength(1);

    const changed = await s.call(deviceId, 'POST', '/dhan/v2/orders', { ...order('QS-dup-1'), quantity: 150 });
    expect(changed.statusCode).toBe(409);
    expect(s.upstream.calls).toHaveLength(1);
  });

  it('does not keep a refused order, so it can be sent again', async () => {
    s.upstream.handler = () => json(400, { errorCode: 'DH-905', errorMessage: 'bad' });
    await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-retry-1'));
    s.upstream.handler = () => json(200, { orderId: '9', orderStatus: 'TRANSIT' });
    const res = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-retry-1'));
    expect(res.statusCode).toBe(200);
    expect(s.upstream.calls).toHaveLength(2);
  });

  it('recovers an order after a timeout by looking it up by correlation id', async () => {
    s.upstream.handler = (req) => {
      if (req.method === 'POST') throw new UpstreamError('timeout', 'timed out');
      return json(200, { orderId: '777', orderStatus: 'PENDING', correlationId: 'QS-rec-1' });
    };
    const res = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-rec-1'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orderId: '777', orderStatus: 'PENDING' });
    expect(res.headers['x-relay-note']).toBe('recovered');
    expect(s.upstream.calls[1].path).toBe('/orders/external/QS-rec-1');
  });

  it('reports an unknown outcome as 504 and checks Dhan before sending the same order again', async () => {
    s.upstream.handler = () => {
      throw new UpstreamError('timeout', 'timed out');
    };
    const first = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-unk-1'));
    expect(first.statusCode).toBe(504);
    expect(first.json().errorCode).toBe('RLY-UPSTREAM-TIMEOUT');

    s.upstream.calls.length = 0;
    s.upstream.handler = (req) =>
      req.method === 'GET' ? json(200, { orderId: '888', orderStatus: 'TRADED' }) : json(500, {});
    const second = await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-unk-1'));
    expect(second.json().orderId).toBe('888');
    expect(s.upstream.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('limits one account to its own rate', async () => {
    let limited = 0;
    for (let i = 0; i < 30; i++) {
      const res = await s.call(deviceId, 'GET', '/dhan/v2/orders');
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('quantity limit', () => {
  it('refuses orders above the configured limit and allows those within it', async () => {
    const s = setup({ MAX_ORDER_QUANTITY: '100' });
    const deviceId = (await s.register()).json().deviceId;
    s.upstream.handler = () => json(200, { orderId: '1', orderStatus: 'TRANSIT' });

    const tooBig = await s.call(deviceId, 'POST', '/dhan/v2/orders', { ...order('QS-big-1'), quantity: 150 });
    expect(tooBig.statusCode).toBe(403);
    expect(tooBig.json().errorCode).toBe('RLY-LIMIT');
    expect(s.upstream.calls).toHaveLength(0);

    const ok = await s.call(deviceId, 'POST', '/dhan/v2/orders', { ...order('QS-ok-1'), quantity: 100 });
    expect(ok.statusCode).toBe(200);
  });

  it('has no limit by default', async () => {
    const s = setup();
    const deviceId = (await s.register()).json().deviceId;
    const res = await s.call(deviceId, 'POST', '/dhan/v2/orders', { ...order('QS-nolimit-1'), quantity: 100000 });
    expect(res.statusCode).toBe(200);
  });
});

describe('audit', () => {
  it('records proxied calls without tokens or bodies', async () => {
    const s = setup();
    const deviceId = (await s.register()).json().deviceId;
    await s.call(deviceId, 'POST', '/dhan/v2/orders', order('QS-aud-1'));
    const rows = s.db.recentAudit(10, CLIENT);
    expect(rows[0]).toMatchObject({ method: 'POST', path: '/orders', status: 200, device_id: deviceId });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});

describe('egress check', () => {
  it('reports the egress IP and whether it matches the whitelist', async () => {
    const s = setup();
    const deviceId = (await s.register()).json().deviceId;
    s.upstream.handler = () => json(200, { primaryIP: '203.0.113.7', secondaryIP: '' });
    const res = await s.call(deviceId, 'GET', '/v1/egress');
    expect(res.json()).toMatchObject({ egressIp: '203.0.113.7', match: true, dhanClientId: CLIENT });

    s.upstream.handler = () => json(200, { primaryIP: '198.51.100.1', secondaryIP: '' });
    expect((await s.call(deviceId, 'GET', '/v1/egress')).json().match).toBe(false);
  });
});

describe('policy', () => {
  it('knows which routes change state', () => {
    expect(matchRoute('POST', '/orders')).toEqual({ write: true, idempotent: true });
    expect(matchRoute('GET', '/orders/external/QS-1')).toEqual({ write: false, idempotent: false });
    expect(matchRoute('DELETE', '/super/orders/123/TARGET_LEG')?.write).toBe(true);
    expect(matchRoute('GET', '/ledger')).toBeNull();
  });

  it('rejects unsafe targets', () => {
    expect(isSafeTarget('/orders', '')).toBe(true);
    expect(isSafeTarget('/killswitch', '?killSwitchStatus=ACTIVATE')).toBe(true);
    expect(isSafeTarget('//evil.com/x', '')).toBe(false);
    expect(isSafeTarget('/orders/%2e%2e', '')).toBe(false);
    expect(isSafeTarget('/orders', '?a=b c')).toBe(false);
  });
});
