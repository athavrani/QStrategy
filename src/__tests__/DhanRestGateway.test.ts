import { DhanRestGateway } from '../services/dhan/DhanRestGateway';

const CREDS = { clientId: '1100345678', token: 'tok' };

function ok(data: any, status = 200) {
  return { ok: true, status, json: async () => data };
}

function setup(overrides: Record<string, any> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const fetchImpl = jest.fn(async (_url: string, _init: any) => ok({ data: { v: 1 } }));
  const gw = new DhanRestGateway({
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...overrides,
  });
  return { gw, fetchImpl, sleeps, advance: (ms: number) => (clock += ms) };
}

describe('DhanRestGateway', () => {
  test('sends auth headers and JSON body to the v2 endpoint', async () => {
    const { gw, fetchImpl } = setup();
    const res = await gw.post('/marketfeed/ltp', { NSE_EQ: [1333] }, CREDS);

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ data: { v: 1 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.dhan.co/v2/marketfeed/ltp');
    expect(init.headers['access-token']).toBe('tok');
    expect(init.headers['client-id']).toBe('1100345678');
    expect(JSON.parse(init.body)).toEqual({ NSE_EQ: [1333] });
  });

  test('collapses concurrent identical requests into one network call', async () => {
    const { gw, fetchImpl } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => gw.post('/marketfeed/ohlc', { IDX_I: [13, 25] }, CREDS))
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test('serves repeat calls from cache within the TTL and refetches after it', async () => {
    const { gw, fetchImpl, advance } = setup();
    await gw.post('/optionchain', { Expiry: 'x' }, CREDS);
    const cached = await gw.post('/optionchain', { Expiry: 'x' }, CREDS);
    expect(cached.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    advance(3001);
    await gw.post('/optionchain', { Expiry: 'x' }, CREDS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('does not cache failures and separates different bodies and clients', async () => {
    const { gw, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' } as any);

    const bad = await gw.post('/marketfeed/ltp', { a: 1 }, CREDS);
    expect(bad.ok).toBe(false);
    expect(bad.errorText).toBe('boom');

    await gw.post('/marketfeed/ltp', { a: 1 }, CREDS);
    await gw.post('/marketfeed/ltp', { a: 2 }, CREDS);
    await gw.post('/marketfeed/ltp', { a: 2 }, { clientId: 'other', token: 't' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('paces requests in the same group but not across groups', async () => {
    const { gw, sleeps } = setup();
    await gw.post('/marketfeed/ltp', { a: 1 }, CREDS);
    await gw.post('/marketfeed/quote', { a: 2 }, CREDS);
    expect(sleeps).toEqual([1000]);

    await gw.post('/optionchain', { a: 3 }, CREDS);
    expect(sleeps).toEqual([1000]);
  });

  test('noCache bypasses cache and single-flight', async () => {
    const { gw, fetchImpl } = setup();
    await Promise.all([
      gw.post('/marketfeed/ltp', { a: 1 }, CREDS, { noCache: true }),
      gw.post('/marketfeed/ltp', { a: 1 }, CREDS, { noCache: true }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('propagates network errors and releases the in-flight slot', async () => {
    const { gw, fetchImpl } = setup();
    fetchImpl.mockRejectedValueOnce(new Error('Connection reset'));
    await expect(gw.post('/charts/intraday', { a: 1 }, CREDS)).rejects.toThrow('Connection reset');
    const retry = await gw.post('/charts/intraday', { a: 1 }, CREDS);
    expect(retry.ok).toBe(true);
  });

  test('aborts requests that exceed the timeout', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const gw = new DhanRestGateway({ fetchImpl: fetchImpl as any, pacing: false });
    await expect(gw.post('/charts/intraday', {}, CREDS, { timeoutMs: 30 })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test('disabled pacing and cache behave like a plain client', async () => {
    const { gw, fetchImpl, sleeps } = setup({ pacing: false, cache: false });
    await gw.post('/marketfeed/ltp', { a: 1 }, CREDS);
    await gw.post('/marketfeed/ltp', { a: 1 }, CREDS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([]);
  });
});
