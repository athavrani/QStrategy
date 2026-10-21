import type { SignalJournalItem } from '../types/mobile';
import type { AcquireAlertLatchDetails, CrossoverTriggerState } from '../services/alertLatchService';
import type { SignalEvent } from './types';

export interface LatchPort {
  isAlertLatched(key: string, side: CrossoverTriggerState): boolean;
  acquireAlertLatch(key: string, side: CrossoverTriggerState, details: AcquireAlertLatchDetails): Promise<boolean>;
}

export type JournalSink = (entry: SignalJournalItem) => Promise<void>;

/** Latch -> notify -> journal for every detected signal, strictly once per latch key per session. */
export class SignalPipeline {
  constructor(
    private readonly latch: LatchPort,
    private readonly now: () => number = Date.now,
    private readonly sink?: JournalSink
  ) {}

  async process(events: SignalEvent[]): Promise<SignalJournalItem[]> {
    const journal: SignalJournalItem[] = [];

    for (const event of events) {
      const { key, side, details } = event.latch;
      if (this.latch.isAlertLatched(key, side)) continue;

      let acquired = false;
      try {
        acquired = await this.latch.acquireAlertLatch(key, side, details);
      } catch {
        continue;
      }
      if (!acquired) continue;

      let notes = '';
      try {
        const out = event.materialize();
        notes = out.notes;
        out.notify?.();
      } catch {
        // The latch is already taken; a failing notification must not erase the journal record.
      }

      const item: SignalJournalItem = {
        id: `${event.idPrefix}-${this.now()}`,
        timestamp: event.timestamp,
        strategyId: event.strategyId,
        strategyName: event.strategyName,
        symbol: event.symbol,
        signalType: event.signalType,
        entryPrice: event.entryPrice,
        ...(event.stopLoss !== undefined ? { stopLoss: event.stopLoss } : {}),
        ...(event.target !== undefined ? { target: event.target } : {}),
        outcome: 'OPEN',
        notes,
      };

      try {
        await this.sink?.(item);
      } catch {
        // Persistence failure must not hide the signal from the live journal.
      }
      journal.push(item);
    }

    return journal;
  }
}
