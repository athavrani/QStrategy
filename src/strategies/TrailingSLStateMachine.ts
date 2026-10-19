/**
 * QStrategy — 4-State Trailing Stop-Loss (TSL) State Machine
 * Implements deterministic risk-to-reward progression:
 * - State 1: INITIAL (Entry Price - 1R risk buffer)
 * - State 2: BREAKEVEN (+1R gain reached -> move SL to entry + 0.05R to lock costs)
 * - State 3: LOCKED_PROFIT (+2R gain reached -> lock +1R profit)
 * - State 4: EOD_EXIT (15:30:00 IST square-off)
 */

export type TslState = 'INITIAL' | 'BREAKEVEN' | 'LOCKED_PROFIT' | 'EOD_EXIT' | 'SL_HIT' | 'TARGET_HIT';

export interface TslConfig {
  entryPrice: number;
  initialRiskPts: number; // 1R value in points (e.g. 1% of stock price or 20% of option premium)
  targetPts?: number; // Optional final profit target (e.g. +3R or +4R)
  eodCutoffIST?: string; // Default: '15:30:00'
}

export interface TslEvaluationResult {
  state: TslState;
  currentSl: number;
  currentGainPts: number;
  currentGainR: number;
  isExitTriggered: boolean;
  exitReason?: string;
  exitPrice?: number;
}

export class TrailingSLStateMachine {
  private config: TslConfig;
  private state: TslState = 'INITIAL';
  private currentSl: number;
  private peakPrice: number;

  constructor(config: TslConfig) {
    this.config = config;
    this.currentSl = config.entryPrice - config.initialRiskPts;
    this.peakPrice = config.entryPrice;
  }

  public getState(): TslState {
    return this.state;
  }

  public getCurrentSl(): number {
    return this.currentSl;
  }

  public getPeakPrice(): number {
    return this.peakPrice;
  }

  /**
   * Evaluates incoming tick price against the 4-state TSL logic
   */
  public update(currentPrice: number, currentTimeIST?: string): TslEvaluationResult {
    // If already exited, return terminal state
    if (this.state === 'SL_HIT' || this.state === 'TARGET_HIT' || this.state === 'EOD_EXIT') {
      return {
        state: this.state,
        currentSl: this.currentSl,
        currentGainPts: currentPrice - this.config.entryPrice,
        currentGainR: (currentPrice - this.config.entryPrice) / this.config.initialRiskPts,
        isExitTriggered: true,
        exitReason: `Position terminated with status ${this.state}`,
      };
    }

    // Check EOD Cutoff (15:30:00 IST)
    const cutoff = this.config.eodCutoffIST || '15:30:00';
    if (currentTimeIST && currentTimeIST >= cutoff) {
      this.state = 'EOD_EXIT';
      return {
        state: 'EOD_EXIT',
        currentSl: this.currentSl,
        currentGainPts: currentPrice - this.config.entryPrice,
        currentGainR: (currentPrice - this.config.entryPrice) / this.config.initialRiskPts,
        isExitTriggered: true,
        exitReason: `EOD Square-Off triggered at ${currentTimeIST}`,
        exitPrice: currentPrice,
      };
    }

    if (currentPrice > this.peakPrice) {
      this.peakPrice = currentPrice;
    }

    const gainPts = currentPrice - this.config.entryPrice;
    const gainR = gainPts / this.config.initialRiskPts;

    // Check Stop-Loss breach
    if (currentPrice <= this.currentSl) {
      this.state = 'SL_HIT';
      return {
        state: 'SL_HIT',
        currentSl: this.currentSl,
        currentGainPts: gainPts,
        currentGainR: gainR,
        isExitTriggered: true,
        exitReason: `Stop-loss breached at ₹${currentPrice.toFixed(2)} (SL: ₹${this.currentSl.toFixed(2)})`,
        exitPrice: currentPrice,
      };
    }

    // Check Optional Final Target
    if (this.config.targetPts && gainPts >= this.config.targetPts) {
      this.state = 'TARGET_HIT';
      return {
        state: 'TARGET_HIT',
        currentSl: this.currentSl,
        currentGainPts: gainPts,
        currentGainR: gainR,
        isExitTriggered: true,
        exitReason: `Target profit reached at ₹${currentPrice.toFixed(2)}`,
        exitPrice: currentPrice,
      };
    }

    // State 3: LOCKED_PROFIT (Reached +2R gain -> lock +1R profit)
    if (gainR >= 2.0 && this.state !== 'LOCKED_PROFIT') {
      this.state = 'LOCKED_PROFIT';
      // SL moves to Entry + 1.0R
      this.currentSl = this.config.entryPrice + this.config.initialRiskPts;
    }
    // State 2: BREAKEVEN (Reached +1R gain -> move SL to breakeven + 0.05R buffer)
    else if (gainR >= 1.0 && this.state === 'INITIAL') {
      this.state = 'BREAKEVEN';
      // SL moves to Entry + 0.05R to cover fees
      this.currentSl = this.config.entryPrice + 0.05 * this.config.initialRiskPts;
    }

    return {
      state: this.state,
      currentSl: Number(this.currentSl.toFixed(2)),
      currentGainPts: Number(gainPts.toFixed(2)),
      currentGainR: Number(gainR.toFixed(2)),
      isExitTriggered: false,
    };
  }
}
