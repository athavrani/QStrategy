/**
 * QStrategy — Alert Latch Facade Service
 * Delegates to MonotonicLatchService backed by local SQLite database.
 * Completely autonomous: 0 remote network calls, 100% on-device SQLite guarantee.
 */

import { monotonicLatchService, LatchTriggerState, LatchDetails } from './MonotonicLatchService';

export type CrossoverTriggerState = 'GREEN' | 'RED';

export interface LatchedAlertRecord {
  ticker: string;
  state: CrossoverTriggerState;
  tradeDate: string;
  crossoverTime: string;
  spotPrice: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  volumeRatio: number;
  timestampMs?: number;
  strategyId?: string;
  latchKey?: string;
}

export interface AcquireAlertLatchDetails {
  spotPrice: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  volumeRatio: number;
  crossoverTime?: string;
  strategyId?: string;
}

class AlertLatchService {
  /**
   * Initializes local SQLite persistent store and fast memory cache
   */
  public async initialize(): Promise<void> {
    await monotonicLatchService.initialize();
  }

  /**
   * Returns current Indian Standard Time (IST) date string in YYYY-MM-DD format.
   */
  public getTodayISTDateString(): string {
    return monotonicLatchService.getTodayISTDateString();
  }

  /**
   * Checks whether a notification for this stock and trigger state has already been fired today.
   * If locked, strictly returns true (duplicate alert suppressed).
   */
  public isAlertLatched(ticker: string, state: CrossoverTriggerState): boolean {
    return monotonicLatchService.isLatchedSync(ticker, state);
  }

  /**
   * Attempts to acquire the monotonic alert latch for today's session.
   * Returns true if lock was acquired and notification should fire.
   * Returns false if already latched (suppressed).
   */
  public async acquireAlertLatch(
    ticker: string,
    state: CrossoverTriggerState,
    details: AcquireAlertLatchDetails
  ): Promise<boolean> {
    return monotonicLatchService.acquireLatch(ticker, state, {
      ...details,
      strategyId: details.strategyId || '20D_CROSSOVER',
    });
  }

  /**
   * Retrieves all latches recorded for the current session
   */
  public async getAllSessionLatches(): Promise<LatchedAlertRecord[]> {
    const items = await monotonicLatchService.getLatchesForDate();
    return items.map((item) => ({
      ticker: item.ticker,
      state: item.triggerState as CrossoverTriggerState,
      tradeDate: item.tradeDate,
      crossoverTime: item.latchedAt,
      spotPrice: item.spotPrice,
      todayTradedShares: item.todayTradedShares,
      avg20DTradedShares: item.avg20DTradedShares,
      volumeRatio: item.volumeRatio,
      strategyId: item.strategyId,
      latchKey: item.latchKey,
    }));
  }
}

export const alertLatchService = new AlertLatchService();
