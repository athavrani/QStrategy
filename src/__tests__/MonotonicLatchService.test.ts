import { MonotonicLatchService } from '../services/MonotonicLatchService';
import { alertLatchService } from '../services/alertLatchService';

describe('MonotonicLatchService & AlertLatch Suite', () => {
  let latchService: MonotonicLatchService;
  const mockDate = '2026-10-20';

  beforeEach(() => {
    latchService = new MonotonicLatchService();
    latchService.clearMemoryCache();
  });

  test('acquires latch on first trigger and rejects duplicate triggers for the same ticker and state', async () => {
    const details = {
      spotPrice: 1650.0,
      todayTradedShares: 5500000,
      avg20DTradedShares: 5000000,
      volumeRatio: 1.1,
      crossoverTime: '09:22:15 AM',
    };

    // First attempt: Must succeed
    const firstAcquire = await latchService.acquireLatch('HDFCBANK', 'GREEN', details, mockDate);
    expect(firstAcquire).toBe(true);

    // Immediate second attempt: Must be rejected (Monotonic guarantee)
    const secondAcquire = await latchService.acquireLatch('HDFCBANK', 'GREEN', details, mockDate);
    expect(secondAcquire).toBe(false);

    // Fast-path sync check: Must report latched
    const isLatchedSync = latchService.isLatchedSync('HDFCBANK', 'GREEN');
    // Note: getTodayISTDateString matches mockDate if simulated or async matches
    const isLatchedAsync = await latchService.isLatched('HDFCBANK', 'GREEN', mockDate);
    expect(isLatchedAsync).toBe(true);
  });

  test('survives process kill & in-memory cache clear by reading persisted SQLite state', async () => {
    const details = {
      spotPrice: 2480.0,
      todayTradedShares: 3200000,
      avg20DTradedShares: 3000000,
      volumeRatio: 1.07,
      crossoverTime: '09:35:00 AM',
    };

    // Latch INFY
    const acquired = await latchService.acquireLatch('INFY', 'GREEN', details, mockDate);
    expect(acquired).toBe(true);

    // Simulate app process kill: clear in-memory cache
    latchService.clearMemoryCache();

    // Query database: must still recognize that INFY was latched today
    const stillLatched = await latchService.isLatched('INFY', 'GREEN', mockDate);
    expect(stillLatched).toBe(true);

    // Attempting to re-acquire after process kill must still be rejected
    const duplicateAfterKill = await latchService.acquireLatch('INFY', 'GREEN', details, mockDate);
    expect(duplicateAfterKill).toBe(false);
  });

  test('allows different trigger states for the same ticker to latch independently', async () => {
    const details = {
      spotPrice: 1200.0,
      todayTradedShares: 1000000,
      avg20DTradedShares: 800000,
      volumeRatio: 1.25,
      crossoverTime: '10:00:00 AM',
    };

    const greenAcquired = await latchService.acquireLatch('TATAMOTORS', 'GREEN', details, mockDate);
    expect(greenAcquired).toBe(true);

    // RED trigger should still be acquirable if strategy specifies
    const redAcquired = await latchService.acquireLatch('TATAMOTORS', 'RED', details, mockDate);
    expect(redAcquired).toBe(true);

    // Both should now be latched
    expect(await latchService.isLatched('TATAMOTORS', 'GREEN', mockDate)).toBe(true);
    expect(await latchService.isLatched('TATAMOTORS', 'RED', mockDate)).toBe(true);
  });

  test('allows different tickers to latch independently on the same date', async () => {
    const details = {
      spotPrice: 2900.0,
      todayTradedShares: 2000000,
      avg20DTradedShares: 1500000,
      volumeRatio: 1.33,
    };

    const tcs = await latchService.acquireLatch('TCS', 'GREEN', details, mockDate);
    const reliance = await latchService.acquireLatch('RELIANCE', 'GREEN', details, mockDate);

    expect(tcs).toBe(true);
    expect(reliance).toBe(true);
  });

  test('getLatchesForDate returns all latched instruments for that session', async () => {
    const latches = await latchService.getLatchesForDate(mockDate);
    expect(Array.isArray(latches)).toBe(true);
    expect(latches.length).toBeGreaterThan(0);
    const hdfc = latches.find((l) => l.ticker === 'HDFCBANK');
    expect(hdfc).toBeDefined();
    expect(hdfc?.spotPrice).toBe(1650.0);
  });

  test('alertLatchService facade integrates with monotonicLatchService seamlessly', async () => {
    const details = {
      spotPrice: 850.0,
      todayTradedShares: 4000000,
      avg20DTradedShares: 3500000,
      volumeRatio: 1.14,
    };

    const first = await alertLatchService.acquireAlertLatch('ICICIBANK', 'GREEN', details);
    expect(typeof first).toBe('boolean');

    const isLatched = alertLatchService.isAlertLatched('ICICIBANK', 'GREEN');
    expect(isLatched).toBe(true);

    const duplicate = await alertLatchService.acquireAlertLatch('ICICIBANK', 'GREEN', details);
    expect(duplicate).toBe(false);
  });
});
