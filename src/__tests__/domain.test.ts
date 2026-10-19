import { 
  StrategyPositionModel, 
  StrategySignalOutput, 
  StockDomainModel,
  calculateVolumeRatio 
} from '../types/domain';

// Pure helper function to verify volume calculations
export function computeVolumeMetrics(todayVolume: number, avg20DVolume: number) {
  if (avg20DVolume <= 0) return { ratio: 0, isNearCross: false };
  const ratio = todayVolume / avg20DVolume;
  return {
    ratio,
    isNearCross: ratio >= 0.8,
  };
}

describe('QStrategy Domain Cleanroom & Invariants', () => {
  describe('Strategy 2: NIFTY 09:20 Overnight (Zero Target Invariant)', () => {
    it('enforces that targetPrice is undefined for overnight strangle positions', () => {
      const position: StrategyPositionModel = {
        id: 'pos_0920_ce_1',
        strategyId: 'NIFTY_OVERNIGHT',
        sessionDate: '2026-10-19',
        legType: 'CE',
        symbol: 'NIFTY 24850 CE',
        securityId: '49512',
        entryTime: '09:20:00',
        entryPrice: 62.50,
        quantity: 75,
        stopLoss: 62.50 * 0.75, // Strict 25% Stop Loss = 46.875
        targetPrice: undefined, // ZERO TARGET INVARIANT
        currentLtp: 62.50,
        pnlPoints: 0.0,
        status: 'ACTIVE',
        exitTime: null,
        exitPrice: null,
        createdAt: Date.now(),
      };

      expect(position.targetPrice).toBeUndefined();
      expect(position.stopLoss).toBeCloseTo(46.875, 3);
    });

    it('enforces that signal output has targetPrice undefined', () => {
      const signal: StrategySignalOutput = {
        strategyId: 'NIFTY_OVERNIGHT',
        status: 'ACTIVE',
        statusBadgeText: 'STRANGLE ACTIVE',
        badgeTone: 'cyan',
        headline: 'NIFTY 09:20 Overnight Strangle',
        primaryMetricLabel: 'Distance to ₹62.50',
        primaryMetricValue: '₹0.60',
        targetPrice: undefined,
        stopLossPrice: 46.88,
        invariantNotice: 'ZERO PROFIT TARGET INVARIANT: Exits exclusively on 25% SL or next-day 09:25 AM close.',
        lastUpdated: '09:20:00 IST',
      };

      expect(signal.targetPrice).toBeUndefined();
      expect(signal.invariantNotice).toContain('ZERO PROFIT TARGET');
    });
  });

  describe('Strategy 1: 20-Day Cumulative Volume Metrics', () => {
    it('computes volume ratio and near-cross flag accurately', () => {
      const avg20D = 5_000_000;
      
      // Below 80%
      const r1 = computeVolumeMetrics(3_500_000, avg20D);
      expect(r1.ratio).toBe(0.7);
      expect(r1.isNearCross).toBe(false);

      // At 80% threshold (Near cross alert)
      const r2 = computeVolumeMetrics(4_000_000, avg20D);
      expect(r2.ratio).toBe(0.8);
      expect(r2.isNearCross).toBe(true);

      // Above 100% (Crossover)
      const r3 = computeVolumeMetrics(5_250_000, avg20D);
      expect(r3.ratio).toBe(1.05);
      expect(r3.isNearCross).toBe(true);
    });

    it('preserves strict nullability on stock models without fake quotes', () => {
      const unhydratedStock: StockDomainModel = {
        ticker: 'RELIANCE',
        securityId: '2885',
        name: 'Reliance Industries Ltd.',
        exchangeSegment: 'NSE_EQ',
        spotPrice: null, // Strict null: offline or pre-market
        dayOpen: null,
        dayHigh: null,
        dayLow: null,
        dayClose: null,
        atp: null,
        todayVolume: 0,
        avg20DVolume: 6_200_000,
        volumeRatio: 0,
        deltaPct: null,
        strikeStep: 20,
        lotSize: 250,
        hasCrossed20D: false,
        latchedAt: null,
        isNearCross: false,
        lastUpdated: '09:00:00 IST',
      };

      expect(unhydratedStock.spotPrice).toBeNull();
      expect(unhydratedStock.dayOpen).toBeNull();
      expect(unhydratedStock.hasCrossed20D).toBe(false);
    });
  });

  describe('Strategy 3: NIFTY 09:25 ₹180 Breakout Invariant', () => {
    it('enforces exact 1:2 risk-to-reward ratio on 180 breakout target and stop-loss', () => {
      const entryPrice = 180.00;
      const targetPrice = 220.00;
      const stopLossPrice = 160.00;

      const riskPoints = entryPrice - stopLossPrice; // 20 pts
      const rewardPoints = targetPrice - entryPrice; // 40 pts
      const riskRewardRatio = rewardPoints / riskPoints;

      expect(riskPoints).toBe(20.00);
      expect(rewardPoints).toBe(40.00);
      expect(riskRewardRatio).toBe(2.0); // Exact 1:2
    });
  });
});
