import AsyncStorage from '@react-native-async-storage/async-storage';
import { dbManager } from '../db/database';
import { dailyStrategyLockService } from '../services/DailyStrategyLockService';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { formatDateKeyIST } from '../constants/nseHolidays';

describe('DailyStrategyLockService — Date-Wise 09:20 & 09:25 Strike Persistence', () => {
  const today = formatDateKeyIST();

  beforeEach(async () => {
    await AsyncStorage.clear();
    const db = await dbManager.getDatabase();
    await db.run('DELETE FROM daily_strategy_locks');
    await niftyOptionFeedService.resetAnchor(true);
    await niftyOptionFeedService.resetBreakout180(true);
    await sensexOptionFeedService.resetAnchor(true);
  });

  describe('1. NIFTY 09:20 OOBTST Lock Persistence & Date-Wise Recall', () => {
    it('should save and reload NIFTY 09:20 locked strikes date-wise across restarts', async () => {
      // Mock option chain data in niftyOptionFeedService
      (niftyOptionFeedService as any).cachedLiveOptionChain = {
        24850: { ceLtp: 75.0, peLtp: 72.0, ceSecId: '101', peSecId: '102' },
        24900: { ceLtp: 62.5, peLtp: 85.0, ceSecId: '103', peSecId: '104' },
        24800: { ceLtp: 90.0, peLtp: 63.0, ceSecId: '105', peSecId: '106' },
      };

      (niftyOptionFeedService as any).candleOpens0920 = {
        date: today,
        opens: { CE_24850: 75.0, CE_24900: 62.5, CE_24800: 90.0, PE_24850: 72.0, PE_24900: 85.0, PE_24800: 63.0 },
        pending: 0,
      };

      const lockedAnchor = niftyOptionFeedService.getOrCreateDayAnchor(24850, '09:20:05 AM');
      expect(lockedAnchor.isConfirmed).toBe(true);
      expect(lockedAnchor.ceStrike).toBe(24900);
      expect(lockedAnchor.peStrike).toBe(24800);

      // Await persistence resolution
      await niftyOptionFeedService.persistLockedAnchor(lockedAnchor);

      // Verify that DailyStrategyLockService stored it in SQLite
      const lockRecord = await dailyStrategyLockService.getLock(today, 'NIFTY_OOBTST');
      expect(lockRecord).not.toBeNull();
      expect(lockRecord!.strategy_id).toBe('NIFTY_OOBTST');
      expect(lockRecord!.ce_strike).toBe(24900);
      expect(lockRecord!.pe_strike).toBe(24800);
      expect(lockRecord!.ce_open_price).toBe(62.5);
      expect(lockRecord!.pe_open_price).toBe(63.0);
      expect(lockRecord!.lock_time).toBe('09:20:05 IST');

      // Simulate App Restart (Clear in-memory cache)
      (niftyOptionFeedService as any).cachedAnchor = null;
      (niftyOptionFeedService as any).peakCeLtp = 0;
      (niftyOptionFeedService as any).peakPeLtp = 0;

      // Rehydrate from store
      const restored = await niftyOptionFeedService.loadPersistedAnchor();
      expect(restored).not.toBeNull();
      expect(restored!.isConfirmed).toBe(true);
      expect(restored!.ceStrike).toBe(24900);
      expect(restored!.peStrike).toBe(24800);
      expect(restored!.ceOpen).toBe(62.5);
      expect(restored!.peOpen).toBe(63.0);
    });
  });

  describe('2. SENSEX 09:20 OOBTST Lock Persistence & Date-Wise Recall', () => {
    it('should save and reload SENSEX 09:20 locked strikes date-wise across restarts', async () => {
      (sensexOptionFeedService as any).cachedLiveOptionChain = {
        81000: { ceLtp: 105.0, peLtp: 102.0, ceSecId: '201', peSecId: '202' },
        81100: { ceLtp: 98.0, peLtp: 115.0, ceSecId: '203', peSecId: '204' },
        80900: { ceLtp: 120.0, peLtp: 99.5, ceSecId: '205', peSecId: '206' },
      };

      const lockedSensex = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:00 AM');
      expect(lockedSensex.isConfirmed).toBe(true);
      expect(lockedSensex.ceStrike).toBe(81100);
      expect(lockedSensex.peStrike).toBe(80900);

      // Await persistence resolution
      await sensexOptionFeedService.persistLockedAnchor(lockedSensex);

      // Verify that DailyStrategyLockService stored it
      const lockRecord = await dailyStrategyLockService.getLock(today, 'SENSEX_OOBTST');
      expect(lockRecord).not.toBeNull();
      expect(lockRecord!.strategy_id).toBe('SENSEX_OOBTST');
      expect(lockRecord!.underlying_symbol).toBe('SENSEX');
      expect(lockRecord!.ce_strike).toBe(81100);
      expect(lockRecord!.pe_strike).toBe(80900);

      // Simulate App Restart
      (sensexOptionFeedService as any).cachedAnchor = null;
      const restored = await sensexOptionFeedService.loadPersistedAnchor();
      expect(restored).not.toBeNull();
      expect(restored!.ceStrike).toBe(81100);
      expect(restored!.peStrike).toBe(80900);
    });
  });

  describe('3. NIFTY 09:25 Breakout 180 Lock Persistence & Date-Wise Recall', () => {
    it('should save and reload NIFTY 09:25 Breakout 180 locked state date-wise', async () => {
      (niftyOptionFeedService as any).cachedLiveOptionChain = {
        24800: { ceLtp: 178.5, peLtp: 140.0, ceSecId: '301', peSecId: '302' },
        24850: { ceLtp: 165.0, peLtp: 175.2, ceSecId: '303', peSecId: '304' },
      };

      const state = niftyOptionFeedService.evaluateBreakout180(24800, '09:25:05 AM');
      expect(state.status).toBe('MONITORING_BREAKOUT');
      expect((niftyOptionFeedService as any).cachedBreakout180?.isLocked).toBe(true);
      expect(state.ceCandidate?.strike).toBe(24800);
      expect(state.peCandidate?.strike).toBe(24800);

      // Await persistence resolution
      await niftyOptionFeedService.persistBreakoutState();

      // Verify DailyStrategyLockService stored it
      const lockRecord = await dailyStrategyLockService.getLock(today, 'NIFTY_BREAKOUT_180');
      expect(lockRecord).not.toBeNull();
      expect(lockRecord!.strategy_id).toBe('NIFTY_BREAKOUT_180');
      expect(lockRecord!.ce_strike).toBe(24800);
      expect(lockRecord!.pe_strike).toBe(24800);
      expect(lockRecord!.ce_open_price).toBe(178.5);
      expect(lockRecord!.pe_open_price).toBe(140.0);

      // Simulate App Restart
      (niftyOptionFeedService as any).cachedBreakout180 = null;
      const restored = await niftyOptionFeedService.loadPersistedBreakoutState();
      expect(restored).not.toBeNull();
      expect(restored.isLocked).toBe(true);
      expect(restored.ceStrike).toBe(24800);
      expect(restored.peStrike).toBe(24800);
    });
  });

  describe('4. Date-Wise Multi-Session Lookup & History Querying', () => {
    it('should support querying locks across distinct trading dates', async () => {
      // Save simulated locks for multiple dates
      await dailyStrategyLockService.saveLock({
        trade_date: '2026-10-19',
        strategy_id: 'NIFTY_OOBTST',
        lock_time: '09:20:00 IST',
        underlying_symbol: 'NIFTY',
        underlying_spot: 24700,
        expiry_str: '20-OCT-2026',
        target_param: 62.5,
        ce_strike: 24800,
        ce_symbol: 'NIFTY 24800 CE',
        ce_open_price: 61.2,
        pe_strike: 24600,
        pe_symbol: 'NIFTY 24600 PE',
        pe_open_price: 63.4,
        status: 'LOCKED',
        raw_payload: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      await dailyStrategyLockService.saveLock({
        trade_date: '2026-10-20',
        strategy_id: 'NIFTY_OOBTST',
        lock_time: '09:20:00 IST',
        underlying_symbol: 'NIFTY',
        underlying_spot: 24850,
        expiry_str: '27-OCT-2026',
        target_param: 62.5,
        ce_strike: 24950,
        ce_symbol: 'NIFTY 24950 CE',
        ce_open_price: 62.0,
        pe_strike: 24750,
        pe_symbol: 'NIFTY 24750 PE',
        pe_open_price: 62.8,
        status: 'LOCKED',
        raw_payload: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Query dates list
      const dates = await dailyStrategyLockService.getAvailableLockDates();
      expect(dates).toContain('2026-10-19');
      expect(dates).toContain('2026-10-20');

      // Query by specific historical date
      const oct19Locks = await dailyStrategyLockService.getLocksForDate('2026-10-19');
      expect(oct19Locks.length).toBe(1);
      expect(oct19Locks[0].ce_strike).toBe(24800);

      const oct20Locks = await dailyStrategyLockService.getLocksForDate('2026-10-20');
      expect(oct20Locks.length).toBe(1);
      expect(oct20Locks[0].ce_strike).toBe(24950);
    });
  });
});
