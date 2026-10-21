import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  calcChangePct,
  isReasonableChangePct,
  safeChangePct,
  resolvePrevClose,
  MAX_REASONABLE_CHANGE_PCT,
} from '../utils/marketDataUtils';
import { avgVolumeService } from '../services/AvgVolumeService';
import { dhanHqRestClient } from '../services/dhan/DhanHqRestClient';
import { dhanDirectService } from '../services/dhanDirectService';

describe('Market Data Utilities: Percentage Change & Bounds', () => {
  test('calcChangePct computes standard 2-decimal percentage change', () => {
    // Normal 1.5% gain
    expect(calcChangePct(1015, 1000)).toBe(1.5);
    // Normal -2% loss
    expect(calcChangePct(980, 1000)).toBe(-2.0);
    // Invalid inputs return null
    expect(calcChangePct(0, 1000)).toBeNull();
    expect(calcChangePct(1000, 0)).toBeNull();
    expect(calcChangePct(-100, 1000)).toBeNull();
  });

  test('isReasonableChangePct enforces MAX_REASONABLE_CHANGE_PCT (25%) circuit bound', () => {
    expect(isReasonableChangePct(0)).toBe(true);
    expect(isReasonableChangePct(5.5)).toBe(true);
    expect(isReasonableChangePct(-19.8)).toBe(true);
    expect(isReasonableChangePct(25.0)).toBe(true);
    expect(isReasonableChangePct(-25.0)).toBe(true);

    // Beyond 25% circuit limit
    expect(isReasonableChangePct(25.01)).toBe(false);
    expect(isReasonableChangePct(-25.1)).toBe(false);
    expect(isReasonableChangePct(1900)).toBe(false);
    expect(isReasonableChangePct(-95)).toBe(false);
    expect(isReasonableChangePct(NaN)).toBe(false);
    expect(isReasonableChangePct(Infinity)).toBe(false);
  });

  test('safeChangePct returns fallback when percentage is unreasonable or invalid', () => {
    // Valid case: 2% change
    expect(safeChangePct(102, 100, 0)).toBe(2);

    // Issue 3: ADANI ENT 1900% scenario — live LTP 135 vs stale catalog 2692 (-95% change)
    // Must return fallback value (0.00% or existing safe change)
    expect(safeChangePct(135, 2692, 0)).toBe(0);
    expect(safeChangePct(135, 2692, 1.25)).toBe(1.25);

    // Opposite scenario: Stale catalog 135 vs live LTP 2692 (+1894% change)
    expect(safeChangePct(2692, 135, 0)).toBe(0);

    // Edge case: prevClose = 0 returns fallback
    expect(safeChangePct(100, 0, 0)).toBe(0);
  });
});

describe('Market Data Utilities: Canonical resolvePrevClose() Priority Hierarchy', () => {
  const catalogDefault = 2500;
  const cachedPrevClose = 2490;

  test('Priority 1: Derives from net_change when available and valid', () => {
    const ltp = 2550;
    const rawNetChange = 50; // prevClose = 2550 - 50 = 2500
    const resolved = resolvePrevClose(
      ltp,
      rawNetChange,
      { previous_close: 2480, close: 2470 },
      cachedPrevClose,
      catalogDefault
    );
    expect(resolved).toBe(2500);
  });

  test('Priority 2: Uses explicit previous_close when net_change is 0', () => {
    const ltp = 2500;
    const resolved = resolvePrevClose(
      ltp,
      0,
      { previous_close: 2495, prev_close: 2480 },
      cachedPrevClose,
      catalogDefault
    );
    expect(resolved).toBe(2495);
  });

  test('Priority 3: Uses prev_close when previous_close is missing', () => {
    const ltp = 2500;
    const resolved = resolvePrevClose(
      ltp,
      0,
      { prev_close: 2492 },
      cachedPrevClose,
      catalogDefault
    );
    expect(resolved).toBe(2492);
  });

  test('Priority 4: Uses ohlc.close during market hours when different from LTP', () => {
    const ltp = 2500;
    const resolved = resolvePrevClose(
      ltp,
      0,
      { ohlcClose: 2485 },
      cachedPrevClose,
      catalogDefault
    );
    expect(resolved).toBe(2485);
  });

  test('Ignores ohlc.close when it equals LTP (Dhan post-market behavior)', () => {
    const ltp = 2500;
    const resolved = resolvePrevClose(
      ltp,
      0,
      { ohlcClose: 2500 }, // same as LTP
      cachedPrevClose,
      catalogDefault
    );
    // Falls through to cachedPrevClose
    expect(resolved).toBe(cachedPrevClose);
  });

  test('Priority 6 & 7: Rejects stale catalog / cache if change exceeds 25%', () => {
    const splitLtp = 135; // ADANI ENT split price
    const staleCatalog = 2692; // Pre-split baseline
    const staleCache = 2680;

    const resolved = resolvePrevClose(
      splitLtp,
      0,
      {},
      staleCache,
      staleCatalog
    );
    // Both cache and catalog exceed 25% boundary, so resolvePrevClose returns 0 (safe fallback)
    expect(resolved).toBe(0);
  });
});

describe('Issue 1: AvgVolumeService Dynamic 20D Volume Computation', () => {
  const sessionDate = '2026-10-21';

  beforeEach(async () => {
    await avgVolumeService.clearCache();
    jest.clearAllMocks();
  });

  test('computes 20D average volume from daily historical candles', async () => {
    // 20 daily volumes of 1,000,000 to 2,900,000
    const mockDailyVolumes = Array.from({ length: 20 }, (_, i) => 1000000 + i * 100000);
    const expectedAverage = Math.round(
      mockDailyVolumes.reduce((a, b) => a + b, 0) / mockDailyVolumes.length
    );

    jest.spyOn(dhanHqRestClient, 'fetchHistoricalDaily').mockResolvedValue({
      volume: mockDailyVolumes,
      timestamp: mockDailyVolumes.map((_, i) => 1700000000 + i * 86400),
    });

    const result = await avgVolumeService.getAvgVolume('RELIANCE', sessionDate, 2000000);
    expect(result.ticker).toBe('RELIANCE');
    expect(result.avg20DVolume).toBe(expectedAverage);
    expect(result.sessionCount).toBe(20);
    expect(result.fromCache).toBe(false);

    // Second call should return from AsyncStorage cache
    const cachedResult = await avgVolumeService.getAvgVolume('RELIANCE', sessionDate, 2000000);
    expect(cachedResult.fromCache).toBe(true);
    expect(cachedResult.avg20DVolume).toBe(expectedAverage);
  });

  test('falls back to 1-minute intraday bars aggregated by day when daily endpoint unavailable', async () => {
    jest.spyOn(dhanHqRestClient, 'fetchHistoricalDaily').mockResolvedValue(null);

    // Simulate 3 trading days of 1-minute candles
    // Day 1: 5 bars of 10,000 each = 50,000
    // Day 2: 5 bars of 20,000 each = 100,000
    const day1Epoch = 1700000000; // Day 1
    const day2Epoch = 1700086400; // Day 2 (+24h)

    const volumes: number[] = [10000, 10000, 10000, 10000, 10000, 20000, 20000, 20000, 20000, 20000];
    const timestamps: number[] = [
      day1Epoch, day1Epoch + 60, day1Epoch + 120, day1Epoch + 180, day1Epoch + 240,
      day2Epoch, day2Epoch + 60, day2Epoch + 120, day2Epoch + 180, day2Epoch + 240,
    ];

    jest.spyOn(dhanHqRestClient, 'fetchHistoricalIntraday').mockResolvedValue({
      volume: volumes,
      start_Time: timestamps,
    });

    const result = await avgVolumeService.getAvgVolume('TCS', sessionDate, 1500000);
    // Day 1 total = 50,000; Day 2 total = 100,000. Average = (50,000 + 100,000) / 2 = 75,000
    expect(result.avg20DVolume).toBe(75000);
    expect(result.sessionCount).toBe(2);
  });

  test('falls back to catalog baseline on total API failure', async () => {
    jest.spyOn(dhanHqRestClient, 'fetchHistoricalDaily').mockRejectedValue(new Error('Network error'));
    jest.spyOn(dhanHqRestClient, 'fetchHistoricalIntraday').mockRejectedValue(new Error('Network error'));

    const catalogFallback = 2600000;
    const result = await avgVolumeService.getAvgVolume('ADANIENT', sessionDate, catalogFallback);
    expect(result.avg20DVolume).toBe(catalogFallback);
    expect(result.sessionCount).toBe(0);
  });
});

describe('Issue 4: dhanDirectService Session-Date Reset & Sanity Rejection', () => {
  test('updatePrevClose rejects unreasonable values against live LTP', () => {
    // Current catalog baseline for ADANIENT
    const catalogPrev = dhanDirectService.getPrevClose('ADANIENT');
    expect(catalogPrev).toBe(2692.0);

    // Attempt to update with a garbage value (e.g. 10.0 when LTP is 2600 — 25900% change)
    dhanDirectService.updatePrevClose('ADANIENT', 10.0, 2600);
    // Value must be rejected; baseline remains 2692.0
    expect(dhanDirectService.getPrevClose('ADANIENT')).toBe(2692.0);

    // Update with a reasonable value (e.g. 2650 when LTP is 2600 — -1.89% change)
    dhanDirectService.updatePrevClose('ADANIENT', 2650.0, 2600);
    expect(dhanDirectService.getPrevClose('ADANIENT')).toBe(2650.0);
  });
});
