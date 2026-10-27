import AsyncStorage from '@react-native-async-storage/async-storage';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';

const row = (ce: number, pe: number, id: string, ageMs = 0) => ({
  ceLtp: ce,
  peLtp: pe,
  ceSecId: `c${id}`,
  peSecId: `p${id}`,
  ceUpdatedTime: Date.now() - ageMs,
  peUpdatedTime: Date.now() - ageMs,
});

describe('NIFTY Re-lock after a successful lock', () => {
  const svc: any = niftyOptionFeedService;
  const today = formatDateKeyIST();

  beforeEach(async () => {
    await niftyOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    svc.chainFeed.chain = { 22650: row(110, 20, '1'), 22700: row(64, 35, '2'), 22750: row(40, 60, '3') };
    svc.lastCandleFetchAt = Date.now();
    niftyOptionFeedService.getOrCreateDayAnchor(22700, '09:21:10 AM');
    await niftyOptionFeedService.retryLock(22700, '11:02:10 AM');
  });
  afterEach(() => jest.restoreAllMocks());

  it('starts from a locked strategy', () => {
    const state = niftyOptionFeedService.evaluateOobtst(22700, '11:02:11 AM');
    expect(state.isLocked).toBe(true);
    expect(state.ceLeg).toMatchObject({ strike: 22700, openPrice: 64 });
  });

  it('selects the strikes again from the latest prices, locks them and arms the trigger from the new price', async () => {
    svc.chainFeed.chain = { 22650: row(62, 20, '1'), 22700: row(90, 35, '2'), 22750: row(40, 52, '3') };

    const result = await niftyOptionFeedService.relock(22700, '11:05:00 AM');
    expect(result).toEqual({ ok: true, message: 'Re-locked at 11:05:00 IST on live prices.' });

    const state = niftyOptionFeedService.evaluateOobtst(22700, '11:05:01 AM');
    expect(state.isLocked).toBe(true);
    expect(state.lockSource).toBe('MANUAL_LIVE');
    expect(state.anchorTime).toBe('11:05:00 IST');
    expect(state.ceLeg).toMatchObject({ strike: 22650, openPrice: 62, triggerPrice: 93 });
    expect(state.peLeg).toMatchObject({ strike: 22750, openPrice: 52, triggerPrice: 78 });
    expect(state.activeLeg).toBeNull();

    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_oobtst_anchor_${today}`))!);
    expect(stored.anchor.ceStrike).toBe(22650);
    expect(stored.anchor.ceOpen).toBe(62);
  });

  it('keeps the new lock for the rest of the session', async () => {
    svc.chainFeed.chain = { 22650: row(62, 20, '1'), 22700: row(90, 35, '2'), 22750: row(40, 52, '3') };
    await niftyOptionFeedService.relock(22700, '11:05:00 AM');
    svc.chainFeed.chain = { 22700: row(64, 35, '2'), 22800: row(62, 60, '4') };
    expect(niftyOptionFeedService.getOrCreateDayAnchor(22700, '11:30:00 AM').ceStrike).toBe(22650);
  });

  it('can be repeated', async () => {
    svc.chainFeed.chain = { 22650: row(62, 20, '1'), 22700: row(90, 35, '2'), 22750: row(40, 52, '3') };
    await niftyOptionFeedService.relock(22700, '11:05:00 AM');
    svc.chainFeed.chain = { 22650: row(80, 20, '1'), 22700: row(66, 35, '2'), 22750: row(40, 58, '3') };
    const result = await niftyOptionFeedService.relock(22700, '11:20:00 AM');
    expect(result.ok).toBe(true);
    expect(niftyOptionFeedService.evaluateOobtst(22700, '11:20:01 AM').ceLeg).toMatchObject({ strike: 22700, openPrice: 66 });
  });

  it('leaves the current lock in place when the latest prices give no eligible strike', async () => {
    svc.chainFeed.chain = { 22700: row(85, 60, '2') }; // above the band but below the 1.5x trigger
    const result = await niftyOptionFeedService.relock(22700, '11:05:00 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Re-lock found no CE priced');
    expect(result.message).toContain('The current lock is unchanged');

    svc.chainFeed.chain = { 22650: row(110, 20, '1'), 22700: row(64, 35, '2'), 22750: row(40, 60, '3') };
    const state = niftyOptionFeedService.evaluateOobtst(22700, '11:05:01 AM');
    expect(state.isLocked).toBe(true);
    expect(state.isLockFailed).toBe(false);
    expect(state.ceLeg).toMatchObject({ strike: 22700, openPrice: 64 });
    expect(state.peLeg).toMatchObject({ strike: 22750, openPrice: 60 });
  });

  it('is refused once a leg has reached its trigger', async () => {
    svc.chainFeed.chain = { 22650: row(110, 20, '1'), 22700: row(100, 35, '2'), 22750: row(40, 60, '3') };
    expect(niftyOptionFeedService.evaluateOobtst(22700, '11:03:00 AM').activeLeg).toBe('CE');

    svc.chainFeed.chain = { 22650: row(62, 20, '1'), 22700: row(70, 35, '2'), 22750: row(40, 52, '3') };
    const result = await niftyOptionFeedService.relock(22700, '11:05:00 AM');
    expect(result).toEqual({ ok: false, message: 'Re-lock is unavailable once a leg has triggered.' });
    expect(niftyOptionFeedService.evaluateOobtst(22700, '11:05:01 AM').ceLeg.strike).toBe(22700);
  });

  it('is refused outside 09:20:05-15:30 IST and when the prices cannot be fetched', async () => {
    expect((await niftyOptionFeedService.relock(22700, '03:35:00 PM')).message).toBe('Re-lock is available from 09:20:05 until 15:30 IST.');

    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(false);
    expect((await niftyOptionFeedService.relock(22700, '11:05:00 AM')).message).toContain('Could not fetch the latest option prices');
  });

  it('has nothing to re-lock while the lock is failed', async () => {
    await niftyOptionFeedService.resetAnchor(true);
    niftyOptionFeedService.getOrCreateDayAnchor(22700, '09:21:10 AM');
    const result = await niftyOptionFeedService.relock(22700, '11:05:00 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Nothing to re-lock');
  });
});

describe('SENSEX Re-lock after a successful lock', () => {
  const svc: any = sensexOptionFeedService;

  beforeEach(async () => {
    await sensexOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    jest.spyOn(sensexOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    svc.cachedLiveOptionChain = { 80900: row(140, 101, '1'), 81000: row(98, 125, '2'), 81100: row(125, 96, '3') };
    svc.lastCandleFetchAt = Date.now();
    sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:21:10 AM');
    await sensexOptionFeedService.retryLock(81000, '10:15:30 AM');
  });
  afterEach(() => jest.restoreAllMocks());

  it('selects the strikes again from the latest prices and locks them', async () => {
    svc.cachedLiveOptionChain = { 80900: row(97, 140, '1'), 81000: row(125, 110, '2'), 81100: row(112, 93, '3') };

    const result = await sensexOptionFeedService.relock(81000, '10:30:00 AM');
    expect(result).toEqual({ ok: true, message: 'Re-locked at 10:30:00 IST on live prices.' });

    const state = sensexOptionFeedService.evaluateSensexOobtst(81000, '10:30:01 AM');
    expect(state.isLocked).toBe(true);
    expect(state.lockSource).toBe('MANUAL_LIVE');
    expect(state.anchorTime).toBe('10:30:00 IST');
    expect(state.ceLeg).toMatchObject({ strike: 80900, openPrice: 97, triggerPrice: 145.5 });
    expect(state.peLeg).toMatchObject({ strike: 81100, openPrice: 93, triggerPrice: 139.5 });
  });

  it('leaves the current lock in place when the latest prices give no eligible strike', async () => {
    svc.cachedLiveOptionChain = { 81000: row(60, 125, '2'), 81100: row(150, 99, '3') };
    const result = await sensexOptionFeedService.relock(81000, '10:30:00 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('The current lock is unchanged');

    const state = sensexOptionFeedService.evaluateSensexOobtst(81000, '10:30:01 AM');
    expect(state.isLocked).toBe(true);
    expect(state.ceLeg).toMatchObject({ strike: 81000, openPrice: 98 });
  });

  it('is refused once a leg has reached its trigger', async () => {
    svc.cachedLiveOptionChain = { 80900: row(140, 101, '1'), 81000: row(150, 125, '2'), 81100: row(125, 96, '3') };
    expect(sensexOptionFeedService.evaluateSensexOobtst(81000, '10:20:00 AM').activeLeg).toBe('CE');

    svc.cachedLiveOptionChain = { 80900: row(97, 140, '1'), 81000: row(125, 110, '2'), 81100: row(112, 93, '3') };
    const result = await sensexOptionFeedService.relock(81000, '10:30:00 AM');
    expect(result).toEqual({ ok: false, message: 'Re-lock is unavailable once a leg has triggered.' });
  });
});

describe('NIFTY 09:25 breakout Re-lock after a successful lock', () => {
  const svc: any = niftyOptionFeedService;
  const today = formatDateKeyIST();

  beforeEach(async () => {
    await niftyOptionFeedService.resetAnchor(true);
    await niftyOptionFeedService.resetBreakout180(true);
    jest.spyOn(niftyOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    niftyOptionFeedService.evaluateBreakout180(24850, '09:25:05 AM');
    svc.chainFeed.chain = { 24800: row(210, 150, '0'), 24850: row(175, 170, '1'), 24900: row(150, 200, '2') };
    await niftyOptionFeedService.retryBreakoutLock(24850, '09:27:30 AM');
  });
  afterEach(() => jest.restoreAllMocks());

  it('selects the strikes again from the latest prices and locks them', async () => {
    svc.chainFeed.chain = { 24800: row(210, 150, '0'), 24850: row(120, 120, '1'), 24900: row(176, 100, '2') };

    const result = await niftyOptionFeedService.relockBreakout(24850, '09:28:10 AM');
    expect(result).toEqual({ ok: true, message: 'Re-locked at 09:28:10 IST on live prices.' });

    const state = niftyOptionFeedService.evaluateBreakout180(24850, '09:28:11 AM');
    expect(state.status).toBe('MONITORING_BREAKOUT');
    expect(state.lockSource).toBe('MANUAL_LIVE');
    expect(state.lockedAt).toBe('09:28:10 IST');
    expect(state.ceCandidate).toMatchObject({ strike: 24900, price0925: 176 });
    expect(state.peCandidate).toMatchObject({ strike: 24800, price0925: 150 });

    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_breakout180_state_${today}`))!);
    expect(stored.isLocked).toBe(true);
    expect(stored.ceStrike).toBe(24900);
  });

  it('leaves the current lock in place, stored and live, when nothing is priced below the threshold', async () => {
    svc.chainFeed.chain = { 24850: row(200, 210, '1') };
    const result = await niftyOptionFeedService.relockBreakout(24850, '09:28:10 AM');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('The current lock is unchanged');

    svc.chainFeed.chain = { 24800: row(210, 150, '0'), 24850: row(175, 170, '1'), 24900: row(150, 200, '2') };
    const state = niftyOptionFeedService.evaluateBreakout180(24850, '09:28:11 AM');
    expect(state.status).toBe('MONITORING_BREAKOUT');
    expect(state.isLockFailed).toBe(false);
    expect(state.ceCandidate).toMatchObject({ strike: 24850, price0925: 175 });

    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_breakout180_state_${today}`))!);
    expect(stored.isLocked).toBe(true);
    expect(stored.isLockFailed).toBe(false);
  });

  it('is refused once a trade has been taken', async () => {
    svc.chainFeed.chain = { 24850: row(185, 170, '1'), 24900: row(150, 200, '2') };
    expect(niftyOptionFeedService.evaluateBreakout180(24850, '09:31:00 AM').activeContract).toBe('CE');

    const result = await niftyOptionFeedService.relockBreakout(24850, '09:32:00 AM');
    expect(result).toEqual({ ok: false, message: 'Re-lock is unavailable once a leg has triggered.' });
  });

  it('is refused outside 09:25-09:45 IST', async () => {
    expect((await niftyOptionFeedService.relockBreakout(24850, '09:50:00 AM')).message).toBe('Re-lock is available from 09:25 until 09:45 IST.');
  });
});
