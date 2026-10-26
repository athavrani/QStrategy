/**
 * Client for the QStrategy order relay: a service on a host with a fixed public IP that forwards live order
 * requests to Dhan, because Dhan only accepts order calls from a whitelisted static IP.
 *
 * The phone holds an Ed25519 key pair. The private key never leaves the secure keystore, and each request to the
 * relay is signed with it. The Dhan token still travels in the normal headers (over HTTPS) and is not stored by the relay.
 */

import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { secureVault } from '../SecureCredentialVault';
import type { RequestSigner } from '../dhan/DhanRestGateway';

const KEY_URL = 'QSTRATEGY_RELAY_URL';
const KEY_DEVICE = 'QSTRATEGY_RELAY_DEVICE_ID';
const KEY_PRIVATE = 'QSTRATEGY_RELAY_PRIVATE_KEY';

/** Dhan paths are mounted under this prefix on the relay. */
export const RELAY_DHAN_PREFIX = '/dhan/v2';
const CALL_TIMEOUT_MS = 10_000;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const secureStoreAdapter: KeyValueStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: (k) => SecureStore.deleteItemAsync(k),
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 bytes of a string, without depending on TextEncoder being present in the JS engine. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** The string the relay verifies; keep it in step with canonicalString() in relay/src/auth.ts. */
export function canonicalString(p: { ts: string; nonce: string; method: string; url: string; body: string | undefined }): string {
  const bodyHash = bytesToHex(sha256(utf8(p.body ?? '')));
  return `v1\n${p.ts}\n${p.nonce}\n${p.method.toUpperCase()}\n${p.url}\n${bodyHash}`;
}

/** Accepts an origin only. Plain http is allowed for local development hosts, because the Dhan token travels in the headers. */
export function normalizeRelayUrl(input: string): string | null {
  const v = input.trim().replace(/\/+$/, '').toLowerCase();
  if (/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(v)) return v;
  if (/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d{1,5})?$/.test(v)) return v;
  return null;
}

export interface RelayConfig {
  url: string;
  deviceId: string;
}

export type RegisterOutcome = { ok: true; deviceId: string; egressIp: string | null } | { ok: false; error: string };

export type EgressOutcome =
  | { ok: true; egressIp: string | null; dhan: { primaryIP: string | null; secondaryIP: string | null } | null; match: boolean | null }
  | { ok: false; error: string };

interface Loaded extends RelayConfig {
  privateKey: Uint8Array;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

function relayMessage(body: any, status: number): string {
  const msg = typeof body?.errorMessage === 'string' ? body.errorMessage : null;
  return msg ? `${msg} (${body?.errorCode ?? `HTTP ${status}`})` : `The relay answered HTTP ${status}.`;
}

export class RelayService {
  private cache: Loaded | null | undefined;

  constructor(
    private readonly store: KeyValueStore = secureStoreAdapter,
    private readonly random: (n: number) => Uint8Array = getRandomBytes,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  private async load(): Promise<Loaded | null> {
    if (this.cache !== undefined) return this.cache;
    try {
      const [url, deviceId, key] = await Promise.all([this.store.get(KEY_URL), this.store.get(KEY_DEVICE), this.store.get(KEY_PRIVATE)]);
      this.cache = url && deviceId && key ? { url, deviceId, privateKey: fromBase64(key) } : null;
      return this.cache;
    } catch {
      // Do not remember a failed read; the next call tries again.
      return null;
    }
  }

  async getConfig(): Promise<RelayConfig | null> {
    const c = await this.load();
    return c ? { url: c.url, deviceId: c.deviceId } : null;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  private signedHeaders(cfg: Loaded, method: string, urlPath: string, body: string | undefined): Record<string, string> {
    const ts = String(this.now());
    const nonce = bytesToHex(this.random(12));
    const canonical = canonicalString({ ts, nonce, method, url: urlPath, body });
    return {
      'x-relay-device': cfg.deviceId,
      'x-relay-ts': ts,
      'x-relay-nonce': nonce,
      'x-relay-sig': toBase64(ed25519.sign(utf8(canonical), cfg.privateKey)),
    };
  }

  /** Where live order traffic should go, or null when no relay is set up and orders go straight to Dhan. */
  async route(): Promise<{ baseUrl: string; signer: RequestSigner } | null> {
    const cfg = await this.load();
    if (!cfg) return null;
    return {
      baseUrl: `${cfg.url}${RELAY_DHAN_PREFIX}`,
      signer: async (method, endpoint, body) => this.signedHeaders(cfg, method, `${RELAY_DHAN_PREFIX}${endpoint}`, body),
    };
  }

  private async fetchJson(url: string, init: any): Promise<{ status: number; body: any } | { error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch (err: any) {
      return { error: err?.name === 'AbortError' ? 'The relay did not answer in time.' : 'Could not reach the relay.' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Creates this phone's key pair and registers it with the relay using a single-use invite code. */
  async register(a: { url: string; inviteCode: string; dhanClientId: string; label?: string }): Promise<RegisterOutcome> {
    const url = normalizeRelayUrl(a.url);
    if (!url) return { ok: false, error: 'Enter the relay address as https://your-host (no path).' };
    if (!/^\d{5,12}$/.test(a.dhanClientId.trim())) return { ok: false, error: 'Save your Dhan client ID in Settings first.' };
    if (!a.inviteCode.trim()) return { ok: false, error: 'Enter the invite code from the relay admin.' };

    const privateKey = this.random(32);
    const publicKey = ed25519.getPublicKey(privateKey);
    const out = await this.fetchJson(`${url}/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inviteCode: a.inviteCode.trim(),
        publicKey: toBase64(publicKey),
        dhanClientId: a.dhanClientId.trim(),
        label: a.label,
      }),
    });
    if ('error' in out) return { ok: false, error: out.error };
    if (out.status !== 200 || typeof out.body?.deviceId !== 'string') return { ok: false, error: relayMessage(out.body, out.status) };

    await this.store.set(KEY_URL, url);
    await this.store.set(KEY_DEVICE, out.body.deviceId);
    await this.store.set(KEY_PRIVATE, toBase64(privateKey));
    this.cache = { url, deviceId: out.body.deviceId, privateKey };
    return { ok: true, deviceId: out.body.deviceId, egressIp: typeof out.body.egressIp === 'string' ? out.body.egressIp : null };
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.store.remove(KEY_URL), this.store.remove(KEY_DEVICE), this.store.remove(KEY_PRIVATE)]);
    this.cache = null;
  }

  /** Asks the relay for its public IP and whether Dhan has it whitelisted for this account. Null when no relay is set up. */
  async checkEgress(): Promise<EgressOutcome | null> {
    const cfg = await this.load();
    if (!cfg) return null;
    const creds = await secureVault.getEffectiveCredentials();
    if (!creds.clientId || !creds.token) return { ok: false, error: 'Dhan credentials are not configured.' };

    const out = await this.fetchJson(`${cfg.url}/v1/egress`, {
      method: 'GET',
      headers: {
        'access-token': creds.token,
        'client-id': creds.clientId,
        ...this.signedHeaders(cfg, 'GET', '/v1/egress', undefined),
      },
    });
    if ('error' in out) return { ok: false, error: out.error };
    if (out.status !== 200) return { ok: false, error: relayMessage(out.body, out.status) };
    const b = out.body ?? {};
    return {
      ok: true,
      egressIp: typeof b.egressIp === 'string' ? b.egressIp : null,
      dhan: b.dhan ? { primaryIP: b.dhan.primaryIP ?? null, secondaryIP: b.dhan.secondaryIP ?? null } : null,
      match: typeof b.match === 'boolean' ? b.match : null,
    };
  }

  /** Message that blocks an order, or null when the relay's IP is the one Dhan has whitelisted. Null relay means not configured. */
  async preflight(): Promise<{ configured: false } | { configured: true; problem: string | null }> {
    const res = await this.checkEgress();
    if (!res) return { configured: false };
    if (!res.ok) return { configured: true, problem: `Could not check the order relay: ${res.error}` };
    if (res.match === true) return { configured: true, problem: null };
    if (!res.dhan) return { configured: true, problem: 'Could not read the Dhan IP whitelist through the relay.' };
    if (!res.dhan.primaryIP && !res.dhan.secondaryIP) {
      return { configured: true, problem: `No IP is whitelisted with Dhan yet. Whitelist the relay IP (${res.egressIp ?? 'unknown'}) in Settings first.` };
    }
    return {
      configured: true,
      problem: `The relay IP (${res.egressIp ?? 'unknown'}) is not the IP whitelisted with Dhan, so Dhan would reject the order.`,
    };
  }
}

export const relayService = new RelayService();
