/**
 * QStrategy — BSE SENSEX 09:20 OOBTST Strategy Engine (SENSEX_OOBTST)
 *
 * Mathematical Invariants:
 * 1. Target Premium: ₹100.00 (Configurable)
 * 2. Premium Eligibility Window: ₹90.00 <= Premium <= ₹120.00 (Strictly inclusive)
 * 3. Candidate Ranking: Smallest distance |Premium - 100|
 * 4. Deterministic Tie-Breaker: Tighter valid bid-ask spread; then consistent strike ordering
 * 5. Exact 09:20:00 Candle Open Lock: 90 <= 09:20 Candle Open <= 120
 * 6. Directional 1.5x Breakout: CE Trigger = CE Open * 1.5, PE Trigger = PE Open * 1.5
 * 7. OCO Cancellation: First executed leg cancels and permanently disables opposing leg
 * 8. Stop-Loss: Exactly 50% of actual executed price
 * 9. STRICTLY ZERO PROFIT TARGET INVARIANT (targetPrice === undefined)
 * 10. Overnight BTST Hold: Position surviving 15:30 IST is carried overnight
 * 11. D+1 Next Trading Day Exit: 09:15 - 09:25 AM IST
 */

export const SENSEX_OOBTST_TARGET_PREMIUM = 100.0;
export const SENSEX_OOBTST_RANGE_MIN = 90.0;
export const SENSEX_OOBTST_RANGE_MAX = 120.0;
export const SENSEX_OOBTST_SL_MULTIPLIER = 0.5; // 50% of executed buy price
export const SENSEX_OOBTST_BREAKOUT_MULTIPLIER = 1.5; // 1.5x of 09:20 candle open

export type SensexOobtstStatus =
  | 'MARKET_CLOSED'
  | 'PREVIEW'
  | 'PROVISIONAL_STRIKES'
  | 'LOCKED'
  | 'NO_ELIGIBLE_STRIKE'
  | 'LOCK_FAILED'
  | 'EXECUTED_CE'
  | 'EXECUTED_PE'
  | 'SL_HIT'
  | 'BTST_HOLD'
  | 'NEXT_DAY_EXIT';

export interface SensexCandidateOption {
  strike: number;
  type: 'CE' | 'PE';
  symbol: string;
  ltp: number;
  open0920?: number;
  distanceToTarget: number;
  bidAskSpread: number;
  securityId?: string;
  isEligible: boolean;
}

export interface SensexOobtstLegState {
  type: 'CE' | 'PE';
  strike: number;
  symbol: string;
  openPrice: number;
  triggerPrice: number;
  currentLtp: number;
  stopLossPrice: number;
  // STRICT INVARIANT: Target price is intentionally and strictly undefined
  targetPrice?: undefined;
  status: 'ARMED' | 'EXECUTED' | 'DISABLED' | 'SL_HIT' | 'SQUARED_OFF';
  pnlPts: number;
  pnlPct: number;
  securityId?: string;
}

export interface SensexOobtstEvaluation {
  status: SensexOobtstStatus;
  statusBadgeText: string;
  sessionDate: string;
  entryTime?: string;
  exitTime?: string;
  isOvernightCarry: boolean;
  ceCandidate: SensexCandidateOption | null;
  peCandidate: SensexCandidateOption | null;
  ceLeg: SensexOobtstLegState | null;
  peLeg: SensexOobtstLegState | null;
  netPnlPts: number;
  headline: string;
  // STRICT INVARIANT: Strategy target is strictly undefined
  target?: undefined;
  stopLossRule: string;
  invariantNotice: string;
}

export class SensexOobtstStrategy {
  /**
   * Filters and selects candidate strikes adhering strictly to:
   * 1. 90 <= Premium <= 120
   * 2. Smallest distance |Premium - 100|
   * 3. Tie-breaker: Tighter bid-ask spread, then strike ordering
   */
  public filterAndRankCandidates(
    strikes: Array<{
      strikePrice: number;
      ceLtp?: number;
      peLtp?: number;
      ceBid?: number;
      ceAsk?: number;
      peBid?: number;
      peAsk?: number;
      ceSecId?: string;
      peSecId?: string;
    }>,
    target: number = SENSEX_OOBTST_TARGET_PREMIUM,
    minEligible: number = SENSEX_OOBTST_RANGE_MIN,
    maxEligible: number = SENSEX_OOBTST_RANGE_MAX
  ): {
    ceCandidates: SensexCandidateOption[];
    peCandidates: SensexCandidateOption[];
    bestCe: SensexCandidateOption | null;
    bestPe: SensexCandidateOption | null;
  } {
    const ceList: SensexCandidateOption[] = [];
    const peList: SensexCandidateOption[] = [];

    for (const s of strikes) {
      if (s.ceLtp !== undefined && s.ceLtp >= minEligible && s.ceLtp <= maxEligible) {
        const spread = s.ceBid !== undefined && s.ceAsk !== undefined ? Math.abs(s.ceAsk - s.ceBid) : 999;
        ceList.push({
          strike: s.strikePrice,
          type: 'CE',
          symbol: `SENSEX ${s.strikePrice} CE`,
          ltp: s.ceLtp,
          distanceToTarget: Number(Math.abs(s.ceLtp - target).toFixed(2)),
          bidAskSpread: Number(spread.toFixed(2)),
          securityId: s.ceSecId,
          isEligible: true,
        });
      }

      if (s.peLtp !== undefined && s.peLtp >= minEligible && s.peLtp <= maxEligible) {
        const spread = s.peBid !== undefined && s.peAsk !== undefined ? Math.abs(s.peAsk - s.peBid) : 999;
        peList.push({
          strike: s.strikePrice,
          type: 'PE',
          symbol: `SENSEX ${s.strikePrice} PE`,
          ltp: s.peLtp,
          distanceToTarget: Number(Math.abs(s.peLtp - target).toFixed(2)),
          bidAskSpread: Number(spread.toFixed(2)),
          securityId: s.peSecId,
          isEligible: true,
        });
      }
    }

    // Sort CE:
    // 1. Distance ascending
    // 2. Spread ascending (tighter spread wins)
    // 3. Lower strike first
    ceList.sort((a, b) => {
      if (Math.abs(a.distanceToTarget - b.distanceToTarget) > 0.001) {
        return a.distanceToTarget - b.distanceToTarget;
      }
      if (Math.abs(a.bidAskSpread - b.bidAskSpread) > 0.01) {
        return a.bidAskSpread - b.bidAskSpread;
      }
      return a.strike - b.strike;
    });

    // Sort PE:
    // 1. Distance ascending
    // 2. Spread ascending (tighter spread wins)
    // 3. Higher strike first
    peList.sort((a, b) => {
      if (Math.abs(a.distanceToTarget - b.distanceToTarget) > 0.001) {
        return a.distanceToTarget - b.distanceToTarget;
      }
      if (Math.abs(a.bidAskSpread - b.bidAskSpread) > 0.01) {
        return a.bidAskSpread - b.bidAskSpread;
      }
      return b.strike - a.strike;
    });

    return {
      ceCandidates: ceList.slice(0, 2),
      peCandidates: peList.slice(0, 2),
      bestCe: ceList.length > 0 ? ceList[0] : null,
      bestPe: peList.length > 0 ? peList[0] : null,
    };
  }

  /**
   * Computes the 1.5x Breakout trigger price from the 09:20 candle open
   */
  public computeBreakoutTrigger(open0920: number): number {
    return Number((open0920 * SENSEX_OOBTST_BREAKOUT_MULTIPLIER).toFixed(2));
  }

  /**
   * Computes the 50% stop-loss price strictly from actual executed price
   */
  public computeStopLoss(executedPrice: number): number {
    return Number((executedPrice * SENSEX_OOBTST_SL_MULTIPLIER).toFixed(2));
  }
}

export const sensexOobtstStrategy = new SensexOobtstStrategy();
