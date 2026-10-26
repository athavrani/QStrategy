import { niftyOptionFeedService, candleOpenAt0920 } from '../services/niftyOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { assessLockFreshness, LOCK_MAX_QUOTE_AGE_MS, LOCK_RETRY_WINDOW_SEC } from '../services/marketdata/lockFreshness';

describe('NIFTY strike ranking and 09:20 lock', () => {
  const svc: any = niftyOptionFeedService;
  const now = Date.now();

  beforeEach(() => {
    svc.cachedAnchor = null;
  });

  it('picks the closest premium on both sides even when it is just inside ATM', () => {
    svc.chainFeed.chain = {
      22900: { ceLtp: 95, peLtp: 38, ceSecId: 'c1', peSecId: 'p1', ceUpdatedTime: now, peUpdatedTime: now },
      22950: { ceLtp: 62.5, peLtp: 52, ceSecId: 'c2', peSecId: 'p2', ceUpdatedTime: now, peUpdatedTime: now },
      23000: { ceLtp: 48, peLtp: 64, ceSecId: 'c3', peSecId: 'p3', ceUpdatedTime: now, peUpdatedTime: now },
      23100: { ceLtp: 20, peLtp: 110, ceSecId: 'c4', peSecId: 'p4', ceUpdatedTime: now, peUpdatedTime: now },
    };
    // Spot 22,990 rounds to ATM 23,000, which used to exclude the 22950 CE.
    const r = svc.selectTopTwoCandidates(22990, 62.5);
    expect(r.ceCandidates[0].strike).toBe(22950);
    expect(r.peCandidates[0].strike).toBe(23000);
  });

  it('ranks a mirrored PE just above ATM correctly', () => {
    svc.chainFeed.chain = {
      23050: { ceLtp: 30, peLtp: 62.5, ceSecId: 'c1', peSecId: 'p1', ceUpdatedTime: now, peUpdatedTime: now },
      22950: { ceLtp: 80, peLtp: 40, ceSecId: 'c2', peSecId: 'p2', ceUpdatedTime: now, peUpdatedTime: now },
    };
    const r = svc.selectTopTwoCandidates(23010, 62.5);
    expect(r.peCandidates[0].strike).toBe(23050);
  });

  describe('09:20:05 lock on the 09:20 candle open', () => {
    const today = formatDateKeyIST();
    // Live LTPs here are deliberately wrong (the reported bug): 22750 CE looks closest, 22650 CE looks far.
    const chain = () => ({
      22650: { ceLtp: 120, peLtp: 20, ceSecId: 'c1', peSecId: 'p1', ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
      22700: { ceLtp: 95, peLtp: 30, ceSecId: 'c2', peSecId: 'p2', ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
      22750: { ceLtp: 62.5, peLtp: 45, ceSecId: 'c3', peSecId: 'p3', ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
    });
    const opens = (o: Record<string, number>) => ({ date: today, opens: o, pending: 0 });

    beforeEach(() => {
      svc.candleOpens0920 = null;
      svc.lastCandleFetchAt = Date.now(); // keeps the background fetch quiet unless a test resets it
      svc.chainFeed.chain = chain();
    });

    it('does not lock before 09:20:05', () => {
      svc.candleOpens0920 = opens({ CE_22650: 67, PE_22750: 60 });
      const a = svc.getOrCreateDayAnchor(22700, '09:20:04 AM');
      expect(a.isConfirmed).toBe(false);
      expect(a.isLockFailed).toBe(false);
      expect(a.isProvisional).toBe(true);
    });

    it('waits while the candle opens are still being fetched', () => {
      const a = svc.getOrCreateDayAnchor(22700, '09:20:30 AM');
      expect(a.isConfirmed).toBe(false);
      expect(a.isLockFailed).toBe(false);
      expect(a.isProvisional).toBe(true);
    });

    it('locks the strike whose 09:20 candle open is closest to 62.5, ignoring live LTP', () => {
      svc.candleOpens0920 = opens({ CE_22650: 67, CE_22700: 52, CE_22750: 41, PE_22650: 20, PE_22700: 30, PE_22750: 64 });
      const a = svc.getOrCreateDayAnchor(22700, '09:20:05 AM');
      expect(a.isConfirmed).toBe(true);
      expect(a.ceStrike).toBe(22650);
      expect(a.ceOpen).toBe(67);
      expect(a.peStrike).toBe(22750);
      expect(a.ceTrigger).toBeCloseTo(100.5, 2);
      expect(a.lockAudit?.opensCe[0]).toEqual({ strike: 22650, open: 67 });
    });

    it('ignores candle opens outside the 50-75 band and fails the lock', () => {
      svc.candleOpens0920 = opens({ CE_22650: 80, CE_22750: 41, PE_22750: 60 });
      const a = svc.getOrCreateDayAnchor(22700, '09:20:10 AM');
      expect(a.isConfirmed).toBe(false);
      expect(a.isLockFailed).toBe(true);
      expect(a.lockFailureReason).toMatch(/No CE/);
    });

    it('fails once the candle opens are still missing after the deadline', () => {
      const a = svc.getOrCreateDayAnchor(22700, '09:21:10 AM');
      expect(a.isLockFailed).toBe(true);
      expect(a.lockFailureReason).toMatch(/unavailable/);
    });

    it('never replaces a confirmed lock', () => {
      svc.candleOpens0920 = opens({ CE_22650: 67, PE_22750: 60 });
      expect(svc.getOrCreateDayAnchor(22700, '09:20:06 AM').ceStrike).toBe(22650);
      svc.candleOpens0920 = opens({ CE_22700: 62.5, PE_22700: 62.5 });
      expect(svc.getOrCreateDayAnchor(22700, '09:31:00 AM').ceStrike).toBe(22650);
    });

    it('reads the 09:20 bar only, in IST epoch seconds', () => {
      const day = Date.UTC(2026, 9, 26) / 1000;
      const t0920 = day + (9 * 3600 + 20 * 60) - 19800;
      expect(candleOpenAt0920({ open: [50, 67], start_Time: [t0920 - 60, t0920] })).toBe(67);
      expect(candleOpenAt0920({ open: [50], start_Time: [t0920 - 60] })).toBe(0);
      expect(candleOpenAt0920({ open: [67] })).toBe(0);
      expect(candleOpenAt0920(null)).toBe(0);
    });

    it('fetches the window contracts and retries only the ones that failed', async () => {
      const day = Date.UTC(2026, 9, 26) / 1000;
      const t0920 = day + (9 * 3600 + 20 * 60) - 19800;
      svc.lastCandleFetchAt = 0;
      const fetch = jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockImplementation(async (secId: any) =>
        secId === 'c1' && fetch.mock.calls.filter((c) => c[0] === 'c1').length === 1
          ? null
          : ({ open: [67], start_Time: [t0920] } as any)
      );
      expect(await svc.refreshCandleOpens0920(22700)).toBe(false);
      expect(svc.candleOpens0920.pending).toBe(1);
      svc.lastCandleFetchAt = 0;
      expect(await svc.refreshCandleOpens0920(22700)).toBe(true);
      expect(fetch.mock.calls.filter((c) => c[0] === 'c1')).toHaveLength(2);
      expect(fetch.mock.calls.filter((c) => c[0] === 'c2')).toHaveLength(1);
      fetch.mockRestore();
    });
  });

  it('classifies freshness around the thresholds', () => {
    expect(assessLockFreshness([100, LOCK_MAX_QUOTE_AGE_MS], 1)).toBe('FRESH');
    expect(assessLockFreshness([LOCK_MAX_QUOTE_AGE_MS + 1], 1)).toBe('WAIT');
    expect(assessLockFreshness([LOCK_MAX_QUOTE_AGE_MS + 1], LOCK_RETRY_WINDOW_SEC)).toBe('STALE');
    expect(assessLockFreshness([undefined], 1)).toBe('WAIT');
  });
});
