/**
 * Dhan order API client: place, modify, cancel, order book, order lookup, trades and positions.
 *
 * Safety rules built in:
 *  - an environment (SANDBOX or LIVE) is chosen per client and LIVE is refused while switched off in orderConfig;
 *  - requests are never cached or merged, and a POST is never retried;
 *  - when the outcome of a placement is unknown (timeout, network error, server error) the order is looked up
 *    by its correlation id instead of being sent again.
 */

import { secureVault } from '../SecureCredentialVault';
import { dhanRestGateway, type GatewayResponse } from './DhanRestGateway';
import { parseDhanError } from './dhanErrors';
import { DHAN_BASE_URLS, ORDER_ENVIRONMENTS_ENABLED, type OrderEnvironment } from '../../config/orderConfig';

export type TransactionType = 'BUY' | 'SELL';
export type ExchangeSegment = 'NSE_EQ' | 'NSE_FNO' | 'NSE_COMM' | 'BSE_EQ' | 'BSE_FNO' | 'MCX_COMM';
export type ProductType = 'CNC' | 'INTRADAY' | 'MARGIN' | 'MTF';
export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_LOSS' | 'STOP_LOSS_MARKET';
export type Validity = 'DAY' | 'IOC';

export interface OrderRequest {
  correlationId?: string;
  transactionType: TransactionType;
  exchangeSegment: ExchangeSegment;
  productType: ProductType;
  orderType: OrderType;
  validity: Validity;
  securityId: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  disclosedQuantity?: number;
}

/** An order as reported by Dhan, with only the fields the app uses. */
export interface DhanOrder {
  orderId: string;
  correlationId: string | null;
  status: string;
  transactionType: string;
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: string;
  securityId: string;
  tradingSymbol: string | null;
  quantity: number;
  price: number;
  triggerPrice: number;
  filledQty: number;
  remainingQuantity: number;
  averageTradedPrice: number;
  createTime: string | null;
  updateTime: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export type PlaceOutcome =
  | { kind: 'PLACED'; orderId: string; status: string; correlationId: string }
  /** Dhan or the client refused the order; nothing was placed. */
  | { kind: 'REJECTED'; error: string; code: string | null; correlationId: string }
  /** The result is not known; look the order up by correlationId before doing anything else. */
  | { kind: 'UNKNOWN'; error: string; correlationId: string };

export type CallResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code: string | null };

/** Statuses that mean the order is still working at the exchange. */
export const OPEN_ORDER_STATUSES = ['TRANSIT', 'PENDING', 'PART_TRADED', 'TRIGGERED', 'MODIFIED'];
export const isOpenOrderStatus = (status: string): boolean => OPEN_ORDER_STATUSES.includes(status);

const CORRELATION_RE = /^[a-zA-Z0-9_.-]{1,30}$/;

export function generateCorrelationId(prefix = 'QS'): string {
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${prefix}-${time}-${rand}`.slice(0, 30);
}

/** Returns a message for the first problem found, or null when the request is well formed. */
export function validateOrderRequest(req: OrderRequest): string | null {
  if (!/^\d+$/.test(String(req.securityId ?? '').trim())) return 'Security ID must be numeric.';
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) return 'Quantity must be a whole number above zero.';
  if (req.disclosedQuantity !== undefined && (!Number.isInteger(req.disclosedQuantity) || req.disclosedQuantity < 0)) {
    return 'Disclosed quantity must be a whole number.';
  }
  const needsPrice = req.orderType === 'LIMIT' || req.orderType === 'STOP_LOSS';
  const needsTrigger = req.orderType === 'STOP_LOSS' || req.orderType === 'STOP_LOSS_MARKET';
  if (needsPrice && !(typeof req.price === 'number' && req.price > 0)) return 'A price above zero is required for this order type.';
  if (needsTrigger && !(typeof req.triggerPrice === 'number' && req.triggerPrice > 0)) {
    return 'A trigger price above zero is required for this order type.';
  }
  if (req.orderType === 'MARKET' && req.price !== undefined && req.price !== 0) return 'Market orders must not carry a price.';
  if (req.correlationId !== undefined && !CORRELATION_RE.test(req.correlationId)) {
    return 'Correlation id must be 1-30 characters of letters, digits, dot, dash or underscore.';
  }
  return null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function normalizeOrder(raw: any): DhanOrder {
  return {
    orderId: String(raw?.orderId ?? ''),
    correlationId: text(raw?.correlationId),
    status: String(raw?.orderStatus ?? 'UNKNOWN'),
    transactionType: String(raw?.transactionType ?? ''),
    exchangeSegment: String(raw?.exchangeSegment ?? ''),
    productType: String(raw?.productType ?? ''),
    orderType: String(raw?.orderType ?? ''),
    validity: String(raw?.validity ?? ''),
    securityId: String(raw?.securityId ?? ''),
    tradingSymbol: text(raw?.tradingSymbol),
    quantity: num(raw?.quantity),
    price: num(raw?.price),
    triggerPrice: num(raw?.triggerPrice),
    filledQty: num(raw?.filledQty),
    remainingQuantity: num(raw?.remainingQuantity),
    averageTradedPrice: num(raw?.averageTradedPrice),
    createTime: text(raw?.createTime),
    updateTime: text(raw?.updateTime),
    errorCode: text(raw?.omsErrorCode),
    errorMessage: text(raw?.omsErrorDescription),
  };
}

export interface OrderClientOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Pause before each look-up after an unknown placement outcome. */
  lookupDelayMs?: number;
  lookupAttempts?: number;
}

export class DhanOrderClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lookupDelayMs: number;
  private readonly lookupAttempts: number;

  constructor(
    public readonly env: OrderEnvironment,
    options: OrderClientOptions = {}
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lookupDelayMs = options.lookupDelayMs ?? 1500;
    this.lookupAttempts = options.lookupAttempts ?? 3;
  }

  private async credentials(): Promise<{ clientId: string; token: string } | null> {
    if (this.env === 'SANDBOX') {
      const c = await secureVault.getSandboxCredentials();
      return c.clientId && c.token ? c : null;
    }
    const c = await secureVault.getEffectiveCredentials();
    return c.clientId && c.token ? { clientId: c.clientId, token: c.token } : null;
  }

  private guard(): string | null {
    return ORDER_ENVIRONMENTS_ENABLED[this.env] ? null : `${this.env} orders are switched off in this build.`;
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: unknown
  ): Promise<{ res: GatewayResponse } | { error: string; transport: boolean }> {
    const off = this.guard();
    if (off) return { error: off, transport: false };
    const creds = await this.credentials();
    if (!creds) {
      return { error: `Dhan ${this.env.toLowerCase()} credentials are not configured.`, transport: false };
    }
    try {
      const res = await dhanRestGateway.request(method, endpoint, body, creds, {
        baseUrl: DHAN_BASE_URLS[this.env],
        timeoutMs: 10_000,
      });
      if (res.status === 401 && this.env === 'LIVE') {
        secureVault.updateTelemetry({ status: 'TOKEN_EXPIRED', lastError: 'Access token expired (HTTP 401).' });
      }
      return { res };
    } catch (err: any) {
      return { error: err?.name === 'AbortError' ? 'Request timed out.' : err?.message || 'Network error.', transport: true };
    }
  }

  private fail(res: GatewayResponse): { ok: false; status: number; error: string; code: string | null } {
    const info = parseDhanError(res);
    return { ok: false, status: res.status, error: info.message, code: info.code };
  }

  /** Places one order. Never retries; an unclear outcome is reported as UNKNOWN. */
  async placeOrder(req: OrderRequest): Promise<PlaceOutcome> {
    const correlationId = req.correlationId ?? generateCorrelationId();
    const invalid = validateOrderRequest({ ...req, correlationId });
    if (invalid) return { kind: 'REJECTED', error: invalid, code: null, correlationId };

    const creds = await this.credentials();
    const off = this.guard();
    if (off) return { kind: 'REJECTED', error: off, code: null, correlationId };
    if (!creds) {
      return { kind: 'REJECTED', error: `Dhan ${this.env.toLowerCase()} credentials are not configured.`, code: null, correlationId };
    }

    const body: Record<string, unknown> = {
      dhanClientId: creds.clientId,
      correlationId,
      transactionType: req.transactionType,
      exchangeSegment: req.exchangeSegment,
      productType: req.productType,
      orderType: req.orderType,
      validity: req.validity,
      securityId: String(req.securityId).trim(),
      quantity: req.quantity,
    };
    if (req.price !== undefined) body.price = req.price;
    if (req.triggerPrice !== undefined) body.triggerPrice = req.triggerPrice;
    if (req.disclosedQuantity !== undefined) body.disclosedQuantity = req.disclosedQuantity;

    const out = await this.call('POST', '/orders', body);
    if ('error' in out) return { kind: 'UNKNOWN', error: out.error, correlationId };

    const { res } = out;
    if (res.ok) {
      const orderId = String(res.data?.orderId ?? '');
      if (!orderId) return { kind: 'UNKNOWN', error: 'Dhan accepted the request but returned no order id.', correlationId };
      return { kind: 'PLACED', orderId, status: String(res.data?.orderStatus ?? 'TRANSIT'), correlationId };
    }
    const info = parseDhanError(res);
    // A client error means Dhan refused the order. A server error may have been processed, so it is unclear.
    if (res.status >= 500) return { kind: 'UNKNOWN', error: info.message, correlationId };
    return { kind: 'REJECTED', error: info.message, code: info.code, correlationId };
  }

  /** Places an order and, when the outcome is unclear, looks it up by correlation id before reporting UNKNOWN. */
  async placeAndConfirm(req: OrderRequest): Promise<PlaceOutcome> {
    const outcome = await this.placeOrder(req);
    if (outcome.kind !== 'UNKNOWN') return outcome;

    for (let i = 0; i < this.lookupAttempts; i++) {
      await this.sleep(this.lookupDelayMs);
      const found = await this.getOrderByCorrelationId(outcome.correlationId);
      if (found.ok && found.data) {
        return { kind: 'PLACED', orderId: found.data.orderId, status: found.data.status, correlationId: outcome.correlationId };
      }
    }
    return outcome;
  }

  async cancelOrder(orderId: string): Promise<CallResult<{ orderId: string; status: string }>> {
    const out = await this.call('DELETE', `/orders/${encodeURIComponent(orderId)}`);
    if ('error' in out) return { ok: false, status: 0, error: out.error, code: null };
    if (!out.res.ok) return this.fail(out.res);
    return { ok: true, data: { orderId: String(out.res.data?.orderId ?? orderId), status: String(out.res.data?.orderStatus ?? 'CANCELLED') } };
  }

  async modifyOrder(
    orderId: string,
    change: { orderType: OrderType; validity: Validity; quantity?: number; price?: number; triggerPrice?: number }
  ): Promise<CallResult<{ orderId: string; status: string }>> {
    const creds = await this.credentials();
    if (!creds) return { ok: false, status: 0, error: `Dhan ${this.env.toLowerCase()} credentials are not configured.`, code: null };
    const out = await this.call('PUT', `/orders/${encodeURIComponent(orderId)}`, {
      dhanClientId: creds.clientId,
      orderId,
      ...change,
    });
    if ('error' in out) return { ok: false, status: 0, error: out.error, code: null };
    if (!out.res.ok) return this.fail(out.res);
    return { ok: true, data: { orderId: String(out.res.data?.orderId ?? orderId), status: String(out.res.data?.orderStatus ?? 'MODIFIED') } };
  }

  async getOrders(): Promise<CallResult<DhanOrder[]>> {
    const out = await this.call('GET', '/orders');
    if ('error' in out) return { ok: false, status: 0, error: out.error, code: null };
    if (!out.res.ok) return this.fail(out.res);
    const list = Array.isArray(out.res.data) ? out.res.data : Array.isArray(out.res.data?.data) ? out.res.data.data : [];
    return { ok: true, data: list.map(normalizeOrder) };
  }

  /** ok with data null means Dhan has no order with that correlation id (yet). */
  async getOrderByCorrelationId(correlationId: string): Promise<CallResult<DhanOrder | null>> {
    const out = await this.call('GET', `/orders/external/${encodeURIComponent(correlationId)}`);
    if ('error' in out) return { ok: false, status: 0, error: out.error, code: null };
    if (out.res.status === 404) return { ok: true, data: null };
    if (!out.res.ok) return this.fail(out.res);
    const raw = Array.isArray(out.res.data) ? out.res.data[0] : out.res.data;
    return { ok: true, data: raw && raw.orderId ? normalizeOrder(raw) : null };
  }

  async getTrades(): Promise<CallResult<any[]>> {
    const out = await this.call('GET', '/trades');
    if ('error' in out) return { ok: false, status: 0, error: out.error, code: null };
    if (!out.res.ok) return this.fail(out.res);
    return { ok: true, data: Array.isArray(out.res.data) ? out.res.data : [] };
  }

  async getPositions(): Promise<CallResult<any[]>> {
    const out = await this.call('GET', '/positions');
    if ('error' in out) return { ok: false, status: 0, error: out.error, code: null };
    if (!out.res.ok) return this.fail(out.res);
    return { ok: true, data: Array.isArray(out.res.data) ? out.res.data : [] };
  }
}

export const sandboxOrderClient = new DhanOrderClient('SANDBOX');
