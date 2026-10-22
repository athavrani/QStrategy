import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
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

  it('keeps waiting for fresh quotes after 09:20:00 instead of locking on stale prices', () => {
    const old = now - 30_000;
    svc.chainFeed.chain = {
      22950: { ceLtp: 62.5, peLtp: 60, ceSecId: 'c2', peSecId: 'p2', ceUpdatedTime: old, peUpdatedTime: old },
    };
    const early = svc.getOrCreateDayAnchor(22990, '09:20:03 AM');
    expect(early.isConfirmed).toBe(false);
    expect(early.isLockFailed).toBe(false);
    expect(early.isProvisional).toBe(true);
  });

  it('locks once both quotes are fresh and never replaces the lock', () => {
    svc.chainFeed.chain = {
      22950: { ceLtp: 62.5, peLtp: 60, ceSecId: 'c2', peSecId: 'p2', ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
    };
    const locked = svc.getOrCreateDayAnchor(22990, '09:20:04 AM');
    expect(locked.isConfirmed).toBe(true);
    expect(locked.ceStrike).toBe(22950);
    expect(locked.ceTrigger).toBeCloseTo(93.75, 2);

    svc.chainFeed.chain = {
      23100: { ceLtp: 62.5, peLtp: 62.5, ceSecId: 'c9', peSecId: 'p9', ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
    };
    expect(svc.getOrCreateDayAnchor(23100, '09:31:00 AM').ceStrike).toBe(22950);
  });

  it('fails the lock when quotes stay stale past the retry window', () => {
    const old = Date.now() - 60_000;
    svc.chainFeed.chain = {
      22950: { ceLtp: 62.5, peLtp: 60, ceSecId: 'c2', peSecId: 'p2', ceUpdatedTime: old, peUpdatedTime: old },
    };
    const a = svc.getOrCreateDayAnchor(22990, '09:21:00 AM');
    expect(a.isLockFailed).toBe(true);
  });

  it('classifies freshness around the thresholds', () => {
    expect(assessLockFreshness([100, LOCK_MAX_QUOTE_AGE_MS], 1)).toBe('FRESH');
    expect(assessLockFreshness([LOCK_MAX_QUOTE_AGE_MS + 1], 1)).toBe('WAIT');
    expect(assessLockFreshness([LOCK_MAX_QUOTE_AGE_MS + 1], LOCK_RETRY_WINDOW_SEC)).toBe('STALE');
    expect(assessLockFreshness([undefined], 1)).toBe('WAIT');
  });
});
