/**
 * QStrategy — NIFTY 09:25 ₹180 Directional Breakout Strategy Engine (NIFTY_BREAKOUT_180)
 * Mathematical Invariants:
 * 1. 09:25 Candle Open < ₹180.00 filter
 * 2. High-speed breakout trigger (First contract crossing >= ₹180 between 09:25:00 and 09:45:00 IST)
 * 3. One-Cancels-Other (OCO): The instant one leg triggers, the opposite leg is permanently disabled
 * 4. Fixed 1:2 Risk-to-Reward: Target = ₹220.00 (+40 pts), Stop Loss = ₹160.00 (-20 pts)
 * 5. Mandatory Hard Cutoff: Square-off at market price at exactly 09:45:00 IST
 */

import { OptionChainResult } from '../services/dhan/DhanOptionChainService';

export const BREAKOUT_TRIGGER_LEVEL = 180.0;
export const FIXED_TARGET = 220.0; // +40 pts
export const FIXED_STOP_LOSS = 160.0; // -20 pts
export const RISK_REWARD_RATIO = 2.0; // 1:2
export const SCAN_START_TIME = '09:25:00';
export const SCAN_END_TIME = '09:45:00';

export type BreakoutStatus =
  | 'WAITING_0925'
  | 'PROVISIONAL_MONITORING'
  | 'CANDIDATES_LOCKED'
  | 'MONITORING_BREAKOUT'
  | 'IN_TRADE'
  | 'TARGET_HIT'
  | 'SL_HIT'
  | 'TIME_EXIT'
  | 'NO_TRADE_WINDOW_CLOSED'
  | 'LOCK_FAILED'
  | 'NO_ELIGIBLE_STRIKE';

export interface BreakoutCandidateLeg {
  type: 'CE' | 'PE';
  strike: number;
  symbol: string;
  price0925: number;
  currentLtp: number;
  distanceTo180: number;
  isTriggered: boolean;
  isDisabled: boolean;
  rank?: 1 | 2;
  securityId?: string;
  quoteTimestamp?: string;
  quoteFreshness?: 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED';
}

export interface BreakoutStrategyState {
  status: BreakoutStatus;
  currentStep: 1 | 2 | 3;
  entryTime?: string;
  exitTime?: string;
  entryPrice?: number;
  exitPrice?: number;
  activeContract: 'CE' | 'PE' | null;
  threshold: number;
  lockedThreshold?: number;
  fixedTarget: number;
  fixedStopLoss: number;
  pnlPoints: number;
  ceCandidate: BreakoutCandidateLeg | null;
  peCandidate: BreakoutCandidateLeg | null;
  ceCandidates?: BreakoutCandidateLeg[];
  peCandidates?: BreakoutCandidateLeg[];
  tradeCountToday: number;
  headline: string;
  statusBadgeText: string;
  isLockFailed?: boolean;
  lockFailureReason?: string;
  noEligibleSide?: 'CE' | 'PE' | 'BOTH' | null;
  isHistoricalSession?: boolean;
  historicalDate?: string;
  historicalStatus?: 'HISTORICAL SESSION RESULTS' | 'HISTORICAL DATA UNAVAILABLE';
}

export class NiftyBreakout180Strategy {
  /**
   * Filters option chain at 09:25:00 AM IST to pick CE and PE closest under threshold (default: ₹180.00)
   * Invariant 1: 09:25 Candle Open < threshold
   */
  public select0925Candidates(
    chain: OptionChainResult,
    candleOpens?: Record<string, number>,
    threshold: number = BREAKOUT_TRIGGER_LEVEL
  ): {
    ceCandidate: BreakoutCandidateLeg | null;
    peCandidate: BreakoutCandidateLeg | null;
    ceCandidates: BreakoutCandidateLeg[];
    peCandidates: BreakoutCandidateLeg[];
  } {
    if (!chain || chain.strikes.length === 0 || chain.spotPrice === null) {
      return { ceCandidate: null, peCandidate: null, ceCandidates: [], peCandidates: [] };
    }

    const atm = chain.atmStrike ?? chain.spotPrice;

    const ceCandidatesList: BreakoutCandidateLeg[] = [];
    const peCandidatesList: BreakoutCandidateLeg[] = [];

    for (const strike of chain.strikes) {
      // CE: strike >= ATM, LTP < threshold, and Open < threshold
      if (strike.strikePrice >= atm && strike.ce.ltp !== null) {
        const ltp = strike.ce.ltp;
        const openPrice = candleOpens?.[`CE_${strike.strikePrice}`] ?? ltp;

        if (ltp < threshold && openPrice < threshold && ltp > 0) {
          ceCandidatesList.push({
            type: 'CE',
            strike: strike.strikePrice,
            symbol: `NIFTY ${strike.strikePrice} CE`,
            price0925: openPrice,
            currentLtp: ltp,
            distanceTo180: Number((threshold - openPrice).toFixed(2)),
            isTriggered: false,
            isDisabled: false,
            securityId: strike.ce.securityId,
          });
        }
      }

      // PE: strike <= ATM, LTP < threshold, and Open < threshold
      if (strike.strikePrice <= atm && strike.pe.ltp !== null) {
        const ltp = strike.pe.ltp;
        const openPrice = candleOpens?.[`PE_${strike.strikePrice}`] ?? ltp;

        if (ltp < threshold && openPrice < threshold && ltp > 0) {
          peCandidatesList.push({
            type: 'PE',
            strike: strike.strikePrice,
            symbol: `NIFTY ${strike.strikePrice} PE`,
            price0925: openPrice,
            currentLtp: ltp,
            distanceTo180: Number((threshold - openPrice).toFixed(2)),
            isTriggered: false,
            isDisabled: false,
            securityId: strike.pe.securityId,
          });
        }
      }
    }

    // Rank descending by openPrice (closest to threshold from below)
    ceCandidatesList.sort((a, b) => b.price0925 - a.price0925);
    peCandidatesList.sort((a, b) => b.price0925 - a.price0925);

    ceCandidatesList.forEach((c, idx) => {
      c.rank = (idx + 1) as 1 | 2;
    });
    peCandidatesList.forEach((p, idx) => {
      p.rank = (idx + 1) as 1 | 2;
    });

    const topCe = ceCandidatesList.slice(0, 2);
    const topPe = peCandidatesList.slice(0, 2);

    return {
      ceCandidate: topCe[0] ?? null,
      peCandidate: topPe[0] ?? null,
      ceCandidates: topCe,
      peCandidates: topPe,
    };
  }

  /**
   * Evaluates the breakout state machine, OCO leg cancellation, 1:2 R:R, and 09:45 cutoff
   */
  public evaluate(
    currentState: BreakoutStrategyState | null,
    ticks: { ceLtp?: number; peLtp?: number },
    currentTimeIST: string,
    chain?: OptionChainResult,
    candleOpens?: Record<string, number>,
    customThreshold?: number
  ): BreakoutStrategyState {
    const activeThreshold =
      currentState?.lockedThreshold ?? customThreshold ?? currentState?.threshold ?? BREAKOUT_TRIGGER_LEVEL;
    const isBefore0915 = currentTimeIST < '09:15:00';
    const isProvisional = currentTimeIST >= '09:15:00' && currentTimeIST < SCAN_START_TIME;
    const isBefore0925 = currentTimeIST < SCAN_START_TIME;
    const isPast0945 = currentTimeIST >= SCAN_END_TIME;

    // Phase A1: Before 09:15:00 IST (Market Closed / Awaiting Open)
    if (isBefore0915) {
      return {
        status: 'WAITING_0925',
        currentStep: 1,
        activeContract: null,
        threshold: activeThreshold,
        fixedTarget: FIXED_TARGET,
        fixedStopLoss: FIXED_STOP_LOSS,
        pnlPoints: 0,
        ceCandidate: currentState?.ceCandidate ?? null,
        peCandidate: currentState?.peCandidate ?? null,
        tradeCountToday: 0,
        headline: `Waiting for market open to monitor contracts < ₹${activeThreshold.toFixed(2)}`,
        statusBadgeText: 'STEP 1: WAITING 09:15',
      };
    }

    // Phase A2: Pre-Lock Candidate Monitoring (09:15:00 to 09:24:59 IST)
    if (isProvisional) {
      let ceCand = currentState?.ceCandidate ?? null;
      let peCand = currentState?.peCandidate ?? null;
      let ceCands = currentState?.ceCandidates ?? [];
      let peCands = currentState?.peCandidates ?? [];

      if (chain) {
        const selected = this.select0925Candidates(chain, candleOpens, activeThreshold);
        ceCand = selected.ceCandidate;
        peCand = selected.peCandidate;
        ceCands = selected.ceCandidates;
        peCands = selected.peCandidates;
      }

      return {
        status: 'PROVISIONAL_MONITORING',
        currentStep: 1,
        activeContract: null,
        threshold: activeThreshold,
        fixedTarget: FIXED_TARGET,
        fixedStopLoss: FIXED_STOP_LOSS,
        pnlPoints: 0,
        ceCandidate: ceCand,
        peCandidate: peCand,
        ceCandidates: ceCands,
        peCandidates: peCands,
        tradeCountToday: 0,
        headline: 'PROVISIONAL — NOT LOCKED • Monitoring Top 2 CE & PE',
        statusBadgeText: 'PROVISIONAL MONITORING',
      };
    }

    // Phase B: Exact 09:25:00 Candle Open Strike Lock
    let state = currentState;
    if (!state || state.status === 'WAITING_0925' || state.status === 'PROVISIONAL_MONITORING') {
      let ceCand = state?.ceCandidate ?? null;
      let peCand = state?.peCandidate ?? null;
      let ceCands = state?.ceCandidates ?? [];
      let peCands = state?.peCandidates ?? [];

      if (chain) {
        const selected = this.select0925Candidates(chain, candleOpens, activeThreshold);
        ceCand = selected.ceCandidate;
        peCand = selected.peCandidate;
        ceCands = selected.ceCandidates;
        peCands = selected.peCandidates;
      }

      if (!ceCand && !peCand) {
        return {
          status: 'LOCK_FAILED',
          currentStep: 1,
          activeContract: null,
          threshold: activeThreshold,
          fixedTarget: FIXED_TARGET,
          fixedStopLoss: FIXED_STOP_LOSS,
          pnlPoints: 0,
          ceCandidate: null,
          peCandidate: null,
          tradeCountToday: 0,
          headline: 'LOCK FAILED — DATA UNAVAILABLE',
          statusBadgeText: 'LOCK FAILED',
          isLockFailed: true,
          lockFailureReason: 'LOCK FAILED — DATA UNAVAILABLE',
        };
      }

      if (!ceCand || !peCand) {
        return {
          status: 'NO_ELIGIBLE_STRIKE',
          currentStep: 1,
          activeContract: null,
          threshold: activeThreshold,
          fixedTarget: FIXED_TARGET,
          fixedStopLoss: FIXED_STOP_LOSS,
          pnlPoints: 0,
          ceCandidate: ceCand,
          peCandidate: peCand,
          tradeCountToday: 0,
          headline: `NO_ELIGIBLE_STRIKE for ${!ceCand ? 'CE' : 'PE'} below ₹${activeThreshold.toFixed(2)}`,
          statusBadgeText: 'NO ELIGIBLE STRIKE',
          noEligibleSide: !ceCand && !peCand ? 'BOTH' : !ceCand ? 'CE' : 'PE',
        };
      }

      state = {
        status: 'MONITORING_BREAKOUT',
        currentStep: 1,
        activeContract: null,
        threshold: activeThreshold,
        lockedThreshold: activeThreshold, // Stored upon locking
        fixedTarget: FIXED_TARGET,
        fixedStopLoss: FIXED_STOP_LOSS,
        pnlPoints: 0,
        ceCandidate: ceCand,
        peCandidate: peCand,
        ceCandidates: ceCands,
        peCandidates: peCands,
        tradeCountToday: 0,
        headline: `Locked candidates: ${ceCand.strike} CE & ${peCand.strike} PE (< ₹${activeThreshold.toFixed(2)})`,
        statusBadgeText: 'LOCKED',
      };
    }

    // Terminal states do not re-evaluate
    if (
      state.status === 'TARGET_HIT' ||
      state.status === 'SL_HIT' ||
      state.status === 'TIME_EXIT' ||
      state.status === 'NO_TRADE_WINDOW_CLOSED'
    ) {
      return state;
    }

    // Phase C: If already in trade, monitor Target, SL, and 09:45 Time Exit
    if (state.status === 'IN_TRADE') {
      const activeContract = state.activeContract!;
      const activeLtp = (activeContract === 'CE' ? ticks.ceLtp : ticks.peLtp) ?? state.entryPrice ?? BREAKOUT_TRIGGER_LEVEL;
      const entryPrice = state.entryPrice ?? BREAKOUT_TRIGGER_LEVEL;
      const pnlPoints = Number((activeLtp - entryPrice).toFixed(2));

      // Update candidate current LTP
      const updatedCe = state.ceCandidate
        ? { ...state.ceCandidate, currentLtp: ticks.ceLtp ?? state.ceCandidate.currentLtp }
        : null;
      const updatedPe = state.peCandidate
        ? { ...state.peCandidate, currentLtp: ticks.peLtp ?? state.peCandidate.currentLtp }
        : null;

      // 1. Mandatory 09:45:00 Time Exit Cutoff
      if (isPast0945) {
        return {
          ...state,
          status: 'TIME_EXIT',
          currentStep: 3,
          exitTime: currentTimeIST,
          exitPrice: activeLtp,
          pnlPoints,
          ceCandidate: updatedCe,
          peCandidate: updatedPe,
          headline: `⏱️ 09:45 AM Hard Time Exit triggered @ ₹${activeLtp.toFixed(2)} (P&L: ${pnlPoints >= 0 ? '+' : ''}${pnlPoints} pts)`,
          statusBadgeText: 'STEP 3: TIME EXIT ⏱️',
        };
      }

      // 2. Fixed Target Reach (>= ₹220.00)
      if (activeLtp >= FIXED_TARGET) {
        return {
          ...state,
          status: 'TARGET_HIT',
          currentStep: 3,
          exitTime: currentTimeIST,
          exitPrice: activeLtp,
          pnlPoints,
          ceCandidate: updatedCe,
          peCandidate: updatedPe,
          headline: `🎯 TARGET BOOKED @ ₹${activeLtp.toFixed(2)} (+40 pts / 1:2 R:R achieved)`,
          statusBadgeText: 'STEP 3: TARGET HIT 🎯',
        };
      }

      // 3. Fixed Stop Loss Breach (<= ₹160.00)
      if (activeLtp <= FIXED_STOP_LOSS) {
        return {
          ...state,
          status: 'SL_HIT',
          currentStep: 3,
          exitTime: currentTimeIST,
          exitPrice: activeLtp,
          pnlPoints,
          ceCandidate: updatedCe,
          peCandidate: updatedPe,
          headline: `🛑 STOP LOSS HIT @ ₹${activeLtp.toFixed(2)} (-20 pts contained)`,
          statusBadgeText: 'STEP 3: SL HIT 🛑',
        };
      }

      // Still In Trade
      return {
        ...state,
        pnlPoints,
        ceCandidate: updatedCe,
        peCandidate: updatedPe,
        headline: `🚀 In Trade: ${activeContract} @ ₹${activeLtp.toFixed(2)} (P&L: ${pnlPoints >= 0 ? '+' : ''}${pnlPoints} pts)`,
        statusBadgeText: 'STEP 2: ACTIVE 🚀',
      };
    }

    // Phase D: Monitoring Breakout Window (09:25:00 to 09:45:00)
    // Check if 09:45 cutoff arrived without any breakout
    if (isPast0945) {
      return {
        ...state,
        status: 'NO_TRADE_WINDOW_CLOSED',
        currentStep: 3,
        headline: 'Neither contract broke ₹180 before 09:45 AM cutoff. No trade today.',
        statusBadgeText: 'STEP 3: NO TRADE ⛔',
      };
    }

    const cePrice = ticks.ceLtp ?? state.ceCandidate?.currentLtp ?? 0;
    const pePrice = ticks.peLtp ?? state.peCandidate?.currentLtp ?? 0;

    const ceCrossed = cePrice >= activeThreshold && !state.ceCandidate?.isDisabled;
    const peCrossed = pePrice >= activeThreshold && !state.peCandidate?.isDisabled;

    // Trigger BUY on first contract crossing activeThreshold and OCO opposite leg
    if (ceCrossed || peCrossed) {
      const activeContract: 'CE' | 'PE' = ceCrossed ? 'CE' : 'PE';
      const entryPrice = ceCrossed ? cePrice : pePrice;

      const ceCandidate: BreakoutCandidateLeg | null = state.ceCandidate
        ? {
            ...state.ceCandidate,
            currentLtp: cePrice,
            isTriggered: ceCrossed,
            isDisabled: !ceCrossed, // OCO: Permanently disable if PE crossed
          }
        : null;

      const peCandidate: BreakoutCandidateLeg | null = state.peCandidate
        ? {
            ...state.peCandidate,
            currentLtp: pePrice,
            isTriggered: peCrossed,
            isDisabled: !peCrossed, // OCO: Permanently disable if CE crossed
          }
        : null;

      return {
        ...state,
        status: 'IN_TRADE',
        currentStep: 2,
        entryTime: currentTimeIST,
        entryPrice,
        activeContract,
        tradeCountToday: 1, // Max 1 trade per day invariant
        pnlPoints: 0,
        ceCandidate,
        peCandidate,
        headline: `🚀 BUY TRIGGERED: NIFTY ${activeContract} @ ₹${entryPrice.toFixed(2)} • Opposite Leg Permanently Disabled`,
        statusBadgeText: 'STEP 2: ACTIVE 🚀',
      };
    }

    // Neither crossed yet; update live LTPs and distances
    const updatedCe = state.ceCandidate
      ? {
          ...state.ceCandidate,
          currentLtp: cePrice,
          distanceTo180: Number(Math.max(0, activeThreshold - cePrice).toFixed(2)),
        }
      : null;

    const updatedPe = state.peCandidate
      ? {
          ...state.peCandidate,
          currentLtp: pePrice,
          distanceTo180: Number(Math.max(0, activeThreshold - pePrice).toFixed(2)),
        }
      : null;

    return {
      ...state,
      ceCandidate: updatedCe,
      peCandidate: updatedPe,
      headline: `Watching CE (₹${cePrice.toFixed(1)}) & PE (₹${pePrice.toFixed(1)}) [< ₹${activeThreshold.toFixed(2)}]`,
      statusBadgeText: 'STEP 1: MONITORING > ' + Math.round(activeThreshold),
    };
  }
}

export const niftyBreakout180Strategy = new NiftyBreakout180Strategy();
