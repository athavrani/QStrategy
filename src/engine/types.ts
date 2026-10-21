import type { StockRadarItem, NiftyBreakout180State } from '../types/mobile';
import type { OobtstLiveState } from '../strategies/types';
import type { AcquireAlertLatchDetails, CrossoverTriggerState } from '../services/alertLatchService';

/** Inputs a strategy may read. Missing inputs mean "nothing to detect" for that strategy. */
export interface EngineContext {
  istTime: string;
  stocks?: StockRadarItem[];
  breakout?: NiftyBreakout180State | null;
  niftyOobtst?: OobtstLiveState | null;
  sensexOobtst?: OobtstLiveState | null;
}

export interface SignalEvent {
  /** Prefix of the journal entry id; a timestamp is appended. */
  idPrefix: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  signalType: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss?: number;
  target?: number;
  timestamp: string;
  latch: {
    key: string;
    side: CrossoverTriggerState;
    details: AcquireAlertLatchDetails;
  };
  /** Runs only after the latch is acquired, so expensive work is skipped for suppressed duplicates. */
  materialize: () => { notes: string; notify?: () => void };
}

export interface EngineStrategy {
  id: string;
  detect(ctx: EngineContext): SignalEvent[];
}
