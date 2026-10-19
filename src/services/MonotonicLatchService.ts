/**
 * QStrategy — Monotonic Alert Latch Engine
 * Guarantees that breakout/crossover alerts for any instrument can ONLY trigger ONCE per session date.
 * Backed by persistent SQLite storage with in-memory fast path cache.
 */

import { dbManager, DatabaseDriver } from '../db/database';

export type LatchTriggerState = 'GREEN' | 'RED' | 'BREAKOUT' | string;

export interface LatchDetails {
  spotPrice: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  volumeRatio: number;
  strategyId?: string;
  crossoverTime?: string;
}

export interface LatchedAlertItem {
  tradeDate: string;
  latchKey: string;
  strategyId: string;
  ticker: string;
  triggerState: LatchTriggerState;
  spotPrice: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  volumeRatio: number;
  latchedAt: string;
}

export class MonotonicLatchService {
  private memCache = new Set<string>();
  private currentSessionDate: string = '';
  private isInitialized = false;

  constructor() {
    this.currentSessionDate = this.getTodayISTDateString();
  }

  /**
   * Returns current Indian Standard Time (IST) date string in YYYY-MM-DD format.
   * Session boundary transitions at 09:00:00 AM IST.
   */
  public getTodayISTDateString(now = new Date()): string {
    const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
    const istDate = new Date(istMs);

    const year = istDate.getUTCFullYear();
    const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Initializes SQLite database and loads current session's latches into fast memory cache
   */
  public async initialize(): Promise<void> {
    const today = this.getTodayISTDateString();
    this.currentSessionDate = today;

    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>(
      'SELECT trade_date, latch_key FROM alert_latches WHERE trade_date = ?',
      [today]
    );

    this.memCache.clear();
    for (const r of rows) {
      this.memCache.add(`${r.trade_date}::${r.latch_key}`);
    }

    this.isInitialized = true;
  }

  /**
   * Synchronous fast-check for active memory cache
   */
  public isLatchedSync(ticker: string, state: LatchTriggerState): boolean {
    const today = this.getTodayISTDateString();
    if (today !== this.currentSessionDate) {
      this.currentSessionDate = today;
      this.memCache.clear();
    }
    const key = `${today}::${ticker.toUpperCase()}_${state.toUpperCase()}`;
    return this.memCache.has(key);
  }

  /**
   * Asynchronous check with database fallback
   */
  public async isLatched(ticker: string, state: LatchTriggerState, tradeDate?: string): Promise<boolean> {
    const date = tradeDate || this.getTodayISTDateString();
    const latchKey = `${ticker.toUpperCase()}_${state.toUpperCase()}`;
    const cacheKey = `${date}::${latchKey}`;

    if (this.memCache.has(cacheKey)) {
      return true;
    }

    const db = await dbManager.getDatabase();
    const row = await db.getFirst<any>(
      'SELECT 1 FROM alert_latches WHERE trade_date = ? AND latch_key = ?',
      [date, latchKey]
    );

    if (row) {
      this.memCache.add(cacheKey);
      return true;
    }

    return false;
  }

  /**
   * Attempts to acquire the monotonic alert latch for today's session.
   * Atomic operation:
   * - Returns true if lock was acquired (first time today) -> caller fires notification
   * - Returns false if already locked -> caller suppresses notification
   */
  public async acquireLatch(
    ticker: string,
    state: LatchTriggerState,
    details: LatchDetails,
    tradeDate?: string
  ): Promise<boolean> {
    const date = tradeDate || this.getTodayISTDateString();
    const latchKey = `${ticker.toUpperCase()}_${state.toUpperCase()}`;
    const cacheKey = `${date}::${latchKey}`;

    // Fast-path rejection from memory cache
    if (this.memCache.has(cacheKey)) {
      return false;
    }

    const db = await dbManager.getDatabase();
    const strategyId = details.strategyId || '20D_CROSSOVER';
    const latchedAt = details.crossoverTime || new Date().toISOString();

    const result = await db.run(
      `INSERT OR IGNORE INTO alert_latches (
        trade_date,
        latch_key,
        strategy_id,
        ticker,
        trigger_state,
        spot_price,
        today_traded_shares,
        avg_20d_traded_shares,
        volume_ratio,
        latched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        date,
        latchKey,
        strategyId,
        ticker.toUpperCase(),
        state.toUpperCase(),
        details.spotPrice,
        Math.round(details.todayTradedShares),
        Math.round(details.avg20DTradedShares),
        details.volumeRatio,
        latchedAt,
      ]
    );

    if (result.changes > 0) {
      // Lock acquired successfully
      this.memCache.add(cacheKey);
      return true;
    }

    // Already exists in database (e.g. from prior process before restart)
    this.memCache.add(cacheKey);
    return false;
  }

  /**
   * Retrieves all latches recorded for a given session date
   */
  public async getLatchesForDate(tradeDate?: string): Promise<LatchedAlertItem[]> {
    const date = tradeDate || this.getTodayISTDateString();
    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>(
      'SELECT * FROM alert_latches WHERE trade_date = ? ORDER BY latched_at ASC',
      [date]
    );

    return rows.map((r) => ({
      tradeDate: r.trade_date,
      latchKey: r.latch_key,
      strategyId: r.strategy_id,
      ticker: r.ticker,
      triggerState: r.trigger_state,
      spotPrice: r.spot_price,
      todayTradedShares: r.today_traded_shares,
      avg20DTradedShares: r.avg_20d_traded_shares,
      volumeRatio: r.volume_ratio,
      latchedAt: r.latched_at,
    }));
  }

  /**
   * Purges expired historical latches older than retention period (default 30 days)
   */
  public async purgeOldLatches(retentionDays = 30): Promise<number> {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = this.getTodayISTDateString(new Date(cutoffMs));

    const db = await dbManager.getDatabase();
    const res = await db.run('DELETE FROM alert_latches WHERE trade_date < ?', [cutoffDate]);
    return res.changes;
  }

  /**
   * Clear cache for testing purposes
   */
  public clearMemoryCache(): void {
    this.memCache.clear();
  }
}

export const monotonicLatchService = new MonotonicLatchService();
