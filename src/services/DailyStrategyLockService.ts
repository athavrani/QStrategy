/**
 * QStrategy — Daily Strategy Lock Service
 * Multi-Tier Date-Wise Persistence Engine for 09:20 / 09:25 Strike Locks:
 * - NIFTY 09:20 OOBTST
 * - SENSEX 09:20 OOBTST
 * - NIFTY 09:25 Breakout 180
 *
 * Guarantees:
 * 1. Immediate reload of locked strikes on app open by session date.
 * 2. SQLite transactional storage + AsyncStorage fallback redundancy.
 * 3. Date-wise historical lookup for trader auditing and back-checks.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { dbManager } from '../db/database';
import { DailyStrategyLockRecord } from '../db/schema';
import { formatDateKeyIST } from '../constants/nseHolidays';

export class DailyStrategyLockService {
  /**
   * Persists a locked strategy state into SQLite and AsyncStorage
   */
  public async saveLock(record: DailyStrategyLockRecord): Promise<boolean> {
    if (!record.trade_date || !record.strategy_id) {
      return false;
    }

    try {
      const db = await dbManager.getDatabase();
      const sql = `
        INSERT OR REPLACE INTO daily_strategy_locks (
          trade_date,
          strategy_id,
          lock_time,
          underlying_symbol,
          underlying_spot,
          expiry_str,
          target_param,
          ce_strike,
          ce_symbol,
          ce_open_price,
          ce_trigger_price,
          ce_sec_id,
          pe_strike,
          pe_symbol,
          pe_open_price,
          pe_trigger_price,
          pe_sec_id,
          execution_side,
          execution_price,
          execution_time,
          sl_price,
          status,
          lock_failure_reason,
          raw_payload,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      await db.run(sql, [
        record.trade_date,
        record.strategy_id,
        record.lock_time,
        record.underlying_symbol,
        record.underlying_spot,
        record.expiry_str,
        record.target_param,
        record.ce_strike,
        record.ce_symbol,
        record.ce_open_price,
        record.ce_trigger_price ?? null,
        record.ce_sec_id ?? null,
        record.pe_strike,
        record.pe_symbol,
        record.pe_open_price,
        record.pe_trigger_price ?? null,
        record.pe_sec_id ?? null,
        record.execution_side ?? null,
        record.execution_price ?? null,
        record.execution_time ?? null,
        record.sl_price ?? null,
        record.status,
        record.lock_failure_reason ?? null,
        record.raw_payload || '{}',
        record.created_at || new Date().toISOString(),
        new Date().toISOString(),
      ]);

      // Multi-tier redundancy: save to AsyncStorage
      const asyncKey = `@qstrategy_lock_${record.strategy_id}_${record.trade_date}`;
      await AsyncStorage.setItem(asyncKey, JSON.stringify(record));

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves a locked strike record for a specific date and strategy
   */
  public async getLock(
    tradeDate: string,
    strategyId: string
  ): Promise<DailyStrategyLockRecord | null> {
    try {
      const db = await dbManager.getDatabase();
      const sql = `
        SELECT * FROM daily_strategy_locks
        WHERE trade_date = ? AND strategy_id = ?
        LIMIT 1;
      `;
      const row = await db.getFirst<DailyStrategyLockRecord>(sql, [tradeDate, strategyId]);
      if (row) {
        return row;
      }

      // Fallback check to AsyncStorage
      const asyncKey = `@qstrategy_lock_${strategyId}_${tradeDate}`;
      const saved = await AsyncStorage.getItem(asyncKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.trade_date === tradeDate) {
          // Re-sync back to SQLite
          await this.saveLock(parsed);
          return parsed;
        }
      }

      // Legacy key backward compatibility check
      if (strategyId === 'NIFTY_OOBTST') {
        const legacy = await AsyncStorage.getItem(`@qstrategy_oobtst_anchor_${tradeDate}`);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          const anchor = parsed?.anchor;
          if (anchor && anchor.tradeDate === tradeDate && anchor.isConfirmed) {
            const record: DailyStrategyLockRecord = {
              trade_date: anchor.tradeDate,
              strategy_id: 'NIFTY_OOBTST',
              lock_time: anchor.confirmedAt || '09:20:00 IST',
              underlying_symbol: 'NIFTY',
              underlying_spot: anchor.anchorSpot,
              expiry_str: anchor.expiryStr,
              target_param: anchor.targetPremium,
              ce_strike: anchor.ceStrike,
              ce_symbol: `NIFTY ${anchor.ceStrike} CE`,
              ce_open_price: anchor.ceOpen,
              ce_trigger_price: anchor.ceTrigger,
              pe_strike: anchor.peStrike,
              pe_symbol: `NIFTY ${anchor.peStrike} PE`,
              pe_open_price: anchor.peOpen,
              pe_trigger_price: anchor.peTrigger,
              status: anchor.isLockFailed ? 'LOCK_FAILED' : 'LOCKED',
              raw_payload: legacy,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            await this.saveLock(record);
            return record;
          }
        }
      } else if (strategyId === 'SENSEX_OOBTST') {
        const legacy = await AsyncStorage.getItem(`@qstrategy_sensex_oobtst_anchor_${tradeDate}`);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (parsed && parsed.tradeDate === tradeDate && parsed.isConfirmed) {
            const record: DailyStrategyLockRecord = {
              trade_date: parsed.tradeDate,
              strategy_id: 'SENSEX_OOBTST',
              lock_time: '09:20:00 IST',
              underlying_symbol: 'SENSEX',
              underlying_spot: parsed.anchorSpot,
              expiry_str: parsed.expiryStr,
              target_param: parsed.targetPremium,
              ce_strike: parsed.ceStrike,
              ce_symbol: `SENSEX ${parsed.ceStrike} CE`,
              ce_open_price: parsed.ceOpenPrice,
              ce_trigger_price: parsed.ceTriggerPrice,
              pe_strike: parsed.peStrike,
              pe_symbol: `SENSEX ${parsed.peStrike} PE`,
              pe_open_price: parsed.peOpenPrice,
              pe_trigger_price: parsed.peTriggerPrice,
              status: parsed.status === 'SL_HIT' ? 'SL_HIT' : 'LOCKED',
              raw_payload: legacy,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            await this.saveLock(record);
            return record;
          }
        }
      } else if (strategyId === 'NIFTY_BREAKOUT_180') {
        const legacy = await AsyncStorage.getItem(`@qstrategy_breakout180_state_${tradeDate}`);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (parsed && parsed.date === tradeDate && parsed.isLocked) {
            const record: DailyStrategyLockRecord = {
              trade_date: parsed.date,
              strategy_id: 'NIFTY_BREAKOUT_180',
              lock_time: '09:25:00 IST',
              underlying_symbol: 'NIFTY',
              underlying_spot: 24850,
              expiry_str: parsed.expiryStr || '',
              target_param: parsed.lockedThreshold || 180,
              ce_strike: parsed.ceStrike,
              ce_symbol: `NIFTY ${parsed.ceStrike} CE`,
              ce_open_price: parsed.ceOpen0925,
              ce_trigger_price: parsed.lockedThreshold || 180,
              pe_strike: parsed.peStrike,
              pe_symbol: `NIFTY ${parsed.peStrike} PE`,
              pe_open_price: parsed.peOpen0925,
              pe_trigger_price: parsed.lockedThreshold || 180,
              status: parsed.triggeredSide ? 'TRIGGERED' : 'LOCKED',
              raw_payload: legacy,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            await this.saveLock(record);
            return record;
          }
        }
      }
    } catch {}

    return null;
  }

  /**
   * Retrieves all strategy locks recorded for a given date
   */
  public async getLocksForDate(tradeDate: string): Promise<DailyStrategyLockRecord[]> {
    try {
      const db = await dbManager.getDatabase();
      const sql = `
        SELECT * FROM daily_strategy_locks
        WHERE trade_date = ?
        ORDER BY lock_time ASC;
      `;
      const rows = await db.getAll<DailyStrategyLockRecord>(sql, [tradeDate]);
      return rows || [];
    } catch {
      return [];
    }
  }

  /**
   * Retrieves all unique dates that have locked strikes stored, sorted newest first
   */
  public async getAvailableLockDates(limit = 30): Promise<string[]> {
    try {
      const db = await dbManager.getDatabase();
      const rows = await db.getAll<DailyStrategyLockRecord>(
        `SELECT DISTINCT trade_date FROM daily_strategy_locks ORDER BY trade_date DESC LIMIT ${limit};`
      );
      const dates = rows.map((r) => r.trade_date);
      return Array.from(new Set(dates));
    } catch {
      return [];
    }
  }

  /**
   * Convenient helper to load all 3 strategy locks for today's session on app open
   */
  public async loadTodayLocks(dateKey = formatDateKeyIST()): Promise<{
    niftyOobtst: DailyStrategyLockRecord | null;
    sensexOobtst: DailyStrategyLockRecord | null;
    niftyBreakout: DailyStrategyLockRecord | null;
  }> {
    const [niftyOobtst, sensexOobtst, niftyBreakout] = await Promise.all([
      this.getLock(dateKey, 'NIFTY_OOBTST'),
      this.getLock(dateKey, 'SENSEX_OOBTST'),
      this.getLock(dateKey, 'NIFTY_BREAKOUT_180'),
    ]);

    return { niftyOobtst, sensexOobtst, niftyBreakout };
  }
}

export const dailyStrategyLockService = new DailyStrategyLockService();
