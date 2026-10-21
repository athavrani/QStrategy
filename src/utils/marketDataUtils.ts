/**
 * QStrategy — Market Data Utilities
 * Canonical shared functions for prevClose resolution, % change calculation,
 * and data sanity validation. Single source of truth — eliminates duplication
 * across dhanDirectService, useRadarStore tick listener, and RadarScreen.
 */

/**
 * Maximum plausible single-day price change percentage for any NSE/BSE equity.
 * NSE applies a 20% circuit breaker on individual stocks, so anything beyond
 * ±25% is almost certainly a data error (stale prevClose, wrong instrument mapping,
 * or corporate action not yet reflected in the catalog baseline).
 */
export const MAX_REASONABLE_CHANGE_PCT = 25;

/**
 * Returns true if the computed price change percentage is within plausible bounds.
 * Used as a sanity gate to reject garbage % values before they reach the UI.
 *
 * @param pct  Computed percentage value (e.g. 1.23 for +1.23%)
 */
export function isReasonableChangePct(pct: number): boolean {
  return isFinite(pct) && Math.abs(pct) <= MAX_REASONABLE_CHANGE_PCT;
}

/**
 * Calculates price change percentage from spotPrice vs prevClose.
 * Returns null (not 0) when inputs are invalid so callers can fall back gracefully.
 *
 * @param spotPrice   Current last traded price (must be > 0)
 * @param prevClose   Previous trading day's closing price (must be > 0)
 * @returns           Percentage rounded to 2 decimal places, or null if inputs invalid
 */
export function calcChangePct(spotPrice: number, prevClose: number): number | null {
  if (spotPrice <= 0 || prevClose <= 0) return null;
  const raw = ((spotPrice - prevClose) / prevClose) * 100;
  return +raw.toFixed(2);
}

/**
 * Calculates and validates a price change percentage.
 * If the result exceeds MAX_REASONABLE_CHANGE_PCT, the prevClose is considered
 * stale or incorrect and null is returned to signal the caller to use a fallback.
 *
 * @param spotPrice      Current last traded price
 * @param prevClose      Candidate previous close price
 * @param fallbackPct    Value to return when calculation is invalid/unreasonable
 */
export function safeChangePct(
  spotPrice: number,
  prevClose: number,
  fallbackPct: number = 0
): number {
  const pct = calcChangePct(spotPrice, prevClose);
  if (pct === null) return fallbackPct;
  if (!isReasonableChangePct(pct)) return fallbackPct;
  return pct;
}

/**
 * Canonical prevClose resolver for market tick / REST quote data.
 * Resolves in strict priority order and applies a sanity-range check
 * on the resulting % change to reject stale/wrong catalog values.
 *
 * Priority:
 *  1. net_change derived:   prevClose = ltp - netChange  (most reliable when Dhan provides it)
 *  2. previous_close field (explicit API field)
 *  3. prev_close field (alternate API field name)
 *  4. ohlc.close (different from ltp — valid during regular hours)
 *  5. close (different from ltp — valid during regular hours)
 *  6. dailyPrevCloseMap entry (service-layer cache, updated from live API discoveries)
 *  7. catalogPrevClose (hardcoded baseline — LAST resort, sanity-checked)
 *
 * @param ltp               Current last traded price
 * @param rawNetChange      Net price change from API (ltp - prevClose); 0 if not provided
 * @param apiFields         Object containing optional close-related API fields
 * @param cachedPrevClose   Previously discovered prevClose from service cache (dailyPrevCloseMap)
 * @param catalogPrevClose  Hardcoded fallback from stockUniverse.ts (emergency last resort)
 * @returns                 Resolved prevClose (> 0) or 0 if none available
 */
export function resolvePrevClose(
  ltp: number,
  rawNetChange: number,
  apiFields: {
    previous_close?: number;
    prev_close?: number;
    ohlcClose?: number;
    close?: number;
  },
  cachedPrevClose: number,
  catalogPrevClose: number
): number {
  // Helper to test if a candidate prevClose produces a reasonable percentage change against LTP
  const isCandidateValid = (cand: number): boolean => {
    if (cand <= 0) return false;
    if (ltp <= 0) return true; // If no live LTP, accept positive candidate
    const pct = calcChangePct(ltp, cand);
    return pct !== null && isReasonableChangePct(pct);
  };

  // Priority 1: Derive from net_change — mathematically guaranteed correct
  if (rawNetChange !== 0 && ltp > 0) {
    const derived = +(ltp - rawNetChange).toFixed(2);
    if (isCandidateValid(derived)) return derived;
  }

  // Priority 2: Explicit previous_close field
  if (apiFields.previous_close && isCandidateValid(apiFields.previous_close)) {
    return apiFields.previous_close;
  }

  // Priority 3: Alternate prev_close field name
  if (apiFields.prev_close && isCandidateValid(apiFields.prev_close)) {
    return apiFields.prev_close;
  }

  // Priority 4: ohlc.close — valid as prevClose during regular market hours
  // Note: Dhan sets this to today's close post-market, so we allow it unless it equals LTP
  if (apiFields.ohlcClose && apiFields.ohlcClose > 0 && apiFields.ohlcClose !== ltp) {
    if (isCandidateValid(apiFields.ohlcClose)) {
      return apiFields.ohlcClose;
    }
  }

  // Priority 5: item.close (same semantics as ohlc.close)
  if (apiFields.close && apiFields.close > 0 && apiFields.close !== ltp) {
    if (isCandidateValid(apiFields.close)) {
      return apiFields.close;
    }
  }

  // Priority 6: Service-layer dailyPrevCloseMap cache
  if (cachedPrevClose > 0 && isCandidateValid(cachedPrevClose)) {
    return cachedPrevClose;
  }

  // Priority 7 (LAST RESORT): Hardcoded catalog baseline
  if (catalogPrevClose > 0 && isCandidateValid(catalogPrevClose)) {
    return catalogPrevClose;
  }

  return 0;
}

/**
 * Returns the current IST time as HH:MM string for session/time comparisons.
 */
export function getCurrentISTTime(): { hours: number; minutes: number; timeStr: string } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 3600000;
  const ist = new Date(istMs);
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { hours, minutes, timeStr };
}

/**
 * Returns true if the current IST time is within regular market hours (09:15 - 15:30).
 */
export function isRegularMarketHours(): boolean {
  const { hours, minutes } = getCurrentISTTime();
  const totalMins = hours * 60 + minutes;
  return totalMins >= 555 && totalMins < 930; // 09:15 to 15:30
}
