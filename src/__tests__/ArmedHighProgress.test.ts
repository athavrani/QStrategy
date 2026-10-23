import AsyncStorage from '@react-native-async-storage/async-storage';
import { niftyOptionFeedService as nifty } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService as sensex } from '../services/sensexOptionFeedService';
import { marketData } from '../services/marketdata/MarketDataService';
import { triggerProgressPct } from '../utils/triggerProgress';

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
