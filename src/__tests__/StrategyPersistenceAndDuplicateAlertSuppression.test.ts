import AsyncStorage from '@react-native-async-storage/async-storage';
import { dbManager } from '../db/database';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { alertLatchService } from '../services/alertLatchService';
import { monotonicLatchService } from '../services/MonotonicLatchService';
import { useRadarStore } from '../store/useRadarStore';
import { formatDateKeyIST } from '../constants/nseHolidays';

describe('Production Strategy Persistence & Monotonic Duplicate Alert Suppression', () => {
  const today = alertLatchService.getTodayISTDateString();

  beforeEach(async () => {
    await AsyncStorage.clear();
    const db = await dbManager.getDatabase();
    await db.run('DELETE FROM alert_latches');
    await monotonicLatchService.initialize();
    await niftyOptionFeedService.resetAnchor(true);
    await niftyOptionFeedService.resetBreakout180(true);
    await sensexOptionFeedService.resetAnchor(true);
  });

  describe('1. NIFTY 09:20 OOBTST Anchor Persistence', () => {
    it('should persist locked anchor at 09:20:00 and restore exactly after app restart', async () => {
      // Step 1: Simulate confirmed anchor lock at 09:20:05 AM
      // Mock option chain data in niftyOptionFeedService
      (niftyOptionFeedService as any).cachedLiveOptionChain = {
        24850: { ceLtp: 75.0, peLtp: 72.0, ceSecId: '101', peSecId: '102' },
        24900: { ceLtp: 62.5, peLtp: 85.0, ceSecId: '103', peSecId: '104' },
        24800: { ceLtp: 90.0, peLtp: 63.0, ceSecId: '105', peSecId: '106' },
      };

      (niftyOptionFeedService as any).candleOpens0920 = {
        date: formatDateKeyIST(),
        opens: { CE_24850: 75.0, CE_24900: 62.5, CE_24800: 90.0, PE_24850: 72.0, PE_24900: 85.0, PE_24800: 63.0 },
        pending: 0,
      };

      const lockedAnchor = niftyOptionFeedService.getOrCreateDayAnchor(24850, '09:20:05 AM');
      expect(lockedAnchor.isConfirmed).toBe(true);
      expect(lockedAnchor.ceStrike).toBe(24900);
      expect(lockedAnchor.peStrike).toBe(24800);
      expect(lockedAnchor.ceOpen).toBe(62.5);
      expect(lockedAnchor.peOpen).toBe(63.0);

      // Verify that it was saved to AsyncStorage
      const storedJson = await AsyncStorage.getItem(`@qstrategy_oobtst_anchor_${today}`);
      expect(storedJson).toBeTruthy();
      const parsed = JSON.parse(storedJson!);
      expect(parsed.anchor.ceStrike).toBe(24900);
      expect(parsed.anchor.peStrike).toBe(24800);

      // Step 2: Simulate complete app kill/restart (clear all memory caches)
      (niftyOptionFeedService as any).cachedAnchor = null;
      (niftyOptionFeedService as any).peakCeLtp = 0;
      (niftyOptionFeedService as any).peakPeLtp = 0;

      // Re-hydrate from storage
      const restored = await niftyOptionFeedService.loadPersistedAnchor();
      expect(restored).not.toBeNull();
      expect(restored!.isConfirmed).toBe(true);
      expect(restored!.ceStrike).toBe(24900);
      expect(restored!.peStrike).toBe(24800);
      expect(restored!.ceOpen).toBe(62.5);
      expect(restored!.peOpen).toBe(63.0);

      // Verify that evaluating anchor at 10:30 AM returns the original 09:20 anchor
      const evaluatedLater = niftyOptionFeedService.getOrCreateDayAnchor(25100, '10:30:00 AM');
      expect(evaluatedLater.ceStrike).toBe(24900);
      expect(evaluatedLater.peStrike).toBe(24800);
      expect(evaluatedLater.ceOpen).toBe(62.5);
    });
  });

  describe('2. SENSEX 09:20 OOBTST Anchor Persistence', () => {
    it('should persist locked Sensex anchor and restore after app restart', async () => {
      (sensexOptionFeedService as any).cachedLiveOptionChain = {
        81000: { ceLtp: 105.0, peLtp: 102.0, ceSecId: '201', peSecId: '202' },
        81100: { ceLtp: 98.0, peLtp: 115.0, ceSecId: '203', peSecId: '204' },
        80900: { ceLtp: 120.0, peLtp: 99.5, ceSecId: '205', peSecId: '206' },
      };

      (sensexOptionFeedService as any).candleOpens0920 = {
        date: formatDateKeyIST(),
        opens: { CE_81000: 105.0, CE_81100: 98.0, CE_80900: 120.0, PE_81000: 102.0, PE_81100: 115.0, PE_80900: 99.5 },
        pending: 0,
      };

      const locked = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:05 AM');
      expect(locked.isConfirmed).toBe(true);
      expect(locked.ceStrike).toBe(81100);
      expect(locked.peStrike).toBe(80900);

      // Verify AsyncStorage
      const storedJson = await AsyncStorage.getItem(`@qstrategy_sensex_oobtst_anchor_${today}`);
      expect(storedJson).toBeTruthy();

      // Simulate App Restart
      (sensexOptionFeedService as any).cachedAnchor = null;
      const restored = await sensexOptionFeedService.loadPersistedAnchor();
      expect(restored).not.toBeNull();
      expect(restored!.ceStrike).toBe(81100);
      expect(restored!.peStrike).toBe(80900);
    });
  });

  describe('3. NIFTY 09:25 Breakout 180 State Persistence', () => {
    it('should persist locked candidate strikes and entry execution across app restarts', async () => {
      (niftyOptionFeedService as any).cachedLiveOptionChain = {
        24800: { ceLtp: 178.5, peLtp: 140.0, ceSecId: '301', peSecId: '302' },
        24850: { ceLtp: 165.0, peLtp: 175.2, ceSecId: '303', peSecId: '304' },
      };

      // 09:25:00 Strike lock evaluation
      const state1 = niftyOptionFeedService.evaluateBreakout180(24800, '09:25:05 AM');
      expect(state1.status).toBe('MONITORING_BREAKOUT');
      expect(state1.ceCandidate?.strike).toBe(24800);
      expect(state1.ceCandidate?.price0925).toBe(178.5);

      // Verify AsyncStorage state
      const savedState = await AsyncStorage.getItem(`@qstrategy_breakout180_state_${today}`);
      expect(savedState).toBeTruthy();
      const parsedState = JSON.parse(savedState!);
      expect(parsedState.isLocked).toBe(true);
      expect(parsedState.ceStrike).toBe(24800);

      // Simulate trade entry breakout > 180.00
      (niftyOptionFeedService as any).cachedLiveOptionChain[24800].ceLtp = 182.5;
      const state2 = niftyOptionFeedService.evaluateBreakout180(24800, '09:30:00 AM');
      expect(state2.status).toBe('IN_TRADE');
      expect(state2.activeContract).toBe('CE');
      expect(state2.entryPrice).toBe(182.5);

      // Simulate App Kill & Restart
      (niftyOptionFeedService as any).cachedBreakout180 = null;

      // Restore
      const restoredState = await niftyOptionFeedService.loadPersistedBreakoutState();
      expect(restoredState).not.toBeNull();
      expect(restoredState.isLocked).toBe(true);
      expect(restoredState.triggeredSide).toBe('CE');
      expect(restoredState.entryPrice).toBe(182.5);

      // Subsequent evaluation at 09:35 AM maintains active trade state
      const state3 = niftyOptionFeedService.evaluateBreakout180(24800, '09:35:00 AM');
      expect(state3.status).toBe('IN_TRADE');
      expect(state3.activeContract).toBe('CE');
      expect(state3.entryPrice).toBe(182.5);
    });
  });

  describe('4. Monotonic Duplicate Alert Suppression on App Restart', () => {
    it('should suppress duplicate alerts for 09:25 Breakout across restarts', async () => {
      const lockKey = 'BREAKOUT_180_24800_CE';

      // 1. First trigger during morning session
      expect(alertLatchService.isAlertLatched(lockKey, 'GREEN')).toBe(false);
      const acquired1 = await alertLatchService.acquireAlertLatch(lockKey, 'GREEN', {
        spotPrice: 181.5,
        todayTradedShares: 0,
        avg20DTradedShares: 0,
        volumeRatio: 1,
        crossoverTime: '09:26:10 AM',
        strategyId: 'NIFTY_BREAKOUT_180',
      });
      expect(acquired1).toBe(true);

      // Latch is active
      expect(alertLatchService.isAlertLatched(lockKey, 'GREEN')).toBe(true);

      // 2. Simulate user closing app and reopening 30 minutes later (memory cache cleared)
      monotonicLatchService.clearMemoryCache();
      // On app init:
      await alertLatchService.initialize();

      // Memory cache is rehydrated from SQLite
      expect(alertLatchService.isAlertLatched(lockKey, 'GREEN')).toBe(true);

      // Attempting to re-acquire latch must fail
      const acquired2 = await alertLatchService.acquireAlertLatch(lockKey, 'GREEN', {
        spotPrice: 185.0,
        todayTradedShares: 0,
        avg20DTradedShares: 0,
        volumeRatio: 1,
        crossoverTime: '09:56:00 AM',
        strategyId: 'NIFTY_BREAKOUT_180',
      });
      expect(acquired2).toBe(false); // Duplicate alert suppressed!
    });
  });

  describe('5. Signal Journal Hydration on App Restart', () => {
    it('should restore session latches into Signal Journal after app restart', async () => {
      // Record 2 alerts in SQLite
      await alertLatchService.acquireAlertLatch('TCS', 'GREEN', {
        spotPrice: 3500.0,
        todayTradedShares: 1500000,
        avg20DTradedShares: 1000000,
        volumeRatio: 1.5,
        crossoverTime: '09:22:00 AM',
        strategyId: '20D_CROSSOVER',
      });

      await alertLatchService.acquireAlertLatch('BREAKOUT_180_24800_CE', 'GREEN', {
        spotPrice: 182.0,
        todayTradedShares: 0,
        avg20DTradedShares: 0,
        volumeRatio: 1,
        crossoverTime: '09:27:00 AM',
        strategyId: 'NIFTY_BREAKOUT_180',
      });

      // Clear memory cache to simulate restart
      monotonicLatchService.clearMemoryCache();
      useRadarStore.setState({ journal: [], latchServiceInitialized: false });

      // Run refreshAll to trigger initialization and journal hydration
      await useRadarStore.getState().refreshAll(false);

      const storeJournal = useRadarStore.getState().journal;
      expect(storeJournal.length).toBeGreaterThanOrEqual(2);

      const breakoutEntry = storeJournal.find((j) => j.strategyId === 'NIFTY_BREAKOUT_180');
      expect(breakoutEntry).toBeDefined();
      expect(breakoutEntry?.entryPrice).toBe(182.0);

      const crossoverEntry = storeJournal.find((j) => j.symbol === 'TCS');
      expect(crossoverEntry).toBeDefined();
      expect(crossoverEntry?.signalType).toBe('BUY');
    });
  });
});
