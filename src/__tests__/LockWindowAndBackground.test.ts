import AsyncStorage from '@react-native-async-storage/async-storage';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { lockWindowContracts } from '../services/marketdata/candleOpens';
import {
  backgroundTickDelayMs,
  chainSyncIntervalMs,
  isMarketHoursIst,
  istClockString,
} from '../services/marketdata/lockSchedule';

const row = (ce: number, pe: number, id: string) => ({
  ceLtp: ce,
  peLtp: pe,
  ceSecId: ce > 0 || pe > 0 ? `c${id}` : undefined,
  peSecId: ce > 0 || pe > 0 ? `p${id}` : undefined,
  ceUpdatedTime: Date.now(),
  peUpdatedTime: Date.now(),
});

// A one-minute bar whose start is 09:20 IST (epoch seconds are 5h30 behind IST).
const bar0920 = (open: number) => ({ open: [open], start_Time: [9 * 3600 + 20 * 60 - 19800] });

const mockOpens = (opens: Record<string, number>) =>
  jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockImplementation(async (secId: any) => {
    const open = opens[String(secId)];
    return open ? (bar0920(open) as any) : (bar0920(500) as any);
  });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('lockWindowContracts', () => {
  const band = { min: 90, max: 120 };
  const chain: any = {
    81000: row(300, 280, '1'),
    82500: row(99, 3, '2'), // far from spot, CE could open in the band
    84000: row(0, 0, '3'), // far and unpriced
    85000: row(20, 0, '4'), // far and priced out of reach of the band
  };

  it('keeps contracts near spot and far contracts whose live price is in range', () => {
    const keys = lockWindowContracts(chain, 81000, 1000, band).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['CE_81000', 'PE_81000', 'CE_82500']));
  });

  it('drops far contracts that are unpriced or priced too low to open in the band', () => {
    const keys = lockWindowContracts(chain, 81000, 1000, band).map((c) => c.key);
    expect(keys).not.toContain('CE_84000');
    expect(keys).not.toContain('CE_85000');
    expect(keys).not.toContain('PE_82500');
  });
});

describe('SENSEX lock considers the strike nearest ₹100 even when far from spot', () => {
  const svc: any = sensexOptionFeedService;

  beforeEach(async () => {
    await sensexOptionFeedService.resetAnchor(true);
    svc.chainFeed.chain = {
      80200: row(380, 119, '1'),
      79600: row(520, 101, '2'), // 1,400 points below spot, PE closest to 100
      81000: row(300, 280, '3'),
      81800: row(118, 40, '4'),
      82500: row(99, 10, '5'), // 1,500 points above spot, CE closest to 100
    };
    svc.lastCandleFetchAt = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  it('fetches the 09:20 open of far strikes and locks on them', async () => {
    const load = mockOpens({ c1: 380, p1: 119, c2: 520, p2: 101, c3: 300, p3: 280, c4: 118, p4: 40, c5: 99, p5: 10 });
    expect(await svc.refreshCandleOpens0920(81000)).toBe(true);
    expect(load.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['c5', 'p2']));

    const anchor = svc.getOrCreateDayAnchor(81000, '09:20:10 AM');
    expect(anchor.isConfirmed).toBe(true);
    expect(anchor.ceStrike).toBe(82500);
    expect(anchor.ceOpen0920).toBe(99);
    expect(anchor.peStrike).toBe(79600);
    expect(anchor.peOpen0920).toBe(101);
  });
});

describe('SENSEX lock after the app was in the background', () => {
  const svc: any = sensexOptionFeedService;

  beforeEach(async () => {
    await sensexOptionFeedService.resetAnchor(true);
    svc.chainFeed.chain = { 81000: row(98, 102, '1'), 81100: row(80, 125, '2') };
    svc.lastCandleFetchAt = Date.now();
  });
  afterEach(() => jest.restoreAllMocks());

  it('does not declare failure on a late first evaluation before the candle opens were tried', () => {
    const late = svc.getOrCreateDayAnchor(81000, '09:30:00 AM');
    expect(late.isLockFailed).toBe(false);
    expect(late.isProvisionalLock).toBe(true);
  });

  it('fails once a fetch was tried and the opens are still missing', () => {
    svc.candleFetchAttempts = 1;
    expect(svc.getOrCreateDayAnchor(81000, '09:30:00 AM').isLockFailed).toBe(true);
  });

  it('locks on a late evaluation from the 09:20 opens it fetches', async () => {
    mockOpens({ c1: 98, p1: 102, c2: 80, p2: 125 });
    svc.lastCandleFetchAt = 0;
    const first = svc.getOrCreateDayAnchor(81000, '09:30:00 AM');
    expect(first.isConfirmed).toBe(false);
    await svc.candleFetchInflight;
    const anchor = svc.getOrCreateDayAnchor(81000, '09:30:01 AM');
    expect(anchor.isConfirmed).toBe(true);
    expect(anchor.ceStrike).toBe(81000);
    expect(anchor.ceOpen0920).toBe(98);
    expect(anchor.peStrike).toBe(81000);
    expect(anchor.peOpen0920).toBe(102);
  });

  it('uses the 09:20 opens saved earlier without asking Dhan again', async () => {
    mockOpens({ c1: 98, p1: 102, c2: 80, p2: 125 });
    svc.lastCandleFetchAt = 0;
    expect(await svc.refreshCandleOpens0920(81000)).toBe(true);
    await settle();
    const stored = JSON.parse((await AsyncStorage.getItem(`@qstrategy_sensex_candle_opens_0920_${formatDateKeyIST()}`))!);
    expect(stored.opens).toMatchObject({ CE_81000: 98, PE_81000: 102 });

    // The app restarted: nothing in memory, but the saved opens are enough to lock.
    jest.restoreAllMocks();
    const load = jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    svc.candleOpens0920 = null;
    svc.candleFetchAttempts = 0;
    await sensexOptionFeedService.loadPersistedCandleOpens();
    const anchor = svc.getOrCreateDayAnchor(81000, '09:45:00 AM');
    expect(anchor.isConfirmed).toBe(true);
    expect(anchor.ceStrike).toBe(81000);
    expect(load).not.toHaveBeenCalled();
  });

  it('clears the saved opens when the anchor is reset with storage', async () => {
    mockOpens({ c1: 98, p1: 102, c2: 80, p2: 125 });
    svc.lastCandleFetchAt = 0;
    await svc.refreshCandleOpens0920(81000);
    await settle();
    await sensexOptionFeedService.resetAnchor(true);
    expect(await AsyncStorage.getItem(`@qstrategy_sensex_candle_opens_0920_${formatDateKeyIST()}`)).toBeNull();
  });
});

describe('SENSEX Re-lock uses live prices, not the 09:20 candle open', () => {
  const svc: any = sensexOptionFeedService;

  afterEach(() => jest.restoreAllMocks());

  it('locks the strike whose live price is nearest ₹100 even when the 09:20 open pointed elsewhere', async () => {
    await sensexOptionFeedService.resetAnchor(true);
    svc.chainFeed.chain = { 81000: row(98, 102, '1'), 81100: row(80, 125, '2') };
    svc.candleOpens0920 = { date: formatDateKeyIST(), opens: { CE_81000: 98, PE_81000: 102, CE_81100: 118, PE_81100: 91 }, pending: 0 };
    expect(svc.getOrCreateDayAnchor(81000, '09:21:00 AM').isConfirmed).toBe(true);

    jest.spyOn(sensexOptionFeedService, 'syncLiveOptionChain').mockResolvedValue(true);
    svc.chainFeed.chain = { 81000: row(75, 140, '1'), 81100: row(101, 96, '2') };
    const result = await sensexOptionFeedService.relock(81000, '11:05:00 AM');
    expect(result).toEqual({ ok: true, message: 'Re-locked at 11:05:00 IST on live prices.' });
    const anchor = svc.getOrCreateDayAnchor(81000, '11:05:01 AM');
    expect(anchor.ceStrike).toBe(81100);
    expect(anchor.ceOpen0920).toBe(101);
    expect(anchor.peStrike).toBe(81100);
    expect(anchor.peOpen0920).toBe(96);
    expect(anchor.lockSource).toBe('MANUAL_LIVE');
  });
});

describe('NIFTY lock considers the strike nearest ₹62.50 even when far from spot', () => {
  const svc: any = niftyOptionFeedService;

  beforeEach(async () => {
    await niftyOptionFeedService.resetAnchor(true);
    svc.chainFeed.chain = {
      22700: row(150, 120, '1'),
      22750: row(110, 85, '2'),
      23400: row(63, 5, '3'), // 700 points above spot, outside the 10 strikes around it
      22000: row(700, 61, '4'), // 700 points below spot
    };
    svc.lastCandleFetchAt = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  it('ranks the live preview on every strike in the chain', () => {
    const r = svc.selectTopTwoCandidates(22700, 62.5);
    expect(r.ceCandidates[0].strike).toBe(23400);
    expect(r.peCandidates[0].strike).toBe(22000);
  });

  it('fetches the 09:20 open of far strikes and locks on them', async () => {
    const load = mockOpens({ c1: 150, p1: 120, c2: 110, p2: 85, c3: 63, p3: 5, c4: 700, p4: 61 });
    expect(await svc.refreshCandleOpens0920(22700)).toBe(true);
    expect(load.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['c3', 'p4']));
    const anchor = svc.getOrCreateDayAnchor(22700, '09:20:10 AM');
    expect(anchor.isConfirmed).toBe(true);
    expect(anchor.ceStrike).toBe(23400);
    expect(anchor.peStrike).toBe(22000);
  });

  it('keeps the lock provisional on a late first evaluation until a fetch was tried', () => {
    svc.lastCandleFetchAt = Date.now();
    const late = svc.getOrCreateDayAnchor(22700, '09:30:00 AM');
    expect(late.isLockFailed).toBe(false);
    expect(late.isProvisional).toBe(true);
  });

  it('restores saved 09:20 opens after a restart', async () => {
    mockOpens({ c1: 150, p1: 120, c2: 110, p2: 85, c3: 63, p3: 5, c4: 700, p4: 61 });
    await svc.refreshCandleOpens0920(22700);
    await settle();
    jest.restoreAllMocks();
    const load = jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    svc.candleOpens0920 = null;
    svc.candleFetchAttempts = 0;
    await niftyOptionFeedService.loadPersistedCandleOpens();
    expect(svc.getOrCreateDayAnchor(22700, '09:45:00 AM').ceStrike).toBe(23400);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('lock schedule helpers', () => {
  it('formats IST wall-clock time, including across midnight', () => {
    expect(istClockString(new Date(Date.UTC(2026, 10, 3, 3, 50, 5)))).toBe('09:20:05 IST');
    expect(istClockString(new Date(Date.UTC(2026, 10, 3, 19, 0, 0)))).toBe('00:30:00 IST');
  });

  it('wakes the background task every second around 09:20 and every five seconds otherwise', () => {
    expect(backgroundTickDelayMs(new Date(Date.UTC(2026, 10, 3, 3, 50, 5)))).toBe(1000);
    expect(backgroundTickDelayMs(new Date(Date.UTC(2026, 10, 3, 4, 30, 0)))).toBe(5000);
  });
});

describe('chain refresh schedule', () => {
  const at = (h: number, m: number, sec = 0) => h * 3600 + m * 60 + sec;

  it('refreshes every 2 s from 09:19:00 to 09:21:10, every 8 s through the day, and never outside market hours', () => {
    expect(chainSyncIntervalMs(at(9, 18, 59))).toBe(8000);
    expect(chainSyncIntervalMs(at(9, 19, 0))).toBe(2000);
    expect(chainSyncIntervalMs(at(9, 21, 10))).toBe(2000);
    expect(chainSyncIntervalMs(at(9, 21, 11))).toBe(8000);
    expect(chainSyncIntervalMs(at(15, 30))).toBe(8000);
    expect(chainSyncIntervalMs(at(15, 31))).toBeNull();
    expect(chainSyncIntervalMs(at(8, 59))).toBeNull();
    expect(chainSyncIntervalMs(null)).toBeNull();
  });

  it('starts waking the background task every second from 09:18:50', () => {
    expect(backgroundTickDelayMs(new Date(Date.UTC(2026, 10, 3, 3, 49, 0)))).toBe(1000);
    expect(backgroundTickDelayMs(new Date(Date.UTC(2026, 10, 3, 3, 48, 40)))).toBe(5000);
  });

  it('knows market hours in IST and skips weekends', () => {
    expect(isMarketHoursIst(new Date(Date.UTC(2026, 10, 3, 3, 50, 0)))).toBe(true); // Tue 09:20 IST
    expect(isMarketHoursIst(new Date(Date.UTC(2026, 10, 3, 10, 5, 0)))).toBe(false); // 15:35 IST
    expect(isMarketHoursIst(new Date(Date.UTC(2026, 10, 7, 3, 50, 0)))).toBe(false); // Saturday
  });
});
