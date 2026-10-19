/**
 * QStrategy — SQLite Database Schema & Migrations
 * Tables:
 * - strategy_positions: Active & historical multi-strategy algo positions
 * - alert_latches: Monotonic one-way notification latches (immutable per session)
 * - historical_baselines: 20-day average volume and reference baselines
 */

export const DATABASE_NAME = 'qstrategy.db';
export const CURRENT_SCHEMA_VERSION = 1;

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
`;
