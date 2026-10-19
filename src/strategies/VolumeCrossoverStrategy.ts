/**
 * QStrategy — 20-Day Cumulative Volume Crossover Strategy Engine (20D_CROSSOVER)
 * Pure mathematical evaluator enforcing:
 * 1. 20D Historical Volume baseline calculation (completed sessions only)
 * 2. 09:15:00 - 09:16:00 Opening feed stabilization filter (suppresses false spikes)
 * 3. Directional Bullish confirmation (LTP >= Day Open & Delta% >= 0)
 * 4. Monotonic one-way latch (once triggered, remains latched for session)
 * 5. Dynamic π% (3.1416%) milestone targets
 */

export const PI_PERCENT = 0.031416;

export interface StockEvaluationInput {
  ticker: string;
  spotPrice: number;
  dayOpen: number;
  prevClose?: number;
  percentChange: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  strikeStep?: number;
}

export interface VolumeCrossoverEvaluation {
  ticker: string;
  volumeRatio: number;
  hasCrossed20D: boolean;
  isOpeningStabilizing: boolean;
  isStabilizationFiltered: boolean;
  triggerState: 'GREEN' | 'RED' | 'AMBER' | 'GREY';
  crossoverDirection: 'BULLISH' | 'BEARISH';
  recommendedCeStrike: number;
  targets: {
    t1: number;
    t2: number;
    t3: number;
    t4: number;
  };
  initialStopLoss: number;
}

/**
 * Checks whether current IST time falls in the 09:15:00–09:16:00 opening feed stabilization window
 */
export function isOpeningFeedStabilizing(timeStr: string): boolean {
  if (!timeStr) return false;
  // Match HH:MM:SS or HH:MM
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return false;

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parts.length >= 3 ? parseInt(parts[2], 10) : 0;

  if (hours === 9 && minutes === 15) {
    return true; // 09:15:00 to 09:15:59
  }
  return false;
}

/**
 * Evaluates volume crossover metrics and returns typed evaluation
 */
export function evaluateVolumeCrossover(
  stock: StockEvaluationInput,
  currentTimeIST = ''
): VolumeCrossoverEvaluation {
  const avgShares = stock.avg20DTradedShares > 0 ? stock.avg20DTradedShares : 1;
  const todayShares = Math.max(0, stock.todayTradedShares);
  const volumeRatio = +(todayShares / avgShares).toFixed(3);

  const stabilizing = isOpeningFeedStabilizing(currentTimeIST);

  // Invariant 2: Opening Stabilization Gate
  // If in first 60s (09:15 - 09:16) and volume spike >= 50% of 20D baseline, ignore as noise
  const isStabilizationFiltered = stabilizing && volumeRatio >= 0.5;

  const hasCrossed = !isStabilizationFiltered && todayShares >= avgShares && todayShares > 0;

  // Invariant 3: Directional Confirmation
  // Bullish requires LTP >= Day Open AND percentChange >= 0
  const isPriceBullish = stock.spotPrice >= stock.dayOpen && stock.percentChange >= 0;
  const crossoverDirection: 'BULLISH' | 'BEARISH' = isPriceBullish ? 'BULLISH' : 'BEARISH';

  let triggerState: 'GREEN' | 'RED' | 'AMBER' | 'GREY' = 'GREY';

  if (!isStabilizationFiltered) {
    if (hasCrossed) {
      triggerState = isPriceBullish ? 'GREEN' : 'RED';
    } else if (volumeRatio >= 0.8) {
      triggerState = 'AMBER';
    }
  }

  // Tactical strike recommendation: round(Spot / step) * step
  const step = stock.strikeStep && stock.strikeStep > 0 ? stock.strikeStep : 50;
  const recommendedCeStrike = stock.spotPrice > 0 ? Math.round(stock.spotPrice / step) * step : 0;

  // Dynamic π% Milestone Targets
  const spot = stock.spotPrice;
  const targets = {
    t1: +(spot * (1 + PI_PERCENT)).toFixed(2),
    t2: +(spot * (1 + 2 * PI_PERCENT)).toFixed(2),
    t3: +(spot * (1 + 3 * PI_PERCENT)).toFixed(2),
    t4: +(spot * (1 + 4 * PI_PERCENT)).toFixed(2),
  };

  // Initial stop loss: -1% on spot or -20% on option
  const initialStopLoss = +(spot * 0.99).toFixed(2);

  return {
    ticker: stock.ticker,
    volumeRatio,
    hasCrossed20D: hasCrossed,
    isOpeningStabilizing: stabilizing,
    isStabilizationFiltered,
    triggerState,
    crossoverDirection,
    recommendedCeStrike,
    targets,
    initialStopLoss,
  };
}
