/**
 * QStrategy — NIFTY 09:20 Overnight Strangle Strategy Engine (NIFTY_OVERNIGHT)
 * Mathematical Invariants:
 * 1. Dual Entry at 09:20:00 AM IST closest to ₹62.50 in ₹50–₹75 candidate range
 * 2. Strict 25% Stop Loss (refPrice * 0.75)
 * 3. STRICTLY ZERO PROFIT TARGET INVARIANT (targetPrice === undefined)
 * 4. Overnight carry through 15:30 (OVERNIGHT_HOLD)
 * 5. Mandatory square-off at 09:25:00 AM IST on next NSE trading day (D+1)
 */

import { OptionChainResult, OptionStrikeData } from '../services/dhan/DhanOptionChainService';

export const TARGET_PREMIUM_ANCHOR = 62.5;
export const CANDIDATE_RANGE_MIN = 50.0;
export const CANDIDATE_RANGE_MAX = 75.0;
export const SL_PERCENTAGE = 0.25; // Strict 25% Stop Loss

export type StrangleStrategyStatus =
  | 'PRE_SELECTION' // Before 09:20:00
  | 'ENTRY_TRIGGERED' // Exactly 09:20:00
  | 'ACTIVE_HOLD' // 09:20:00 to 15:30:00
  | 'OVERNIGHT_HOLD' // 15:30:00 to Next Day 09:15:00
  | 'NEXT_DAY_HOLD' // Next Day 09:15:00 to 09:25:00
  | 'COMPLETED'; // Next Day 09:25:00 or Both SL Hit

export interface StrangleLegState {
  type: 'CE' | 'PE';
  strike: number;
  symbol: string;
  refPrice: number;
  stopLossPrice: number;
  currentLtp: number;
  // STRICT INVARIANT: Target price is intentionally and strictly undefined
  targetPrice?: undefined;
  status: 'ACTIVE' | 'SL_HIT' | 'SQUARED_OFF';
  pnlPts: number;
  pnlPct: number;
  securityId?: string;
}

export interface StrangleStrategyEvaluation {
  status: StrangleStrategyStatus;
  statusBadgeText: string;
  sessionDate: string;
  entryTime: string;
  exitTime?: string;
  isOvernightCarry: boolean;
  ceLeg: StrangleLegState | null;
  peLeg: StrangleLegState | null;
  netPnlPts: number;
  headline: string;
  // STRICT INVARIANT: Strategy target is strictly undefined
  target?: undefined;
  stopLossRule: string;
  invariantNotice: string;
}

export interface CandidateContract {
  strike: number;
  ltp: number;
  distanceToAnchor: number;
  securityId?: string;
}

export class NiftyOvernightStrategy {
  /**
   * Filters and selects the candidate strikes closest to ₹62.50 within the ₹50–₹75 range
   */
  public select0920Candidates(chain: OptionChainResult): {
    ceCandidate: CandidateContract | null;
    peCandidate: CandidateContract | null;
  } {
    if (!chain || chain.strikes.length === 0 || chain.spotPrice === null) {
      return { ceCandidate: null, peCandidate: null };
    }

    const atm = chain.atmStrike ?? chain.spotPrice;

    let bestCe: CandidateContract | null = null;
    let minCeDiff = Infinity;

    let bestPe: CandidateContract | null = null;
    let minPeDiff = Infinity;

    for (const strike of chain.strikes) {
      // CE Candidate: strike >= ATM and price between ₹50 and ₹75
      if (strike.strikePrice >= atm && strike.ce.ltp !== null) {
        const p = strike.ce.ltp;
        if (p >= CANDIDATE_RANGE_MIN && p <= CANDIDATE_RANGE_MAX) {
          const diff = Math.abs(p - TARGET_PREMIUM_ANCHOR);
          if (diff < minCeDiff) {
            minCeDiff = diff;
            bestCe = {
              strike: strike.strikePrice,
              ltp: p,
              distanceToAnchor: Number(diff.toFixed(2)),
              securityId: strike.ce.securityId,
            };
          }
        }
      }

      // PE Candidate: strike <= ATM and price between ₹50 and ₹75
      if (strike.strikePrice <= atm && strike.pe.ltp !== null) {
        const p = strike.pe.ltp;
        if (p >= CANDIDATE_RANGE_MIN && p <= CANDIDATE_RANGE_MAX) {
          const diff = Math.abs(p - TARGET_PREMIUM_ANCHOR);
          if (diff < minPeDiff) {
            minPeDiff = diff;
            bestPe = {
              strike: strike.strikePrice,
              ltp: p,
              distanceToAnchor: Number(diff.toFixed(2)),
              securityId: strike.pe.securityId,
            };
          }
        }
      }
    }

    return { ceCandidate: bestCe, peCandidate: bestPe };
  }

  /**
   * Evaluates the Strangle position and enforces stop-losses and Zero Target Invariant
   */
  public evaluate(
    chain: OptionChainResult,
    currentTimeIST: string,
    existingPosition?: {
      ceLeg: StrangleLegState;
      peLeg: StrangleLegState;
      entryDate: string;
      isNextDay?: boolean;
    }
  ): StrangleStrategyEvaluation {
    const invariantNotice =
      '⚡ Zero Target Invariant: This strategy carries overnight with NO profit target. Exits strictly on 25% SL or next-day 09:25 AM IST.';
    const stopLossRule = 'Strict 25% Stop Loss (Ref * 0.75)';

    // Case 1: Existing position being monitored
    if (existingPosition) {
      const isNextDay = !!existingPosition.isNextDay;
      let status: StrangleStrategyStatus = isNextDay ? 'NEXT_DAY_HOLD' : 'ACTIVE_HOLD';

      // Check next-day 09:25:00 exit
      if (isNextDay && currentTimeIST >= '09:25:00') {
        status = 'COMPLETED';
      } else if (!isNextDay && currentTimeIST >= '15:30:00') {
        status = 'OVERNIGHT_HOLD';
      }

      // Check live tick prices against 25% SL
      const ceLtp = this.findLivePrice(chain, existingPosition.ceLeg.strike, 'CE') ?? existingPosition.ceLeg.currentLtp;
      const peLtp = this.findLivePrice(chain, existingPosition.peLeg.strike, 'PE') ?? existingPosition.peLeg.currentLtp;

      const ceSlHit = existingPosition.ceLeg.status === 'SL_HIT' || ceLtp <= existingPosition.ceLeg.stopLossPrice;
      const peSlHit = existingPosition.peLeg.status === 'SL_HIT' || peLtp <= existingPosition.peLeg.stopLossPrice;

      const updatedCe: StrangleLegState = {
        ...existingPosition.ceLeg,
        currentLtp: ceLtp,
        status: ceSlHit ? 'SL_HIT' : status === 'COMPLETED' ? 'SQUARED_OFF' : 'ACTIVE',
        pnlPts: Number((ceLtp - existingPosition.ceLeg.refPrice).toFixed(2)),
        pnlPct: Number((((ceLtp - existingPosition.ceLeg.refPrice) / existingPosition.ceLeg.refPrice) * 100).toFixed(2)),
        // STRICT INVARIANT
        targetPrice: undefined,
      };

      const updatedPe: StrangleLegState = {
        ...existingPosition.peLeg,
        currentLtp: peLtp,
        status: peSlHit ? 'SL_HIT' : status === 'COMPLETED' ? 'SQUARED_OFF' : 'ACTIVE',
        pnlPts: Number((peLtp - existingPosition.peLeg.refPrice).toFixed(2)),
        pnlPct: Number((((peLtp - existingPosition.peLeg.refPrice) / existingPosition.peLeg.refPrice) * 100).toFixed(2)),
        // STRICT INVARIANT
        targetPrice: undefined,
      };

      const netPnlPts = Number((updatedCe.pnlPts + updatedPe.pnlPts).toFixed(2));

      return {
        status,
        statusBadgeText:
          status === 'COMPLETED'
            ? 'SQUARED OFF @ 09:25'
            : status === 'OVERNIGHT_HOLD'
            ? 'OVERNIGHT HOLD (EXEMPT EOD)'
            : `${status} (P&L: ${netPnlPts >= 0 ? '+' : ''}${netPnlPts} pts)`,
        sessionDate: existingPosition.entryDate,
        entryTime: '09:20:00',
        exitTime: status === 'COMPLETED' ? '09:25:00' : undefined,
        isOvernightCarry: status === 'OVERNIGHT_HOLD' || status === 'NEXT_DAY_HOLD',
        ceLeg: updatedCe,
        peLeg: updatedPe,
        netPnlPts,
        headline: `NIFTY 09:20 Strangle (${updatedCe.symbol} + ${updatedPe.symbol})`,
        target: undefined,
        stopLossRule,
        invariantNotice,
      };
    }

    // Case 2: No position yet — check current time
    const isBefore0920 = currentTimeIST < '09:20:00';
    const is0920Trigger = currentTimeIST >= '09:20:00' && currentTimeIST < '15:30:00';

    const { ceCandidate, peCandidate } = this.select0920Candidates(chain);

    if (isBefore0920 || !ceCandidate || !peCandidate) {
      return {
        status: 'PRE_SELECTION',
        statusBadgeText: 'PRE-SELECTION (LOCKS 09:20:00)',
        sessionDate: chain.expiry,
        entryTime: '09:20:00',
        isOvernightCarry: false,
        ceLeg: null,
        peLeg: null,
        netPnlPts: 0,
        headline: 'Monitoring candidate strikes in ₹50–₹75 range closest to ₹62.50',
        target: undefined,
        stopLossRule,
        invariantNotice,
      };
    }

    // Dual Buy Entry at 09:20:00 AM IST
    const ceSl = Number((ceCandidate.ltp * (1 - SL_PERCENTAGE)).toFixed(2));
    const peSl = Number((peCandidate.ltp * (1 - SL_PERCENTAGE)).toFixed(2));

    const ceLeg: StrangleLegState = {
      type: 'CE',
      strike: ceCandidate.strike,
      symbol: `NIFTY ${ceCandidate.strike} CE`,
      refPrice: ceCandidate.ltp,
      stopLossPrice: ceSl,
      currentLtp: ceCandidate.ltp,
      status: 'ACTIVE',
      pnlPts: 0,
      pnlPct: 0,
      targetPrice: undefined,
      securityId: ceCandidate.securityId,
    };

    const peLeg: StrangleLegState = {
      type: 'PE',
      strike: peCandidate.strike,
      symbol: `NIFTY ${peCandidate.strike} PE`,
      refPrice: peCandidate.ltp,
      stopLossPrice: peSl,
      currentLtp: peCandidate.ltp,
      status: 'ACTIVE',
      pnlPts: 0,
      pnlPct: 0,
      targetPrice: undefined,
      securityId: peCandidate.securityId,
    };

    return {
      status: is0920Trigger ? 'ENTRY_TRIGGERED' : 'PRE_SELECTION',
      statusBadgeText: 'ENTRY TRIGGERED @ 09:20',
      sessionDate: chain.expiry,
      entryTime: '09:20:00',
      isOvernightCarry: true,
      ceLeg,
      peLeg,
      netPnlPts: 0,
      headline: `Locked Dual Entry: ${ceLeg.symbol} @ ₹${ceLeg.refPrice} & ${peLeg.symbol} @ ₹${peLeg.refPrice}`,
      target: undefined,
      stopLossRule,
      invariantNotice,
    };
  }

  private findLivePrice(chain: OptionChainResult, strike: number, type: 'CE' | 'PE'): number | null {
    const item = chain.strikes.find((s) => s.strikePrice === strike);
    if (!item) return null;
    return type === 'CE' ? item.ce.ltp : item.pe.ltp;
  }
}

export const niftyOvernightStrategy = new NiftyOvernightStrategy();
