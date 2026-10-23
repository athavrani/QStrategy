import { alertLatchService } from '../services/alertLatchService';
import { journalRepository } from '../services/JournalRepository';
import { marketData } from '../services/marketdata/MarketDataService';
import { notificationService } from '../services/notificationService';
import { apiService } from '../services/apiService';
import { executionService } from '../execution/ExecutionService';
import { SignalPipeline } from './SignalPipeline';
import { StrategyEngine } from './StrategyEngine';
import { createDefaultStrategies } from './strategies';

export { STRATEGY_IDS } from './strategies';
export { applyClosedTrades, sumPoints } from './journalMath';
export type { EngineContext, SignalEvent, EngineStrategy, ClosedTrade, CarryTrade } from './types';

export const strategyEngine = new StrategyEngine(
  new SignalPipeline(
    alertLatchService,
    Date.now,
    (entry) => journalRepository.save(entry, alertLatchService.getTodayISTDateString()),
    (trade) => journalRepository.closeTrade(trade, trade.tradeDate ?? alertLatchService.getTodayISTDateString()),
    executionService
  )
);

createDefaultStrategies({
  notifier: notificationService,
  tacticalStrike: (stock) => apiService.calculateTacticalStrike(stock),
  getLtp: (segment, securityId) => marketData.getQuote(segment, securityId)?.ltp,
}).forEach((strategy) => strategyEngine.register(strategy));
