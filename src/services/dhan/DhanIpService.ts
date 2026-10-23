/**
 * Dhan static-IP whitelist client: GET /ip/getIP, POST /ip/setIP, PUT /ip/modifyIP.
 * Order placement, modification and cancellation are only accepted from a whitelisted IP.
 * Once an IP is set it cannot be changed for 7 days, so callers must confirm with the user first.
 */

import { secureVault } from '../SecureCredentialVault';
import { dhanRestGateway, type GatewayResponse } from './DhanRestGateway';
import { parseDhanError } from './dhanErrors';
import { ipsMatch, isValidIp, normalizeIp } from '../PublicIpService';

export type IpSlot = 'PRIMARY' | 'SECONDARY';

export interface DhanIpConfig {
  primaryIP: string | null;
  secondaryIP: string | null;
  modifyDatePrimary: string | null;
  modifyDateSecondary: string | null;
}

export type IpCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function failure(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

const describeError = (res: GatewayResponse): string => parseDhanError(res).message;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function parseIpConfig(raw: any): DhanIpConfig {
  const d = raw?.data ?? raw ?? {};
  return {
    primaryIP: str(d.primaryIP),
    secondaryIP: str(d.secondaryIP),
    modifyDatePrimary: str(d.modifyDatePrimary),
    modifyDateSecondary: str(d.modifyDateSecondary),
  };
}

export class DhanIpService {
  private async creds(): Promise<{ clientId: string; token: string } | null> {
    const c = await secureVault.getEffectiveCredentials();
    return c.clientId && c.token ? { clientId: c.clientId, token: c.token } : null;
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT',
    endpoint: string,
    body?: unknown
  ): Promise<IpCallResult<any>> {
    const creds = await this.creds();
    if (!creds) return failure(0, 'Dhan credentials are not configured.');
    try {
      const res = await dhanRestGateway.request(method, endpoint, body, creds, { timeoutMs: 10_000 });
      if (res.status === 401) {
        secureVault.updateTelemetry({ status: 'TOKEN_EXPIRED', lastError: 'Access token expired (HTTP 401).' });
      }
      if (!res.ok) return failure(res.status, describeError(res));
      return { ok: true, data: res.data };
    } catch (err: any) {
      return failure(0, err?.name === 'AbortError' ? 'Request timed out.' : err?.message || 'Network error.');
    }
  }

  async getIp(): Promise<IpCallResult<DhanIpConfig>> {
    const res = await this.call('GET', '/ip/getIP');
    return res.ok ? { ok: true, data: parseIpConfig(res.data) } : res;
  }

  /** First-time set for a slot. */
  async setIp(ip: string, slot: IpSlot): Promise<IpCallResult<string>> {
    return this.write('POST', '/ip/setIP', ip, slot);
  }

  /** Change of an already-set slot; Dhan only allows it once the 7-day window has passed. */
  async modifyIp(ip: string, slot: IpSlot): Promise<IpCallResult<string>> {
    return this.write('PUT', '/ip/modifyIP', ip, slot);
  }

  /** Uses setIP for an empty slot and modifyIP for one that already holds an address. */
  async whitelist(ip: string, slot: IpSlot, current: DhanIpConfig): Promise<IpCallResult<string>> {
    const existing = slot === 'PRIMARY' ? current.primaryIP : current.secondaryIP;
    return existing ? this.modifyIp(ip, slot) : this.setIp(ip, slot);
  }

  private async write(
    method: 'POST' | 'PUT',
    endpoint: string,
    ip: string,
    slot: IpSlot
  ): Promise<IpCallResult<string>> {
    const clean = normalizeIp(ip);
    if (!isValidIp(clean)) return failure(0, 'That is not a valid IPv4 or IPv6 address.');
    const creds = await this.creds();
    if (!creds) return failure(0, 'Dhan credentials are not configured.');
    const res = await this.call(method, endpoint, { dhanClientId: creds.clientId, ip: clean, ipFlag: slot });
    if (!res.ok) return res;
    const message = typeof res.data?.message === 'string' ? res.data.message : 'IP updated.';
    return { ok: true, data: message };
  }
}

export const dhanIpService = new DhanIpService();

export type IpGuardState = 'MATCH' | 'MISMATCH' | 'NOT_WHITELISTED' | 'UNKNOWN';

/** Compares the device's current public IP with the whitelist. Used before any live order. */
export function evaluateIpGuard(detectedIp: string | null, config: DhanIpConfig | null): IpGuardState {
  if (!detectedIp || !config) return 'UNKNOWN';
  if (!config.primaryIP && !config.secondaryIP) return 'NOT_WHITELISTED';
  return ipsMatch(detectedIp, config.primaryIP) || ipsMatch(detectedIp, config.secondaryIP)
    ? 'MATCH'
    : 'MISMATCH';
}
