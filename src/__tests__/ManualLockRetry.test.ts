import AsyncStorage from '@react-native-async-storage/async-storage';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { canRetryLock, pickFreshInBand, openAtOrAfter, candleOpenAt0920 } from '../services/marketdata/candleOpens';

const row = (ce: number, pe: number, id: string, ageMs = 0) => ({
  ceLtp: ce,
  peLtp: pe,
  ceSecId: `c${id}`,
  peSecId: `p${id}`,
  ceUpdatedTime: Date.now() - ageMs,
  peUpdatedTime: Date.now() - ageMs,
});

const DAY = Date.UTC(2026, 9, 26) / 1000;
/** One-minute bars as Dhan returns them: epoch start times, with the given opens at the given IST minutes. */
const bars = (minutes: Record<string, number>) => {
  const entries = Object.entries(minutes).map(([hhmm, open]) => {
    const [h, m] = hhmm.split(':').map(Number);
    return { ts: DAY + h * 3600 + m * 60 - 19800, open };
  });
  return { open: entries.map((e) => e.open), start_Time: entries.map((e) => e.ts) };
};

describe('lock-minute pickers', () => {
  it('takes the 09:20 open, else the 09:21 open, else nothing', () => {
    const pick = openAtOrAfter(9 * 3600 + 20 * 60);
    expect(pick(bars({ '09:20': 60, '09:21': 70 }))).toBe(60);
    expect(pick(bars({ '09:21': 70 }))).toBe(70);
    expect(pick(bars({ '09:19': 50, '09:22': 80 }))).toBe(0);
    expect(pick(null)).toBe(0);
    expect(candleOpenAt0920(bars({ '09:21': 70 }))).toBe(0);
  });
});

describe('canRetryLock / pickFreshInBand', () => {
  it('allows a retry from 09:20:05 until the market closes', () => {
    expect(canRetryLock(9 * 3600 + 20 * 60 + 4)).toBe(false);
    expect(canRetryLock(9 * 3600 + 20 * 60 + 5)).toBe(true);
    expect(canRetryLock(15 * 3600 + 29 * 60 + 59)).toBe(true);
    expect(canRetryLock(15 * 3600 + 30 * 60)).toBe(false);
  });

  it('skips stale and out-of-band prices', () => {
    const c = (ltp: number, quoteAgeMs: number) => ({ rank: 1 as const, type: 'CE' as const, strike: 1, symbol: 's', ltp, diffFromTarget: 0, quoteTimestamp: '', quoteAgeMs, isStale: false });
    const band = { min: 50, max: 75 };
    expect(pickFreshInBand([c(60, 20000), c(80, 0), c(70, 100)], band)?.ltp).toBe(70);
    expect(pickFreshInBand([c(60, 20000), c(80, 0)], band)).toBeNull();
  });
});

describe('NIFTY Retry after a failed lock', () => {
  const svc: any = niftyOptionFeedService;
  const today = formatDateKeyIST();

  beforeEach(async () => {
    await niftyOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    // Live prices at the moment of the retry; the 09:20 candle opens were never available.
    svc.chainFeed.chain = { 22650: row(110, 20, '1'), 22700: row(64, 35, '2'), 22750: row(40, 60, '3') };
    svc.lastCandleFetchAt = Date.now();
    niftyOptionFeedService.getOrCreateDayAnchor(22700, '09:21:10 AM');
  });
  afterEach(() => jest.restoreAllMocks());

  it('locks on the 09:20 candle open (else the 09:21 one) when Dhan returns it, not on the live price', async () => {
    const byContract: Record<string, ReturnType<typeof bars>> = {
      c1: bars({ '09:20': 62 }), // CE 22650: live 110, opened 62
      c2: bars({ '09:20': 80 }), // CE 22700: live 64 but opened out of band
      c3: bars({ '09:21': 55 }), // CE 22750: no 09:20 bar, the 09:21 open counts
      p1: bars({}),
      p2: bars({ '09:20': 40 }),
      p3: bars({ '09:20': 60 }),
    };
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockImplementation(async (secId) => byContract[String(secId)] as any);

    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result).toEqual({ ok: true, message: 'Locked at 11:02:10 IST on the 09:20/09:21 candle open.' });

    const state = niftyOptionFeedService.evaluateOobtst(22700, '11:02:11 AM');
    expect(state.lockSource).toBe('MANUAL_CANDLE');
    expect(state.ceLeg).toMatchObject({ strike: 22650, openPrice: 62, triggerPrice: 93 });
    expect(state.peLeg).toMatchObject({ strike: 22750, openPrice: 60, triggerPrice: 90 });
    expect(state.anchorTime).toBe('11:02:10 IST');
  });

  it('asks Dhan for the 09:20-09:22 window of every contract', async () => {
    const load = jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(load).toHaveBeenCalledWith(expect.any(String), `${today} 09:20:00`, `${today} 09:22:00`, 'NSE_FNO', 'OPTIDX', '1');
    expect(load).toHaveBeenCalledTimes(12); // 6 contracts, a failed answer is asked once more
  });

  it('falls back to live prices when some contracts give no candle answer', async () => {
    jest
      .spyOn(dhanDirectService, 'fetchHistoricalIntraday')
      .mockImplementation(async (secId) => (String(secId) === 'c2' ? (null as any) : (bars({ '09:20': 62 }) as any)));

    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result.message).toBe('Locked at 11:02:10 IST on live prices.');
    expect(niftyOptionFeedService.evaluateOobtst(22700, '11:02:11 AM').lockSource).toBe('MANUAL_LIVE');
  });

  it('falls back to live prices when the candle opens are all outside the band', async () => {
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(bars({ '09:20': 150 }) as any);
    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result.message).toBe('Locked at 11:02:10 IST on live prices.');
  });

  it('starts out failed', () => {
    expect(niftyOptionFeedService.evaluateOobtst(22700, '09:21:10 AM').isLockFailed).toBe(true);
  });

  it('locks the strikes nearest the target on the latest prices and arms the 1.5x trigger from them', async () => {
    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result).toEqual({ ok: true, message: 'Locked at 11:02:10 IST on live prices.' });

    const state = niftyOptionFeedService.evaluateOobtst(22700, '11:02:11 AM');
    expect(state.isLocked).toBe(true);
    expect(state.isLockFailed).toBe(false);
    expect(state.lockSource).toBe('MANUAL_LIVE');
    expect(state.anchorTime).toBe('11:02:10 IST');
    expect(state.ceLeg).toMatchObject({ strike: 22700, openPrice: 64, triggerPrice: 96 });
    expect(state.peLeg).toMatchObject({ strike: 22750, openPrice: 60, triggerPrice: 90 });
    expect(state.activeLeg).toBeNull();
  });

  it('keeps that lock for the rest of the session and stores it with its source', async () => {
    await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    svc.chainFeed.chain = { 22700: row(52, 35, '2'), 22800: row(62, 35, '4') };
    expect(niftyOptionFeedService.getOrCreateDayAnchor(22700, '11:30:00 AM').ceStrike).toBe(22700);

    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_oobtst_anchor_${today}`))!);
    expect(stored.anchor.lockSource).toBe('MANUAL_LIVE');
    expect(stored.anchor.confirmedAt).toBe('11:02:10 IST');
    expect(stored.anchor.lockAudit.source).toBe('MANUAL_LIVE');
  });

  it('answers a retry on an already locked strategy without locking again', async () => {
    await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(await niftyOptionFeedService.retryLock(22700, '11:03:00 AM')).toEqual({ ok: true, message: 'Already locked for today.' });
  });

  it('stays failed and says why when no strike is priced in the band right now', async () => {
    svc.chainFeed.chain = { 22650: row(140, 20, '1'), 22700: row(110, 35, '2'), 22750: row(40, 60, '3') };
    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Retry found no CE priced');
    expect(niftyOptionFeedService.evaluateOobtst(22700, '11:02:11 AM').isLocked).toBe(false);
  });

  it('does not lock on prices older than a few seconds', async () => {
    svc.chainFeed.chain = { 22700: row(64, 60, '2', 60000) };
    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result.ok).toBe(false);
    expect(niftyOptionFeedService.evaluateOobtst(22700, '11:02:11 AM').isLocked).toBe(false);
  });

  it('reports a failed price fetch instead of locking on old prices', async () => {
    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(false);
    const result = await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not fetch the latest option prices');
  });

  it('is refused outside 09:20:05-15:30 IST', async () => {
    expect((await niftyOptionFeedService.retryLock(22700, '09:10:00 AM')).ok).toBe(false);
    expect((await niftyOptionFeedService.retryLock(22700, '03:35:00 PM')).message).toContain('09:20:05 until 15:30');
  });

  it('shares one retry between rapid taps', async () => {
    const [a, b] = [niftyOptionFeedService.retryLock(22700, '11:02:10 AM'), niftyOptionFeedService.retryLock(22700, '11:02:10 AM')];
    expect(a).toBe(b);
    expect((await a).ok).toBe(true);
    expect(niftyOptionFeedService.syncLiveOptionChain).toHaveBeenCalledTimes(1);
  });
});

describe('SENSEX Retry after a failed lock', () => {
  const svc: any = sensexOptionFeedService;
  const today = formatDateKeyIST();

  beforeEach(async () => {
    await sensexOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    jest.spyOn(sensexOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    svc.cachedLiveOptionChain = { 80900: row(140, 101, '1'), 81000: row(98, 125, '2'), 81100: row(125, 96, '3') };
    svc.lastCandleFetchAt = Date.now();
    sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:21:10 AM');
  });
  afterEach(() => jest.restoreAllMocks());

  it('locks the strikes nearest the target on the latest prices and records the source', async () => {
    expect(sensexOptionFeedService.evaluateSensexOobtst(81000, '09:21:10 AM').isLockFailed).toBe(true);

    const result = await sensexOptionFeedService.retryLock(81000, '10:15:30 AM');
    expect(result).toEqual({ ok: true, message: 'Locked at 10:15:30 IST on live prices.' });

    const state = sensexOptionFeedService.evaluateSensexOobtst(81000, '10:15:31 AM');
    expect(state.isLocked).toBe(true);
    expect(state.lockSource).toBe('MANUAL_LIVE');
    expect(state.anchorTime).toBe('10:15:30 IST');
    expect(state.ceLeg).toMatchObject({ strike: 81000, openPrice: 98, triggerPrice: 147 });
    expect(state.peLeg).toMatchObject({ strike: 80900, openPrice: 101, triggerPrice: 151.5 });

    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_sensex_oobtst_anchor_${today}`))!);
    expect(stored.lockSource).toBe('MANUAL_LIVE');
  });

  it('stays failed and says why when no strike is priced in the band right now', async () => {
    svc.cachedLiveOptionChain = { 81000: row(60, 125, '2'), 81100: row(150, 99, '3') };
    const result = await sensexOptionFeedService.retryLock(81000, '10:15:30 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Retry found no CE priced');
    expect(sensexOptionFeedService.evaluateSensexOobtst(81000, '10:15:31 AM').isLocked).toBe(false);
  });

  it('locks on the 09:20/09:21 candle open when Dhan returns it', async () => {
    const byContract: Record<string, ReturnType<typeof bars>> = {
      c1: bars({ '09:20': 150 }),
      c2: bars({ '09:21': 104 }), // CE 81000: live 98, 09:21 open 104
      c3: bars({ '09:20': 101 }), // CE 81100: live 125, opened 101
      p1: bars({ '09:20': 99 }),
      p2: bars({ '09:20': 150 }),
      p3: bars({ '09:20': 120 }),
    };
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockImplementation(async (secId) => byContract[String(secId)] as any);

    const result = await sensexOptionFeedService.retryLock(81000, '10:15:30 AM');
    expect(result.message).toBe('Locked at 10:15:30 IST on the 09:20/09:21 candle open.');

    const state = sensexOptionFeedService.evaluateSensexOobtst(81000, '10:15:31 AM');
    expect(state.lockSource).toBe('MANUAL_CANDLE');
    expect(state.ceLeg).toMatchObject({ strike: 81100, openPrice: 101, triggerPrice: 151.5 });
    expect(state.peLeg).toMatchObject({ strike: 80900, openPrice: 99, triggerPrice: 148.5 });
  });

  it('is refused after the market closes', async () => {
    expect((await sensexOptionFeedService.retryLock(81000, '03:35:00 PM')).ok).toBe(false);
  });
});

describe('NIFTY 09:25 breakout Retry after a failed lock', () => {
  const svc: any = niftyOptionFeedService;
  const today = formatDateKeyIST();
  // CE strikes at or above ATM 24850 and PE strikes at or below it compete; the highest premium under 180 wins.
  const liveChain = () => ({
    24800: row(210, 150, '0'),
    24850: row(175, 170, '1'),
    24900: row(150, 200, '2'),
  });

  beforeEach(async () => {
    await niftyOptionFeedService.resetAnchor(true);
    await niftyOptionFeedService.resetBreakout180(true);
    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    expect(niftyOptionFeedService.evaluateBreakout180(24850, '09:25:05 AM').status).toBe('LOCK_FAILED');
    svc.chainFeed.chain = liveChain();
  });
  afterEach(() => jest.restoreAllMocks());

  it('locks on the latest prices when no candle data comes back, and records the source', async () => {
    const result = await niftyOptionFeedService.retryBreakoutLock(24850, '09:27:30 AM');
    expect(result).toEqual({ ok: true, message: 'Locked at 09:27:30 IST on live prices.' });

    const state = niftyOptionFeedService.evaluateBreakout180(24850, '09:27:31 AM');
    expect(state.status).toBe('MONITORING_BREAKOUT');
    expect(state.isLockFailed).toBe(false);
    expect(state.lockSource).toBe('MANUAL_LIVE');
    expect(state.lockedAt).toBe('09:27:30 IST');
    expect(state.lockedThreshold).toBe(180);
    expect(state.ceCandidate).toMatchObject({ strike: 24850, price0925: 175 });
    expect(state.peCandidate).toMatchObject({ strike: 24850, price0925: 170 });

    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_breakout180_state_${today}`))!);
    expect(stored.isLocked).toBe(true);
    expect(stored.isLockFailed).toBe(false);
    expect(stored.lockSource).toBe('MANUAL_LIVE');
  });

  it('locks on the 09:25 candle open (else the 09:26 one) when Dhan returns it', async () => {
    const byContract: Record<string, ReturnType<typeof bars>> = {
      c1: bars({ '09:25': 182 }), // CE 24850: live 175 but opened above 180
      c2: bars({ '09:26': 178 }), // CE 24900: live 150, 09:26 open 178
      p0: bars({ '09:25': 160 }),
      p1: bars({ '09:25': 171 }),
    };
    const load = jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockImplementation(async (secId) => byContract[String(secId)] as any);

    const result = await niftyOptionFeedService.retryBreakoutLock(24850, '09:27:30 AM');
    expect(result).toEqual({ ok: true, message: 'Locked at 09:27:30 IST on the 09:25/09:26 candle open.' });
    expect(load).toHaveBeenCalledWith(expect.any(String), `${today} 09:25:00`, `${today} 09:27:00`, 'NSE_FNO', 'OPTIDX', '1');

    const state = niftyOptionFeedService.evaluateBreakout180(24850, '09:27:31 AM');
    expect(state.lockSource).toBe('MANUAL_CANDLE');
    expect(state.ceCandidate).toMatchObject({ strike: 24900, price0925: 178 });
    expect(state.peCandidate).toMatchObject({ strike: 24850, price0925: 171 });
  });

  it('keeps the lock for the session', async () => {
    await niftyOptionFeedService.retryBreakoutLock(24850, '09:27:30 AM');
    svc.chainFeed.chain = { 24850: row(120, 120, '1'), 24900: row(176, 100, '2') };
    expect(niftyOptionFeedService.evaluateBreakout180(24850, '09:28:00 AM').ceCandidate).toMatchObject({ strike: 24850, price0925: 175 });
    expect(await niftyOptionFeedService.retryBreakoutLock(24850, '09:28:10 AM')).toEqual({ ok: true, message: 'Already locked for today.' });
  });

  it('stays failed and says why when nothing is priced below the threshold', async () => {
    svc.chainFeed.chain = { 24850: row(200, 210, '1') };
    const result = await niftyOptionFeedService.retryBreakoutLock(24850, '09:27:30 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Retry found no CE or PE priced below');
    expect(niftyOptionFeedService.evaluateBreakout180(24850, '09:27:31 AM').status).toBe('LOCK_FAILED');
  });

  it('is refused outside 09:25-09:45 IST and when the prices cannot be fetched', async () => {
    expect((await niftyOptionFeedService.retryBreakoutLock(24850, '09:20:00 AM')).message).toBe('Retry is available from 09:25 until 09:45 IST.');
    expect((await niftyOptionFeedService.retryBreakoutLock(24850, '09:45:00 AM')).ok).toBe(false);

    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(false);
    expect((await niftyOptionFeedService.retryBreakoutLock(24850, '09:27:30 AM')).message).toContain('Could not fetch the latest option prices');
  });
});
