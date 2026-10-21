import { dbManager } from '../db/database';
import type { SignalJournalItem } from '../types/mobile';
import type { ClosedTrade } from '../engine/types';

/** SQLite-backed signal audit trail, keyed by session date. */
export class JournalRepository {
  async save(entry: SignalJournalItem, tradeDate: string): Promise<void> {
    const db = await dbManager.getDatabase();
    await db.run(
      `INSERT OR IGNORE INTO signal_journal
        (id, trade_date, timestamp, strategy_id, strategy_name, symbol, signal_type, entry_price,
         exit_price, stop_loss, target, pnl_points, outcome, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        tradeDate,
        entry.timestamp,
        entry.strategyId,
        entry.strategyName,
        entry.symbol,
        entry.signalType,
        entry.entryPrice,
        entry.exitPrice ?? null,
        entry.stopLoss ?? null,
        entry.target ?? null,
        entry.pnlPoints ?? null,
        entry.outcome,
        entry.notes ?? null,
        new Date().toISOString(),
      ]
    );
  }

  /** Newest first. */
  async loadForDate(tradeDate: string): Promise<SignalJournalItem[]> {
    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>(
      'SELECT * FROM signal_journal WHERE trade_date = ? ORDER BY rowid DESC',
      [tradeDate]
    );
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      strategyId: r.strategy_id,
      strategyName: r.strategy_name,
      symbol: r.symbol,
      signalType: r.signal_type,
      entryPrice: r.entry_price,
      ...(r.exit_price != null ? { exitPrice: r.exit_price } : {}),
      ...(r.stop_loss != null ? { stopLoss: r.stop_loss } : {}),
      ...(r.target != null ? { target: r.target } : {}),
      ...(r.pnl_points != null ? { pnlPoints: r.pnl_points } : {}),
      outcome: r.outcome,
      ...(r.notes != null ? { notes: r.notes } : {}),
    }));
  }

  /** Marks the open entry of a trade as closed. Closed or missing rows are left untouched. */
  async closeTrade(trade: ClosedTrade, tradeDate: string): Promise<void> {
    const db = await dbManager.getDatabase();
    await db.run(
      `UPDATE signal_journal
         SET outcome = ?, exit_price = ?, pnl_points = ?, notes = COALESCE(notes, '') || ?
       WHERE trade_date = ? AND strategy_id = ? AND symbol = ? AND outcome = 'OPEN'`,
      [trade.outcome, trade.exitPrice, trade.pnlPoints, ` ${trade.notes}`, tradeDate, trade.strategyId, trade.symbol]
    );
  }

  /** Drops sessions older than `cutoffDate` (YYYY-MM-DD). */
  async pruneBefore(cutoffDate: string): Promise<void> {
    const db = await dbManager.getDatabase();
    await db.run('DELETE FROM signal_journal WHERE trade_date < ?', [cutoffDate]);
  }
}

export const journalRepository = new JournalRepository();
