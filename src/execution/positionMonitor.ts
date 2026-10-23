import { strategyEngine } from '../engine';
import { positionManager } from './PositionManager';
import { marketHoursBlock } from './orderMapping';
import { tradingCalendarService } from '../services/TradingCalendarService';

const FAST_MS = 5_000;
const SLOW_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let busy = false;
let lastRun = 0;

/** Every few seconds while the market is open, once a minute otherwise (an overnight position still needs watching). */
function due(now: number): boolean {
  const open = marketHoursBlock(new Date(now), (d) => tradingCalendarService.isTradingDay(d)) === null;
  return now - lastRun >= (open ? FAST_MS : SLOW_MS);
}

async function tick(force = false): Promise<void> {
  if (busy) return;
  const now = Date.now();
  if (!force && !due(now)) return;
  busy = true;
  lastRun = now;
  try {
    await positionManager.reconcile();
  } catch {
    // The next tick tries again; reconciliation never throws into the app.
  } finally {
    busy = false;
  }
}

/** Starts watching positions in the background and routes strategy target/time exits to them. */
export function startPositionMonitor(): void {
  if (timer) return;
  unsubscribe = strategyEngine.onClosed((trades) => {
    positionManager.onTradesClosed(trades).catch(() => {});
  });
  timer = setInterval(() => void tick(), FAST_MS);
  void tick(true);
}

export function stopPositionMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** Reconciles right away, for example just after an entry order was sent. */
export function kickPositionMonitor(): Promise<void> {
  return tick(true);
}
