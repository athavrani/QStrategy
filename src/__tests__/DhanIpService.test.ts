import { DhanIpService, evaluateIpGuard, parseIpConfig } from '../services/dhan/DhanIpService';
import { detectPublicIp, ipsMatch, isValidIp } from '../services/PublicIpService';
import { secureVault } from '../services/SecureCredentialVault';

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    getEffectiveCredentials: jest.fn(async () => ({ clientId: '1100345678', token: 'tok' })),
    updateTelemetry: jest.fn(),
  },
}));

const jsonRes = (data: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

describe('PublicIpService', () => {
  test('validates IPv4 and IPv6 and rejects junk', () => {
    expect(isValidIp('49.36.10.200')).toBe(true);
    expect(isValidIp('2401:4900:1c2a::1')).toBe(true);
    expect(isValidIp('999.1.1.1')).toBe(false);
    expect(isValidIp('hello')).toBe(false);
    expect(isValidIp('')).toBe(false);
  });

  test('compares addresses ignoring case and spacing, never matching empty', () => {
    expect(ipsMatch(' 2401:ABCD::1 ', '2401:abcd::1')).toBe(true);
    expect(ipsMatch('1.2.3.4', '1.2.3.5')).toBe(false);
    expect(ipsMatch('', '')).toBe(false);
    expect(ipsMatch(null, '1.2.3.4')).toBe(false);
  });

  test('detects the public IP and reports failures', async () => {
    const ok = await detectPublicIp(async () => jsonRes({ ip: '49.36.10.200' }));
    expect(ok).toEqual({ ok: true, ip: '49.36.10.200' });

    const bad = await detectPublicIp(async () => jsonRes({ ip: 'nope' }));
    expect(bad.ok).toBe(false);

    const down = await detectPublicIp(async () => jsonRes({}, 503));
    expect(down).toEqual({ ok: false, error: 'IP lookup failed (HTTP 503).' });

    const offline = await detectPublicIp(async () => {
      throw new Error('network');
    });
    expect(offline.ok).toBe(false);
  });
});

describe('DhanIpService', () => {
  const svc = new DhanIpService();
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });

  test('getIp sends a bodyless GET with auth headers and parses the config', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        primaryIP: '49.36.10.200',
        secondaryIP: '',
        modifyDatePrimary: '2026-10-30 10:00:00',
        modifyDateSecondary: '',
      })
    );
    const res = await svc.getIp();
    expect(res).toEqual({
      ok: true,
      data: {
        primaryIP: '49.36.10.200',
        secondaryIP: null,
        modifyDatePrimary: '2026-10-30 10:00:00',
        modifyDateSecondary: null,
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.dhan.co/v2/ip/getIP');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['access-token']).toBe('tok');
  });

  test('whitelist uses setIP for an empty slot and modifyIP for a filled one', async () => {
    fetchMock.mockResolvedValue(jsonRes({ message: 'IP saved', status: 'SUCCESS' }));
    const empty = parseIpConfig({});
    const filled = parseIpConfig({ primaryIP: '1.1.1.1' });

    const first = await svc.whitelist('49.36.10.200', 'PRIMARY', empty);
    expect(first).toEqual({ ok: true, data: 'IP saved' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.dhan.co/v2/ip/setIP');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      dhanClientId: '1100345678',
      ip: '49.36.10.200',
      ipFlag: 'PRIMARY',
    });

    await svc.whitelist('49.36.10.200', 'PRIMARY', filled);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.dhan.co/v2/ip/modifyIP');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
  });

  test('rejects an invalid IP without calling Dhan', async () => {
    const res = await svc.setIp('not-an-ip', 'PRIMARY');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('surfaces Dhan error messages and flags an expired token', async () => {
    fetchMock.mockResolvedValue(jsonRes({ errorMessage: 'IP cannot be modified for 7 days' }, 400));
    const res = await svc.modifyIp('49.36.10.200', 'PRIMARY');
    expect(res).toEqual({ ok: false, status: 400, error: 'IP cannot be modified for 7 days (HTTP 400)' });

    fetchMock.mockResolvedValue(jsonRes({}, 401));
    const expired = await svc.getIp();
    expect(expired.ok).toBe(false);
    expect(secureVault.updateTelemetry).toHaveBeenCalledWith(expect.objectContaining({ status: 'TOKEN_EXPIRED' }));
  });

  test('reports missing credentials and network failures without throwing', async () => {
    (secureVault.getEffectiveCredentials as jest.Mock).mockResolvedValueOnce({ clientId: '', token: '' });
    const none = await svc.getIp();
    expect(none).toEqual({ ok: false, status: 0, error: 'Dhan credentials are not configured.' });

    fetchMock.mockRejectedValue(new Error('offline'));
    const offline = await svc.getIp();
    expect(offline).toEqual({ ok: false, status: 0, error: 'offline' });
  });
});

describe('evaluateIpGuard', () => {
  const cfg = parseIpConfig({ primaryIP: '49.36.10.200' });
  test('covers every state', () => {
    expect(evaluateIpGuard('49.36.10.200', cfg)).toBe('MATCH');
    expect(evaluateIpGuard('49.36.10.201', cfg)).toBe('MISMATCH');
    expect(evaluateIpGuard('49.36.10.200', parseIpConfig({}))).toBe('NOT_WHITELISTED');
    expect(evaluateIpGuard(null, cfg)).toBe('UNKNOWN');
    expect(evaluateIpGuard('49.36.10.200', null)).toBe('UNKNOWN');
    expect(evaluateIpGuard('49.36.10.200', parseIpConfig({ secondaryIP: '49.36.10.200' }))).toBe('MATCH');
  });
});
