import { validateOrderRequest, type OrderRequest } from '../services/dhan/DhanOrderClient';
import type { ExecutableSignal, ExecutionSettings, ExecutableStrategyId } from './types';
import { EXECUTABLE_STRATEGIES } from './types';

const TICK = 0.05;

export function isExecutableStrategy(id: string): id is ExecutableStrategyId {
  return (EXECUTABLE_STRATEGIES as readonly string[]).includes(id);
}

/** Rounds up to the option tick size (0.05) so a buy limit is never below the buffered price. */
export function roundUpToTick(price: number): number {
  return Number((Math.ceil(price / TICK - 1e-9) * TICK).toFixed(2));
}

/** Stable per signal, so recording the same signal twice updates one row instead of adding another. */
export function paperCorrelationId(journalId: string): string {
  const clean = journalId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `QSP-${clean.slice(-26)}`;
}

export type MappingResult = { ok: true; request: OrderRequest; lots: number } | { ok: false; reason: string };

/** Builds the entry order for a signal, or says why it cannot be built. Entry orders are buy limit orders. */
export function buildOrderRequest(signal: ExecutableSignal, settings: ExecutionSettings): MappingResult {
  if (!isExecutableStrategy(signal.strategyId)) return { ok: false, reason: 'This strategy is alert-only.' };
  if (signal.side !== 'BUY') return { ok: false, reason: 'Only BUY entries are executed.' };
  if (!signal.hint) return { ok: false, reason: 'No instrument data for this signal (security ID missing).' };
  if (!(signal.entryPrice > 0)) return { ok: false, reason: 'Signal has no valid entry price.' };

  const lots = settings.strategies[signal.strategyId].lots;
  const request: OrderRequest = {
    correlationId: paperCorrelationId(signal.journalId),
    transactionType: 'BUY',
    exchangeSegment: signal.hint.exchangeSegment,
    productType: signal.hint.productType,
    orderType: 'LIMIT',
    validity: 'DAY',
    securityId: signal.hint.securityId,
    quantity: lots * signal.hint.lotSize,
    price: roundUpToTick(signal.entryPrice * (1 + settings.limitBufferPct / 100)),
  };

  const invalid = validateOrderRequest(request);
  return invalid ? { ok: false, reason: invalid } : { ok: true, request, lots };
}

export interface DayTotals {
  orders: number;
  value: number;
}

/** First limit that the order would break, or null. Totals cover today's already planned orders. */
export function checkLimits(request: OrderRequest, lots: number, today: DayTotals, settings: ExecutionSettings): string | null {
  const { limits } = settings;
  const value = (request.price ?? 0) * request.quantity;
  if (lots > limits.maxLotsPerOrder) return `${lots} lots is above the ${limits.maxLotsPerOrder}-lot limit per order.`;
  if (today.orders >= limits.maxOrdersPerDay) return `Daily limit of ${limits.maxOrdersPerDay} orders reached.`;
  if (value > limits.maxOrderValue) return `Order value ₹${Math.round(value)} is above the ₹${limits.maxOrderValue} per-order limit.`;
  if (today.value + value > limits.maxDailyValue) {
    return `Today's total would be ₹${Math.round(today.value + value)}, above the ₹${limits.maxDailyValue} daily limit.`;
  }
  return null;
}

const OPEN_MINUTES = 9 * 60 + 15;
const CLOSE_MINUTES = 15 * 60 + 25;

/** Orders are only planned during market hours, 09:15 to 15:25 IST on trading days. */
export function marketHoursBlock(now: Date, isTradingDay: (d: Date) => boolean): string | null {
  if (!isTradingDay(now)) return 'The market is closed today.';
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes < OPEN_MINUTES || minutes >= CLOSE_MINUTES) return 'Outside order hours (09:15 to 15:25 IST).';
  return null;
}
