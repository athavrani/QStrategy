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
  | 'CANDIDATES_LOCKED'
  | 'MONITORING_BREAKOUT'
  | 'IN_TRADE'
  | 'TARGET_HIT'
  | 'SL_HIT'
  | 'TIME_EXIT'
  | 'NO_TRADE_WINDOW_CLOSED';

export interface BreakoutCandidateLeg {
  type: 'CE' | 'PE';
  strike: number;
  symbol: string;
  price0925: number;
  currentLtp: number;
  distanceTo180: number;
  isTriggered: boolean;
  isDisabled: boolean;
  securityId?: string;
}

export interface BreakoutStrategyState {
  status: BreakoutStatus;
  currentStep: 1 | 2 | 3;
  entryTime?: string;
  exitTime?: string;
  entryPrice?: number;
  exitPrice?: number;
  activeContract: 'CE' | 'PE' | null;
  fixedTarget: number;
  fixedStopLoss: number;
  pnlPoints: number;
  ceCandidate: BreakoutCandidateLeg | null;
  peCandidate: BreakoutCandidateLeg | null;
  tradeCountToday: number;
  headline: string;
  statusBadgeText: string;
}

export class NiftyBreakout180Strategy {
  /**
   * Filters option chain at 09:25:00 AM IST to pick CE and PE closest under ₹180.00
   * Invariant 1: 09:25 Candle Open < ₹180.00
   */
  public select0925Candidates(
    chain: OptionChainResult,
    candleOpens?: Record<string, number>
  ): {
    ceCandidate: BreakoutCandidateLeg | null;
    peCandidate: BreakoutCandidateLeg | null;
  } {
    if (!chain || chain.strikes.length === 0 || chain.spotPrice === null) {
      return { ceCandidate: null, peCandidate: null };
    }

    const atm = chain.atmStrike ?? chain.spotPrice;

    let bestCe: BreakoutCandidateLeg | null = null;
    let maxCePrice = -Infinity;

    let bestPe: BreakoutCandidateLeg | null = null;
    let maxPePrice = -Infinity;

    for (const strike of chain.strikes) {
      // CE: strike >= ATM, LTP < 180, and Open < 180
      if (strike.strikePrice >= atm && strike.ce.ltp !== null) {
        const ltp = strike.ce.ltp;
        const openPrice = candleOpens?.[`CE_${strike.strikePrice}`] ?? ltp;

        if (ltp < BREAKOUT_TRIGGER_LEVEL && openPrice < BREAKOUT_TRIGGER_LEVEL) {
          if (ltp > maxCePrice) {
            maxCePrice = ltp;
            bestCe = {
              type: 'CE',
              strike: strike.strikePrice,
              symbol: `NIFTY ${strike.strikePrice} CE`,
              price0925: ltp,
              currentLtp: ltp,
              distanceTo180: Number((BREAKOUT_TRIGGER_LEVEL - ltp).toFixed(2)),
              isTriggered: false,
              isDisabled: false,
              securityId: strike.ce.securityId,
            };
          }
        }
      }

      // PE: strike <= ATM, LTP < 180, and Open < 180
      if (strike.strikePrice <= atm && strike.pe.ltp !== null) {
        const ltp = strike.pe.ltp;
        const openPrice = candleOpens?.[`PE_${strike.strikePrice}`] ?? ltp;

        if (ltp < BREAKOUT_TRIGGER_LEVEL && openPrice < BREAKOUT_TRIGGER_LEVEL) {
          if (ltp > maxPePrice) {
            maxPePrice = ltp;
            bestPe = {
              type: 'PE',
              strike: strike.strikePrice,
              symbol: `NIFTY ${strike.strikePrice} PE`,
              price0925: ltp,
              currentLtp: ltp,
              distanceTo180: Number((BREAKOUT_TRIGGER_LEVEL - ltp).toFixed(2)),
              isTriggered: false,
              isDisabled: false,
              securityId: strike.pe.securityId,
            };
          }
        }
      }
    }

    return { ceCandidate: bestCe, peCandidate: bestPe };
  }

  /**
   * Evaluates the breakout state machine, OCO leg cancellation, 1:2 R:R, and 09:45 cutoff
   */
  public evaluate(
    currentState: BreakoutStrategyState | null,
    ticks: { ceLtp?: number; peLtp?: number },
    currentTimeIST: string,
    chain?: OptionChainResult
  ): BreakoutStrategyState {
    const isBefore0925 = currentTimeIST < SCAN_START_TIME;
    const isPast0945 = currentTimeIST >= SCAN_END_TIME;

    // Phase A: Before 09:25:00 IST
    if (isBefore0925) {
      return {
        status: 'WAITING_0925',
        currentStep: 1,
        activeContract: null,
        fixedTarget: FIXED_TARGET,
        fixedStopLoss: FIXED_STOP_LOSS,
        pnlPoints: 0,
        ceCandidate: currentState?.ceCandidate ?? null,
        peCandidate: currentState?.peCandidate ?? null,
        tradeCountToday: 0,
        headline: 'Waiting for 09:25:00 IST candle open to select contracts < ₹180',
        statusBadgeText: 'STEP 1: WAITING 09:25',
      };
    }

    // Phase B: Locked / Monitoring (09:25:00 to 09:45:00 IST)
    let state = currentState;
    if (!state || state.status === 'WAITING_0925') {
      let ceCand = state?.ceCandidate ?? null;
      let peCand = state?.peCandidate ?? null;

      if ((!ceCand || !peCand) && chain) {
        const selected = this.select0925Candidates(chain);
        ceCand = selected.ceCandidate;
        peCand = selected.peCandidate;
      }

      state = {
        status: 'MONITORING_BREAKOUT',
        currentStep: 1,
        activeContract: null,
        fixedTarget: FIXED_TARGET,
        fixedStopLoss: FIXED_STOP_LOSS,
        pnlPoints: 0,
        ceCandidate: ceCand,
        peCandidate: peCand,
        tradeCountToday: 0,
        headline: `Locked candidates: ${ceCand?.strike || '---'} CE & ${peCand?.strike || '---'} PE (< ₹180)`,
        statusBadgeText: 'STEP 1: MONITORING > 180',
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

    const ceCrossed = cePrice >= BREAKOUT_TRIGGER_LEVEL && !state.ceCandidate?.isDisabled;
    const peCrossed = pePrice >= BREAKOUT_TRIGGER_LEVEL && !state.peCandidate?.isDisabled;

    // Trigger BUY on first contract crossing 180 and OCO opposite leg
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
          distanceTo180: Number(Math.max(0, BREAKOUT_TRIGGER_LEVEL - cePrice).toFixed(2)),
        }
      : null;

    const updatedPe = state.peCandidate
      ? {
          ...state.peCandidate,
          currentLtp: pePrice,
          distanceTo180: Number(Math.max(0, BREAKOUT_TRIGGER_LEVEL - pePrice).toFixed(2)),
        }
      : null;

    return {
      ...state,
      ceCandidate: updatedCe,
      peCandidate: updatedPe,
      headline: `Watching CE (₹${cePrice.toFixed(1)}) & PE (₹${pePrice.toFixed(1)}) [< ₹180]`,
      statusBadgeText: 'STEP 1: MONITORING > 180',
    };
  }
}

export const niftyBreakout180Strategy = new NiftyBreakout180Strategy();
