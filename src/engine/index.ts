import { alertLatchService } from '../services/alertLatchService';
import { journalRepository } from '../services/JournalRepository';
import { notificationService } from '../services/notificationService';
import { apiService } from '../services/apiService';
import { SignalPipeline } from './SignalPipeline';
import { StrategyEngine } from './StrategyEngine';
import { createDefaultStrategies } from './strategies';

export { STRATEGY_IDS } from './strategies';
export { applyClosedTrades, sumPoints } from './journalMath';
export type { EngineContext, SignalEvent, EngineStrategy, ClosedTrade } from './types';

export const strategyEngine = new StrategyEngine(
  new SignalPipeline(
    alertLatchService,
    Date.now,
    (entry) => journalRepository.save(entry, alertLatchService.getTodayISTDateString()),
    (trade) => journalRepository.closeTrade(trade, alertLatchService.getTodayISTDateString())
  )
);

createDefaultStrategies({
  notifier: notificationService,
  tacticalStrike: (stock) => apiService.calculateTacticalStrike(stock),
}).forEach((strategy) => strategyEngine.register(strategy));
