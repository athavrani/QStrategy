import { BaseStrategyPlugin, StrategyCategory, StrategyContext, StrategySignalOutput } from './types';

class StrategyRegistryService {
  private plugins: Map<string, BaseStrategyPlugin> = new Map();

  register(plugin: BaseStrategyPlugin) {
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string) {
    this.plugins.delete(id);
  }

  get(id: string): BaseStrategyPlugin | undefined {
    return this.plugins.get(id);
  }

  getAll(): BaseStrategyPlugin[] {
    return Array.from(this.plugins.values());
  }

  getByCategory(category: StrategyCategory): BaseStrategyPlugin[] {
    return this.getAll().filter((p) => p.category === category);
  }

  evaluateAll(ctx: StrategyContext): Record<string, StrategySignalOutput> {
    const outputs: Record<string, StrategySignalOutput> = {};
    for (const [id, plugin] of this.plugins.entries()) {
      try {
        outputs[id] = plugin.evaluate(ctx);
      } catch (err) {
        outputs[id] = {
          status: 'IDLE',
          statusBadgeText: 'ERROR',
          badgeTone: 'bearish',
          headline: 'Evaluation error',
          primaryMetricLabel: 'STATUS',
          primaryMetricValue: 'OFFLINE',
          lastUpdated: ctx.istTime,
        };
      }
    }
    return outputs;
  }
}

export const strategyRegistry = new StrategyRegistryService();
