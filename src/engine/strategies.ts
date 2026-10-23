import type { StockRadarItem, TacticalStrikeSuggestion } from '../types/mobile';
import type { OobtstLiveState } from '../strategies/types';
import type { CarryTrade, EngineContext, EngineStrategy, ExitEvent, SignalEvent } from './types';
import { parseClockSeconds } from './clockTriggers';

export const STRATEGY_IDS = {
  VOLUME_CROSSOVER: '20D_CROSSOVER',
  BREAKOUT_180: 'NIFTY_BREAKOUT_180',
  OOBTST_NIFTY: 'OOBTST_NIFTY',
  OOBTST_SENSEX: 'OOBTST_SENSEX',
  BTST_CARRY: 'BTST_CARRY',
} as const;

export interface Notifier {
  notify20DCrossover(ticker: string, volumeRatio: number, spotPrice: number, atmStrike: number): unknown;
  notify180BreakoutTriggered(type: 'CE' | 'PE', strike: number, price: number, target: number, sl: number): unknown;
  notify0920StrangleEntry(ceStrike: number, peStrike: number, cePrice: number, pePrice: number): unknown;
  notify0920StopLossHit?(legType: 'CE' | 'PE', strike: number, price: number): unknown;
  notify180TimeExit?(strike: number, type: 'CE' | 'PE'): unknown;
}

export interface StrategyDeps {
  notifier: Notifier;
  tacticalStrike: (stock: StockRadarItem) => Pick<TacticalStrikeSuggestion, 'recommendedCeStrike'>;
  /** Latest traded price of a derivative contract, if one has been received. */
  getLtp?: (segment: string, securityId: string) => number | undefined;
}

const SECONDS_0915 = 9 * 3600 + 15 * 60;
const SECONDS_0916 = 9 * 3600 + 16 * 60;
const SECONDS_0925 = 9 * 3600 + 25 * 60;

/** Morning exit of overnight OOBTST positions: stop-loss from 09:15, otherwise square off at 09:25. */
export function createBtstCarryStrategy(deps: StrategyDeps): EngineStrategy {
  return {
    id: STRATEGY_IDS.BTST_CARRY,
    detect: () => [],
    detectExits(ctx: EngineContext): ExitEvent[] {
      const now = parseClockSeconds(ctx.istTime);
      if (now === null || now < SECONDS_0915) return [];

      const exits: ExitEvent[] = [];
      for (const t of ctx.carry ?? []) {
        const ltp = deps.getLtp?.(t.segment, t.securityId);
        if (!ltp || ltp <= 0) continue;

        const stopped = ltp <= t.slPrice;
        if (!stopped && now < SECONDS_0925) continue;

        const exitPrice = stopped ? t.slPrice : ltp;
        const pnlPoints = +(exitPrice - t.entryPrice).toFixed(2);
        exits.push(buildCarryExit(t, exitPrice, pnlPoints, stopped, ctx.istTime, deps));
      }
      return exits;
    },
  };
}

function buildCarryExit(
  t: CarryTrade,
  exitPrice: number,
  pnlPoints: number,
  stopped: boolean,
  istTime: string,
  deps: StrategyDeps
): ExitEvent {
  const legType: 'CE' | 'PE' = t.symbol.trim().endsWith('PE') ? 'PE' : 'CE';
  const strike = Number(/(\d+)\s+(?:CE|PE)$/.exec(t.symbol)?.[1] ?? 0);
  return {
    strategyId: t.strategyId,
    symbol: t.symbol,
    outcome: stopped ? 'LOSS' : 'TIME_EXIT',
    exitPrice,
    pnlPoints,
    timestamp: istTime,
    tradeDate: t.tradeDate,
    journalId: t.journalId,
    notes: `${stopped ? 'Overnight stop-loss hit' : 'BTST morning exit 09:25'} @ \u20b9${exitPrice.toFixed(2)} (${pnlPoints >= 0 ? '+' : ''}${pnlPoints.toFixed(2)} pts).`,
    latch: {
      key: `EXIT_BTST_${t.strategyId}_${t.symbol.replace(/\s+/g, '_')}_${t.tradeDate}`,
      side: 'RED',
      details: {
        spotPrice: exitPrice,
        todayTradedShares: 0,
        avg20DTradedShares: 0,
        volumeRatio: 1,
        crossoverTime: istTime,
        strategyId: t.strategyId,
      },
    },
    notify: stopped ? () => deps.notifier.notify0920StopLossHit?.(legType, strike, exitPrice) : undefined,
  };
}

const clock = () => new Date().toLocaleTimeString('en-IN');

export function createVolumeCrossoverStrategy(deps: StrategyDeps): EngineStrategy {
  return {
    id: STRATEGY_IDS.VOLUME_CROSSOVER,
    detect(ctx: EngineContext): SignalEvent[] {
      const events: SignalEvent[] = [];
      // Pre-open volume is the previous session's and must never register as a crossover
      const now = parseClockSeconds(ctx.istTime ?? '');
      if (now !== null && now < SECONDS_0916) return events;
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
            notes: `🚀 09:25 Candle Open < ₹180 Breakout Triggered @ ₹${entry.toFixed(2)}. Target: ₹${b.fixedTarget.toFixed(2)}, SL: ₹${b.fixedStopLoss.toFixed(2)}.`,
            notify: () => deps.notifier.notify180BreakoutTriggered(contract, strike, entry, b.fixedTarget, b.fixedStopLoss),
          }),
        },
      ];
    },
    detectExits(ctx: EngineContext): ExitEvent[] {
      const b = ctx.breakout;
      if (!b || !b.activeContract || !b.ceCandidate || !b.peCandidate || b.entryPrice == null) return [];
      if (b.status !== 'TARGET_HIT' && b.status !== 'SL_HIT' && b.status !== 'TIME_EXIT') return [];

      const contract = b.activeContract;
      const strike = contract === 'CE' ? b.ceCandidate.strike : b.peCandidate.strike;
      const symbol = `NIFTY ${strike} ${contract}`;
      const entry = b.entryPrice;
      const exitPrice = b.exitPrice ??
        (b.status === 'TARGET_HIT' ? b.fixedTarget : b.status === 'SL_HIT' ? b.fixedStopLoss : (b.currentPrice ?? entry));
      const pnlPoints = +(exitPrice - entry).toFixed(2);
      const label =
        b.status === 'TARGET_HIT' ? 'Target hit' : b.status === 'SL_HIT' ? 'Stop-loss hit' : 'Squared off at 09:45 time exit';

      return [
        {
          strategyId: STRATEGY_IDS.BREAKOUT_180,
          symbol,
          outcome: b.status === 'TARGET_HIT' ? 'WIN' : b.status === 'SL_HIT' ? 'LOSS' : 'TIME_EXIT',
          exitPrice,
          pnlPoints,
          timestamp: b.exitTime ?? ctx.istTime,
          notes: `${label} @ ₹${exitPrice.toFixed(2)} (${pnlPoints >= 0 ? '+' : ''}${pnlPoints.toFixed(2)} pts).`,
          latch: {
            key: `EXIT_BREAKOUT_180_${symbol.replace(/\s+/g, '_')}`,
            side: 'RED',
            details: {
              spotPrice: exitPrice,
              todayTradedShares: 0,
              avg20DTradedShares: 0,
              volumeRatio: 1,
              crossoverTime: ctx.istTime,
              strategyId: STRATEGY_IDS.BREAKOUT_180,
            },
          },
          notify:
            b.status === 'TIME_EXIT' ? () => deps.notifier.notify180TimeExit?.(strike, contract) : undefined,
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
    detectExits(ctx: EngineContext): ExitEvent[] {
      const s = cfg.select(ctx);
      if (!s || s.status !== 'SL_HIT' || !s.activeLeg) return [];
      if (s.executedPrice == null || s.slPrice == null) return [];

      const leg = s.activeLeg === 'CE' ? s.ceLeg : s.peLeg;
      const pnlPoints = +(s.slPrice - s.executedPrice).toFixed(2);
      const legType = s.activeLeg;

      return [
        {
          strategyId: cfg.strategyId,
          symbol: leg.symbol,
          outcome: 'LOSS',
          exitPrice: s.slPrice,
          pnlPoints,
          timestamp: s.lastUpdated || ctx.istTime,
          notes: `Stop-loss hit @ ₹${s.slPrice.toFixed(2)} (${pnlPoints.toFixed(2)} pts).`,
          latch: {
            key: `EXIT_${cfg.latchPrefix}_${leg.symbol.replace(/\s+/g, '_')}`,
            side: 'RED',
            details: {
              spotPrice: s.slPrice,
              todayTradedShares: 0,
              avg20DTradedShares: 0,
              volumeRatio: 1,
              crossoverTime: s.lastUpdated || ctx.istTime,
              strategyId: cfg.strategyId,
            },
          },
          notify: () => deps.notifier.notify0920StopLossHit?.(legType, leg.strike, s.slPrice as number),
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
    createBtstCarryStrategy(deps),
  ];
}
