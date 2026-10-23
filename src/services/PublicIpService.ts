/**
 * Detects the public IP address this device's requests currently leave from.
 * Dhan checks that address against the whitelist for order calls, so the app compares the two
 * before sending anything. Uses a third-party echo service, which sees only this device's IP.
 */

const IP_ECHO_URL = 'https://api.ipify.org?format=json';
const DETECT_TIMEOUT_MS = 6000;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function isValidIp(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (IPV4.test(v)) return true;
  return v.includes(':') && IPV6.test(v) && (v.match(/:/g) ?? []).length >= 2 && v.length <= 45;
}

/** Normalised form used for comparison (trimmed, lower-cased). */
export function normalizeIp(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function ipsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIp(a);
  return x !== '' && x === normalizeIp(b);
}

export type DetectIpResult = { ok: true; ip: string } | { ok: false; error: string };

export async function detectPublicIp(
  fetchImpl: (url: string, init?: any) => Promise<any> = (url, init) => fetch(url, init),
  timeoutMs = DETECT_TIMEOUT_MS
): Promise<DetectIpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(IP_ECHO_URL, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `IP lookup failed (HTTP ${res.status}).` };
    const body = await res.json();
    const ip = typeof body?.ip === 'string' ? body.ip.trim() : '';
    if (!isValidIp(ip)) return { ok: false, error: 'IP lookup returned an unexpected answer.' };
    return { ok: true, ip };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'IP lookup timed out.' : 'Could not reach the IP lookup service.',
    };
  } finally {
    clearTimeout(timer);
  }
}
