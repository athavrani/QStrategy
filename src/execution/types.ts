import type { ExecutionHint } from '../engine/types';

export type { ExecutionHint };

/**
 * OFF ignores signals. PAPER records the order that would be sent, without sending anything.
 * CONFIRM turns a signal into a proposal that is sent live only after you confirm it.
 */
export type ExecutionMode = 'OFF' | 'PAPER' | 'CONFIRM';

/** Strategies whose signals can become orders. The 20D volume screener is alert-only. */
export const EXECUTABLE_STRATEGIES = ['NIFTY_BREAKOUT_180', 'OOBTST_NIFTY', 'OOBTST_SENSEX'] as const;
export type ExecutableStrategyId = (typeof EXECUTABLE_STRATEGIES)[number];

export interface StrategyExecutionSetting {
  enabled: boolean;
  lots: number;
}

export interface ExecutionLimits {
  maxLotsPerOrder: number;
  maxOrdersPerDay: number;
  /** Premium paid for one order (price x quantity), in rupees. */
  maxOrderValue: number;
  /** Premium paid across all of today's orders, in rupees. */
  maxDailyValue: number;
}

export interface ExecutionSettings {
  mode: ExecutionMode;
  /** When on, every signal is blocked and recorded as such. */
  killSwitch: boolean;
  strategies: Record<ExecutableStrategyId, StrategyExecutionSetting>;
  limits: ExecutionLimits;
  /** Entry limit price is the signal price plus this percentage, so a fast-moving option still fills. */
  limitBufferPct: number;
}

/** A detected signal as the execution layer receives it, after it has been latched and journaled. */
export interface ExecutableSignal {
  journalId: string;
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss?: number;
  target?: number;
  timestamp: string;
  hint?: ExecutionHint;
}

export type ExecutionDecision =
  /** The order that would be sent was recorded (paper). */
  | { kind: 'PLANNED'; correlationId: string }
  /** A live order is waiting for the user to confirm it. */
  | { kind: 'PROPOSED'; correlationId: string }
  /** A rule stopped the order; the reason was recorded. */
  | { kind: 'BLOCKED'; reason: string; correlationId: string }
  /** Execution is off or not enabled for this strategy; nothing was recorded. */
  | { kind: 'SKIPPED' };

export interface ExecutionPort {
  onSignal(signal: ExecutableSignal): Promise<ExecutionDecision>;
}
