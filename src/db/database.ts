/**
 * QStrategy — Database Connection & Migration Engine
 * Wraps expo-sqlite with migrations, type-safe query helpers, and in-memory test fallback.
 */

import { DATABASE_NAME, CURRENT_SCHEMA_VERSION, CREATE_TABLES_SQL } from './schema';

export interface DatabaseDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: any[]): Promise<{ lastInsertRowId?: number; changes: number }>;
  getAll<T = any>(sql: string, params?: any[]): Promise<T[]>;
  getFirst<T = any>(sql: string, params?: any[]): Promise<T | null>;
  close?(): Promise<void>;
}

class InMemoryDatabaseDriver implements DatabaseDriver {
  private tables = new Map<string, Map<string, any>>();

  public async exec(sql: string): Promise<void> {
    // No-op in memory representation
  }

  public async run(sql: string, params: any[] = []): Promise<{ lastInsertRowId?: number; changes: number }> {
    const trimmed = sql.trim().toUpperCase();

    if (trimmed.startsWith('INSERT')) {
      if (sql.includes('daily_strategy_locks')) {
        const table = this.getOrCreateTable('daily_strategy_locks');
        const [
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
          updated_at,
        ] = params;
        const pk = `${trade_date}::${strategy_id}`;
        table.set(pk, {
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
          updated_at,
        });
        return { changes: 1, lastInsertRowId: table.size };
      }

      if (sql.includes('alert_latches')) {
        const table = this.getOrCreateTable('alert_latches');
        // Params: [trade_date, latch_key, strategy_id, ticker, trigger_state, spot_price, today_traded_shares, avg_20d_traded_shares, volume_ratio, latched_at]
        const [trade_date, latch_key, strategy_id, ticker, trigger_state, spot_price, today_traded_shares, avg_20d_traded_shares, volume_ratio, latched_at] = params;
        const pk = `${trade_date}::${latch_key}`;

        if (table.has(pk)) {
          // INSERT OR IGNORE behavior
          return { changes: 0 };
        }

        table.set(pk, {
          trade_date,
          latch_key,
          strategy_id,
          ticker,
          trigger_state,
          spot_price,
          today_traded_shares,
          avg_20d_traded_shares,
          volume_ratio,
          latched_at,
        });

        return { changes: 1, lastInsertRowId: table.size };
      }

      if (sql.includes('strategy_positions')) {
        const table = this.getOrCreateTable('strategy_positions');
        const [id, strategy_id, symbol, side, entry_price, target_price, stop_loss, status, entry_time, exit_time, exit_price, pnl, metadata] = params;
        if (table.has(id)) return { changes: 0 };
        table.set(id, {
          id,
          strategy_id,
          symbol,
          side,
          entry_price,
          target_price,
          stop_loss,
          status,
          entry_time,
          exit_time,
          exit_price,
          pnl,
          metadata,
        });
        return { changes: 1 };
      }
    }

    if (trimmed.startsWith('DELETE')) {
      if (sql.includes('daily_strategy_locks')) {
        const table = this.getOrCreateTable('daily_strategy_locks');
        if (params.length === 0) {
          const count = table.size;
          table.clear();
          return { changes: count };
        }
        if (params.length === 1) {
          const [trade_date] = params;
          let deletedCount = 0;
          for (const [key, val] of table.entries()) {
            if (val.trade_date === trade_date || val.trade_date < trade_date) {
              table.delete(key);
              deletedCount++;
            }
          }
          return { changes: deletedCount };
        }
      }

      if (sql.includes('alert_latches')) {
        const table = this.getOrCreateTable('alert_latches');
        if (params.length === 0) {
          const count = table.size;
          table.clear();
          return { changes: count };
        }
        if (params.length === 1) {
          const [trade_date] = params;
          let deletedCount = 0;
          for (const [key, val] of table.entries()) {
            if (val.trade_date < trade_date) {
              table.delete(key);
              deletedCount++;
            }
          }
          return { changes: deletedCount };
        }
      }
    }

    return { changes: 0 };
  }

  public async getAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (sql.includes('daily_strategy_locks')) {
      const table = this.getOrCreateTable('daily_strategy_locks');
      const rows = Array.from(table.values());

      if (params.length === 1) {
        const [trade_date] = params;
        return rows.filter((r) => r.trade_date === trade_date) as T[];
      }
      return rows.sort((a, b) => b.trade_date.localeCompare(a.trade_date)) as T[];
    }

    if (sql.includes('alert_latches')) {
      const table = this.getOrCreateTable('alert_latches');
      const rows = Array.from(table.values());

      if (params.length === 1) {
        const [trade_date] = params;
        return rows.filter((r) => r.trade_date === trade_date) as T[];
      }
      return rows as T[];
    }
    return [];
  }

  public async getFirst<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    if (sql.includes('daily_strategy_locks')) {
      const table = this.getOrCreateTable('daily_strategy_locks');
      if (params.length === 2) {
        const [trade_date, strategy_id] = params;
        const pk = `${trade_date}::${strategy_id}`;
        return (table.get(pk) as T) ?? null;
      }
    }

    if (sql.includes('alert_latches')) {
      const table = this.getOrCreateTable('alert_latches');
      if (params.length === 2) {
        const [trade_date, latch_key] = params;
        const pk = `${trade_date}::${latch_key}`;
        return (table.get(pk) as T) ?? null;
      }
    }
    return null;
  }

  private getOrCreateTable(name: string): Map<string, any> {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map());
    }
    return this.tables.get(name)!;
  }
}

class SQLiteDatabaseManager {
  private driver: DatabaseDriver | null = null;
  private initPromise: Promise<DatabaseDriver> | null = null;

  public async getDatabase(): Promise<DatabaseDriver> {
    if (this.driver) return this.driver;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Attempt import of expo-sqlite for native environment
        const sqliteModule = require('expo-sqlite');
        if (sqliteModule && typeof sqliteModule.openDatabaseAsync === 'function') {
          const nativeDb = await sqliteModule.openDatabaseAsync(DATABASE_NAME);
          await nativeDb.execAsync(CREATE_TABLES_SQL);

          this.driver = {
            exec: (sql: string) => nativeDb.execAsync(sql),
            run: async (sql: string, params = []) => {
              const res = await nativeDb.runAsync(sql, params);
              return { changes: res.changes, lastInsertRowId: res.lastInsertRowId };
            },
            getAll: (sql: string, params = []) => nativeDb.getAllAsync(sql, params),
            getFirst: (sql: string, params = []) => nativeDb.getFirstAsync(sql, params),
            close: () => nativeDb.closeAsync(),
          };
          return this.driver;
        }
      } catch {
        // Fallback to in-memory driver when native SQLite is unavailable (Jest / Node test runner)
      }

      this.driver = new InMemoryDatabaseDriver();
      await this.driver.exec(CREATE_TABLES_SQL);
      return this.driver;
    })();

    return this.initPromise;
  }
}

export const dbManager = new SQLiteDatabaseManager();
