/**
 * QStrategy — SQLite Database Schema & Migrations
 * Tables:
 * - strategy_positions: Active & historical multi-strategy algo positions
 * - alert_latches: Monotonic one-way notification latches (immutable per session)
 * - historical_baselines: 20-day average volume and reference baselines
 * - daily_strategy_locks: Immutable date-wise 09:20 / 09:25 strike locks (NIFTY OOBTST, SENSEX OOBTST, NIFTY BREAKOUT 180)
 * - signal_journal: Audit trail of every signal the engine fired, per session date
 */

export const DATABASE_NAME = 'qstrategy.db';
export const CURRENT_SCHEMA_VERSION = 3;

export interface DailyStrategyLockRecord {
  trade_date: string;          // 'YYYY-MM-DD'
  strategy_id: string;         // 'NIFTY_OOBTST' | 'SENSEX_OOBTST' | 'NIFTY_BREAKOUT_180'
  lock_time: string;           // '09:20:00 IST' | '09:25:00 IST'
  underlying_symbol: string;   // 'NIFTY' | 'SENSEX'
  underlying_spot: number;
  expiry_str: string;
  target_param: number;        // 62.50, 100.00, or 180.00
  ce_strike: number;
  ce_symbol: string;
  ce_open_price: number;
  ce_trigger_price?: number;
  ce_sec_id?: string;
  pe_strike: number;
  pe_symbol: string;
  pe_open_price: number;
  pe_trigger_price?: number;
  pe_sec_id?: string;
  execution_side?: 'CE' | 'PE' | null;
  execution_price?: number | null;
  execution_time?: string | null;
  sl_price?: number | null;
  status: 'LOCKED' | 'TRIGGERED' | 'EXECUTED' | 'SL_HIT' | 'TARGET_HIT' | 'EXPIRED' | 'LOCK_FAILED';
  lock_failure_reason?: string | null;
  raw_payload: string;         // JSON snapshot with candidates, metrics, etc.
  created_at: string;
  updated_at: string;
}

export const CREATE_TABLES_SQL = `
-- 1. Strategy Positions Table
CREATE TABLE IF NOT EXISTS strategy_positions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  target_price REAL,
  stop_loss REAL,
  status TEXT NOT NULL,
  entry_time TEXT NOT NULL,
  exit_time TEXT,
  exit_price REAL,
  pnl REAL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_positions_strategy ON strategy_positions(strategy_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON strategy_positions(status);

-- 2. Alert Latches Table (Guarantees one-way monotonic locking per session date)
CREATE TABLE IF NOT EXISTS alert_latches (
  trade_date TEXT NOT NULL,
  latch_key TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  trigger_state TEXT NOT NULL,
  spot_price REAL NOT NULL,
  today_traded_shares INTEGER NOT NULL,
  avg_20d_traded_shares INTEGER NOT NULL,
  volume_ratio REAL NOT NULL,
  latched_at TEXT NOT NULL,
  PRIMARY KEY (trade_date, latch_key)
);

CREATE INDEX IF NOT EXISTS idx_latches_trade_date ON alert_latches(trade_date);
CREATE INDEX IF NOT EXISTS idx_latches_ticker ON alert_latches(ticker);

-- 3. Historical Baselines Table (Completed daily reference metrics)
CREATE TABLE IF NOT EXISTS historical_baselines (
  ticker TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  avg_20d_volume INTEGER NOT NULL,
  prev_close REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticker, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_baselines_date ON historical_baselines(trade_date);

-- 4. Daily Strategy Locks Table (Date-wise 09:20 / 09:25 Strike Persistence)
CREATE TABLE IF NOT EXISTS daily_strategy_locks (
  trade_date TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  lock_time TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  underlying_spot REAL NOT NULL,
  expiry_str TEXT NOT NULL,
  target_param REAL NOT NULL,
  ce_strike INTEGER NOT NULL,
  ce_symbol TEXT NOT NULL,
  ce_open_price REAL NOT NULL,
  ce_trigger_price REAL,
  ce_sec_id TEXT,
  pe_strike INTEGER NOT NULL,
  pe_symbol TEXT NOT NULL,
  pe_open_price REAL NOT NULL,
  pe_trigger_price REAL,
  pe_sec_id TEXT,
  execution_side TEXT,
  execution_price REAL,
  execution_time TEXT,
  sl_price REAL,
  status TEXT NOT NULL,
  lock_failure_reason TEXT,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trade_date, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_locks_date ON daily_strategy_locks(trade_date);
CREATE INDEX IF NOT EXISTS idx_strategy_locks_status ON daily_strategy_locks(status);

-- 5. Signal Journal Table (Persistent audit trail of fired signals)
CREATE TABLE IF NOT EXISTS signal_journal (
  id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  stop_loss REAL,
  target REAL,
  pnl_points REAL,
  outcome TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_trade_date ON signal_journal(trade_date);
`;
