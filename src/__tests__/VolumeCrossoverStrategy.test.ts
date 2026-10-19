import {
  evaluateVolumeCrossover,
  isOpeningFeedStabilizing,
  StockEvaluationInput,
  PI_PERCENT,
} from '../strategies/VolumeCrossoverStrategy';
import { TrailingSLStateMachine } from '../strategies/TrailingSLStateMachine';

describe('Strategy 1 Engine: 20D Volume Crossover & TSL State Machine', () => {
  describe('Opening Feed Stabilization Filter (09:15:00 - 09:16:00 IST)', () => {
    test('correctly identifies opening stabilization window', () => {
      expect(isOpeningFeedStabilizing('09:15:00')).toBe(true);
      expect(isOpeningFeedStabilizing('09:15:35')).toBe(true);
      expect(isOpeningFeedStabilizing('09:15:59')).toBe(true);
      expect(isOpeningFeedStabilizing('09:16:00')).toBe(false);
      expect(isOpeningFeedStabilizing('09:20:00')).toBe(false);
      expect(isOpeningFeedStabilizing('09:14:59')).toBe(false);
    });

    test('discards volume spikes >= 50% during the 09:15-09:16 opening minute as feed noise', () => {
      const spikeInput: StockEvaluationInput = {
        ticker: 'RELIANCE',
        spotPrice: 2950.0,
        dayOpen: 2940.0,
        percentChange: 0.5,
        todayTradedShares: 1200000,
        avg20DTradedShares: 2000000, // 60% of baseline in first 30 seconds
      };

      const result = evaluateVolumeCrossover(spikeInput, '09:15:30');
      expect(result.isOpeningStabilizing).toBe(true);
      expect(result.isStabilizationFiltered).toBe(true);
      expect(result.hasCrossed20D).toBe(false);
      expect(result.triggerState).toBe('GREY'); // Suppressed
    });

    test('activates breakout normally once time reaches 09:16:00 IST', () => {
      const normalInput: StockEvaluationInput = {
        ticker: 'RELIANCE',
        spotPrice: 2960.0,
        dayOpen: 2940.0,
        percentChange: 0.8,
        todayTradedShares: 2100000,
        avg20DTradedShares: 2000000, // 105% of baseline
      };

      const result = evaluateVolumeCrossover(normalInput, '09:16:02');
      expect(result.isOpeningStabilizing).toBe(false);
      expect(result.isStabilizationFiltered).toBe(false);
      expect(result.hasCrossed20D).toBe(true);
      expect(result.triggerState).toBe('GREEN');
      expect(result.crossoverDirection).toBe('BULLISH');
    });
  });

  describe('Directional Bullish Confirmation & Indicator States', () => {
    test('confirms GREEN (Accumulation Breakout) when Volume >= 100%, LTP >= Open, and Change >= 0%', () => {
      const bullishStock: StockEvaluationInput = {
        ticker: 'HDFCBANK',
        spotPrice: 1655.0,
        dayOpen: 1640.0,
        percentChange: 1.2,
        todayTradedShares: 5500000,
        avg20DTradedShares: 5000000,
        strikeStep: 20,
      };

      const result = evaluateVolumeCrossover(bullishStock, '09:30:00');
      expect(result.hasCrossed20D).toBe(true);
      expect(result.triggerState).toBe('GREEN');
      expect(result.crossoverDirection).toBe('BULLISH');
      // Tactical strike: round(1655 / 20) * 20 = 83 * 20 = 1660
      expect(result.recommendedCeStrike).toBe(1660);
    });

    test('flags RED (Distribution) when Volume >= 100% but price is bearish (LTP < Open or Change < 0%)', () => {
      const bearishDistributionStock: StockEvaluationInput = {
        ticker: 'ICICIBANK',
        spotPrice: 1220.0,
        dayOpen: 1240.0, // Open is higher than current price
        percentChange: -0.8,
        todayTradedShares: 4500000,
        avg20DTradedShares: 4000000, // Volume crossed
      };

      const result = evaluateVolumeCrossover(bearishDistributionStock, '10:15:00');
      expect(result.hasCrossed20D).toBe(true);
      expect(result.triggerState).toBe('RED');
      expect(result.crossoverDirection).toBe('BEARISH');
    });

    test('flags AMBER when volume is approaching breakout (80% - 99%)', () => {
      const approachingStock: StockEvaluationInput = {
        ticker: 'TCS',
        spotPrice: 3850.0,
        dayOpen: 3840.0,
        percentChange: 0.3,
        todayTradedShares: 850000,
        avg20DTradedShares: 1000000, // 85% volume
      };

      const result = evaluateVolumeCrossover(approachingStock, '11:00:00');
      expect(result.hasCrossed20D).toBe(false);
      expect(result.triggerState).toBe('AMBER');
    });

    test('computes exact dynamic π% (3.1416%) milestone targets', () => {
      const stock: StockEvaluationInput = {
        ticker: 'INFY',
        spotPrice: 1000.0,
        dayOpen: 995.0,
        percentChange: 0.5,
        todayTradedShares: 2500000,
        avg20DTradedShares: 2000000,
      };

      const result = evaluateVolumeCrossover(stock, '10:00:00');
      // T1 = 1000 * 1.031416 = 1031.42
      expect(result.targets.t1).toBe(1031.42);
      // T2 = 1000 * (1 + 2 * 0.031416) = 1062.83
      expect(result.targets.t2).toBe(1062.83);
      // T3 = 1000 * (1 + 3 * 0.031416) = 1094.25
      expect(result.targets.t3).toBe(1094.25);
      // T4 = 1000 * (1 + 4 * 0.031416) = 1125.66
      expect(result.targets.t4).toBe(1125.66);
    });
  });

  describe('4-State Trailing Stop-Loss (TSL) State Machine', () => {
    test('initializes in INITIAL state with entry - 1R stop-loss', () => {
      const tsl = new TrailingSLStateMachine({
        entryPrice: 100,
        initialRiskPts: 10, // 1R = 10 pts (Initial SL = 90)
      });

      expect(tsl.getState()).toBe('INITIAL');
      expect(tsl.getCurrentSl()).toBe(90);
    });

    test('advances to BREAKEVEN (+0.05R) when gain reaches +1R (110 pts)', () => {
      const tsl = new TrailingSLStateMachine({
        entryPrice: 100,
        initialRiskPts: 10,
      });

      // Price moves to 105 (+0.5R) -> still INITIAL
      let res = tsl.update(105, '10:00:00');
      expect(res.state).toBe('INITIAL');
      expect(res.currentSl).toBe(90);

      // Price moves to 110 (+1.0R) -> advances to BREAKEVEN
      res = tsl.update(110, '10:15:00');
      expect(res.state).toBe('BREAKEVEN');
      // SL moves to Entry + 0.05 * 10 = 100.50
      expect(res.currentSl).toBe(100.50);
    });

    test('advances to LOCKED_PROFIT (+1R locked) when gain reaches +2R (120 pts)', () => {
      const tsl = new TrailingSLStateMachine({
        entryPrice: 100,
        initialRiskPts: 10,
      });

      // Jump directly to 120 (+2R)
      const res = tsl.update(120, '11:00:00');
      expect(res.state).toBe('LOCKED_PROFIT');
      // SL moves to Entry + 1.0 * 10 = 110.00
      expect(res.currentSl).toBe(110.00);
    });

    test('triggers SL_HIT when price pulls back to the trailing stop loss', () => {
      const tsl = new TrailingSLStateMachine({
        entryPrice: 100,
        initialRiskPts: 10,
      });

      // Gain +2R -> SL is now 110
      tsl.update(120, '11:00:00');
      expect(tsl.getCurrentSl()).toBe(110);

      // Price drops to 109.50 -> Breaches 110 SL
      const exitRes = tsl.update(109.50, '11:30:00');
      expect(exitRes.state).toBe('SL_HIT');
      expect(exitRes.isExitTriggered).toBe(true);
      expect(exitRes.exitReason).toContain('Stop-loss breached');
    });

    test('triggers EOD_EXIT when time reaches 15:30:00 IST', () => {
      const tsl = new TrailingSLStateMachine({
        entryPrice: 100,
        initialRiskPts: 10,
      });

      // In trade at 15:30:00
      const eodRes = tsl.update(115, '15:30:00');
      expect(eodRes.state).toBe('EOD_EXIT');
      expect(eodRes.isExitTriggered).toBe(true);
      expect(eodRes.exitReason).toContain('EOD Square-Off');
    });
  });
});
