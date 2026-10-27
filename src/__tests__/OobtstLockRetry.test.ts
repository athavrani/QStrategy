import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { chooseCandleContracts, clockAfter0920, LockRetry } from '../services/marketdata/candleOpens';

describe('LockRetry', () => {
  it('announces a retry 30 s after the failure and reports it as due once', () => {
    const retry = new LockRetry();
    retry.sync('2026-05-15');
    expect(retry.onFailure(10)).toBe(' Retrying at 09:20:40 IST.');
    expect(retry.due(39)).toBe(false);
    expect(retry.due(40)).toBe(true);
    expect(retry.wide).toBe(true);
    expect(retry.due(41)).toBe(false);
  });

  it('keeps the first failure time when failures are reported repeatedly', () => {
    const retry = new LockRetry();
    retry.sync('2026-05-15');
    retry.onFailure(5);
    expect(retry.onFailure(20)).toBe(' Retrying at 09:20:35 IST.');
  });

  it('schedules no retry that would start after 09:21:00', () => {
    const retry = new LockRetry();
    retry.sync('2026-05-15');
    expect(retry.onFailure(30)).toBe(' Retrying at 09:21:00 IST.');

    const late = new LockRetry();
    late.sync('2026-05-15');
    expect(late.onFailure(31)).toBe('');
    expect(late.due(61)).toBe(false);
  });

  it('starts over on a new trading day', () => {
    const retry = new LockRetry();
    retry.sync('2026-05-15');
    retry.onFailure(10);
    retry.due(40);
    retry.sync('2026-05-18');
    expect(retry.wide).toBe(false);
    expect(retry.attempt).toBe(1);
    expect(retry.onFailure(12)).toBe(' Retrying at 09:20:42 IST.');
  });
});

describe('clockAfter0920', () => {
  it('formats seconds after 09:20:00', () => {
    expect(clockAfter0920(0)).toBe('09:20:00');
    expect(clockAfter0920(40)).toBe('09:20:40');
    expect(clockAfter0920(60)).toBe('09:21:00');
  });
});

describe('chooseCandleContracts', () => {
  const band = { min: 50, max: 75 };
  const all = [
    { key: 'CE_1', secId: '1', liveLtp: 300 },
    { key: 'CE_2', secId: '2', liveLtp: 80 },
    { key: 'CE_3', secId: '3', liveLtp: 0 },
    { key: 'CE_4', secId: '4', liveLtp: 62 },
    { key: 'CE_5', secId: '5', liveLtp: 5 },
  ];

  it('drops contracts far outside the band, keeps unpriced ones, nearest to the target first', () => {
    expect(chooseCandleContracts(all, band, 62.5, false).map((c) => c.key)).toEqual(['CE_4', 'CE_2', 'CE_3']);
  });

  it('keeps every contract when wide, so a retry can reach a stale-priced strike', () => {
    expect(chooseCandleContracts(all, band, 62.5, true).map((c) => c.key)).toEqual(['CE_4', 'CE_2', 'CE_5', 'CE_1', 'CE_3']);
  });
});

describe('NIFTY lock retry timeline', () => {
  const svc: any = niftyOptionFeedService;
  const today = formatDateKeyIST();
  const row = (ce: number, pe: number, id: string) => ({
    ceLtp: ce, peLtp: pe, ceSecId: `c${id}`, peSecId: `p${id}`, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now(),
  });

  beforeEach(async () => {
    await niftyOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    svc.chainFeed.chain = { 22650: row(300, 20, '1'), 22700: row(95, 30, '2'), 22750: row(40, 64, '3') };
    svc.lastCandleFetchAt = Date.now();
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the retry time on a failed lock, retries 30 s later, and locks when the open turns up', () => {
    svc.candleOpens0920 = { date: today, opens: { CE_22650: 300, CE_22700: 95, PE_22750: 64 }, pending: 0 };

    const failed = svc.getOrCreateDayAnchor(22700, '09:20:10 AM');
    expect(failed.isLockFailed).toBe(true);
    expect(failed.lockFailureReason).toContain('Retrying at 09:20:40 IST');

    const retrying = svc.getOrCreateDayAnchor(22700, '09:20:40 AM');
    expect(retrying.isLockFailed).toBe(false);
    expect(retrying.isConfirmed).toBe(false);

    svc.candleOpens0920 = { date: today, opens: { CE_22650: 300, CE_22700: 95, CE_22750: 62, PE_22750: 64 }, pending: 0 };
    const locked = svc.getOrCreateDayAnchor(22700, '09:20:45 AM');
    expect(locked.isConfirmed).toBe(true);
    expect(locked.ceStrike).toBe(22750);
    expect(locked.ceOpen).toBe(62);
  });

  it('does not announce a retry that would start after 09:21:00', () => {
    svc.candleOpens0920 = { date: today, opens: { CE_22650: 300, CE_22700: 95, PE_22750: 64 }, pending: 0 };
    const failed = svc.getOrCreateDayAnchor(22700, '09:20:50 AM');
    expect(failed.isLockFailed).toBe(true);
    expect(failed.lockFailureReason).not.toContain('Retrying');
  });
});
