import { Agent, ProxyAgent, request, type buildConnector, type Dispatcher } from 'undici';
import type { RelayConfig } from './config.js';

export interface UpstreamRequest {
  method: string;
  /** Path and query below the Dhan base URL, e.g. /orders. */
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
}

export interface UpstreamResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message: string
  ) {
    super(message);
  }
}

export interface Upstream {
  forward(req: UpstreamRequest): Promise<UpstreamResponse>;
  /** The public IP Dhan sees for this relay, looked up through the same route as order traffic. */
  egressIp(): Promise<string | null>;
  /** Last IP found by egressIp(), without a network call. */
  cachedEgressIp(): string | null;
}

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR']);
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{3,45})$/i;
const EGRESS_TTL_MS = 60_000;

export function createUpstream(cfg: Pick<RelayConfig, 'upstreamBase' | 'egressLocalAddress' | 'upstreamProxy' | 'egressIpUrl'>): Upstream {
  // IPv4 only: on a dual-stack host an IPv6 connection would leave from an address Dhan has not whitelisted.
  // undici's typings demand a port here although it is filled in per request.
  const connect = { family: 4, ...(cfg.egressLocalAddress ? { localAddress: cfg.egressLocalAddress } : {}) } as buildConnector.BuildOptions;
  const dispatcher: Dispatcher = cfg.upstreamProxy ? new ProxyAgent({ uri: cfg.upstreamProxy }) : new Agent({ connect });

  let cached: { ip: string; at: number } | null = null;

  return {
    async forward(req) {
      try {
        const res = await request(`${cfg.upstreamBase}${req.path}`, {
          dispatcher,
          method: req.method as Dispatcher.HttpMethod,
          headers: req.headers,
          body: req.body,
          headersTimeout: req.timeoutMs,
          bodyTimeout: req.timeoutMs,
        });
        const body = Buffer.from(await res.body.arrayBuffer());
        const ct = res.headers['content-type'];
        return { status: res.statusCode, contentType: typeof ct === 'string' ? ct : null, body };
      } catch (err: any) {
        const kind = TIMEOUT_CODES.has(err?.code) || err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
        throw new UpstreamError(kind, err?.message ?? 'Upstream request failed.');
      }
    },

    async egressIp() {
      if (cached && Date.now() - cached.at < EGRESS_TTL_MS) return cached.ip;
      try {
        const res = await request(cfg.egressIpUrl, { dispatcher, headersTimeout: 4000, bodyTimeout: 4000 });
        const ip = (await res.body.text()).trim();
        if (res.statusCode === 200 && IP_RE.test(ip)) cached = { ip, at: Date.now() };
      } catch {
        // Keep the last known IP; a failed lookup must not look like an IP change.
      }
      return cached?.ip ?? null;
    },

    cachedEgressIp() {
      return cached?.ip ?? null;
    },
  };
}
