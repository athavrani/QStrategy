import type { SignalJournalItem } from '../types/mobile';
import type { ClosedTrade } from './types';

/** Applies closed trades to the open journal rows of the same strategy and symbol. */
export function applyClosedTrades(journal: SignalJournalItem[], closed: ClosedTrade[]): SignalJournalItem[] {
  if (closed.length === 0) return journal;
  const remaining = [...closed];
  return journal.map((item) => {
    if (item.outcome !== 'OPEN') return item;
    const idx = remaining.findIndex((c) =>
      c.journalId ? c.journalId === item.id : c.strategyId === item.strategyId && c.symbol === item.symbol
    );
    if (idx < 0) return item;
    const [trade] = remaining.splice(idx, 1);
    return {
      ...item,
      outcome: trade.outcome,
      exitPrice: trade.exitPrice,
      pnlPoints: trade.pnlPoints,
      notes: `${item.notes ?? ''} ${trade.notes}`.trim(),
    };
  });
}

/** Net points over every journal entry that has a result. */
export function sumPoints(journal: SignalJournalItem[]): number {
  return +journal.reduce((sum, j) => sum + (j.pnlPoints ?? 0), 0).toFixed(2);
}
