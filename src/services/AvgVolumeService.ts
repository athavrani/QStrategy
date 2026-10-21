/**
 * QStrategy — 20-Day Average Volume Service
 * Dynamically computes the 20-day average daily traded volume for all NIFTY 50
 * and BSE SENSEX constituents using the Dhan HQ /charts/intraday REST endpoint.
 *
 * Design:
 * - Fetches once per trading day at session start (day rollover detection in useRadarStore)
 * - Persists computed averages to AsyncStorage keyed by ticker + sessionDate
 * - Serves cached values within the same trading day without additional API calls
 * - Rate-limits: processes stocks in batches of 3 with 500ms delay between batches
 *   to respect Dhan's intraday API rate limits
 * - Falls back gracefully to the static catalog value on any error
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { dhanHqRestClient } from './dhan/DhanHqRestClient';
import { getDhanSecurityId } from '../constants/dhanSecurityMaster';
import { SENSEX_NIFTY_MASTER_CATALOG } from '../constants/stockUniverse';
import { isTradingDay } from '../constants/nseHolidays';
import { dhanDirectService } from './dhanDirectService';

const AVG_VOLUME_CACHE_PREFIX = 'avgvol_v2:';
const TARGET_SESSIONS = 20;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;
// Fetch up to 40 calendar days back to ensure we get 20 valid trading sessions
const LOOKBACK_CALENDAR_DAYS = 40;

/**
 * Result of the avg volume computation for a single stock.
 */
export interface AvgVolumeResult {
  ticker: string;
  avg20DVolume: number;
  sessionCount: number; // actual number of sessions used (may be < 20 if limited history)
  computedAt: string;   // ISO date string
  fromCache: boolean;
  prevClose?: number;
}

class AvgVolumeService {
  private inProgress = false;
  private lastComputedDate: string | null = null;
  private inMemoryAvgMap = new Map<string, number>();
  private inMemoryPrevCloseMap = new Map<string, number>();

  public getCachedAvg(ticker: string): number | undefined {
    return this.inMemoryAvgMap.get(ticker.toUpperCase());
  }

  public getCachedPrevClose(ticker: string): number | undefined {
    return this.inMemoryPrevCloseMap.get(ticker.toUpperCase());
  }

  public setCachedAvg(ticker: string, avg: number, prevClose?: number): void {
    if (avg > 0) {
      this.inMemoryAvgMap.set(ticker.toUpperCase(), avg);
    }
    if (prevClose && prevClose > 0) {
      this.inMemoryPrevCloseMap.set(ticker.toUpperCase(), prevClose);
    }
  }

  /**
   * Returns the AsyncStorage cache key for a ticker + session date.
   */
  private cacheKey(ticker: string, sessionDate: string): string {
    return `${AVG_VOLUME_CACHE_PREFIX}${ticker.toUpperCase()}:${sessionDate}`;
  }

  /**
   * Generates a list of past calendar dates starting from `fromDate` going backwards,
   * filtering to only valid NSE trading days.
   * Returns dates in descending order (most recent first).
   */
  private getPastTradingDays(fromDate: Date, count: number): Date[] {
    const tradingDays: Date[] = [];
    const cursor = new Date(fromDate);
    cursor.setDate(cursor.getDate() - 1); // Start from yesterday

    while (tradingDays.length < count) {
      if (isTradingDay(cursor)) {
        tradingDays.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() - 1);
      // Safety limit: don't look back more than LOOKBACK_CALENDAR_DAYS days
      const daysDiff = (fromDate.getTime() - cursor.getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > LOOKBACK_CALENDAR_DAYS) break;
    }
    return tradingDays; // most recent first
  }

  /**
   * Formats a Date to 'YYYY-MM-DD' for Dhan API requests.
   */
  private formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Fetches daily historical volumes and authentic previous session close for a stock.
   * Priority:
   * 1. Uses POST /v2/charts/historical for daily candles (1 candle per trading day, total volume directly).
   * 2. Falls back to POST /v2/charts/intraday and sums the 1-minute bars per day.
   */
  private async fetchDailyVolumes(
    ticker: string,
    fromDate: string,
    toDate: string
  ): Promise<{ volumes: number[]; prevClose?: number }> {
    const securityId = getDhanSecurityId(ticker);
    if (!securityId) return { volumes: [] };

    // 1. Primary: Daily historical charts endpoint (single request, daily volume directly)
    try {
      const dailyData = await dhanHqRestClient.fetchHistoricalDaily(
        securityId,
        'NSE_EQ',
        'EQUITY',
        fromDate,
        toDate
      );

      if (dailyData && Array.isArray(dailyData.volume) && dailyData.volume.length > 0) {
        const validVolumes = dailyData.volume.filter((v) => typeof v === 'number' && v > 0);
        let lastClose: number | undefined;
        if (Array.isArray(dailyData.close) && dailyData.close.length > 0) {
          const validCloses = dailyData.close.filter((c) => typeof c === 'number' && c > 0);
          if (validCloses.length > 0) {
            lastClose = validCloses[validCloses.length - 1];
          }
        }
        if (validVolumes.length > 0) {
          return { volumes: validVolumes, prevClose: lastClose };
        }
      }
    } catch {}

    // 2. Fallback: 1-minute intraday bars aggregated by day
    try {
      const data = await dhanHqRestClient.fetchHistoricalIntraday(
        securityId,
        'NSE_EQ',
        'EQUITY',
        fromDate,
        toDate,
        '1'
      );

      if (!data || !Array.isArray(data.volume) || !Array.isArray(data.start_Time)) {
        return { volumes: [] };
      }

      // Group & sum bar volumes by trading day (start_Time is Unix epoch seconds)
      const dailyVolumeMap = new Map<string, number>();
      for (let i = 0; i < data.volume.length; i++) {
        const vol = data.volume[i];
        const ts = data.start_Time[i];
        if (typeof vol !== 'number' || typeof ts !== 'number' || vol <= 0) continue;

        // Convert epoch seconds to IST date string
        const d = new Date(ts * 1000);
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(d.getTime() + istOffset);
        const dateKey = `${istDate.getFullYear()}-${String(istDate.getMonth() + 1).padStart(2, '0')}-${String(istDate.getDate()).padStart(2, '0')}`;

        // Sum periodic 1-minute bar volumes to get total day volume
        dailyVolumeMap.set(dateKey, (dailyVolumeMap.get(dateKey) ?? 0) + vol);
      }

      // Return volumes sorted by date ascending
      const validVolumes = Array.from(dailyVolumeMap.values()).filter((v) => v > 0);
      let lastClose: number | undefined;
      if (Array.isArray(data.close) && data.close.length > 0) {
        const validCloses = data.close.filter((c) => typeof c === 'number' && c > 0);
        if (validCloses.length > 0) {
          lastClose = validCloses[validCloses.length - 1];
        }
      }
      return { volumes: validVolumes, prevClose: lastClose };
    } catch {
      return { volumes: [] };
    }
  }

  /**
   * Computes and caches the 20-day average volume for a single ticker.
   * Returns the cached value if already computed for today's session.
   */
  public async getAvgVolume(
    ticker: string,
    sessionDate: string,
    catalogFallback: number
  ): Promise<AvgVolumeResult> {
    const key = this.cacheKey(ticker, sessionDate);

    // If day changed, clear in-memory cache to force recomputation for the new session
    if (this.lastComputedDate && this.lastComputedDate !== sessionDate) {
      this.inMemoryAvgMap.clear();
      this.inMemoryPrevCloseMap.clear();
      this.lastComputedDate = null;
    }

    // 1. Check in-memory cache first
    const inMem = this.inMemoryAvgMap.get(ticker.toUpperCase());
    if (inMem && inMem > 0) {
      return {
        ticker,
        avg20DVolume: inMem,
        sessionCount: TARGET_SESSIONS,
        computedAt: new Date().toISOString(),
        fromCache: true,
        prevClose: this.inMemoryPrevCloseMap.get(ticker.toUpperCase()),
      };
    }

    // 2. Check AsyncStorage cache
    try {
      const cached = await AsyncStorage.getItem(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed.avg20DVolume === 'number' && parsed.avg20DVolume > 0 && parsed.sessionCount > 0) {
          this.inMemoryAvgMap.set(ticker.toUpperCase(), parsed.avg20DVolume);
          if (parsed.prevClose && parsed.prevClose > 0) {
            this.inMemoryPrevCloseMap.set(ticker.toUpperCase(), parsed.prevClose);
            dhanDirectService.updatePrevClose(ticker, parsed.prevClose);
          }
          return { ...parsed, fromCache: true };
        }
      }
    } catch {}

    // 3. Not cached — fetch from Dhan API
    const toDate = sessionDate;
    const [y, m, d] = sessionDate.split('-').map(Number);
    const fromDateObj = new Date(Date.UTC(y, m - 1, d - LOOKBACK_CALENDAR_DAYS));
    const fromDate = `${fromDateObj.getUTCFullYear()}-${String(fromDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(fromDateObj.getUTCDate()).padStart(2, '0')}`;

    const { volumes: dailyVolumes, prevClose } = await this.fetchDailyVolumes(ticker, fromDate, toDate);

    // Use the most recent TARGET_SESSIONS trading days
    const relevantSessions = dailyVolumes.slice(-TARGET_SESSIONS);
    const sessionCount = relevantSessions.length;

    let avg20DVolume = catalogFallback; // fallback to static catalog
    if (sessionCount > 0) {
      const total = relevantSessions.reduce((sum, v) => sum + v, 0);
      avg20DVolume = Math.round(total / sessionCount);
      this.inMemoryAvgMap.set(ticker.toUpperCase(), avg20DVolume);
      if (prevClose && prevClose > 0) {
        this.inMemoryPrevCloseMap.set(ticker.toUpperCase(), prevClose);
        dhanDirectService.updatePrevClose(ticker, prevClose);
      }
    }

    const result: AvgVolumeResult = {
      ticker,
      avg20DVolume,
      sessionCount,
      computedAt: new Date().toISOString(),
      fromCache: false,
      prevClose,
    };

    // Cache to AsyncStorage ONLY if genuine sessions were computed (> 0)
    if (sessionCount > 0) {
      try {
        await AsyncStorage.setItem(key, JSON.stringify(result));
      } catch {}
    }

    return result;
  }

  /**
   * Refreshes 20D average volumes for all stocks in batches.
   * Called on session start / day rollover.
   *
   * @param sessionDate  Today's trading session date ('YYYY-MM-DD')
   * @param force        Force recalculation even if already computed for today
   * @returns            Map of ticker → { avg20DVolume, prevClose }
   */
  public async refreshAll(
    sessionDate: string,
    force = false
  ): Promise<Map<string, { avg20DVolume: number; prevClose?: number }>> {
    // If day changed or force refresh requested, clear in-memory maps to recompute for the new day
    if (force || (this.lastComputedDate && this.lastComputedDate !== sessionDate)) {
      this.inMemoryAvgMap.clear();
      this.inMemoryPrevCloseMap.clear();
      this.inProgress = false;
      this.lastComputedDate = null;
    }

    if (this.inProgress && this.lastComputedDate === sessionDate) {
      const existing = new Map<string, { avg20DVolume: number; prevClose?: number }>();
      for (const [t, v] of this.inMemoryAvgMap.entries()) {
        existing.set(t, { avg20DVolume: v, prevClose: this.inMemoryPrevCloseMap.get(t) });
      }
      return existing;
    }
    this.inProgress = true;
    this.lastComputedDate = sessionDate;

    const results = new Map<string, { avg20DVolume: number; prevClose?: number }>();
    const stocks = SENSEX_NIFTY_MASTER_CATALOG;

    // Fast-path: Pre-populate in-memory cache from AsyncStorage using multiGet (single I/O operation)
    if (!force && this.inMemoryAvgMap.size === 0) {
      try {
        const keys = stocks.map((s) => this.cacheKey(s.ticker, sessionDate));
        const entries = await AsyncStorage.multiGet(keys);
        for (const [_, val] of entries) {
          if (!val) continue;
          const parsed = JSON.parse(val);
          if (parsed && typeof parsed.avg20DVolume === 'number' && parsed.avg20DVolume > 0 && parsed.sessionCount > 0) {
            const sym = (parsed.ticker || '').toUpperCase();
            if (sym) {
              this.inMemoryAvgMap.set(sym, parsed.avg20DVolume);
              if (parsed.prevClose && parsed.prevClose > 0) {
                this.inMemoryPrevCloseMap.set(sym, parsed.prevClose);
                dhanDirectService.updatePrevClose(sym, parsed.prevClose);
              }
            }
          }
        }
      } catch {}
    }

    // Process in batches to avoid rate limits
    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (stock) => {
          try {
            const result = await this.getAvgVolume(
              stock.ticker,
              sessionDate,
              stock.avg20DTradedShares // catalog fallback
            );
            results.set(stock.ticker.toUpperCase(), {
              avg20DVolume: result.avg20DVolume,
              prevClose: result.prevClose,
            });
          } catch {
            results.set(stock.ticker.toUpperCase(), {
              avg20DVolume: stock.avg20DTradedShares,
            });
          }
        })
      );

      // Rate-limit delay between batches (skip after the last batch)
      if (i + BATCH_SIZE < stocks.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    this.inProgress = false;
    return results;
  }

  /**
   * Explicitly handles trading day change:
   * Clears old session in-memory caches and recomputes fresh 20D average volume and previous day close
   * for all 60 constituents over the new 20-day lookback window.
   */
  public async onDayChange(
    sessionDate: string
  ): Promise<Map<string, { avg20DVolume: number; prevClose?: number }>> {
    return this.refreshAll(sessionDate, true);
  }

  /**
   * Clears all cached avg volume entries from AsyncStorage and in-memory map.
   */
  public async clearCache(): Promise<void> {
    this.inMemoryAvgMap.clear();
    this.inMemoryPrevCloseMap.clear();
    this.lastComputedDate = null;
    this.inProgress = false;
    try {
      const keys = await AsyncStorage.getAllKeys();
      const avgKeys = keys.filter((k) => k.startsWith(AVG_VOLUME_CACHE_PREFIX));
      if (avgKeys.length > 0) {
        await AsyncStorage.multiRemove(avgKeys);
      }
    } catch {}
  }
}

export const avgVolumeService = new AvgVolumeService();
