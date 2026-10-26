/**
 * Single entry point for Dhan REST (Data API) calls.
 * Adds per-group pacing, single-flight de-duplication of identical in-flight requests,
 * short TTL caching of successful responses, and request timeouts.
 * Credentials, 401 handling and telemetry stay with the callers.
 */

export const DHAN_REST_BASE_URL = 'https://api.dhan.co/v2';

export interface GatewayCredentials {
  clientId: string;
  token: string;
}

export interface GatewayResponse {
  ok: boolean;
  status: number;
  fromCache: boolean;
  /** Parsed JSON body (only for ok responses). */
  data: any;
  /** Raw error body when available (non-ok responses). */
  errorText: string;
  json(): Promise<any>;
  text(): Promise<string>;
}

export type GatewayMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RequestSigner = (method: GatewayMethod, endpoint: string, body: string | undefined) => Promise<Record<string, string>>;

export interface GatewayRequestOptions {
  /** Overrides the endpoint's default cache TTL; 0 disables caching for this call. */
  ttlMs?: number;
  /** Skips cache and single-flight entirely (e.g. connection tests). */
  noCache?: boolean;
  timeoutMs?: number;
  /** Overrides the production base URL (the sandbox uses https://sandbox.dhan.co/v2). */
  baseUrl?: string;
  /** Returns extra headers for this request, e.g. the order relay's signature. Receives the endpoint below baseUrl. */
  signer?: RequestSigner;
}

export interface GatewayOptions {
  fetchImpl?: (url: string, init: any) => Promise<any>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pacing?: boolean;
  cache?: boolean;
  defaultTimeoutMs?: number;
}

interface EndpointPolicy {
  group: string;
  minIntervalMs: number;
  ttlMs: number;
}

// Matched in order by prefix. Verify limits against dhan-api-docs.md before tightening.
const POLICIES: Array<[string, EndpointPolicy]> = [
  ['/optionchain/expirylist', { group: 'optionchain', minIntervalMs: 1000, ttlMs: 60_000 }],
  ['/optionchain', { group: 'optionchain', minIntervalMs: 1000, ttlMs: 3000 }],
  ['/marketfeed', { group: 'quote', minIntervalMs: 1000, ttlMs: 1000 }],
  ['/charts', { group: 'data', minIntervalMs: 200, ttlMs: 0 }],
  // Order and account-control calls are never cached or merged; 10 req/s is the documented order limit.
  ['/orders', { group: 'orders', minIntervalMs: 120, ttlMs: 0 }],
  ['/super', { group: 'orders', minIntervalMs: 120, ttlMs: 0 }],
  ['/trades', { group: 'orders', minIntervalMs: 120, ttlMs: 0 }],
  ['/positions', { group: 'orders', minIntervalMs: 120, ttlMs: 0 }],
  ['/ip', { group: 'orders', minIntervalMs: 120, ttlMs: 0 }],
];
const DEFAULT_POLICY: EndpointPolicy = { group: 'default', minIntervalMs: 200, ttlMs: 0 };
const MAX_CACHE_ENTRIES = 200;

export class DhanRestGateway {
  private inflight = new Map<string, Promise<GatewayResponse>>();
  private cache = new Map<string, { expires: number; res: GatewayResponse }>();
  private nextSlot = new Map<string, number>();
  private pacing: boolean;
  private cacheEnabled: boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: (url: string, init: any) => Promise<any>;
  private readonly defaultTimeoutMs: number;

  constructor(options: GatewayOptions = {}) {
    this.pacing = options.pacing ?? true;
    this.cacheEnabled = options.cache ?? true;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Resolved per call so test doubles assigned to global.fetch are honoured.
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  }

  configure(options: { pacing?: boolean; cache?: boolean }): void {
    if (options.pacing !== undefined) this.pacing = options.pacing;
    if (options.cache !== undefined) this.cacheEnabled = options.cache;
  }

  reset(): void {
    this.inflight.clear();
    this.cache.clear();
    this.nextSlot.clear();
  }

  /** Rejects on network errors and timeouts (AbortError), like fetch. */
  async post(
    endpoint: string,
    body: unknown,
    creds: GatewayCredentials,
    options: GatewayRequestOptions = {}
  ): Promise<GatewayResponse> {
    const policy = this.policyFor(endpoint);
    const bodyStr = JSON.stringify(body);
    const ttl = options.ttlMs ?? policy.ttlMs;
    const shareable = this.cacheEnabled && !options.noCache;
    const key = `${creds.clientId}|${endpoint}|${bodyStr}`;

    if (shareable) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > this.now()) return { ...hit.res, fromCache: true };
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }

    const promise = this.execute('POST', endpoint, bodyStr, creds, policy, options.timeoutMs ?? this.defaultTimeoutMs)
      .then((res) => {
        if (shareable && res.ok && ttl > 0) this.store(key, res, ttl);
        return res;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });

    if (shareable) this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Uncached, unmerged request of any method, for order and account-control endpoints where two
   * identical calls must stay two calls. Rejects on network errors and timeouts (AbortError).
   */
  async request(
    method: GatewayMethod,
    endpoint: string,
    body: unknown,
    creds: GatewayCredentials,
    options: GatewayRequestOptions = {}
  ): Promise<GatewayResponse> {
    const policy = this.policyFor(endpoint);
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    return this.execute(
      method,
      endpoint,
      bodyStr,
      creds,
      policy,
      options.timeoutMs ?? this.defaultTimeoutMs,
      options.baseUrl ?? DHAN_REST_BASE_URL,
      options.signer
    );
  }

  private policyFor(endpoint: string): EndpointPolicy {
    for (const [prefix, policy] of POLICIES) {
      if (endpoint.startsWith(prefix)) return policy;
    }
    return DEFAULT_POLICY;
  }

  private store(key: string, res: GatewayResponse, ttl: number): void {
    const now = this.now();
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.cache.forEach((entry, k) => {
        if (entry.expires <= now) this.cache.delete(k);
      });
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    }
    this.cache.set(key, { expires: now + ttl, res });
  }

  // Reserves the next free slot in the endpoint group so concurrent callers are spaced out in FIFO order.
  private async reserveSlot(policy: EndpointPolicy): Promise<void> {
    if (!this.pacing || policy.minIntervalMs <= 0) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(policy.group) ?? 0);
    this.nextSlot.set(policy.group, slot + policy.minIntervalMs);
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }

  private async execute(
    method: GatewayMethod,
    endpoint: string,
    bodyStr: string | undefined,
    creds: GatewayCredentials,
    policy: EndpointPolicy,
    timeoutMs: number,
    baseUrl: string = DHAN_REST_BASE_URL,
    signer?: RequestSigner
  ): Promise<GatewayResponse> {
    await this.reserveSlot(policy);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const extra = signer ? await signer(method, endpoint, bodyStr) : {};
      const raw = await this.fetchImpl(`${baseUrl}${endpoint}`, {
        method,
        headers: {
          'access-token': creds.token,
          'client-id': creds.clientId,
          dhanClientId: creds.clientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extra,
        },
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        signal: controller.signal,
      });

      let data: any = null;
      let errorText = '';
      if (raw.ok) {
        data = await raw.json();
      } else if (typeof raw.text === 'function') {
        try {
          errorText = await raw.text();
        } catch {
          errorText = '';
        }
      }

      return {
        ok: Boolean(raw.ok),
        status: raw.status,
        fromCache: false,
        data,
        errorText,
        json: async () => data,
        text: async () => errorText,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const dhanRestGateway = new DhanRestGateway();
