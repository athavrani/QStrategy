import {
  DhanOrderClient,
  generateCorrelationId,
  normalizeOrder,
  validateOrderRequest,
  type OrderRequest,
} from '../services/dhan/DhanOrderClient';
import { ORDER_ENVIRONMENTS_ENABLED } from '../config/orderConfig';

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getSandboxCredentials: jest.fn(async () => ({ clientId: '2000000001', token: 'sandbox-token' })),
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '1100345678', token: 'live-token' })),
    updateTelemetry: jest.fn(),
  },
}));
import { secureVault } from '../services/SecureCredentialVault';

const res = (data: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

const LIMIT: OrderRequest = {
  transactionType: 'BUY',
  exchangeSegment: 'NSE_EQ',
  productType: 'INTRADAY',
  orderType: 'LIMIT',
  validity: 'DAY',
  securityId: '1333',
  quantity: 5,
  price: 1500.5,
};

const bookRow = (over: any = {}) => ({
  orderId: '112111182198',
  correlationId: 'QS-test',
  orderStatus: 'PENDING',
  transactionType: 'BUY',
  exchangeSegment: 'NSE_EQ',
  productType: 'INTRADAY',
  orderType: 'LIMIT',
  validity: 'DAY',
  securityId: '1333',
  tradingSymbol: 'HDFCBANK',
  quantity: 5,
  price: 1500.5,
  triggerPrice: 0,
  filledQty: 0,
  remainingQuantity: 5,
  averageTradedPrice: 0,
  createTime: '2026-10-23 10:00:00',
  ...over,
});

describe('validateOrderRequest', () => {
  test('accepts a well formed limit order', () => {
    expect(validateOrderRequest(LIMIT)).toBeNull();
  });

  test('rejects bad quantity, security id, missing price or trigger, and bad correlation ids', () => {
    expect(validateOrderRequest({ ...LIMIT, quantity: 0 })).toMatch(/Quantity/);
    expect(validateOrderRequest({ ...LIMIT, quantity: 1.5 })).toMatch(/Quantity/);
    expect(validateOrderRequest({ ...LIMIT, securityId: 'abc' })).toMatch(/Security ID/);
    expect(validateOrderRequest({ ...LIMIT, price: undefined })).toMatch(/price/);
    expect(validateOrderRequest({ ...LIMIT, orderType: 'STOP_LOSS', triggerPrice: undefined })).toMatch(/trigger/);
    expect(validateOrderRequest({ ...LIMIT, orderType: 'MARKET', price: 10 })).toMatch(/Market/);
    expect(validateOrderRequest({ ...LIMIT, orderType: 'MARKET', price: undefined })).toBeNull();
    expect(validateOrderRequest({ ...LIMIT, correlationId: 'bad id!' })).toMatch(/Correlation/);
    expect(validateOrderRequest({ ...LIMIT, correlationId: 'x'.repeat(31) })).toMatch(/Correlation/);
  });

  test('generated correlation ids fit Dhan limits and are unique', () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a).toMatch(/^[a-zA-Z0-9_.-]{1,30}$/);
    expect(a).not.toBe(b);
  });
});

describe('parseDhanError', () => {
  const { parseDhanError } = require('../services/dhan/dhanErrors');
  const body = (obj: any) => ({ status: 400, errorText: JSON.stringify(obj) });

  test('reads the current, snake_case and nested remarks error shapes', () => {
    expect(parseDhanError(body({ errorCode: 'DH-906', errorMessage: 'Bad order' }))).toEqual({ message: 'Bad order (HTTP 400)', code: 'DH-906' });
    expect(parseDhanError(body({ error_code: 'DH-905', error_message: 'Missing field' }))).toEqual({ message: 'Missing field (HTTP 400)', code: 'DH-905' });
    expect(
      parseDhanError(body({ status: 'failure', remarks: { error_code: 'DH-906', error_type: 'Order_Error', error_message: 'Order in transit cannot be cancelled' } }))
    ).toEqual({ message: 'Order in transit cannot be cancelled (HTTP 400)', code: 'DH-906' });
    expect(parseDhanError(body({ remarks: 'plain remark' })).message).toBe('plain remark (HTTP 400)');
  });

  test('falls back to the raw body, the status, and the token message', () => {
    expect(parseDhanError({ status: 400, errorText: 'oops' }).message).toBe('oops (HTTP 400)');
    expect(parseDhanError(body({ unexpected: true })).message).toContain('unexpected');
    expect(parseDhanError({ status: 502, errorText: '' }).message).toBe('Dhan returned HTTP 502.');
    expect(parseDhanError({ status: 401, errorText: '' }).code).toBe('DH-901');
  });
});

describe('normalizeOrder', () => {
  test('maps Dhan fields and tolerates missing ones', () => {
    const o = normalizeOrder(bookRow({ omsErrorCode: '16', omsErrorDescription: 'RMS rejected' }));
    expect(o).toMatchObject({ orderId: '112111182198', status: 'PENDING', quantity: 5, price: 1500.5, errorMessage: 'RMS rejected' });
    expect(normalizeOrder({})).toMatchObject({ orderId: '', status: 'UNKNOWN', quantity: 0, correlationId: null });
  });
});

describe('DhanOrderClient (sandbox)', () => {
  const fetchMock = jest.fn();
  const sleep = jest.fn(async () => {});
  const client = new DhanOrderClient('SANDBOX', { sleep, lookupDelayMs: 0, lookupAttempts: 2 });

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
    (global as any).fetch = fetchMock;
  });

  test('places an order on the sandbox URL with sandbox credentials and a full body', async () => {
    fetchMock.mockResolvedValue(res({ orderId: '777', orderStatus: 'TRANSIT' }));
    const out = await client.placeOrder({ ...LIMIT, correlationId: 'QS-abc' });

    expect(out).toEqual({ kind: 'PLACED', orderId: '777', status: 'TRANSIT', correlationId: 'QS-abc' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sandbox.dhan.co/v2/orders');
    expect(init.method).toBe('POST');
    expect(init.headers['access-token']).toBe('sandbox-token');
    expect(JSON.parse(init.body)).toEqual({
      dhanClientId: '2000000001',
      correlationId: 'QS-abc',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_EQ',
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: '1333',
      quantity: 5,
      price: 1500.5,
    });
  });

  test('an invalid request never reaches the network', async () => {
    const out = await client.placeOrder({ ...LIMIT, quantity: 0 });
    expect(out.kind).toBe('REJECTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a 4xx answer is a definite rejection carrying Dhan message and code', async () => {
    fetchMock.mockResolvedValue(res({ errorType: 'Order_Error', errorCode: 'DH-906', errorMessage: 'Market is Closed!' }, 400));
    const out = await client.placeOrder(LIMIT);
    expect(out).toMatchObject({ kind: 'REJECTED', code: 'DH-906', error: 'Market is Closed! (HTTP 400)' });
  });

  test('a timeout is UNKNOWN and the POST is never retried', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const out = await client.placeOrder({ ...LIMIT, correlationId: 'QS-t1' });
    expect(out).toEqual({ kind: 'UNKNOWN', error: 'Request timed out.', correlationId: 'QS-t1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a server error is treated as unknown rather than rejected', async () => {
    fetchMock.mockResolvedValue(res({ errorCode: 'DH-908', errorMessage: 'Internal error' }, 500));
    const out = await client.placeOrder(LIMIT);
    expect(out.kind).toBe('UNKNOWN');
  });

  test('placeAndConfirm finds an order that was placed despite a timeout, using only GET look-ups', async () => {
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init.method === 'POST') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return res(bookRow({ orderId: '555', correlationId: 'QS-t2' }));
    });
    const out = await client.placeAndConfirm({ ...LIMIT, correlationId: 'QS-t2' });

    expect(out).toEqual({ kind: 'PLACED', orderId: '555', status: 'PENDING', correlationId: 'QS-t2' });
    const methods = fetchMock.mock.calls.map((c) => c[1].method);
    expect(methods.filter((m) => m === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toBe('https://sandbox.dhan.co/v2/orders/external/QS-t2');
  });

  test('placeAndConfirm stays UNKNOWN when the look-ups find nothing', async () => {
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init.method === 'POST') throw new Error('offline');
      return res({}, 404);
    });
    const out = await client.placeAndConfirm({ ...LIMIT, correlationId: 'QS-t3' });
    expect(out.kind).toBe('UNKNOWN');
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'GET')).toHaveLength(2);
  });

  test('cancels with DELETE, modifies with PUT, and reports failures', async () => {
    fetchMock.mockResolvedValue(res({ orderId: '777', orderStatus: 'CANCELLED' }));
    expect(await client.cancelOrder('777')).toEqual({ ok: true, data: { orderId: '777', status: 'CANCELLED' } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.dhan.co/v2/orders/777');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');

    fetchMock.mockResolvedValue(res({ orderId: '777', orderStatus: 'PENDING' }));
    await client.modifyOrder('777', { orderType: 'LIMIT', validity: 'DAY', price: 1490 });
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      dhanClientId: '2000000001',
      orderId: '777',
      orderType: 'LIMIT',
      validity: 'DAY',
      price: 1490,
    });

    fetchMock.mockResolvedValue(res({ errorMessage: 'Order already traded' }, 400));
    expect(await client.cancelOrder('777')).toMatchObject({ ok: false, error: 'Order already traded (HTTP 400)' });
  });

  test('reads the order book and tolerates a wrapped or empty response', async () => {
    fetchMock.mockResolvedValue(res([bookRow(), bookRow({ orderId: '2', correlationId: null, orderStatus: 'TRADED' })]));
    const book = await client.getOrders();
    expect(book.ok && book.data.map((o) => [o.orderId, o.status])).toEqual([['112111182198', 'PENDING'], ['2', 'TRADED']]);

    fetchMock.mockResolvedValue(res({ data: [bookRow()] }));
    expect((await client.getOrders()) as any).toMatchObject({ ok: true });

    fetchMock.mockResolvedValue(res({}));
    expect(await client.getOrders()).toEqual({ ok: true, data: [] });
  });

  test('reports missing sandbox credentials without calling Dhan', async () => {
    (secureVault.getSandboxCredentials as jest.Mock).mockResolvedValueOnce({ clientId: '', token: '' });
    const out = await client.placeOrder(LIMIT);
    expect(out).toMatchObject({ kind: 'REJECTED', error: 'Dhan sandbox credentials are not configured.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DhanOrderClient (live is switched off)', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });

  test('LIVE stays disabled by default', () => {
    expect(ORDER_ENVIRONMENTS_ENABLED.LIVE).toBe(false);
  });

  test('every live call is refused before any network request', async () => {
    const live = new DhanOrderClient('LIVE');
    expect(await live.placeOrder(LIMIT)).toMatchObject({ kind: 'REJECTED', error: 'LIVE orders are switched off in this build.' });
    expect(await live.cancelOrder('1')).toMatchObject({ ok: false });
    expect(await live.modifyOrder('1', { orderType: 'LIMIT', validity: 'DAY', price: 1 })).toMatchObject({ ok: false });
    expect(await live.getOrders()).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
