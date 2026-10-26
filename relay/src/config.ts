export interface RelayConfig {
  host: string;
  port: number;
  dbPath: string;
  /** Dhan REST base URL. Only change it to point the relay at the sandbox. */
  upstreamBase: string;
  upstreamTimeoutMs: number;
  /** Pause before looking an order up by correlation id after an unclear placement. */
  recoveryDelayMs: number;
  tenantRatePerSec: number;
  globalRatePerSec: number;
  clockSkewMs: number;
  trustProxy: boolean;
  /** Source address for outgoing connections, when the host has several IPs. */
  egressLocalAddress?: string;
  /** Send all Dhan traffic through this HTTP proxy (a fixed-IP node), so the relay itself can run anywhere. */
  upstreamProxy?: string;
  egressIpUrl: string;
  /** Refuses any write whose quantity is above this; 0 turns the check off. */
  maxOrderQuantity: number;
  /** Most Dhan accounts this relay will serve. Dhan allows one IP to be shared only within a family. */
  maxAccounts: number;
  /** Receives a plain-text POST (ntfy style) when the relay's public IP changes. */
  alertWebhookUrl?: string;
  egressWatchMinutes: number;
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: positive(env.PORT, 8787),
    dbPath: env.DB_PATH ?? './data/relay.db',
    upstreamBase: (env.DHAN_BASE_URL ?? 'https://api.dhan.co/v2').replace(/\/+$/, ''),
    upstreamTimeoutMs: positive(env.UPSTREAM_TIMEOUT_MS, 7000),
    recoveryDelayMs: positive(env.RECOVERY_DELAY_MS, 1000),
    tenantRatePerSec: positive(env.TENANT_RATE_PER_SEC, 8),
    globalRatePerSec: positive(env.GLOBAL_RATE_PER_SEC, 50),
    clockSkewMs: positive(env.CLOCK_SKEW_SECONDS, 30) * 1000,
    trustProxy: env.TRUST_PROXY === 'true',
    egressLocalAddress: env.EGRESS_LOCAL_ADDRESS || undefined,
    upstreamProxy: env.UPSTREAM_PROXY || undefined,
    egressIpUrl: env.EGRESS_IP_URL ?? 'https://api.ipify.org',
    maxOrderQuantity: Math.max(0, Number(env.MAX_ORDER_QUANTITY) || 0),
    maxAccounts: positive(env.MAX_ACCOUNTS, 2),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || undefined,
    egressWatchMinutes: positive(env.EGRESS_WATCH_MINUTES, 5),
  };
}
