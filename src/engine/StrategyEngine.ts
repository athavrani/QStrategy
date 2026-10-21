import type { SignalJournalItem } from '../types/mobile';
import type { SignalPipeline } from './SignalPipeline';
import type { ClosedTrade, EngineContext, EngineStrategy, ExitEvent, SignalEvent } from './types';

/**
 * Runs registered strategies over a context and sends every detected signal through the shared pipeline.
 * Evaluations are serialized, so overlapping tick- and poll-driven runs cannot double-fire a signal.
 */
export class StrategyEngine {
  private readonly strategies = new Map<string, EngineStrategy>();
  private readonly closedListeners = new Set<(trades: ClosedTrade[]) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pipeline: SignalPipeline) {}

  /** Called with the trades that ended in an evaluation (stop-loss, target, time exit). */
  onClosed(listener: (trades: ClosedTrade[]) => void): () => void {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  register(strategy: EngineStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  unregister(id: string): void {
    this.strategies.delete(id);
  }

  getStrategyIds(): string[] {
    return [...this.strategies.keys()];
  }

  /** `only` restricts the run to the given strategy ids. */
  evaluate(ctx: EngineContext, only?: string[]): Promise<SignalJournalItem[]> {
    const run = this.queue.then(() => this.run(ctx, only));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(ctx: EngineContext, only?: string[]): Promise<SignalJournalItem[]> {
    const events: SignalEvent[] = [];
    const exits: ExitEvent[] = [];
    for (const strategy of this.strategies.values()) {
      if (only && !only.includes(strategy.id)) continue;
      try {
        events.push(...strategy.detect(ctx));
        if (strategy.detectExits) exits.push(...strategy.detectExits(ctx));
      } catch {
        // A faulty strategy must not block the others.
      }
    }

    // Entries first, so an entry and its exit detected in the same run close the freshly written row.
    const entries = await this.pipeline.process(events);
    const closed = await this.pipeline.processExits(exits);
    if (closed.length > 0) {
      this.closedListeners.forEach((listener) => {
        try {
          listener(closed);
        } catch {
          // One failing listener must not block the others.
        }
      });
    }
    return entries;
  }
}
