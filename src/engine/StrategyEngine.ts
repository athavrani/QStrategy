import type { SignalJournalItem } from '../types/mobile';
import type { SignalPipeline } from './SignalPipeline';
import type { EngineContext, EngineStrategy, SignalEvent } from './types';

/**
 * Runs registered strategies over a context and sends every detected signal through the shared pipeline.
 * Evaluations are serialized, so overlapping tick- and poll-driven runs cannot double-fire a signal.
 */
export class StrategyEngine {
  private readonly strategies = new Map<string, EngineStrategy>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pipeline: SignalPipeline) {}

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

  private run(ctx: EngineContext, only?: string[]): Promise<SignalJournalItem[]> {
    const events: SignalEvent[] = [];
    for (const strategy of this.strategies.values()) {
      if (only && !only.includes(strategy.id)) continue;
      try {
        events.push(...strategy.detect(ctx));
      } catch {
        // A faulty strategy must not block the others.
      }
    }
    return this.pipeline.process(events);
  }
}
