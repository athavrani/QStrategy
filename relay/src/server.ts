import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { RelayConfig } from './config.js';
import { canonicalString, isRawPublicKey, verifySignature } from './auth.js';
import { RelayDb, sha256hex, type Device, type Tenant } from './db.js';
import { TokenBucket } from './limiter.js';
import { isSafeTarget, matchRoute } from './policy.js';
import { UpstreamError, type Upstream } from './upstream.js';

export interface Deps {
  config: RelayConfig;
  db: RelayDb;
  upstream: Upstream;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: boolean;
}

interface Result {
  status: number;
  contentType: string;
  body: Buffer;
  note?: string;
}

type Authed = { ok: true; device: Device; tenant: Tenant } | { ok: false; result: Result };

const PREFIX = '/dhan/v2';
const CLIENT_ID_RE = /^\d{5,12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,40}$/;

const failure = (status: number, code: string, message: string, note?: string): Result => ({
  status,
  contentType: 'application/json',
  // Same shape Dhan uses, so the app's error parser reads relay errors too. The relay never returns 401, which is Dhan's token-expired signal.
  body: Buffer.from(JSON.stringify({ status: 'failure', errorType: 'RELAY_ERROR', errorCode: code, errorMessage: message })),
  note,
});

const header = (req: FastifyRequest, name: string): string | null => {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
};

export function buildApp(deps: Deps): FastifyInstance {
  const { config, db, upstream } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const app = Fastify({
    logger: deps.logger ? { level: 'info' } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 65_536,
  });

  // Bodies stay raw so the signature covers exactly the bytes the phone sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const tenantBucket = new TokenBucket(config.tenantRatePerSec, Math.ceil(config.tenantRatePerSec * 1.25), now);
  const globalBucket = new TokenBucket(config.globalRatePerSec, config.globalRatePerSec, now);
  const registerBucket = new TokenBucket(10 / 60, 10, now);
  const inflight = new Map<string, { hash: string; promise: Promise<Result> }>();

  const rawBody = (req: FastifyRequest): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

  const send = (reply: FastifyReply, r: Result, extra: Record<string, string> = {}) => {
    reply.code(r.status).header('content-type', r.contentType);
    for (const [k, v] of Object.entries(extra)) reply.header(k, v);
    return reply.send(r.body);
  };

  function authenticate(req: FastifyRequest): Authed {
    const deviceId = header(req, 'x-relay-device');
    const ts = header(req, 'x-relay-ts');
    const nonce = header(req, 'x-relay-nonce');
    const sig = header(req, 'x-relay-sig');
    if (!deviceId || !ts || !nonce || !sig || !DEVICE_RE.test(deviceId) || !NONCE_RE.test(nonce)) {
      return { ok: false, result: failure(403, 'RLY-AUTH', 'Missing or malformed relay signature headers.') };
    }
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(now() - t) > config.clockSkewMs) {
      return { ok: false, result: failure(403, 'RLY-CLOCK', 'The phone clock differs from the relay clock by too much. Set the phone to automatic time.') };
    }
    const device = db.getDevice(deviceId);
    if (!device || device.status !== 'active') {
      return { ok: false, result: failure(403, 'RLY-AUTH', 'This device is not registered or has been revoked.') };
    }
    if (device.tenant.status !== 'active') {
      return { ok: false, result: failure(403, 'RLY-SUSPENDED', 'This account is suspended on the relay.') };
    }
    const canonical = canonicalString({ ts, nonce, method: req.method, url: req.raw.url ?? '', body: rawBody(req) });
    if (!verifySignature(device.public_key, canonical, sig)) {
      return { ok: false, result: failure(403, 'RLY-AUTH', 'Request signature is not valid.') };
    }
    // Recorded only after the signature checks out, so unsigned traffic cannot fill the table.
    if (!db.recordNonce(device.id, nonce, t)) {
      return { ok: false, result: failure(403, 'RLY-REPLAY', 'This request was already received.') };
    }
    db.touchDevice(device.id, now());
    return { ok: true, device, tenant: device.tenant };
  }

  const upstreamHeaders = (tenant: Tenant, token: string, hasBody: boolean): Record<string, string> => ({
    'access-token': token,
    'client-id': tenant.dhan_client_id,
    dhanClientId: tenant.dhan_client_id,
    accept: 'application/json',
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  });

  /** Looks an order up by correlation id; used when the outcome of a placement is not known. */
  async function recover(correlationId: string, headers: Record<string, string>): Promise<Result | null> {
    await sleep(config.recoveryDelayMs);
    try {
      const up = await upstream.forward({
        method: 'GET',
        path: `/orders/external/${encodeURIComponent(correlationId)}`,
        headers,
        timeoutMs: 3000,
      });
      if (up.status !== 200) return null;
      const parsed = JSON.parse(up.body.toString('utf8'));
      const order = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!order?.orderId) return null;
      return {
        status: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ orderId: String(order.orderId), orderStatus: String(order.orderStatus ?? 'TRANSIT') })),
        note: 'recovered',
      };
    } catch {
      return null;
    }
  }

  app.get('/healthz', async () => ({ ok: true }));

  app.post('/v1/register', async (req, reply) => {
    if (!registerBucket.take(req.ip)) return send(reply, failure(429, 'RLY-RATE', 'Too many attempts. Try again in a minute.'), { 'retry-after': '60' });
    let body: any;
    try {
      body = JSON.parse(rawBody(req).toString('utf8'));
    } catch {
      return send(reply, failure(400, 'RLY-BODY', 'Request body is not valid JSON.'));
    }
    const { inviteCode, publicKey, dhanClientId } = body ?? {};
    const label = typeof body?.label === 'string' ? body.label.slice(0, 40) : null;
    if (typeof inviteCode !== 'string' || !isRawPublicKey(publicKey) || typeof dhanClientId !== 'string' || !CLIENT_ID_RE.test(dhanClientId)) {
      return send(reply, failure(400, 'RLY-BODY', 'inviteCode, publicKey (32-byte Ed25519, base64) and a numeric dhanClientId are required.'));
    }
    const res = db.registerDevice({ inviteCode, publicKey, dhanClientId, label, now: now(), maxAccounts: config.maxAccounts });
    if (!res.ok) {
      const msg =
        res.error === 'client'
          ? 'This invite is for a different Dhan account.'
          : res.error === 'suspended'
            ? 'This account is suspended on the relay.'
            : res.error === 'limit'
              ? `This relay already serves ${config.maxAccounts} Dhan accounts. Ask the admin to raise MAX_ACCOUNTS only if Dhan has approved sharing.`
              : 'The invite code is invalid, expired or already used.';
      return send(reply, failure(403, 'RLY-INVITE', msg));
    }
    db.audit({ now: now(), tenantId: res.tenantId, deviceId: res.deviceId, method: 'POST', path: '/v1/register', status: 200, latencyMs: null, egressIp: null });
    return reply.code(200).send({ deviceId: res.deviceId, egressIp: upstream.cachedEgressIp() });
  });

  app.get('/v1/egress', async (req, reply) => {
    const auth = authenticate(req);
    if (!auth.ok) return send(reply, auth.result);
    if (!tenantBucket.take(`t${auth.tenant.id}`)) return send(reply, failure(429, 'RLY-RATE', 'Too many requests.'), { 'retry-after': '1' });

    const egressIp = await upstream.egressIp();
    let dhan: { primaryIP: string | null; secondaryIP: string | null } | null = null;
    const token = header(req, 'access-token');
    if (token) {
      try {
        const up = await upstream.forward({ method: 'GET', path: '/ip/getIP', headers: upstreamHeaders(auth.tenant, token, false), timeoutMs: 5000 });
        if (up.status === 200) {
          const d = JSON.parse(up.body.toString('utf8'));
          dhan = { primaryIP: d?.primaryIP || null, secondaryIP: d?.secondaryIP || null };
        }
      } catch {
        dhan = null;
      }
    }
    const match = egressIp && dhan ? egressIp === dhan.primaryIP || egressIp === dhan.secondaryIP : null;
    return reply.code(200).send({ egressIp, dhan, match, deviceId: auth.device.id, dhanClientId: auth.tenant.dhan_client_id });
  });

  app.all(`${PREFIX}/*`, async (req, reply) => {
    const started = now();
    const requestId = randomBytes(6).toString('hex');
    const auth = authenticate(req);
    if (!auth.ok) return send(reply, auth.result, { 'x-relay-request-id': requestId });
    const { tenant, device } = auth;

    const finish = (r: Result, path: string): FastifyReply => {
      const latency = now() - started;
      const ip = upstream.cachedEgressIp();
      db.audit({ now: now(), tenantId: tenant.id, deviceId: device.id, method: req.method, path, status: r.status, latencyMs: latency, egressIp: ip, note: r.note });
      return send(reply, r, {
        'x-relay-request-id': requestId,
        'x-relay-latency-ms': String(latency),
        ...(ip ? { 'x-relay-egress-ip': ip } : {}),
        ...(r.note ? { 'x-relay-note': r.note } : {}),
      });
    };

    const rest = (req.raw.url ?? '').slice(PREFIX.length);
    const qi = rest.indexOf('?');
    const path = qi < 0 ? rest : rest.slice(0, qi);
    const query = qi < 0 ? '' : rest.slice(qi);
    const route = isSafeTarget(path, query) ? matchRoute(req.method, path) : null;
    if (!route) return finish(failure(403, 'RLY-PATH', 'This endpoint is not available through the relay.'), path);

    const clientId = header(req, 'client-id') ?? header(req, 'dhanclientid');
    if (clientId !== tenant.dhan_client_id) {
      return finish(failure(403, 'RLY-CLIENT', 'The Dhan client id does not match the one this device is registered for.'), path);
    }
    const token = header(req, 'access-token');
    if (!token) return finish(failure(400, 'RLY-TOKEN', 'The Dhan access token header is missing.'), path);

    if (!globalBucket.take() || !tenantBucket.take(`t${tenant.id}`)) {
      reply.header('retry-after', '1');
      return finish(failure(429, 'RLY-RATE', 'Too many requests. Slow down and retry.'), path);
    }

    const incoming = rawBody(req);
    let outBody: Buffer | undefined;
    let correlationId: string | null = null;
    if (incoming.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(incoming.toString('utf8'));
      } catch {
        return finish(failure(400, 'RLY-BODY', 'Request body is not valid JSON.'), path);
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (obj.dhanClientId !== undefined && String(obj.dhanClientId) !== tenant.dhan_client_id) {
          return finish(failure(403, 'RLY-CLIENT', 'The order names a different Dhan client than this device is registered for.'), path);
        }
        obj.dhanClientId = tenant.dhan_client_id;
        if (config.maxOrderQuantity > 0 && route.write && typeof obj.quantity === 'number' && obj.quantity > config.maxOrderQuantity) {
          return finish(failure(403, 'RLY-LIMIT', `Quantity ${obj.quantity} is above the relay limit of ${config.maxOrderQuantity} per order.`), path);
        }
        if (typeof obj.correlationId === 'string') correlationId = obj.correlationId;
        outBody = Buffer.from(JSON.stringify(obj));
      } else {
        outBody = incoming;
      }
    }

    const headers = upstreamHeaders(tenant, token, outBody !== undefined);
    const idemKey = route.idempotent && correlationId ? `${tenant.id}:${correlationId}` : null;
    const reqHash = sha256hex(`${req.method} ${path} ${sha256hex(incoming)}`);

    if (idemKey && correlationId) {
      const pending = inflight.get(idemKey);
      if (pending) {
        if (pending.hash !== reqHash) return finish(failure(409, 'RLY-IDEM', 'This correlation id is already in use for a different order.'), path);
        return finish({ ...(await pending.promise), note: 'replay' }, path);
      }
      const row = db.getIdem(tenant.id, correlationId);
      if (row) {
        if (row.req_hash !== reqHash) return finish(failure(409, 'RLY-IDEM', 'This correlation id was already used for a different order.'), path);
        if (row.state === 'done' && row.body) {
          return finish({ status: row.status ?? 200, contentType: row.content_type ?? 'application/json', body: row.body, note: 'replay' }, path);
        }
        // An earlier attempt had an unknown outcome: check Dhan before sending the order again.
        const found = await recover(correlationId, headers);
        if (found) {
          db.putIdem({ tenant_id: tenant.id, correlation_id: correlationId, req_hash: reqHash, state: 'done', status: found.status, content_type: found.contentType, body: found.body }, now());
          return finish(found, path);
        }
      }
    }

    const run = async (): Promise<Result> => {
      let result: Result;
      try {
        const up = await upstream.forward({ method: req.method, path: path + query, headers, body: outBody, timeoutMs: config.upstreamTimeoutMs });
        result = { status: up.status, contentType: up.contentType ?? 'application/json', body: up.body };
      } catch (err) {
        const timedOut = err instanceof UpstreamError && err.kind === 'timeout';
        const recovered = correlationId && req.method === 'POST' && route.idempotent ? await recover(correlationId, headers) : null;
        result = recovered ?? (timedOut
          ? failure(504, 'RLY-UPSTREAM-TIMEOUT', 'Dhan did not answer in time. The order may or may not have been placed; look it up by correlation id.')
          : failure(502, 'RLY-UPSTREAM', 'The relay could not reach Dhan.'));
      }

      if (idemKey && correlationId) {
        if (result.status >= 200 && result.status < 300) {
          db.putIdem({ tenant_id: tenant.id, correlation_id: correlationId, req_hash: reqHash, state: 'done', status: result.status, content_type: result.contentType, body: result.body }, now());
        } else if (result.status >= 500) {
          db.putIdem({ tenant_id: tenant.id, correlation_id: correlationId, req_hash: reqHash, state: 'unknown', status: null, content_type: null, body: null }, now());
        }
        // A 4xx means Dhan refused the order, so sending it again is safe and nothing is kept.
      }
      return result;
    };

    const promise = run();
    if (idemKey) inflight.set(idemKey, { hash: reqHash, promise });
    try {
      return finish(await promise, path);
    } finally {
      if (idemKey) inflight.delete(idemKey);
    }
  });

  return app;
}
