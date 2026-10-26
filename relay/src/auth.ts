import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

// DER prefix that wraps a raw 32-byte Ed25519 public key as SPKI.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function isRawPublicKey(b64: unknown): b64 is string {
  return typeof b64 === 'string' && /^[A-Za-z0-9+/]+=*$/.test(b64) && Buffer.from(b64, 'base64').length === 32;
}

const keyCache = new Map<string, KeyObject>();

function keyFor(b64: string): KeyObject {
  let key = keyCache.get(b64);
  if (!key) {
    key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });
    keyCache.set(b64, key);
  }
  return key;
}

export interface SignedParts {
  ts: string;
  nonce: string;
  method: string;
  /** Path and query exactly as sent, e.g. /dhan/v2/orders. */
  url: string;
  body: Buffer;
}

/** The phone signs this exact string; keep it in step with src/services/relay/RelayService.ts in the app. */
export function canonicalString(p: SignedParts): string {
  const bodyHash = createHash('sha256').update(p.body).digest('hex');
  return `v1\n${p.ts}\n${p.nonce}\n${p.method.toUpperCase()}\n${p.url}\n${bodyHash}`;
}

export function verifySignature(publicKeyB64: string, canonical: string, signatureB64: string): boolean {
  try {
    return verify(null, Buffer.from(canonical, 'utf8'), keyFor(publicKeyB64), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
