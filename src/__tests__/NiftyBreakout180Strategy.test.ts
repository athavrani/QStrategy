import {
  NiftyBreakout180Strategy,
  BREAKOUT_TRIGGER_LEVEL,
  FIXED_TARGET,
  FIXED_STOP_LOSS,
  RISK_REWARD_RATIO,
  BreakoutStrategyState,
} from '../strategies/NiftyBreakout180Strategy';
import { OptionChainResult } from '../services/dhan/DhanOptionChainService';

describe('Strategy 3 Engine: NIFTY 09:25 ₹180 Breakout Suite', () => {
  let strategy: NiftyBreakout180Strategy;

  beforeEach(() => {
    strategy = new NiftyBreakout180Strategy();
  });

  const mockChain: OptionChainResult = {
    underlyingScrip: 13,
    underlyingSeg: 'IDX_I',
    expiry: '2026-10-22',
    spotPrice: 24850,
    atmStrike: 24850,
    pcr: 1.0,
    totalCallOi: 10000,
    totalPutOi: 10000,
    strikes: [
      {
        strikePrice: 24800,
        moneyness: 'ITM',
        ce: { ltp: 195.0, oi: 100, volume: 50, iv: 13, bid: 194, ask: 196 }, // Excluded (> 180)
        pe: { ltp: 130.0, oi: 100, volume: 50, iv: 13, bid: 129, ask: 131 },
      },
      {
        strikePrice: 24850,
        moneyness: 'ATM',
        ce: { ltp: 176.4, oi: 100, volume: 50, iv: 13, bid: 175, ask: 177 }, // Closest CE (< 180)
        pe: { ltp: 172.1, oi: 100, volume: 50, iv: 13, bid: 171, ask: 173 }, // Closest PE (< 180)
      },
      {
        strikePrice: 24900,
        moneyness: 'OTM',
        ce: { ltp: 140.0, oi: 100, volume: 50, iv: 13, bid: 139, ask: 141 },
        pe: { ltp: 210.0, oi: 100, volume: 50, iv: 13, bid: 209, ask: 211 }, // Excluded (> 180)
      },
    ],
  };

  describe('09:25 Candidate Selection & Open < 180 Filter', () => {
    test('selects CE and PE closest under ₹180.00', () => {
      const candidates = strategy.select0925Candidates(mockChain);

      expect(candidates.ceCandidate).not.toBeNull();
      expect(candidates.peCandidate).not.toBeNull();

      expect(candidates.ceCandidate?.strike).toBe(24850);
      expect(candidates.ceCandidate?.price0925).toBe(176.4);
      expect(candidates.ceCandidate?.distanceTo180).toBe(3.6);

      expect(candidates.peCandidate?.strike).toBe(24850);
      expect(candidates.peCandidate?.price0925).toBe(172.1);
      expect(candidates.peCandidate?.distanceTo180).toBe(7.9);
    });

    test('strictly filters out strikes where candle open >= 180', () => {
      const candleOpens = {
        CE_24850: 182.0, // Open is above 180 (even if LTP is 176.4)
        PE_24850: 171.0,
      };

      const candidates = strategy.select0925Candidates(mockChain, candleOpens);
      // CE_24850 is disqualified because Open >= 180; falls back to next valid strike CE_24900
      expect(candidates.ceCandidate?.strike).toBe(24900);
      expect(candidates.ceCandidate?.price0925).toBe(140.0);
    });
  });

  describe('One-Cancels-Other (OCO) Permanent Cancellation Invariant', () => {
    test('triggers BUY on first breakout and PERMANENTLY cancels and disables opposite leg', () => {
      // Step 1: Initial state locked at 09:25:00
      let state = strategy.evaluate(null, { ceLtp: 177.0, peLtp: 173.0 }, '09:25:00', mockChain);
      expect(state.status).toBe('MONITORING_BREAKOUT');

      // Step 2: At 09:27:15, CE crosses 180.50 (Trigger!)
      state = strategy.evaluate(state, { ceLtp: 180.5, peLtp: 174.0 }, '09:27:15');

      expect(state.status).toBe('IN_TRADE');
      expect(state.activeContract).toBe('CE');
      expect(state.entryPrice).toBe(180.5);
      expect(state.tradeCountToday).toBe(1);

      // Verify OCO Invariant: PE leg is permanently disabled
      expect(state.ceCandidate?.isTriggered).toBe(true);
      expect(state.ceCandidate?.isDisabled).toBe(false);
      expect(state.peCandidate?.isTriggered).toBe(false);
      expect(state.peCandidate?.isDisabled).toBe(true);

      // Step 3: Even if PE subsequently surges past 180, it MUST NOT trigger another trade
      const nextTick = strategy.evaluate(state, { ceLtp: 185.0, peLtp: 188.0 }, '09:30:00');
      expect(nextTick.activeContract).toBe('CE');
      expect(nextTick.tradeCountToday).toBe(1);
      expect(nextTick.peCandidate?.isDisabled).toBe(true);
    });
  });

  describe('Exact 1:2 Risk-Reward Mathematical Invariant', () => {
    test('enforces fixed ₹220 Target and ₹160 Stop-Loss (exact 1:2 R:R)', () => {
      expect(FIXED_TARGET).toBe(220.0);
      expect(FIXED_STOP_LOSS).toBe(160.0);

      const targetGain = FIXED_TARGET - BREAKOUT_TRIGGER_LEVEL; // +40 pts
      const stopRisk = BREAKOUT_TRIGGER_LEVEL - FIXED_STOP_LOSS; // -20 pts
      const ratio = targetGain / stopRisk;

      expect(targetGain).toBe(40.0);
      expect(stopRisk).toBe(20.0);
      expect(ratio).toBe(RISK_REWARD_RATIO); // Exactly 2.0 (1:2 R:R)
    });

    test('books profit when LTP reaches >= ₹220.00 (TARGET_HIT)', () => {
      let state = strategy.evaluate(null, { ceLtp: 181.0, peLtp: 170.0 }, '09:26:00', mockChain);
      expect(state.status).toBe('IN_TRADE');

      // Price surges to 221.00
      state = strategy.evaluate(state, { ceLtp: 221.0 }, '09:32:00');
      expect(state.status).toBe('TARGET_HIT');
      expect(state.exitPrice).toBe(221.0);
      expect(state.pnlPoints).toBe(40.0); // 221.0 - 181.0
    });

    test('contains loss when LTP falls <= ₹160.00 (SL_HIT)', () => {
      let state = strategy.evaluate(null, { ceLtp: 180.0, peLtp: 170.0 }, '09:26:00', mockChain);
      expect(state.status).toBe('IN_TRADE');

      // Price drops to 159.50
      state = strategy.evaluate(state, { ceLtp: 159.5 }, '09:29:00');
      expect(state.status).toBe('SL_HIT');
      expect(state.exitPrice).toBe(159.5);
      expect(state.pnlPoints).toBe(-20.5);
    });
  });

  describe('Mandatory 09:45:00 IST Time Exit Cutoff', () => {
    test('forces square-off at market price when time reaches 09:45:00 IST for open trade', () => {
      let state = strategy.evaluate(null, { ceLtp: 180.0, peLtp: 170.0 }, '09:26:00', mockChain);
      expect(state.status).toBe('IN_TRADE');

      // Price is at 195.00 at 09:45:00 (neither Target nor SL hit)
      state = strategy.evaluate(state, { ceLtp: 195.0 }, '09:45:00');
      expect(state.status).toBe('TIME_EXIT');
      expect(state.exitPrice).toBe(195.0);
      expect(state.exitTime).toBe('09:45:00');
      expect(state.pnlPoints).toBe(15.0); // 195.0 - 180.0
    });

    test('marks NO_TRADE_WINDOW_CLOSED if neither contract broke out by 09:45:00 IST', () => {
      let state = strategy.evaluate(null, { ceLtp: 176.0, peLtp: 172.0 }, '09:25:00', mockChain);
      expect(state.status).toBe('MONITORING_BREAKOUT');

      // At 09:45:00 without breakout
      state = strategy.evaluate(state, { ceLtp: 178.0, peLtp: 175.0 }, '09:45:00');
      expect(state.status).toBe('NO_TRADE_WINDOW_CLOSED');
      expect(state.tradeCountToday).toBe(0);
    });
  });

  describe('Dhan API Integration & 09:25 Strike Selection Specification', () => {
    test('ranks top 2 CE and top 2 PE candidates strictly below threshold', () => {
      const extendedChain: OptionChainResult = {
        ...mockChain,
        strikes: [
          ...mockChain.strikes,
          {
            strikePrice: 24950,
            moneyness: 'OTM',
            ce: { ltp: 165.0, oi: 50, volume: 20, iv: 13, bid: 164, ask: 166 },
            pe: { ltp: 90.0, oi: 50, volume: 20, iv: 13, bid: 89, ask: 91 },
          },
          {
            strikePrice: 24750,
            moneyness: 'OTM',
            ce: { ltp: 220.0, oi: 50, volume: 20, iv: 13, bid: 219, ask: 221 },
            pe: { ltp: 168.0, oi: 50, volume: 20, iv: 13, bid: 167, ask: 169 },
          },
        ],
      };

      const candidates = strategy.select0925Candidates(extendedChain, undefined, 180.0);
      expect(candidates.ceCandidates.length).toBe(2);
      expect(candidates.peCandidates.length).toBe(2);

      // CE Rank 1 = 24850 (176.4), Rank 2 = 24950 (165.0)
      expect(candidates.ceCandidates[0].strike).toBe(24850);
      expect(candidates.ceCandidates[0].rank).toBe(1);
      expect(candidates.ceCandidates[1].strike).toBe(24950);
      expect(candidates.ceCandidates[1].rank).toBe(2);

      // PE Rank 1 = 24850 (172.1), Rank 2 = 24750 (168.0)
      expect(candidates.peCandidates[0].strike).toBe(24850);
      expect(candidates.peCandidates[0].rank).toBe(1);
      expect(candidates.peCandidates[1].strike).toBe(24750);
      expect(candidates.peCandidates[1].rank).toBe(2);
    });

    test('supports configurable threshold and filters strictly below it', () => {
      // With threshold ₹170.00, 176.4 CE is excluded, next eligible is 140.0 CE
      const candidates = strategy.select0925Candidates(mockChain, undefined, 170.0);
      expect(candidates.ceCandidate?.strike).toBe(24900);
      expect(candidates.ceCandidate?.price0925).toBe(140.0);
      expect(candidates.ceCandidate?.distanceTo180).toBe(30.0); // 170 - 140
    });

    test('locks threshold and candidate strikes at 09:25:00 so later changes do not alter active session', () => {
      let state = strategy.evaluate(
        null,
        { ceLtp: 176.4, peLtp: 172.1 },
        '09:25:00',
        mockChain,
        undefined,
        180.0
      );
      expect(state.status).toBe('MONITORING_BREAKOUT');
      expect(state.lockedThreshold).toBe(180.0);
      expect(state.ceCandidate?.strike).toBe(24850);

      // If user later alters threshold to 190.0, lockedThreshold remains 180.0
      state = strategy.evaluate(
        state,
        { ceLtp: 178.0, peLtp: 174.0 },
        '09:28:00',
        mockChain,
        undefined,
        190.0
      );
      expect(state.lockedThreshold).toBe(180.0);
      expect(state.ceCandidate?.strike).toBe(24850);
    });

    test('reports LOCK_FAILED when reliable market data is completely unavailable at 09:25', () => {
      const emptyChain: OptionChainResult = {
        ...mockChain,
        strikes: [],
      };
      const state = strategy.evaluate(
        null,
        {},
        '09:25:00',
        emptyChain,
        undefined,
        180.0
      );
      expect(state.status).toBe('LOCK_FAILED');
      expect(state.isLockFailed).toBe(true);
      expect(state.lockFailureReason).toBe('LOCK FAILED — DATA UNAVAILABLE');
    });

    test('reports NO_ELIGIBLE_STRIKE when all strikes on a side exceed threshold', () => {
      const highPremiumChain: OptionChainResult = {
        ...mockChain,
        strikes: [
          {
            strikePrice: 24850,
            moneyness: 'ATM',
            ce: { ltp: 195.0, oi: 100, volume: 50, iv: 13, bid: 194, ask: 196 }, // Exceeds 180
            pe: { ltp: 172.1, oi: 100, volume: 50, iv: 13, bid: 171, ask: 173 }, // Eligible
          },
        ],
      };
      const state = strategy.evaluate(
        null,
        {},
        '09:25:00',
        highPremiumChain,
        undefined,
        180.0
      );
      expect(state.status).toBe('NO_ELIGIBLE_STRIKE');
      expect(state.noEligibleSide).toBe('CE');
    });

    test('operates in PROVISIONAL_MONITORING during 09:15:00 - 09:24:59 window without triggering orders', () => {
      const state = strategy.evaluate(
        null,
        { ceLtp: 185.0, peLtp: 170.0 }, // Even if LTP is 185.0 before 09:25
        '09:20:00',
        mockChain,
        undefined,
        180.0
      );
      expect(state.status).toBe('PROVISIONAL_MONITORING');
      expect(state.tradeCountToday).toBe(0);
      expect(state.activeContract).toBeNull();
    });
  });
});

