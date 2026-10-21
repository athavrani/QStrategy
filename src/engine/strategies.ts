import type { StockRadarItem, TacticalStrikeSuggestion } from '../types/mobile';
import type { OobtstLiveState } from '../strategies/types';
import type { EngineContext, EngineStrategy, SignalEvent } from './types';

export const STRATEGY_IDS = {
  VOLUME_CROSSOVER: '20D_CROSSOVER',
  BREAKOUT_180: 'NIFTY_BREAKOUT_180',
  OOBTST_NIFTY: 'OOBTST_NIFTY',
  OOBTST_SENSEX: 'OOBTST_SENSEX',
} as const;

export interface Notifier {
  notify20DCrossover(ticker: string, volumeRatio: number, spotPrice: number, atmStrike: number): unknown;
  notify180BreakoutTriggered(type: 'CE' | 'PE', strike: number, price: number, target: number, sl: number): unknown;
  notify0920StrangleEntry(ceStrike: number, peStrike: number, cePrice: number, pePrice: number): unknown;
}

export interface StrategyDeps {
  notifier: Notifier;
  tacticalStrike: (stock: StockRadarItem) => Pick<TacticalStrikeSuggestion, 'recommendedCeStrike'>;
}

const clock = () => new Date().toLocaleTimeString('en-IN');

export function createVolumeCrossoverStrategy(deps: StrategyDeps): EngineStrategy {
  return {
    id: STRATEGY_IDS.VOLUME_CROSSOVER,
    detect(ctx: EngineContext): SignalEvent[] {
      const events: SignalEvent[] = [];
      for (const stock of ctx.stocks ?? []) {
        if (!stock.hasCrossed20D || stock.todayTradedShares <= 0) continue;
        const side = stock.circleIndicator;
        if (side !== 'GREEN' && side !== 'RED') continue;

        const pct = `${(stock.volumeRatio * 100).toFixed(1)}%`;
        events.push({
          idPrefix: `sig-${stock.ticker}`,
          strategyId: STRATEGY_IDS.VOLUME_CROSSOVER,
          strategyName: '20D Volume Crossover',
          symbol: stock.ticker,
          signalType: side === 'GREEN' ? 'BUY' : 'SELL',
          entryPrice: stock.spotPrice,
          timestamp: ctx.istTime || clock(),
          latch: {
            key: stock.ticker,
            side,
            details: {
              spotPrice: stock.spotPrice,
              todayTradedShares: stock.todayTradedShares,
              avg20DTradedShares: stock.avg20DTradedShares,
              volumeRatio: stock.volumeRatio,
              crossoverTime: stock.crossoverTime,
            },
          },
          materialize: () => {
            if (side === 'RED') {
              return { notes: `🔴 Crossed 100% of 20D Avg (${pct} Vol). Bearish LTP < Open (Distribution).` };
            }
            const tactical = deps.tacticalStrike(stock);
            return {
              notes: `🟢 Crossed 100% of 20D Avg (${pct} Vol). Bullish LTP > Open. Tactical: ${tactical.recommendedCeStrike} CE.`,
              notify: () =>
                deps.notifier.notify20DCrossover(stock.ticker, stock.volumeRatio, stock.spotPrice, tactical.recommendedCeStrike),
            };
          },
        });
      }
      return events;
    },
  };
}

export function createBreakout180Strategy(deps: StrategyDeps): EngineStrategy {
  return {
    id: STRATEGY_IDS.BREAKOUT_180,
    detect(ctx: EngineContext): SignalEvent[] {
      const b = ctx.breakout;
      if (!b || b.status !== 'IN_TRADE' || !b.activeContract || !b.ceCandidate || !b.peCandidate) return [];

      const strike = b.activeContract === 'CE' ? b.ceCandidate.strike : b.peCandidate.strike;
      const symbol = `${strike} ${b.activeContract}`;
      const entry = b.entryPrice || 180;
      const contract = b.activeContract;
      const entryTime = b.entryTime || ctx.istTime;

      return [
        {
          idPrefix: 'sig-breakout',
          strategyId: STRATEGY_IDS.BREAKOUT_180,
          strategyName: 'NIFTY 09:25 ₹180 Breakout',
          symbol: `NIFTY ${symbol}`,
          signalType: 'BUY',
          entryPrice: entry,
          stopLoss: b.fixedStopLoss,
          target: b.fixedTarget,
          timestamp: entryTime,
          latch: {
            key: `BREAKOUT_180_${symbol.replace(/\s+/g, '_')}`,
            side: 'GREEN',
            details: {
              spotPrice: b.currentPrice || 180,
              todayTradedShares: 0,
              avg20DTradedShares: 0,
              volumeRatio: 1,
              crossoverTime: entryTime,
              strategyId: STRATEGY_IDS.BREAKOUT_180,
            },
          },
          materialize: () => ({
            notes: `🚀 09:25 Candle Open < ₹180 Breakout Triggered @ ₹${entry.toFixed(2)}. Target: ₹220, SL: ₹160.`,
            notify: () => deps.notifier.notify180BreakoutTriggered(contract, strike, entry, b.fixedTarget, b.fixedStopLoss),
          }),
        },
      ];
    },
  };
}

interface OobtstConfig {
  strategyId: string;
  strategyName: string;
  idPrefix: string;
  latchPrefix: string;
  notesLabel: string;
  select: (ctx: EngineContext) => OobtstLiveState | null | undefined;
}

function createOobtstStrategy(deps: StrategyDeps, cfg: OobtstConfig): EngineStrategy {
  return {
    id: cfg.strategyId,
    detect(ctx: EngineContext): SignalEvent[] {
      const s = cfg.select(ctx);
      if (!s || (s.status !== 'ACTIVE' && s.status !== 'BTST_HOLD') || !s.activeLeg) return [];

      const leg = s.activeLeg === 'CE' ? s.ceLeg : s.peLeg;
      const trigger = +(leg.openPrice * 1.5).toFixed(2);
      const open = leg.openPrice.toFixed(2);

      return [
        {
          idPrefix: cfg.idPrefix,
          strategyId: cfg.strategyId,
          strategyName: cfg.strategyName,
          symbol: leg.symbol,
          signalType: 'BUY',
          entryPrice: trigger,
          stopLoss: leg.openPrice,
          timestamp: s.lastUpdated || ctx.istTime || clock(),
          latch: {
            key: `${cfg.latchPrefix}_${leg.symbol.replace(/\s+/g, '_')}`,
            side: 'GREEN',
            details: {
              spotPrice: leg.currentLtp || trigger,
              todayTradedShares: 0,
              avg20DTradedShares: 0,
              volumeRatio: 1,
              crossoverTime: s.lastUpdated || ctx.istTime,
              strategyId: cfg.strategyId,
            },
          },
          materialize: () => ({
            notes: `⚡ ${cfg.notesLabel} 1.5X Trigger Breached for ${leg.symbol} (Open: ₹${open}, Trigger: ₹${trigger.toFixed(2)}). SL: ₹${open}.`,
            notify: () =>
              deps.notifier.notify0920StrangleEntry(s.ceLeg.strike, s.peLeg.strike, s.ceLeg.openPrice, s.peLeg.openPrice),
          }),
        },
      ];
    },
  };
}

export function createNiftyOobtstStrategy(deps: StrategyDeps): EngineStrategy {
  return createOobtstStrategy(deps, {
    strategyId: STRATEGY_IDS.OOBTST_NIFTY,
    strategyName: '09:20 OOBTST NIFTY',
    idPrefix: 'sig-oobtst-nifty',
    latchPrefix: 'OOBTST_NIFTY',
    notesLabel: '09:20',
    select: (ctx) => ctx.niftyOobtst,
  });
}

export function createSensexOobtstStrategy(deps: StrategyDeps): EngineStrategy {
  return createOobtstStrategy(deps, {
    strategyId: STRATEGY_IDS.OOBTST_SENSEX,
    strategyName: '09:20 OOBTST SENSEX',
    idPrefix: 'sig-oobtst-sensex',
    latchPrefix: 'OOBTST_SENSEX',
    notesLabel: 'Sensex 09:20',
    select: (ctx) => ctx.sensexOobtst,
  });
}

export function createDefaultStrategies(deps: StrategyDeps): EngineStrategy[] {
  return [
    createVolumeCrossoverStrategy(deps),
    createBreakout180Strategy(deps),
    createNiftyOobtstStrategy(deps),
    createSensexOobtstStrategy(deps),
  ];
}
