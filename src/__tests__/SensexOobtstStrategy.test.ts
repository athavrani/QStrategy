import {
  SensexOobtstStrategy,
  sensexOobtstStrategy,
  SENSEX_OOBTST_TARGET_PREMIUM,
  SENSEX_OOBTST_RANGE_MIN,
  SENSEX_OOBTST_RANGE_MAX,
  SENSEX_OOBTST_BREAKOUT_MULTIPLIER,
  SENSEX_OOBTST_SL_MULTIPLIER,
} from '../strategies/SensexOobtstStrategy';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { tradingCalendarService } from '../services/TradingCalendarService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';

/** The 09:20 candle opens the lock ranks on, keyed like the service does ("CE_80800"). */
const seedOpens = (opens: Record<string, number>, pending = 0) => {
  (sensexOptionFeedService as any).candleOpens0920 = { date: formatDateKeyIST(), opens, pending };
};

describe('SENSEX 09:20 OOBTST Quantitative Strategy Engine', () => {
  beforeEach(() => {
    sensexOptionFeedService.resetAnchor();
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('Requirement 1 & 2: Premium Eligibility Filtering & Ranking', () => {
    it('strictly enforces 90 <= Premium <= 120 boundary condition', () => {
      const strikes = [
        { strikePrice: 80800, ceLtp: 89.9, peLtp: 85.0 }, // Excluded (< 90)
        { strikePrice: 80900, ceLtp: 90.0, peLtp: 90.0 }, // Included (boundary 90.0)
        { strikePrice: 81000, ceLtp: 100.0, peLtp: 100.0 }, // Included (exact target)
        { strikePrice: 81100, ceLtp: 120.0, peLtp: 120.0 }, // Included (boundary 120.0)
        { strikePrice: 81200, ceLtp: 120.1, peLtp: 135.0 }, // Excluded (> 120)
      ];

      const result = sensexOobtstStrategy.filterAndRankCandidates(strikes, 100, 90, 120);

      // Should only include 80900 (90.0), 81000 (100.0), and 81100 (120.0)
      expect(result.ceCandidates.length).toBe(2); // Top 2
      expect(result.bestCe?.strike).toBe(81000); // 100 is exact target
      expect(result.bestCe?.distanceToTarget).toBe(0);

      // Verify boundary strikes are ranked next
      const rank2 = result.ceCandidates[1];
      expect([80900, 81100]).toContain(rank2.strike);
      expect(rank2.distanceToTarget).toBe(10); // |90-100| or |120-100|
    });

    it('ranks eligible candidates by smallest absolute distance from ₹100', () => {
      const strikes = [
        { strikePrice: 80800, ceLtp: 92.5, ceBid: 92.0, ceAsk: 93.0 }, // diff: 7.5
        { strikePrice: 80900, ceLtp: 98.0, ceBid: 97.5, ceAsk: 98.5 }, // diff: 2.0 (Best)
        { strikePrice: 81000, ceLtp: 105.0, ceBid: 104.5, ceAsk: 105.5 }, // diff: 5.0 (Second)
        { strikePrice: 81100, ceLtp: 115.0, ceBid: 114.0, ceAsk: 116.0 }, // diff: 15.0
      ];

      const result = sensexOobtstStrategy.filterAndRankCandidates(strikes, 100);

      expect(result.ceCandidates.length).toBe(2);
      expect(result.ceCandidates[0].strike).toBe(80900);
      expect(result.ceCandidates[0].distanceToTarget).toBe(2.0);
      expect(result.ceCandidates[1].strike).toBe(81000);
      expect(result.ceCandidates[1].distanceToTarget).toBe(5.0);
    });

    it('resolves ties using tighter valid bid-ask spread', () => {
      // Both strikes have distance = 5.0 from 100
      const strikes = [
        { strikePrice: 80900, ceLtp: 95.0, ceBid: 93.0, ceAsk: 97.0 }, // spread = 4.0
        { strikePrice: 81100, ceLtp: 105.0, ceBid: 104.5, ceAsk: 105.5 }, // spread = 1.0 (Tighter spread wins)
      ];

      const result = sensexOobtstStrategy.filterAndRankCandidates(strikes, 100);

      expect(result.bestCe?.strike).toBe(81100);
      expect(result.bestCe?.bidAskSpread).toBe(1.0);
    });

    it('resolves secondary ties using consistent strike ordering', () => {
      // Both strikes have distance = 5.0 and spread = 1.0
      const ceStrikes = [
        { strikePrice: 81100, ceLtp: 105.0, ceBid: 104.5, ceAsk: 105.5 },
        { strikePrice: 80900, ceLtp: 95.0, ceBid: 94.5, ceAsk: 95.5 },
      ];

      const ceResult = sensexOobtstStrategy.filterAndRankCandidates(ceStrikes, 100);
      // For CE, lower strike comes first
      expect(ceResult.bestCe?.strike).toBe(80900);

      const peStrikes = [
        { strikePrice: 80900, peLtp: 95.0, peBid: 94.5, peAsk: 95.5 },
        { strikePrice: 81100, peLtp: 105.0, peBid: 104.5, peAsk: 105.5 },
      ];

      const peResult = sensexOobtstStrategy.filterAndRankCandidates(peStrikes, 100);
      // For PE, higher strike comes first
      expect(peResult.bestPe?.strike).toBe(81100);
    });
  });

  describe('Requirement 3 & 4: Exact 09:20 Strike Lock & 1.5x Breakout', () => {
    it('computes exact 1.5x trigger from 09:20 candle open', () => {
      expect(sensexOobtstStrategy.computeBreakoutTrigger(90.0)).toBe(135.0);
      expect(sensexOobtstStrategy.computeBreakoutTrigger(95.0)).toBe(142.5);
      expect(sensexOobtstStrategy.computeBreakoutTrigger(100.0)).toBe(150.0);
      expect(sensexOobtstStrategy.computeBreakoutTrigger(110.0)).toBe(165.0);
      expect(sensexOobtstStrategy.computeBreakoutTrigger(120.0)).toBe(180.0);
    });

    it('locks selected strikes permanently after 09:20:05 IST', () => {
      // Simulate live candidates
      (sensexOptionFeedService as any).cachedLiveOptionChain = {
        80800: { ceLtp: 95.0, peLtp: 140.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
        81200: { ceLtp: 140.0, peLtp: 102.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
      };
      seedOpens({ CE_80800: 95, CE_81200: 140, PE_80800: 140, PE_81200: 102 });

      const anchor = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:05 AM');
      expect(anchor.isConfirmed).toBe(true);
      expect(anchor.ceStrike).toBe(80800);
      expect(anchor.peStrike).toBe(81200);
      expect(anchor.ceTriggerPrice).toBe(142.5); // 95 * 1.5
      expect(anchor.peTriggerPrice).toBe(153.0); // 102 * 1.5

      // Even if market later moves, locked anchor never replaces strikes
      (sensexOptionFeedService as any).cachedLiveOptionChain = {
        80900: { ceLtp: 100.0, peLtp: 100.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
      };

      const lockedAnchor = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:22:00 AM');
      expect(lockedAnchor.ceStrike).toBe(80800);
      expect(lockedAnchor.peStrike).toBe(81200);
    });

    it('fails lock and reports LOCK_FAILED when candle opens stay unavailable', () => {
      (sensexOptionFeedService as any).cachedLiveOptionChain = {}; // Empty quotes

      const waiting = sensexOptionFeedService.evaluateSensexOobtst(81000, '09:20:30 AM');
      expect(waiting.isLockFailed).toBe(false);
      expect(waiting.isProvisional).toBe(true);

      const state = sensexOptionFeedService.evaluateSensexOobtst(81000, '09:21:10 AM');
      expect(state.isLockFailed).toBe(true);
      expect(state.status).toBe('LOCK_FAILED');
      expect(state.statusBadgeText).toContain('LOCK FAILED');
    });

    describe('lock on the 09:20 candle open', () => {
      const live = (ce: Record<number, number>, pe: Record<number, number>) => {
        const rows: Record<number, any> = {};
        for (const k of new Set([...Object.keys(ce), ...Object.keys(pe)].map(Number))) {
          rows[k] = { ceLtp: ce[k] ?? 0, peLtp: pe[k] ?? 0, ceSecId: `c${k}`, peSecId: `p${k}`, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() };
        }
        (sensexOptionFeedService as any).cachedLiveOptionChain = rows;
      };

      afterEach(async () => {
        await sensexOptionFeedService.setTargetPremium(100);
      });

      it('locks the strike whose 09:20 open is nearest the target, not the one whose live price is (74800 CE vs 75000 CE)', async () => {
        await sensexOptionFeedService.setTargetPremium(95);
        // 74800 CE opened at 95 but its cached price is stale and low; 75000 CE looks closer on live price.
        live({ 74800: 86, 75000: 97 }, { 74800: 140, 75000: 96 });
        seedOpens({ CE_74800: 95, CE_75000: 104, PE_75000: 96, PE_74800: 130 });

        const anchor = sensexOptionFeedService.getOrCreateDayAnchor(74900, '09:20:05 AM');
        expect(anchor.isConfirmed).toBe(true);
        expect(anchor.ceStrike).toBe(74800);
        expect(anchor.ceOpen0920).toBe(95);
        expect(anchor.ceTriggerPrice).toBe(142.5);
        expect(anchor.peStrike).toBe(75000);
      });

      it('does not lock before 09:20:05, and shows PROVISIONAL while it waits', () => {
        live({ 80800: 95 }, { 81200: 102 });
        seedOpens({ CE_80800: 95, PE_81200: 102 });
        const state = sensexOptionFeedService.evaluateSensexOobtst(81000, '09:20:02 AM');
        expect(state.isLocked).toBe(false);
        expect(state.isProvisional).toBe(true);
        expect(state.statusBadgeText).toBe('PROVISIONAL \u2014 NOT LOCKED');
      });

      it('uses the candle open, not the live price, as the 09:20 open for the trigger', () => {
        live({ 80800: 99 }, { 81200: 101 });
        seedOpens({ CE_80800: 94, PE_81200: 103 });
        const anchor = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:05 AM');
        expect(anchor.ceOpen0920).toBe(94);
        expect(anchor.ceTriggerPrice).toBe(141);
        expect(anchor.peOpen0920).toBe(103);
      });

      it('fails with a retry notice, retries once 30 s later, then locks when a candle open turns up', () => {
        live({ 80800: 95 }, { 81200: 102 });
        seedOpens({ CE_80800: 150, PE_81200: 102 });

        const failed = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:10 AM');
        expect(failed.isLockFailed).toBe(true);
        expect(failed.lockFailureReason).toContain('No CE with a 09:20 candle open');
        expect(failed.lockFailureReason).toContain('Retrying at 09:20:40 IST');

        // At the retry time the lock waits for the wider search instead of showing a failure.
        const retrying = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:40 AM');
        expect(retrying.isLockFailed).toBe(false);
        expect(retrying.isProvisionalLock).toBe(true);

        seedOpens({ CE_80800: 150, CE_80900: 108, PE_81200: 102 });
        (sensexOptionFeedService as any).cachedLiveOptionChain[80900] = { ceLtp: 108, peLtp: 0, ceSecId: 'c80900', ceUpdatedTime: Date.now() };
        const locked = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:45 AM');
        expect(locked.isConfirmed).toBe(true);
        expect(locked.ceStrike).toBe(80900);
      });

      it('schedules no retry that would start after 09:21:00', () => {
        live({ 80800: 95 }, { 81200: 102 });
        seedOpens({ CE_80800: 150, PE_81200: 102 });
        const failed = sensexOptionFeedService.getOrCreateDayAnchor(81000, '09:20:50 AM');
        expect(failed.isLockFailed).toBe(true);
        expect(failed.lockFailureReason).not.toContain('Retrying');
      });
    });
  });

  describe('Requirement 5: Stop-Loss & OCO Execution', () => {
    it('calculates stop-loss strictly as 50% of actual executed purchase price', () => {
      expect(sensexOobtstStrategy.computeStopLoss(135.0)).toBe(67.5);
      expect(sensexOobtstStrategy.computeStopLoss(150.0)).toBe(75.0);
      expect(sensexOobtstStrategy.computeStopLoss(165.0)).toBe(82.5);
      expect(sensexOobtstStrategy.computeStopLoss(180.0)).toBe(90.0);
    });

    it('executes first triggered leg and permanently disables opposite leg under OCO', () => {
      (sensexOptionFeedService as any).cachedLiveOptionChain = {
        80800: { ceLtp: 95.0, peLtp: 140.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
        81200: { ceLtp: 140.0, peLtp: 100.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
      };

      // 09:20 Lock
      seedOpens({ CE_80800: 95, CE_81200: 140, PE_80800: 140, PE_81200: 100 });
      sensexOptionFeedService.evaluateSensexOobtst(81000, '09:20:05 AM');

      // Now at 09:22, CE crosses trigger (142.50) with tick at 145.0
      (sensexOptionFeedService as any).cachedLiveOptionChain[80800].ceLtp = 145.0;

      const eval1 = sensexOptionFeedService.evaluateSensexOobtst(81000, '09:22:15 AM');
      expect(eval1.activeLeg).toBe('CE');
      expect(eval1.status).toBe('ACTIVE');
      expect(eval1.executedPrice).toBe(145.0);
      expect(eval1.slPrice).toBe(72.5); // 145.0 * 0.5
      expect(eval1.ceLeg.status).toBe('EXECUTED');
      expect(eval1.peLeg.status).toBe('DISABLED'); // OCO cancellation
    });
  });

  describe('Requirement 6 & 7: BSE Weekly Friday Expiry & Overnight Rollover', () => {
    it('computes weekly Friday expiry for BSE SENSEX options', () => {
      // Wednesday Oct 21, 2026
      const wednesday = new Date(2026, 9, 21, 10, 0, 0); // Month is 0-indexed (9 = Oct)
      const res = tradingCalendarService.getActiveWeeklySensexExpiry(wednesday, true);

      // Upcoming Friday is Oct 23, 2026
      expect(res.expiryStr).toBe('23-OCT-2026');
      expect(res.expiryDateYMD).toBe('2026-10-23');
      expect(res.isExpiryDay).toBe(false);
    });

    it('prepones Friday expiry when Friday is an official exchange holiday', () => {
      // Good Friday is 2026-04-03
      // Wednesday Apr 1, 2026
      const wednesday = new Date(2026, 3, 1, 10, 0, 0); // Apr 1
      const res = tradingCalendarService.getActiveWeeklySensexExpiry(wednesday, true);

      // Should prepone to Thursday Apr 2, 2026
      expect(res.expiryStr).toBe('02-APR-2026');
      expect(res.wasPreponed).toBe(true);
      expect(res.holidayReason).toBe('Good Friday');
    });

    it('rolls forward to NEXT weekly Friday (+7 days) on expiry day for BTST overnight safety', () => {
      // Friday Oct 23, 2026 at 10:00 AM IST
      const fridayExpiryDay = new Date(2026, 9, 23, 10, 0, 0);
      const res = tradingCalendarService.getActiveWeeklySensexExpiry(fridayExpiryDay, true);

      // SENSEX OOBTST BTST must skip today and select next weekly Friday (Oct 30, 2026)
      expect(res.rolledToNextExpiry).toBe(true);
      expect(res.expiryStr).toBe('30-OCT-2026');
      expect(res.expiryDateYMD).toBe('2026-10-30');
    });

    it('transitions surviving position to BTST_HOLD at 15:30 IST', () => {
      (sensexOptionFeedService as any).cachedLiveOptionChain = {
        80800: { ceLtp: 95.0, peLtp: 140.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
        81200: { ceLtp: 140.0, peLtp: 100.0, ceOi: 1000, peOi: 1000, ceUpdatedTime: Date.now(), peUpdatedTime: Date.now() },
      };

      // 09:20 Lock
      seedOpens({ CE_80800: 95, CE_81200: 140, PE_80800: 140, PE_81200: 100 });
      sensexOptionFeedService.evaluateSensexOobtst(81000, '09:20:05 AM');

      // Trigger CE
      (sensexOptionFeedService as any).cachedLiveOptionChain[80800].ceLtp = 145.0;
      sensexOptionFeedService.evaluateSensexOobtst(81000, '09:22:00 AM');

      // At 15:30:00 IST, position transitions to BTST_HOLD
      const eodEval = sensexOptionFeedService.evaluateSensexOobtst(81000, '03:30:00 PM');
      expect(eodEval.status).toBe('BTST_HOLD');
      expect(eodEval.statusBadgeText).toBe('BTST_HOLD');
    });
  });
});
