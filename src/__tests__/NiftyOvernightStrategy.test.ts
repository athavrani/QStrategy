import { NiftyOvernightStrategy, TARGET_PREMIUM_ANCHOR } from '../strategies/NiftyOvernightStrategy';
import { TradingCalendarService } from '../services/TradingCalendarService';
import { OptionChainResult } from '../services/dhan/DhanOptionChainService';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';
import { formatDateKeyIST } from '../constants/nseHolidays';

describe('Strategy 2 Engine: NIFTY 09:20 Overnight Strangle Suite', () => {
  let strategy: NiftyOvernightStrategy;
  let calendar: TradingCalendarService;

  beforeEach(() => {
    strategy = new NiftyOvernightStrategy();
    calendar = new TradingCalendarService();
  });

  describe('Expiry Resolution & Expiry Day Skipping Invariant', () => {
    test('rolls to next weekly expiry (+7 days) when today is the scheduled expiry day', () => {
      // Simulate today being Tuesday 2026-10-13 (an expiry day)
      const expiryDayDate = new Date(2026, 9, 13, 10, 0, 0); // 13-OCT-2026 Tuesday

      const res = calendar.getActiveWeeklyExpiry(expiryDayDate, true);

      // Must roll to next week (+7 days) because OOBTST is a BTST overnight strategy
      expect(res.isExpiryDay).toBe(true);
      expect(res.rolledToNextExpiry).toBe(true);
    });

    test('prepones expiry date if scheduled Tuesday is an official NSE holiday', () => {
      // Dussehra: 2026-10-20 (Tuesday) is an official holiday per circular NSE/CMTR/71775
      const preDussehraDate = new Date(2026, 9, 15, 10, 0, 0); // Thursday Oct 15
      const res = calendar.getActiveWeeklyExpiry(preDussehraDate, false);

      // Should prepone Tuesday Oct 20 to Monday Oct 19
      expect(res.wasPreponed).toBe(true);
      expect(res.expiryDateYMD).toBe('2026-10-19');
    });
  });

  describe('Candidate Selection Math & Range Filter (₹50–₹75)', () => {
    const mockChain: OptionChainResult = {
      underlyingScrip: 13,
      underlyingSeg: 'IDX_I',
      expiry: '2026-10-27',
      spotPrice: 24800,
      atmStrike: 24800,
      pcr: 1.0,
      totalCallOi: 100000,
      totalPutOi: 100000,
      strikes: [
        {
          strikePrice: 24700,
          moneyness: 'ITM',
          ce: { ltp: 110.0, oi: 100, volume: 50, iv: 13, bid: 109, ask: 111 },
          pe: { ltp: 45.0, oi: 100, volume: 50, iv: 13, bid: 44, ask: 46 }, // Out of range (< 50)
        },
        {
          strikePrice: 24750,
          moneyness: 'ITM',
          ce: { ltp: 80.0, oi: 100, volume: 50, iv: 13, bid: 79, ask: 81 },
          pe: { ltp: 58.0, oi: 100, volume: 50, iv: 13, bid: 57, ask: 59 }, // Diff: |58 - 62.5| = 4.5
        },
        {
          strikePrice: 24800,
          moneyness: 'ATM',
          ce: { ltp: 64.0, oi: 100, volume: 50, iv: 13, bid: 63, ask: 65 }, // Diff: |64 - 62.5| = 1.5 (WINNER)
          pe: { ltp: 63.5, oi: 100, volume: 50, iv: 13, bid: 63, ask: 64 }, // Diff: |63.5 - 62.5| = 1.0 (WINNER)
        },
        {
          strikePrice: 24850,
          moneyness: 'OTM',
          ce: { ltp: 52.0, oi: 100, volume: 50, iv: 13, bid: 51, ask: 53 }, // Diff: |52 - 62.5| = 10.5
          pe: { ltp: 85.0, oi: 100, volume: 50, iv: 13, bid: 84, ask: 86 }, // Out of range (> 75)
        },
      ],
    };

    test('selects candidate closest to ₹62.50 within ₹50–₹75 range', () => {
      const { ceCandidate, peCandidate } = strategy.select0920Candidates(mockChain);

      expect(ceCandidate).not.toBeNull();
      expect(peCandidate).not.toBeNull();

      expect(ceCandidate?.strike).toBe(24800);
      expect(ceCandidate?.ltp).toBe(64.0);
      expect(ceCandidate?.distanceToAnchor).toBe(1.5);

      expect(peCandidate?.strike).toBe(24800);
      expect(peCandidate?.ltp).toBe(63.5);
      expect(peCandidate?.distanceToAnchor).toBe(1.0);
    });

    test('strictly enforces permanent 25% Stop Loss (refPrice * 0.75)', () => {
      const evalResult = strategy.evaluate(mockChain, '09:20:00');

      expect(evalResult.status).toBe('ENTRY_TRIGGERED');
      expect(evalResult.ceLeg).not.toBeNull();
      expect(evalResult.peLeg).not.toBeNull();

      // CE: 64.0 * 0.75 = 48.00
      expect(evalResult.ceLeg?.refPrice).toBe(64.0);
      expect(evalResult.ceLeg?.stopLossPrice).toBe(48.0);

      // PE: 63.5 * 0.75 = 47.63
      expect(evalResult.peLeg?.refPrice).toBe(63.5);
      expect(evalResult.peLeg?.stopLossPrice).toBe(47.63);
    });

    test('ENFORCES STRICTLY ZERO PROFIT TARGET INVARIANT', () => {
      const evalResult = strategy.evaluate(mockChain, '09:20:00');

      // MATHEMATICAL INVARIANT: Target MUST be strictly undefined
      expect(evalResult.target).toBeUndefined();
      expect(evalResult.ceLeg?.targetPrice).toBeUndefined();
      expect(evalResult.peLeg?.targetPrice).toBeUndefined();
    });
  });

  describe('Intraday Stop-Loss Breaches & Overnight Progression', () => {
    test('triggers SL_HIT on leg when price falls below 25% stop-loss', () => {
      const initialEval = strategy.evaluate(
        {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          expiry: '2026-10-27',
          spotPrice: 24800,
          atmStrike: 24800,
          pcr: 1.0,
          totalCallOi: 1000,
          totalPutOi: 1000,
          strikes: [
            {
              strikePrice: 24800,
              moneyness: 'ATM',
              ce: { ltp: 60.0, oi: 10, volume: 10, iv: 13, bid: 60, ask: 60 },
              pe: { ltp: 60.0, oi: 10, volume: 10, iv: 13, bid: 60, ask: 60 },
            },
          ],
        },
        '09:20:00'
      );

      const ceLeg = initialEval.ceLeg!;
      const peLeg = initialEval.peLeg!;

      // Ref: 60, SL: 45
      expect(ceLeg.stopLossPrice).toBe(45);

      // Simulate tick where CE crashes to 44.0 (SL breached) while PE rises to 72.0
      const tickChain: OptionChainResult = {
        underlyingScrip: 13,
        underlyingSeg: 'IDX_I',
        expiry: '2026-10-27',
        spotPrice: 24700,
        atmStrike: 24700,
        pcr: 1.0,
        totalCallOi: 1000,
        totalPutOi: 1000,
        strikes: [
          {
            strikePrice: 24800,
            moneyness: 'OTM',
            ce: { ltp: 44.0, oi: 10, volume: 10, iv: 13, bid: 44, ask: 44 },
            pe: { ltp: 72.0, oi: 10, volume: 10, iv: 13, bid: 72, ask: 72 },
          },
        ],
      };

      const monitored = strategy.evaluate(tickChain, '11:15:00', {
        ceLeg,
        peLeg,
        entryDate: '2026-10-20',
      });

      expect(monitored.ceLeg?.status).toBe('SL_HIT');
      expect(monitored.peLeg?.status).toBe('ACTIVE');
      expect(monitored.target).toBeUndefined();
    });

    test('tags open position as OVERNIGHT_HOLD after 15:30:00 IST', () => {
      const dummyLeg = {
        type: 'CE' as const,
        strike: 24800,
        symbol: 'NIFTY 24800 CE',
        refPrice: 62.0,
        stopLossPrice: 46.5,
        currentLtp: 65.0,
        status: 'ACTIVE' as const,
        pnlPts: 3.0,
        pnlPct: 4.8,
        targetPrice: undefined,
      };

      const eodEval = strategy.evaluate(
        {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          expiry: '2026-10-27',
          spotPrice: 24800,
          atmStrike: 24800,
          pcr: 1.0,
          totalCallOi: 1000,
          totalPutOi: 1000,
          strikes: [],
        },
        '15:31:00',
        {
          ceLeg: dummyLeg,
          peLeg: { ...dummyLeg, type: 'PE', symbol: 'NIFTY 24800 PE' },
          entryDate: '2026-10-20',
        }
      );

      expect(eodEval.status).toBe('OVERNIGHT_HOLD');
      expect(eodEval.isOvernightCarry).toBe(true);
    });

    test('mandates exit (COMPLETED) at exactly 09:25:00 AM IST on next trading day', () => {
      const dummyLeg = {
        type: 'CE' as const,
        strike: 24800,
        symbol: 'NIFTY 24800 CE',
        refPrice: 62.0,
        stopLossPrice: 46.5,
        currentLtp: 75.0,
        status: 'ACTIVE' as const,
        pnlPts: 13.0,
        pnlPct: 20.9,
        targetPrice: undefined,
      };

      const exitEval = strategy.evaluate(
        {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          expiry: '2026-10-27',
          spotPrice: 24850,
          atmStrike: 24850,
          pcr: 1.0,
          totalCallOi: 1000,
          totalPutOi: 1000,
          strikes: [],
        },
        '09:25:00',
        {
          ceLeg: dummyLeg,
          peLeg: { ...dummyLeg, type: 'PE', symbol: 'NIFTY 24800 PE' },
          entryDate: '2026-10-20',
          isNextDay: true,
        }
      );

      expect(exitEval.status).toBe('COMPLETED');
      expect(exitEval.ceLeg?.status).toBe('SQUARED_OFF');
      expect(exitEval.peLeg?.status).toBe('SQUARED_OFF');
    });
  });

  describe('09:20 OOBTST Enhanced Strike Selection Engine (Dhan Feed & Lock Invariants)', () => {
    const mockOptionChain = {
      25100: { ceLtp: 62.80, peLtp: 35.00, ceOi: 50000, peOi: 20000, ceSecId: 'SEC_25100_CE', peSecId: 'SEC_25100_PE' },
      25150: { ceLtp: 58.50, peLtp: 42.00, ceOi: 40000, peOi: 30000, ceSecId: 'SEC_25150_CE', peSecId: 'SEC_25150_PE' },
      25200: { ceLtp: 48.00, peLtp: 50.00, ceOi: 30000, peOi: 40000, ceSecId: 'SEC_25200_CE', peSecId: 'SEC_25200_PE' },
      24600: { ceLtp: 120.00, peLtp: 61.90, ceOi: 20000, peOi: 55000, ceSecId: 'SEC_24600_CE', peSecId: 'SEC_24600_PE' },
      24550: { ceLtp: 135.00, peLtp: 64.20, ceOi: 15000, peOi: 45000, ceSecId: 'SEC_24550_CE', peSecId: 'SEC_24550_PE' },
      24500: { ceLtp: 150.00, peLtp: 68.00, ceOi: 10000, peOi: 35000, ceSecId: 'SEC_24500_CE', peSecId: 'SEC_24500_PE' },
    };

    // The lock ranks on 09:20 candle opens; here they equal the mock chain prices.
    const seedCandleOpens = () => {
      const opens: Record<string, number> = {};
      for (const [strike, row] of Object.entries(mockOptionChain)) {
        opens[`CE_${strike}`] = row.ceLtp;
        opens[`PE_${strike}`] = row.peLtp;
      }
      (niftyOptionFeedService as any).candleOpens0920 = { date: formatDateKeyIST(), opens, pending: 0 };
    };

    beforeEach(async () => {
      niftyOptionFeedService.resetAnchor();
      await niftyOptionFeedService.setTargetPremium(62.50);
      jest.spyOn(dhanDirectService, 'fetchOptionChain').mockResolvedValue({
        spotPrice: 24850,
        oc: JSON.parse(JSON.stringify(mockOptionChain)),
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('Requirement 1 & 5: Configurable target premium validation and updates', async () => {
      expect(niftyOptionFeedService.getTargetPremium()).toBe(62.50);

      // Positive value is accepted and saved
      const ok1 = await niftyOptionFeedService.setTargetPremium(70.00);
      expect(ok1).toBe(true);
      expect(niftyOptionFeedService.getTargetPremium()).toBe(70.00);

      // Non-positive values (<= 0 or NaN) are rejected
      const ok2 = await niftyOptionFeedService.setTargetPremium(-5.00);
      expect(ok2).toBe(false);
      expect(niftyOptionFeedService.getTargetPremium()).toBe(70.00);

      const ok3 = await niftyOptionFeedService.setTargetPremium(0);
      expect(ok3).toBe(false);
      expect(niftyOptionFeedService.getTargetPremium()).toBe(70.00);

      const ok4 = await niftyOptionFeedService.setTargetPremium(NaN);
      expect(ok4).toBe(false);
      expect(niftyOptionFeedService.getTargetPremium()).toBe(70.00);

      // Restore default 62.50
      await niftyOptionFeedService.setTargetPremium(62.50);
      expect(niftyOptionFeedService.getTargetPremium()).toBe(62.50);
    });

    test('Requirement 2: Market-Closed Preview displays 2 CE and 2 PE candidates labeled PREVIEW — NOT CONFIRMED', async () => {
      await niftyOptionFeedService.syncLiveOptionChain();

      const evalResult = niftyOptionFeedService.evaluateOobtst(24850, '09:05:00 AM');

      expect(evalResult.isMarketClosed).toBe(true);
      expect(evalResult.isProvisional).toBe(false);
      expect(evalResult.isLocked).toBe(false);
      expect(evalResult.statusBadgeText).toBe('PREVIEW — NOT CONFIRMED');
      expect(evalResult.previewAvailable).toBe(true);

      // Verify two CE candidates sorted by difference to 62.50
      expect(evalResult.ceCandidates.length).toBe(2);
      expect(evalResult.ceCandidates[0].rank).toBe(1);
      expect(evalResult.ceCandidates[0].strike).toBe(25100);
      expect(evalResult.ceCandidates[0].ltp).toBe(62.80);
      expect(evalResult.ceCandidates[0].diffFromTarget).toBe(0.30); // |62.80 - 62.50|
      expect(evalResult.ceCandidates[1].rank).toBe(2);
      expect(evalResult.ceCandidates[1].strike).toBe(25150);
      expect(evalResult.ceCandidates[1].ltp).toBe(58.50);

      // Verify two PE candidates sorted by difference to 62.50
      expect(evalResult.peCandidates.length).toBe(2);
      expect(evalResult.peCandidates[0].rank).toBe(1);
      expect(evalResult.peCandidates[0].strike).toBe(24600);
      expect(evalResult.peCandidates[0].ltp).toBe(61.90);
      expect(evalResult.peCandidates[0].diffFromTarget).toBe(0.60); // |61.90 - 62.50|
      expect(evalResult.peCandidates[1].rank).toBe(2);
      expect(evalResult.peCandidates[1].strike).toBe(24550);
      expect(evalResult.peCandidates[1].ltp).toBe(64.20);
    });

    test('Requirement 2 (Fallback): PREVIEW UNAVAILABLE when option chain data is absent, never fabricates prices', () => {
      niftyOptionFeedService.resetAnchor();

      const evalResult = niftyOptionFeedService.evaluateOobtst(24850, '09:05:00 AM');

      expect(evalResult.isMarketClosed).toBe(true);
      expect(evalResult.statusBadgeText).toBe('PREVIEW UNAVAILABLE');
      expect(evalResult.previewAvailable).toBe(false);
      expect(evalResult.ceLeg.openPrice).toBe(0);
      expect(evalResult.peLeg.openPrice).toBe(0);
    });

    test('Requirement 3: Live Provisional Monitoring (09:15-09:19:59 IST) updates candidates dynamically from ticks', async () => {
      await niftyOptionFeedService.syncLiveOptionChain();

      // At 09:18:00 AM: Provisional window
      const provEval = niftyOptionFeedService.evaluateOobtst(24850, '09:18:00 AM');
      expect(provEval.isProvisional).toBe(true);
      expect(provEval.isLocked).toBe(false);
      expect(provEval.statusBadgeText).toBe('PROVISIONAL_STRIKES');
      expect(provEval.ceCandidates[0].strike).toBe(25100);

      // Simulate live tick on 25150 CE making it closest to 62.50
      niftyOptionFeedService.updateOptionPriceFromTick('SEC_25150_CE', 62.55);

      const updatedEval = niftyOptionFeedService.evaluateOobtst(24850, '09:18:30 AM');
      expect(updatedEval.ceCandidates[0].strike).toBe(25150);
      expect(updatedEval.ceCandidates[0].ltp).toBe(62.55);
      expect(updatedEval.ceCandidates[0].diffFromTarget).toBe(0.05);
    });

    test('Requirement 4: Exact 09:20 AM Lock selects single CE/PE, captures open prices, and locks permanently for session', async () => {
      await niftyOptionFeedService.syncLiveOptionChain();

      // Between 09:20:00 and 09:20:05 nothing is armed yet
      const waiting = niftyOptionFeedService.evaluateOobtst(24850, '09:20:00 AM');
      expect(waiting.isLocked).toBe(false);
      expect(waiting.isProvisional).toBe(true);

      // At 09:20:05 AM the lock reads the 09:20 candle opens
      seedCandleOpens();
      const lockedEval = niftyOptionFeedService.evaluateOobtst(24850, '09:20:05 AM');

      expect(lockedEval.currentStep).toBe(2);
      expect(lockedEval.status).toBe('ARMED');
      expect(lockedEval.statusBadgeText).toBe('LOCKED / ARMED_1.5X');
      expect(lockedEval.isLocked).toBe(true);
      expect(lockedEval.isProvisional).toBe(false);
      expect(lockedEval.isMarketClosed).toBe(false);

      // Captured 09:20 opening prices
      expect(lockedEval.ceLeg.strike).toBe(25100);
      expect(lockedEval.ceLeg.openPrice).toBe(62.80);
      expect(lockedEval.ceLeg.triggerPrice).toBe(+(62.80 * 1.5).toFixed(2)); // 94.20

      expect(lockedEval.peLeg.strike).toBe(24600);
      expect(lockedEval.peLeg.openPrice).toBe(61.90);
      expect(lockedEval.peLeg.triggerPrice).toBe(+(61.90 * 1.5).toFixed(2)); // 92.85

      // Immutable Lock Guarantee: Subsequent market moves never change locked strikes
      niftyOptionFeedService.updateOptionPriceFromTick('SEC_25200_CE', 62.50); // Becomes closer to target

      const subsequentEval = niftyOptionFeedService.evaluateOobtst(24850, '09:22:00 AM');
      expect(subsequentEval.ceLeg.strike).toBe(25100); // Unchanged!
      expect(subsequentEval.ceLeg.openPrice).toBe(62.80); // Unchanged!
    });

    test('Requirement 4 (Lock Failure): Missing quote data at 09:20:00 causes LOCK FAILED — DATA UNAVAILABLE and disarms strategy', () => {
      niftyOptionFeedService.resetAnchor();

      // No candle opens ever arrive: the lock fails once the 09:21:05 deadline passes
      const failedEval = niftyOptionFeedService.evaluateOobtst(24850, '09:21:10 AM');

      expect(failedEval.currentStep).toBe(1);
      expect(failedEval.status).toBe('LOCK_FAILED');
      expect(failedEval.statusBadgeText).toBe('LOCK FAILED — DATA UNAVAILABLE');
      expect(failedEval.isLockFailed).toBe(true);
      expect(failedEval.isLocked).toBe(false);
      expect(failedEval.ceLeg.triggerPrice).toBe(0);
      expect(failedEval.peLeg.triggerPrice).toBe(0);
    });

    test('Requirement 6: Downstream 1.5x trigger, OCO cancel opposing leg, 50% SL, and overnight carry rules preserved', async () => {
      await niftyOptionFeedService.syncLiveOptionChain();

      // Lock at 09:20:05
      seedCandleOpens();
      niftyOptionFeedService.evaluateOobtst(24850, '09:20:05 AM');

      // CE trigger is 94.20. Simulate CE surging past 94.20 to 95.00
      niftyOptionFeedService.updateOptionPriceFromTick('SEC_25100_CE', 95.00);

      const activeEval = niftyOptionFeedService.evaluateOobtst(24850, '09:25:00 AM');
      expect(activeEval.currentStep).toBe(3);
      expect(activeEval.status).toBe('ACTIVE');
      expect(activeEval.statusBadgeText).toBe('OOBTST_ACTIVE');
      expect(activeEval.activeLeg).toBe('CE');
      expect(activeEval.ceLeg.status).toBe('EXECUTED');
      expect(activeEval.peLeg.status).toBe('DISABLED'); // OCO rule

      // 50% Stop-loss: Buy level = 94.20, SL = 47.10
      expect(activeEval.slPrice).toBe(47.10);

      // Simulate price crash hitting SL (<= 47.10)
      niftyOptionFeedService.updateOptionPriceFromTick('SEC_25100_CE', 46.50);
      const slEval = niftyOptionFeedService.evaluateOobtst(24850, '10:00:00 AM');
      expect(slEval.status).toBe('SL_HIT');
      expect(slEval.statusBadgeText).toBe('SL_HIT');
      expect(slEval.ceLeg.status).toBe('SL_HIT');

      // Overnight carry: Surviving position past 15:30 IST transitions to BTST_HOLD
      niftyOptionFeedService.updateOptionPriceFromTick('SEC_25100_CE', 110.00);
      const eodEval = niftyOptionFeedService.evaluateOobtst(24850, '03:35:00 PM');
      expect(eodEval.status).toBe('BTST_HOLD');
      expect(eodEval.statusBadgeText).toBe('BTST_HOLD');
    });
  });
});
