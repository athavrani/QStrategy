import AsyncStorage from '@react-native-async-storage/async-storage';
import { niftyOptionFeedService as nifty } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService as sensex } from '../services/sensexOptionFeedService';
import { marketData } from '../services/marketdata/MarketDataService';
import { triggerProgressPct } from '../utils/triggerProgress';
import { formatDateKeyIST } from '../constants/nseHolidays';

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(async () => {
  await AsyncStorage.clear();
  await nifty.resetAnchor(true);
  await nifty.resetBreakout180(true);
  await sensex.resetAnchor(true);
});

describe('triggerProgressPct', () => {
  test('is the high over the trigger, capped at 100 and 0 when unknown', () => {
    expect(triggerProgressPct(80, 93.75)).toBe(85);
    expect(triggerProgressPct(120, 93.75)).toBe(100);
    expect(triggerProgressPct(0, 93.75)).toBe(0);
    expect(triggerProgressPct(80, 0)).toBe(0);
  });
});

describe('09:20 OOBTST NIFTY progress follows the armed high', () => {
  const lock = () => {
    (nifty as any).cachedLiveOptionChain = {
      24850: { ceLtp: 75.0, peLtp: 72.0, ceSecId: '101', peSecId: '102' },
      24900: { ceLtp: 62.5, peLtp: 85.0, ceSecId: '103', peSecId: '104' },
      24800: { ceLtp: 90.0, peLtp: 63.0, ceSecId: '105', peSecId: '106' },
    };
    (nifty as any).candleOpens0920 = {
      date: formatDateKeyIST(),
      opens: { CE_24850: 75.0, CE_24900: 62.5, CE_24800: 90.0, PE_24850: 72.0, PE_24900: 85.0, PE_24800: 63.0 },
      pending: 0,
    };
    nifty.getOrCreateDayAnchor(24850, '09:20:05 AM');
  };

  test('the bar keeps the highest price when the LTP pulls back', () => {
    lock();
    (nifty as any).cachedLiveOptionChain[24900].ceLtp = 80;
    expect(nifty.evaluateOobtst(24850, '09:21:00 AM').ceLeg).toMatchObject({ armedHigh: 80, progressPct: 85 });

    (nifty as any).cachedLiveOptionChain[24900].ceLtp = 70;
    const leg = nifty.evaluateOobtst(24850, '09:22:00 AM').ceLeg;
    expect(leg).toMatchObject({ currentLtp: 70, armedHigh: 80, progressPct: 85 });
  });

  test('the day high comes from the quote and is never below the armed high', () => {
    lock();
    jest.spyOn(marketData, 'getQuote').mockReturnValue({ dayHigh: 88 } as any);
    (nifty as any).cachedLiveOptionChain[24900].ceLtp = 80;
    expect(nifty.evaluateOobtst(24850, '09:21:00 AM').ceLeg.dayHigh).toBe(88);

    jest.spyOn(marketData, 'getQuote').mockReturnValue(undefined);
    expect(nifty.evaluateOobtst(24850, '09:21:30 AM').ceLeg.dayHigh).toBe(80);
  });
});

describe('09:20 OOBTST SENSEX progress follows the armed high', () => {
  const lock = () => {
    (sensex as any).cachedLiveOptionChain = {
      80800: { ceLtp: 95.0, peLtp: 140.0, ceSecId: '201', peSecId: '202' },
      81200: { ceLtp: 140.0, peLtp: 100.0, ceSecId: '203', peSecId: '204' },
    };
    sensex.evaluateSensexOobtst(81000, '09:20:00 AM');
  };

  test('the bar keeps the highest price when the LTP pulls back, without triggering', () => {
    lock();
    (sensex as any).cachedLiveOptionChain[80800].ceLtp = 120;
    expect(sensex.evaluateSensexOobtst(81000, '09:21:00 AM').ceLeg).toMatchObject({ armedHigh: 120, progressPct: 84 });

    (sensex as any).cachedLiveOptionChain[80800].ceLtp = 105;
    const s = sensex.evaluateSensexOobtst(81000, '09:22:00 AM');
    expect(s.ceLeg).toMatchObject({ currentLtp: 105, armedHigh: 120, progressPct: 84 });
    expect(s.activeLeg).toBeNull();
  });

  test('the day high comes from the quote', () => {
    lock();
    jest.spyOn(marketData, 'getQuote').mockReturnValue({ dayHigh: 133 } as any);
    expect(sensex.evaluateSensexOobtst(81000, '09:21:00 AM').ceLeg.dayHigh).toBe(133);
  });
});

describe('09:25 breakout progress follows the high since the 09:30 entry window', () => {
  const setChain = (ce: number) => {
    (nifty as any).cachedLiveOptionChain = {
      24800: { ceLtp: ce, peLtp: 140.0, ceSecId: '301', peSecId: '302' },
      24850: { ceLtp: 165.0, peLtp: 175.2, ceSecId: '303', peSecId: '304' },
    };
  };
  const setCe = (v: number) => {
    (nifty as any).cachedLiveOptionChain[24800].ceLtp = v;
  };

  test('a pre-09:30 spike does not count towards the armed high', () => {
    setChain(178.5);
    nifty.evaluateBreakout180(24800, '09:25:05 AM');
    jest.spyOn(marketData, 'getQuote').mockReturnValue({ dayHigh: 185 } as any);
    setCe(185);
    expect(nifty.evaluateBreakout180(24800, '09:27:00 AM').ceCandidate).toMatchObject({ currentLtp: 185, dayHigh: 185 });

    setCe(170);
    const s = nifty.evaluateBreakout180(24800, '09:30:00 AM');
    expect(s.status).toBe('MONITORING_BREAKOUT');
    expect(s.ceCandidate).toMatchObject({ armedHigh: 170, dayHigh: 185 });
  });

  test('the armed high only rises from 09:30', () => {
    setChain(178.5);
    nifty.evaluateBreakout180(24800, '09:25:05 AM');
    setCe(172);
    nifty.evaluateBreakout180(24800, '09:30:00 AM');
    setCe(177);
    nifty.evaluateBreakout180(24800, '09:33:00 AM');
    setCe(174);
    expect(nifty.evaluateBreakout180(24800, '09:35:00 AM').ceCandidate).toMatchObject({ currentLtp: 174, armedHigh: 177 });
  });
});

describe('Dhan feed subscription codes', () => {
  test('quote subscription is 17 and ticker 15', () => {
    const { DhanFeedRequestCode } = require('../services/dhan/DhanBinaryCodec');
    expect(DhanFeedRequestCode.SUBSCRIBE_TICKER).toBe(15);
    expect(DhanFeedRequestCode.SUBSCRIBE_QUOTE).toBe(17);
  });
});

describe('SENSEX OOBTST day high', () => {
  const lockSensex = () => {
    (sensex as any).cachedLiveOptionChain = {
      80800: { ceLtp: 95.0, peLtp: 140.0, ceSecId: '201', peSecId: '202' },
      81200: { ceLtp: 140.0, peLtp: 100.0, ceSecId: '203', peSecId: '204' },
    };
    sensex.evaluateSensexOobtst(81000, '09:20:00 AM');
  };

  test('a quote packet fills the exchange Day High of a locked leg', () => {
    const { encodeDhanQuotePacket, decodeDhanBinaryPacket } = require('../services/dhan/DhanBinaryCodec');
    lockSensex();
    const packet = decodeDhanBinaryPacket(
      encodeDhanQuotePacket({
        securityId: 201, exchangeSegment: 8, ltp: 100, ltq: 1, ltt: 1729321200, atp: 99, volume: 10,
        totalSellQty: 1, totalBuyQty: 1, dayOpen: 95, dayClose: 0, dayHigh: 133.5, dayLow: 90,
      })
    );
    (marketData as any).snapshots.apply('8:201', packet, Date.now());
    expect(sensex.evaluateSensexOobtst(81000, '09:21:00 AM').ceLeg.dayHigh).toBe(133.5);
  });

  test('Day High follows a rising price after the leg is bought, with no exchange value', () => {
    lockSensex();
    (sensex as any).cachedLiveOptionChain[80800].ceLtp = 145;
    expect(sensex.evaluateSensexOobtst(81000, '09:22:00 AM').activeLeg).toBe('CE');
    (sensex as any).cachedLiveOptionChain[80800].ceLtp = 170;
    const leg = sensex.evaluateSensexOobtst(81000, '09:30:00 AM').ceLeg;
    expect(leg).toMatchObject({ currentLtp: 170, armedHigh: 170, dayHigh: 170 });
    (sensex as any).cachedLiveOptionChain[80800].ceLtp = 160;
    expect(sensex.evaluateSensexOobtst(81000, '09:31:00 AM').ceLeg).toMatchObject({ currentLtp: 160, dayHigh: 170 });
  });
});

describe('locked legs stay streamed and snapshots clear', () => {
  test('pin acquires the locked contracts once and reset releases them', () => {
    const { OptionChainFeed } = require('../services/marketdata/OptionChainFeed');
    const market = { acquire: jest.fn(), release: jest.fn(), isConnected: () => true };
    const feed = new OptionChainFeed(
      {
        owner: 'sx', underlying: 'SENSEX', optionSegment: 'BSE_FNO', fallbackSpot: 81000,
        resolveExpiryYmd: () => '2026-10-30',
        selectCandidates: () => ({ ceCandidates: [], peCandidates: [] }),
      },
      { market }
    );
    feed.chain = { 80800: { ceLtp: 1, peLtp: 1, ceOi: 0, peOi: 0, ceSecId: '201', peSecId: '202' } };
    const legs = [{ strike: 80800, type: 'CE' as const }, { strike: 80800, type: 'PE' as const }];
    feed.pin(legs);
    feed.pin(legs);
    expect(market.acquire).toHaveBeenCalledTimes(1);
    expect(market.acquire).toHaveBeenCalledWith('sx-locked', [
      { exchangeSegment: 'BSE_FNO', securityId: '201' },
      { exchangeSegment: 'BSE_FNO', securityId: '202' },
    ]);
    feed.reset();
    expect(market.release).toHaveBeenCalledWith('sx-locked', expect.any(Array));
  });

  test('clearSnapshots drops yesterday quotes', () => {
    (marketData as any).snapshots.apply('8:301', { exchangeSegment: 8, securityId: 301, dayHigh: 140 }, 1);
    expect(marketData.getQuote('BSE_FNO', '301')?.dayHigh).toBe(140);
    marketData.clearSnapshots();
    expect(marketData.getQuote('BSE_FNO', '301')).toBeUndefined();
  });
});
