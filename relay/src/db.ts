import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Tenant {
  id: number;
  dhan_client_id: string;
  label: string | null;
  status: 'active' | 'suspended';
  created_at: number;
}

export interface Device {
  id: string;
  tenant_id: number;
  public_key: string;
  label: string | null;
  status: 'active' | 'revoked';
  created_at: number;
  last_seen: number | null;
}

export interface IdemRow {
  tenant_id: number;
  correlation_id: string;
  req_hash: string;
  state: 'done' | 'unknown';
  status: number | null;
  content_type: string | null;
  body: Buffer | null;
}

export type RegisterResult =
  | { ok: true; deviceId: string; tenantId: number }
  | { ok: false; error: 'invite' | 'client' | 'suspended' | 'limit' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dhan_client_id TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  public_key TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  label TEXT,
  dhan_client_id TEXT,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE TABLE IF NOT EXISTS idempotency (
  tenant_id INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  req_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  status INTEGER,
  content_type TEXT,
  body BLOB,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, correlation_id)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tenant_id INTEGER,
  device_id TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER,
  egress_ip TEXT,
  note TEXT
);
`;

export const sha256hex = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');

/** Invite codes are shown in groups; compare them without separators or case. */
export const normalizeInvite = (code: string): string => code.toLowerCase().replace(/[^0-9a-f]/g, '');

const DAY = 86_400_000;

export class RelayDb {
  readonly raw: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
  }

  close(): void {
    this.raw.close();
  }

  createInvite(opts: { label?: string; hours: number; dhanClientId?: string; now: number }): string {
    const hex = randomBytes(16).toString('hex');
    this.raw
      .prepare('INSERT INTO invites (code_hash, label, dhan_client_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256hex(hex), opts.label ?? null, opts.dhanClientId ?? null, opts.now + opts.hours * 3_600_000, opts.now);
    return hex.match(/.{4}/g)!.join('-');
  }

  /** Redeems an invite and creates the device (and the tenant, the first time a Dhan account is seen). */
  registerDevice(a: { inviteCode: string; publicKey: string; dhanClientId: string; label: string | null; now: number; maxAccounts?: number }): RegisterResult {
    const hash = sha256hex(normalizeInvite(a.inviteCode));
    const tx = this.raw.transaction((): RegisterResult => {
      const inv = this.raw.prepare('SELECT * FROM invites WHERE code_hash = ?').get(hash) as
        | { used_by: string | null; expires_at: number; dhan_client_id: string | null }
        | undefined;
      if (!inv || inv.used_by || inv.expires_at < a.now) return { ok: false, error: 'invite' };
      if (inv.dhan_client_id && inv.dhan_client_id !== a.dhanClientId) return { ok: false, error: 'client' };

      let tenant = this.raw.prepare('SELECT * FROM tenants WHERE dhan_client_id = ?').get(a.dhanClientId) as Tenant | undefined;
      if (tenant && tenant.status !== 'active') return { ok: false, error: 'suspended' };
      if (!tenant) {
        const accounts = (this.raw.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number }).n;
        if (a.maxAccounts !== undefined && accounts >= a.maxAccounts) return { ok: false, error: 'limit' };
        const info = this.raw
          .prepare('INSERT INTO tenants (dhan_client_id, label, created_at) VALUES (?, ?, ?)')
          .run(a.dhanClientId, a.label, a.now);
        tenant = { id: Number(info.lastInsertRowid) } as Tenant;
      }
      const deviceId = `d_${randomBytes(8).toString('hex')}`;
      this.raw
        .prepare('INSERT INTO devices (id, tenant_id, public_key, label, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(deviceId, tenant.id, a.publicKey, a.label, a.now);
      this.raw.prepare('UPDATE invites SET used_by = ? WHERE code_hash = ?').run(deviceId, hash);
      return { ok: true, deviceId, tenantId: tenant.id };
    });
    return tx();
  }

  getDevice(id: string): (Device & { tenant: Tenant }) | null {
    const d = this.raw.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Device | undefined;
    if (!d) return null;
    const tenant = this.raw.prepare('SELECT * FROM tenants WHERE id = ?').get(d.tenant_id) as Tenant;
    return { ...d, tenant };
  }

  touchDevice(id: string, now: number): void {
    this.raw.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, id);
  }

  /** False when this nonce was already used by the device, i.e. the request is a replay. */
  recordNonce(deviceId: string, nonce: string, ts: number): boolean {
    return this.raw.prepare('INSERT OR IGNORE INTO nonces (device_id, nonce, ts) VALUES (?, ?, ?)').run(deviceId, nonce, ts).changes === 1;
  }

  getIdem(tenantId: number, correlationId: string): IdemRow | null {
    return (
      (this.raw.prepare('SELECT * FROM idempotency WHERE tenant_id = ? AND correlation_id = ?').get(tenantId, correlationId) as IdemRow | undefined) ??
      null
    );
  }

  putIdem(row: IdemRow, now: number): void {
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO idempotency (tenant_id, correlation_id, req_hash, state, status, content_type, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.tenant_id, row.correlation_id, row.req_hash, row.state, row.status, row.content_type, row.body, now);
  }

  audit(e: {
    now: number;
    tenantId: number | null;
    deviceId: string | null;
    method: string;
    path: string;
    status: number;
    latencyMs: number | null;
    egressIp: string | null;
    note?: string;
  }): void {
    this.raw
      .prepare('INSERT INTO audit (ts, tenant_id, device_id, method, path, status, latency_ms, egress_ip, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.now, e.tenantId, e.deviceId, e.method, e.path, e.status, e.latencyMs, e.egressIp, e.note ?? null);
  }

  recentAudit(limit: number, dhanClientId?: string): Array<Record<string, unknown>> {
    const where = dhanClientId ? 'WHERE t.dhan_client_id = ?' : '';
    const sql = `SELECT datetime(a.ts / 1000, 'unixepoch') AS time_utc, t.dhan_client_id, a.device_id, a.method, a.path, a.status, a.latency_ms, a.egress_ip, a.note
      FROM audit a LEFT JOIN tenants t ON t.id = a.tenant_id ${where} ORDER BY a.id DESC LIMIT ?`;
    const stmt = this.raw.prepare(sql);
    return (dhanClientId ? stmt.all(dhanClientId, limit) : stmt.all(limit)) as Array<Record<string, unknown>>;
  }

  purge(now: number): void {
    this.raw.prepare('DELETE FROM nonces WHERE ts < ?').run(now - 10 * 60_000);
    this.raw.prepare('DELETE FROM idempotency WHERE created_at < ?').run(now - 7 * DAY);
    this.raw.prepare('DELETE FROM audit WHERE ts < ?').run(now - 90 * DAY);
  }

  listTenants(): Array<Tenant & { devices: number }> {
    return this.raw
      .prepare('SELECT t.*, (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id) AS devices FROM tenants t ORDER BY t.id')
      .all() as Array<Tenant & { devices: number }>;
  }

  listDevices(): Array<Device & { dhan_client_id: string }> {
    return this.raw
      .prepare('SELECT d.*, t.dhan_client_id FROM devices d JOIN tenants t ON t.id = d.tenant_id ORDER BY d.created_at')
      .all() as Array<Device & { dhan_client_id: string }>;
  }

  setDeviceStatus(id: string, status: 'active' | 'revoked'): boolean {
    return this.raw.prepare('UPDATE devices SET status = ? WHERE id = ?').run(status, id).changes === 1;
  }

  setTenantStatus(dhanClientId: string, status: 'active' | 'suspended'): boolean {
    return this.raw.prepare('UPDATE tenants SET status = ? WHERE dhan_client_id = ?').run(status, dhanClientId).changes === 1;
  }
}
