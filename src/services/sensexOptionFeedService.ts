/**
 * QStrategy — BSE SENSEX 09:20 OOBTST Feed & Evaluation Service
 *
 * Implements the complete specification for SENSEX 09:20 OOBTST (Open Opportunity BTST):
 * 1. Strike Discovery: ₹90 <= Premium <= ₹120, target ₹100.
 * 2. Candidate Ranking: Smallest distance |Premium - 100|, top 2 CE & top 2 PE.
 *    Tie-breaker: tighter valid bid-ask spread, then consistent strike ordering.
 * 3. Exact 09:20:00 AM IST Strike Lock: 90 <= 09:20 Candle Open <= 120, permanent lock for session.
 * 4. 1.5x Directional Breakout Trigger with OCO opposing leg cancellation.
 * 5. 50% Stop-Loss calculated strictly from actual executed price.
 * 6. Overnight BTST Carry (15:30 IST -> BTST_HOLD), next-day 09:15-09:25 AM IST exit.
 * 7. Expiry Safety: Weekly Friday expiry, holiday preponement, and auto-roll to next week on expiry day.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OptionChainFeed, OptionChainRows } from './marketdata/OptionChainFeed';
import {
  RANK_WINDOW_STRIKES,
  OOBTST_LOCK_DELAY_SEC,
  OOBTST_CANDLE_DEADLINE_SEC,
  OOBTST_ZERO_FINAL_SEC,
} from './marketdata/lockFreshness';
import {
  CANDLE_0920_IST_SEC,
  CANDLE_FETCH_RETRY_MS,
  MANUAL_RETRY_WINDOW_MESSAGE,
  RELOCK_TRIGGERED_MESSAGE,
  RELOCK_WINDOW_MESSAGE,
  LockRetry,
  canRetryLock,
  chooseCandleContracts,
  clockAfter0920,
  fetchCandleOpens,
  fetchRetryOpens,
  openAtOrAfter,
  pickFreshInBand,
  zeroIsFinalAfter,
  type CandleContract,
  type CandleOpenState,
  type ManualLockResult,
} from './marketdata/candleOpens';
import { dhanDirectService } from './dhanDirectService';
import { tradingCalendarService } from './TradingCalendarService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { dailyStrategyLockService } from './DailyStrategyLockService';
import { OobtstCandidateStrike, OobtstLiveState, OobtstLegDetail, OobtstLockSource } from '../strategies/types';
import { SENSEX_LOT_SIZE } from '../constants/lotSizes';
import { triggerProgressPct } from '../utils/triggerProgress';

export { SENSEX_LOT_SIZE };
export const SENSEX_STRIKE_STEP = 100;
export const SENSEX_DEFAULT_TARGET_PREMIUM = 100.0;
export const SENSEX_MIN_ELIGIBLE_PREMIUM = 90.0;
export const SENSEX_MAX_ELIGIBLE_PREMIUM = 120.0;

export interface SensexOobtstDayAnchor {
  tradeDate: string; // YYYY-MM-DD
  expiryStr: string;
  ceStrike: number;
  peStrike: number;
  ceOpen0920: number;
  peOpen0920: number;
  ceSecId?: string;
  peSecId?: string;
  ceTriggerPrice: number;
  peTriggerPrice: number;
  activeLeg: 'CE' | 'PE' | null;
  executedPrice: number | null;
  slPrice: number | null;
  isConfirmed: boolean;
  isLockFailed: boolean;
  lockFailureReason?: string;
  /** True while the lock waits for the 09:20 candle opens, so the card shows PROVISIONAL rather than LOCKED. */
  isProvisionalLock?: boolean;
  /** MANUAL_LIVE when the Retry button locked on live prices after the 09:20 candle open could not be had. */
  lockSource?: OobtstLockSource;
  confirmedAt?: string;
  peakPrice: number;
  troughPrice: number;
  /** Highest LTP per leg since the 09:20 lock; a spike between evaluations still triggers. */
  ceArmedHigh?: number;
  peArmedHigh?: number;
  status: 'SCANNING' | 'ARMED' | 'ACTIVE' | 'SL_HIT' | 'BTST_HOLD' | 'LOCK_FAILED';
  entryTime: string | null;
  exitTime: string | null;
  targetPremium: number;
}

function parseIstSeconds(istTimeStr?: string): { istMinutes: number; totalSeconds: number } {
  let istMinutes = 572; // Default ~09:32 AM
  let istSeconds = 0;

  if (istTimeStr) {
    const match = istTimeStr.match(/(\d{1,2}):(\d{2}):?(\d{2})?\s*(AM|PM)?/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = match[3] ? parseInt(match[3], 10) : 0;
      const meridiem = match[4]?.toUpperCase();

      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;

      istMinutes = hours * 60 + minutes;
      istSeconds = seconds;
    }
  } else {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMins = now.getUTCMinutes();
    const istH = (utcHours + 5 + Math.floor((utcMins + 30) / 60)) % 24;
    const istM = (utcMins + 30) % 60;
    istMinutes = istH * 60 + istM;
    istSeconds = now.getUTCSeconds();
  }

  return {
    istMinutes,
    totalSeconds: istMinutes * 60 + istSeconds,
  };
}

export class SensexOptionFeedService {
  private targetPremium: number = SENSEX_DEFAULT_TARGET_PREMIUM;
  private isTargetPremiumLoaded: boolean = false;

  private chainFeed = new OptionChainFeed({
    owner: 'sensex-options',
    underlying: 'SENSEX',
    optionSegment: 'BSE_FNO',
    fallbackSpot: 81000,
    streamWindow: { step: SENSEX_STRIKE_STEP, strikes: RANK_WINDOW_STRIKES },
    resolveExpiryYmd: () => tradingCalendarService.getActiveWeeklySensexExpiry(new Date(), true).expiryDateYMD,
    selectCandidates: (spot) => this.selectTopTwoCandidates(spot),
  });

  // Chain state lives in the shared feed; accessors keep the existing field-style access working.
  private get cachedLiveOptionChain(): OptionChainRows | null {
    return this.chainFeed.chain;
  }
  private set cachedLiveOptionChain(value: OptionChainRows | null) {
    this.chainFeed.chain = value;
  }
  private get lastLiveSpot(): number | null {
    return this.chainFeed.lastSpot;
  }
  private set lastLiveSpot(value: number | null) {
    this.chainFeed.lastSpot = value;
  }
  private get lastOptionChainSyncTime(): number {
    return this.chainFeed.lastSyncTime;
  }
  private set lastOptionChainSyncTime(value: number) {
    this.chainFeed.lastSyncTime = value;
  }
  private cachedAnchor: SensexOobtstDayAnchor | null = null;

  // 09:20 one-minute candle opens per contract ("CE_81000"); 0 is a confirmed no-trade minute, a missing key is unknown.
  private candleOpens0920: CandleOpenState | null = null;
  private candleFetchInflight: Promise<boolean> | null = null;
  private lastCandleFetchAt = 0;
  private lockRetry = new LockRetry();
  private manualLock: { opens: Record<string, number> | null; relock?: boolean } | null = null;
  private manualRetryInflight: Promise<ManualLockResult> | null = null;

  public getTargetPremium(): number {
    return this.targetPremium;
  }

  public async loadSavedTargetPremium(): Promise<number> {
    if (this.isTargetPremiumLoaded) return this.targetPremium;
    try {
      const saved = await AsyncStorage.getItem('@qstrategy_sensex_oobtst_target_premium');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed > 0) {
          this.targetPremium = Number(parsed.toFixed(2));
        }
      }
    } catch {}
    this.isTargetPremiumLoaded = true;
    return this.targetPremium;
  }

  public async setTargetPremium(val: number): Promise<boolean> {
    if (typeof val !== 'number' || isNaN(val) || val <= 0) {
      return false;
    }
    const clean = Number(val.toFixed(2));
    this.targetPremium = clean;
    try {
      await AsyncStorage.setItem('@qstrategy_sensex_oobtst_target_premium', String(clean));
    } catch {}

    // If anchor is not confirmed/locked yet, reset cached provisional anchor so it recalculates with new target
    if (this.cachedAnchor && !this.cachedAnchor.isConfirmed) {
      this.cachedAnchor = null;
    }
    return true;
  }

  public async resetAnchor(clearStorage = false): Promise<void> {
    this.cachedAnchor = null;
    this.candleOpens0920 = null;
    this.lastCandleFetchAt = 0;
    this.lockRetry = new LockRetry();
    this.chainFeed.reset();
    if (clearStorage) {
      try {
        const today = formatDateKeyIST();
        await AsyncStorage.removeItem(`@qstrategy_sensex_oobtst_anchor_${today}`);
      } catch {}
    }
  }

  /**
   * Persists confirmed 09:20 day anchor to SQLite and AsyncStorage across app restarts
   */
  public async persistLockedAnchor(anchor = this.cachedAnchor): Promise<void> {
    if (!anchor || !anchor.isConfirmed || anchor.isLockFailed) return;
    try {
      await AsyncStorage.setItem(`@qstrategy_sensex_oobtst_anchor_${anchor.tradeDate}`, JSON.stringify(anchor));

      await dailyStrategyLockService.saveLock({
        trade_date: anchor.tradeDate,
        strategy_id: 'SENSEX_OOBTST',
        lock_time: anchor.confirmedAt || '09:20:00 IST',
        underlying_symbol: 'SENSEX',
        underlying_spot: this.lastLiveSpot || 81000,
        expiry_str: anchor.expiryStr,
        target_param: anchor.targetPremium,
        ce_strike: anchor.ceStrike,
        ce_symbol: `SENSEX ${anchor.ceStrike} CE`,
        ce_open_price: anchor.ceOpen0920,
        ce_trigger_price: anchor.ceTriggerPrice,
        ce_sec_id: anchor.ceSecId,
        pe_strike: anchor.peStrike,
        pe_symbol: `SENSEX ${anchor.peStrike} PE`,
        pe_open_price: anchor.peOpen0920,
        pe_trigger_price: anchor.peTriggerPrice,
        pe_sec_id: anchor.peSecId,
        execution_side: anchor.activeLeg,
        execution_price: anchor.executedPrice,
        execution_time: anchor.entryTime,
        sl_price: anchor.slPrice,
        status: anchor.status === 'SL_HIT' ? 'SL_HIT' : anchor.activeLeg ? 'TRIGGERED' : 'LOCKED',
        lock_failure_reason: anchor.lockFailureReason,
        raw_payload: JSON.stringify(anchor),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  /**
   * Restores locked 09:20 day anchor from SQLite / AsyncStorage across app restarts
   */
  public async loadPersistedAnchor(dateKey?: string): Promise<SensexOobtstDayAnchor | null> {
    const today = dateKey || formatDateKeyIST();
    // The in-memory anchor carries the armed highs and entry; storage can lag it
    const live = this.cachedAnchor;
    if (live && live.tradeDate === today && live.isConfirmed && !live.isLockFailed) return live;
    try {
      // 1. Try SQLite multi-tier store
      const record = await dailyStrategyLockService.getLock(today, 'SENSEX_OOBTST');
      if (record && record.raw_payload) {
        try {
          const parsed: SensexOobtstDayAnchor = JSON.parse(record.raw_payload);
          if (parsed && parsed.tradeDate === today && parsed.isConfirmed && !parsed.isLockFailed) {
            this.cachedAnchor = parsed;
            return this.cachedAnchor;
          }
        } catch {}

        const reconstructed: SensexOobtstDayAnchor = {
          tradeDate: record.trade_date,
          expiryStr: record.expiry_str,
          ceStrike: record.ce_strike,
          peStrike: record.pe_strike,
          ceOpen0920: record.ce_open_price,
          peOpen0920: record.pe_open_price,
          ceSecId: record.ce_sec_id,
          peSecId: record.pe_sec_id,
          ceTriggerPrice: record.ce_trigger_price || +(record.ce_open_price * 1.5).toFixed(2),
          peTriggerPrice: record.pe_trigger_price || +(record.pe_open_price * 1.5).toFixed(2),
          activeLeg: (record.execution_side as any) || null,
          executedPrice: record.execution_price || null,
          slPrice: record.sl_price || null,
          isConfirmed: true,
          isLockFailed: false,
          peakPrice: record.ce_open_price,
          troughPrice: record.pe_open_price,
          status: (record.status as any) || 'ARMED',
          entryTime: record.execution_time || null,
          exitTime: null,
          targetPremium: record.target_param,
        };
        this.cachedAnchor = reconstructed;
        return reconstructed;
      }

      // 2. Fallback to AsyncStorage
      const json = await AsyncStorage.getItem(`@qstrategy_sensex_oobtst_anchor_${today}`);
      if (json) {
        const parsed: SensexOobtstDayAnchor = JSON.parse(json);
        if (parsed && parsed.tradeDate === today && parsed.isConfirmed && !parsed.isLockFailed) {
          this.cachedAnchor = parsed;
          return this.cachedAnchor;
        }
      }
    } catch {}
    return null;
  }

  public getLastLiveSpot(): number | null {
    return this.chainFeed.lastSpot;
  }

  public getQuoteFreshness(): 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED' {
    return this.chainFeed.getQuoteFreshness();
  }

  /**
   * Syncs live SENSEX option chain directly from Dhan HQ API (/v2/optionchain)
   */
  public syncLiveOptionChain(): Promise<boolean> {
    return this.chainFeed.sync();
  }

  public updateOptionPriceFromTick(
    securityId: string,
    ltp: number,
    bid?: number,
    ask?: number
  ): void {
    this.chainFeed.updateFromTick(securityId, ltp, bid, ask);
  }

  /**
   * Evaluates the two CE and two PE strikes closest to target premium.
   * Premium eligibility rule: ₹90 <= Premium <= ₹120.
   * Candidate ranking rule: abs(Premium - targetPremium).
   * Tie-breaker:
   * 1. Tighter valid bid-ask spread
   * 2. Consistent strike ordering (CE: lower strike first; PE: higher strike first)
   */
  public selectTopTwoCandidates(
    spot: number,
    target: number = this.targetPremium
  ): {
    ceCandidates: OobtstCandidateStrike[];
    peCandidates: OobtstCandidateStrike[];
    previewAvailable: boolean;
  } {
    const nowMs = Date.now();
    const { expiryStr } = tradingCalendarService.getActiveWeeklySensexExpiry(new Date(), true);
    const atm = Math.round(spot / SENSEX_STRIKE_STEP) * SENSEX_STRIKE_STEP;

    interface CandidateInternal {
      strike: number;
      type: 'CE' | 'PE';
      symbol: string;
      ltp: number;
      diffFromTarget: number;
      bidAskSpread: number;
      quoteTimestamp: string;
      quoteAgeMs: number;
      isStale: boolean;
      securityId?: string;
    }

    const eligibleCe: CandidateInternal[] = [];
    const eligiblePe: CandidateInternal[] = [];

    if (this.cachedLiveOptionChain && Object.keys(this.cachedLiveOptionChain).length > 0) {
      for (const [strikeStr, data] of Object.entries(this.cachedLiveOptionChain)) {
        const strike = parseInt(strikeStr, 10);
        if (isNaN(strike)) continue;

        // CE check: ₹90 <= premium <= ₹120
        if (data.ceLtp >= SENSEX_MIN_ELIGIBLE_PREMIUM && data.ceLtp <= SENSEX_MAX_ELIGIBLE_PREMIUM) {
          const ageMs = nowMs - (data.ceUpdatedTime || this.lastOptionChainSyncTime || nowMs);
          const diff = Number(Math.abs(data.ceLtp - target).toFixed(2));
          const spread = data.ceBid && data.ceAsk ? Math.abs(data.ceAsk - data.ceBid) : 999;
          eligibleCe.push({
            strike,
            type: 'CE',
            symbol: `SENSEX ${strike} CE`,
            ltp: data.ceLtp,
            diffFromTarget: diff,
            bidAskSpread: spread,
            quoteTimestamp: data.ceUpdatedTime ? new Date(data.ceUpdatedTime).toLocaleTimeString('en-IN') : 'Cached',
            quoteAgeMs: ageMs,
            isStale: ageMs > 15000,
            securityId: data.ceSecId,
          });
        }

        // PE check: ₹90 <= premium <= ₹120
        if (data.peLtp >= SENSEX_MIN_ELIGIBLE_PREMIUM && data.peLtp <= SENSEX_MAX_ELIGIBLE_PREMIUM) {
          const ageMs = nowMs - (data.peUpdatedTime || this.lastOptionChainSyncTime || nowMs);
          const diff = Number(Math.abs(data.peLtp - target).toFixed(2));
          const spread = data.peBid && data.peAsk ? Math.abs(data.peAsk - data.peBid) : 999;
          eligiblePe.push({
            strike,
            type: 'PE',
            symbol: `SENSEX ${strike} PE`,
            ltp: data.peLtp,
            diffFromTarget: diff,
            bidAskSpread: spread,
            quoteTimestamp: data.peUpdatedTime ? new Date(data.peUpdatedTime).toLocaleTimeString('en-IN') : 'Cached',
            quoteAgeMs: ageMs,
            isStale: ageMs > 15000,
            securityId: data.peSecId,
          });
        }
      }
    }

    // Sort CE candidates:
    // 1. diffFromTarget ascending
    // 2. bidAskSpread ascending (tighter spread wins)
    // 3. strike ascending (lower strike first)
    eligibleCe.sort((a, b) => {
      if (Math.abs(a.diffFromTarget - b.diffFromTarget) > 0.001) {
        return a.diffFromTarget - b.diffFromTarget;
      }
      if (Math.abs(a.bidAskSpread - b.bidAskSpread) > 0.01) {
        return a.bidAskSpread - b.bidAskSpread;
      }
      return a.strike - b.strike;
    });

    // Sort PE candidates:
    // 1. diffFromTarget ascending
    // 2. bidAskSpread ascending (tighter spread wins)
    // 3. strike descending (higher strike first)
    eligiblePe.sort((a, b) => {
      if (Math.abs(a.diffFromTarget - b.diffFromTarget) > 0.001) {
        return a.diffFromTarget - b.diffFromTarget;
      }
      if (Math.abs(a.bidAskSpread - b.bidAskSpread) > 0.01) {
        return a.bidAskSpread - b.bidAskSpread;
      }
      return b.strike - a.strike;
    });

    const ceCandidates: OobtstCandidateStrike[] = eligibleCe.slice(0, 2).map((c, idx) => ({
      rank: (idx + 1) as 1 | 2,
      type: 'CE',
      strike: c.strike,
      symbol: c.symbol,
      ltp: c.ltp,
      diffFromTarget: c.diffFromTarget,
      quoteTimestamp: c.quoteTimestamp,
      quoteAgeMs: c.quoteAgeMs,
      isStale: c.isStale,
      securityId: c.securityId,
    }));

    const peCandidates: OobtstCandidateStrike[] = eligiblePe.slice(0, 2).map((c, idx) => ({
      rank: (idx + 1) as 1 | 2,
      type: 'PE',
      strike: c.strike,
      symbol: c.symbol,
      ltp: c.ltp,
      diffFromTarget: c.diffFromTarget,
      quoteTimestamp: c.quoteTimestamp,
      quoteAgeMs: c.quoteAgeMs,
      isStale: c.isStale,
      securityId: c.securityId,
    }));

    const previewAvailable = ceCandidates.length > 0 && peCandidates.length > 0;
    return { ceCandidates, peCandidates, previewAvailable };
  }

  /** True once every contract being fetched has an answer for today's 09:20 candle. */
  public hasCandleOpens0920(): boolean {
    const state = this.candleOpens0920;
    return !!state && state.date === formatDateKeyIST() && state.pending === 0 && Object.keys(state.opens).length > 0;
  }

  /**
   * Reads the 09:20 candle open of the contracts that can matter from Dhan's intraday API: those whose live price is
   * near the band first, and every contract in the window after a retry or once the 09:20 minute has closed.
   */
  public refreshCandleOpens0920(spot: number, zerosFinal = false): Promise<boolean> {
    if (this.candleFetchInflight) return this.candleFetchInflight;
    if (this.hasCandleOpens0920()) return Promise.resolve(true);
    if (Date.now() - this.lastCandleFetchAt < CANDLE_FETCH_RETRY_MS) return Promise.resolve(false);
    this.lastCandleFetchAt = Date.now();
    this.candleFetchInflight = this.fetchCandleOpens0920(spot, zerosFinal).finally(() => {
      this.candleFetchInflight = null;
    });
    return this.candleFetchInflight;
  }

  /** A retry looks at every contract in the window, so the lock waits for those answers before it decides again. */
  private widenCandleSearch(): void {
    if (this.candleOpens0920) this.candleOpens0920.pending = Math.max(1, this.candleOpens0920.pending);
    this.lastCandleFetchAt = 0;
  }

  /** Every contract in the ranking window that has a security id. */
  private windowContracts(spot: number): CandleContract[] {
    const reach = RANK_WINDOW_STRIKES * SENSEX_STRIKE_STEP;
    const all: CandleContract[] = [];
    for (const [strike, row] of Object.entries(this.cachedLiveOptionChain ?? {})) {
      if (Math.abs(Number(strike) - spot) > reach) continue;
      if (row.ceSecId) all.push({ key: `CE_${strike}`, secId: String(row.ceSecId), liveLtp: row.ceLtp });
      if (row.peSecId) all.push({ key: `PE_${strike}`, secId: String(row.peSecId), liveLtp: row.peLtp });
    }
    return all;
  }

  private async fetchCandleOpens0920(spot: number, zerosFinal: boolean): Promise<boolean> {
    const chain = this.cachedLiveOptionChain;
    if (!chain) return false;
    const today = formatDateKeyIST();
    if (!this.candleOpens0920 || this.candleOpens0920.date !== today) {
      this.candleOpens0920 = { date: today, opens: {}, pending: 0 };
    }
    const contracts = chooseCandleContracts(
      this.windowContracts(spot),
      { min: SENSEX_MIN_ELIGIBLE_PREMIUM, max: SENSEX_MAX_ELIGIBLE_PREMIUM },
      this.targetPremium,
      this.lockRetry.wide || zerosFinal
    );
    const from = `${today} 09:20:00`;
    const to = `${today} 09:21:00`;
    return fetchCandleOpens({
      state: this.candleOpens0920,
      contracts,
      load: (secId) => dhanDirectService.fetchHistoricalIntraday(secId, from, to, 'BSE_FNO', 'OPTIDX', '1'),
      zeroIsFinal: zerosFinal,
    });
  }

  /** Five candle opens closest to the target, in or out of band, so a failed lock can be diagnosed. */
  private topOpens(
    type: 'CE' | 'PE',
    opens: Record<string, number> = this.candleOpens0920?.opens ?? {}
  ): Array<{ strike: number; open: number }> {
    return Object.entries(opens)
      .filter(([key, open]) => key.startsWith(`${type}_`) && open > 0)
      .map(([key, open]) => ({ strike: Number(key.slice(3)), open }))
      .sort((a, b) => Math.abs(a.open - this.targetPremium) - Math.abs(b.open - this.targetPremium))
      .slice(0, 5);
  }

  /**
   * Ranks contracts by the 09:20 candle open against the target premium. Only opens inside ₹90–₹120 can win.
   * Ties go to the lower strike for CE and the higher strike for PE.
   */
  private selectCandleOpenCandidates(
    opens: Record<string, number> = this.candleOpens0920?.opens ?? {}
  ): { ceCandidates: OobtstCandidateStrike[]; peCandidates: OobtstCandidateStrike[] } {
    const chain = this.cachedLiveOptionChain ?? {};
    const rank = (type: 'CE' | 'PE'): OobtstCandidateStrike[] => {
      const list: Array<{ strike: number; open: number; diff: number; secId?: string }> = [];
      for (const [strikeStr, row] of Object.entries(chain)) {
        const strike = Number(strikeStr);
        const open = opens[`${type}_${strike}`];
        if (!(open >= SENSEX_MIN_ELIGIBLE_PREMIUM && open <= SENSEX_MAX_ELIGIBLE_PREMIUM)) continue;
        list.push({ strike, open, diff: Math.abs(open - this.targetPremium), secId: type === 'CE' ? row.ceSecId : row.peSecId });
      }
      list.sort((a, b) => {
        if (Math.abs(a.diff - b.diff) > 0.001) return a.diff - b.diff;
        return type === 'CE' ? a.strike - b.strike : b.strike - a.strike;
      });
      return list.slice(0, 2).map((item, idx) => ({
        rank: (idx + 1) as 1 | 2,
        type,
        strike: item.strike,
        symbol: `SENSEX ${item.strike} ${type}`,
        ltp: item.open,
        diffFromTarget: Number(item.diff.toFixed(2)),
        quoteTimestamp: '09:20 candle open',
        quoteAgeMs: 0,
        isStale: false,
        securityId: item.secId,
      }));
    };
    return { ceCandidates: rank('CE'), peCandidates: rank('PE') };
  }

  private lastLockFailureLogged = '';

  private logLockFailure(reason: string): void {
    if (reason === this.lastLockFailureLogged) return;
    this.lastLockFailureLogged = reason;
    console.warn('[SENSEX OOBTST] 09:20 lock failed:', reason, JSON.stringify({ ce: this.topOpens('CE'), pe: this.topOpens('PE') }));
  }

  /**
   * Captures or initializes the 09:20 day anchor.
   * Invariants:
   * 1. Market Closed (< 09:15): Strikes unlocked, labeled PREVIEW — NOT CONFIRMED (or PREVIEW UNAVAILABLE).
   * 2. Provisional (09:15 - 09:20:04): Top two CE and PE candidates update dynamically from live ticks.
   * 3. 09:20:05 Lock: Selects the single CE and PE whose 09:20 candle open is closest to the target within ₹90-₹120,
   *    and locks permanently for session. Never replaces a locked strike.
   *    A failed lock is retried 30 s later, until 09:21:00. If the candle opens stay unavailable the lock fails.
   */
  public getOrCreateDayAnchor(spot: number, istTimeStr?: string): SensexOobtstDayAnchor {
    const today = formatDateKeyIST();
    const { expiryStr } = tradingCalendarService.getActiveWeeklySensexExpiry(new Date(), true);
    const { totalSeconds } = parseIstSeconds(istTimeStr);

    const gate0915 = 9 * 3600 + 15 * 60; // 09:15:00 AM
    const gate0920 = 9 * 3600 + 20 * 60; // 09:20:00 AM

    const isMarketClosed = totalSeconds < gate0915;
    const isProvisional = totalSeconds >= gate0915 && totalSeconds < gate0920;
    const isConfirmationTime = totalSeconds >= gate0920;

    // If anchor was already confirmed today at or after 09:20:00, it is permanently locked for today's session
    if (
      this.cachedAnchor &&
      this.cachedAnchor.tradeDate === today &&
      this.cachedAnchor.expiryStr === expiryStr &&
      this.cachedAnchor.isConfirmed &&
      !this.cachedAnchor.isLockFailed &&
      !this.manualLock
    ) {
      return this.cachedAnchor;
    }

    const live = this.selectTopTwoCandidates(spot, this.targetPremium);
    let ceCandidates = live.ceCandidates;
    let peCandidates = live.peCandidates;

    let isConfirmed = false;
    let isLockFailed = false;
    let isProvisionalLock = false;
    let lockFailureReason: string | undefined = undefined;
    let lockSource: OobtstLockSource | undefined;
    let confirmedAt: string | undefined;

    if (isConfirmationTime) {
      const secsPast = totalSeconds - gate0920;
      this.lockRetry.sync(today);
      if (this.manualLock) {
        // The Retry button locks on the 09:20 (else 09:21) candle open when it could be read, otherwise on prices fetched just now.
        const band = { min: SENSEX_MIN_ELIGIBLE_PREMIUM, max: SENSEX_MAX_ELIGIBLE_PREMIUM };
        const opens = this.manualLock.opens;
        const fromCandle = opens ? this.selectCandleOpenCandidates(opens) : null;
        const ce = pickFreshInBand(live.ceCandidates, band);
        const pe = pickFreshInBand(live.peCandidates, band);
        if (fromCandle && fromCandle.ceCandidates.length > 0 && fromCandle.peCandidates.length > 0) {
          ceCandidates = fromCandle.ceCandidates;
          peCandidates = fromCandle.peCandidates;
          isConfirmed = true;
          lockSource = 'MANUAL_CANDLE';
          confirmedAt = `${clockAfter0920(secsPast)} IST`;
        } else if (ce && pe) {
          ceCandidates = [{ ...ce, rank: 1 }];
          peCandidates = [{ ...pe, rank: 1 }];
          isConfirmed = true;
          lockSource = 'MANUAL_LIVE';
          confirmedAt = `${clockAfter0920(secsPast)} IST`;
        } else {
          isLockFailed = true;
          lockFailureReason = this.manualLock.relock
            ? `Re-lock found no ${ce ? 'PE' : 'CE'} priced ₹${SENSEX_MIN_ELIGIBLE_PREMIUM}–₹${SENSEX_MAX_ELIGIBLE_PREMIUM} right now. The current lock is unchanged.`
            : `Retry found no ${ce ? 'PE' : 'CE'} priced ₹${SENSEX_MIN_ELIGIBLE_PREMIUM}–₹${SENSEX_MAX_ELIGIBLE_PREMIUM} on the 09:20/09:21 candle or right now.`;
        }
      } else if (secsPast < OOBTST_LOCK_DELAY_SEC) {
        // The lock waits until 09:20:05 so the 09:20 candle has opened and its open is final.
        isProvisionalLock = true;
      } else {
        // A failed lock is retried 30 s later, until 09:21:00; the retry looks at every contract in the window.
        if (this.lockRetry.due(secsPast)) this.widenCandleSearch();
        if (this.hasCandleOpens0920()) {
          // The premium is the 09:20 candle open, not the live price at the moment the lock happens to run.
          const fromCandle = this.selectCandleOpenCandidates();
          ceCandidates = fromCandle.ceCandidates;
          peCandidates = fromCandle.peCandidates;
          if (ceCandidates.length > 0 && peCandidates.length > 0) {
            isConfirmed = true;
          } else {
            isLockFailed = true;
            lockFailureReason =
              `No ${ceCandidates.length === 0 ? 'CE' : 'PE'} with a 09:20 candle open in ₹${SENSEX_MIN_ELIGIBLE_PREMIUM}–₹${SENSEX_MAX_ELIGIBLE_PREMIUM}.` +
              this.lockRetry.onFailure(secsPast);
            this.logLockFailure(lockFailureReason);
          }
        } else if (secsPast < OOBTST_CANDLE_DEADLINE_SEC) {
          // Keep showing the live preview while the 09:20 candle opens are being fetched.
          isProvisionalLock = true;
        } else {
          isLockFailed = true;
          lockFailureReason = 'Sensex 09:20 candle open unavailable';
          this.logLockFailure(lockFailureReason);
        }
        // Past the failure point the fetch keeps going, so a late answer still locks the correct strikes.
        if (!isConfirmed) void this.refreshCandleOpens0920(spot, secsPast >= OOBTST_ZERO_FINAL_SEC);
      }
    }

    const rank1Ce = ceCandidates.length > 0 ? ceCandidates[0] : null;
    const rank1Pe = peCandidates.length > 0 ? peCandidates[0] : null;

    const atm = Math.round(spot / SENSEX_STRIKE_STEP) * SENSEX_STRIKE_STEP;
    const ceStrike = rank1Ce ? rank1Ce.strike : atm + 500;
    const peStrike = rank1Pe ? rank1Pe.strike : atm - 500;

    // Once confirmed this is the 09:20 candle open; before that it is the live preview price.
    const ceOpen = rank1Ce ? rank1Ce.ltp : 0;
    const peOpen = rank1Pe ? rank1Pe.ltp : 0;

    const ceTrigger = Number((ceOpen * 1.5).toFixed(2));
    const peTrigger = Number((peOpen * 1.5).toFixed(2));

    const anchor: SensexOobtstDayAnchor = {
      tradeDate: today,
      expiryStr,
      ceStrike,
      peStrike,
      ceOpen0920: ceOpen,
      peOpen0920: peOpen,
      ceSecId: rank1Ce?.securityId,
      peSecId: rank1Pe?.securityId,
      ceTriggerPrice: ceTrigger,
      peTriggerPrice: peTrigger,
      activeLeg: null,
      executedPrice: null,
      slPrice: null,
      isConfirmed,
      isLockFailed,
      lockFailureReason,
      isProvisionalLock,
      lockSource: isConfirmed ? (lockSource ?? 'CANDLE_OPEN_0920') : undefined,
      confirmedAt: isConfirmed ? confirmedAt : undefined,
      peakPrice: 0,
      troughPrice: 99999,
      status: isLockFailed ? 'LOCK_FAILED' : (isConfirmed ? 'ARMED' : 'SCANNING'),
      entryTime: null,
      exitTime: null,
      targetPremium: this.targetPremium,
    };

    if (isConfirmed && !isLockFailed) {
      this.cachedAnchor = anchor;
      this.persistLockedAnchor(anchor);
    }

    return anchor;
  }

  /**
   * Retry button after a failed lock: locks on the 09:20 candle open (else the 09:21 one) when Dhan returns it, and
   * otherwise on the latest prices at this moment. Either way the strikes must sit inside ₹90–₹120 and the
   * 1.5x trigger comes from the locked price.
   */
  public retryLock(spot: number, istTimeStr?: string): Promise<ManualLockResult> {
    if (!this.manualRetryInflight) {
      this.manualRetryInflight = this.runManualRetry(spot, istTimeStr).finally(() => {
        this.manualRetryInflight = null;
      });
    }
    return this.manualRetryInflight;
  }

  private async runManualRetry(spot: number, istTimeStr?: string): Promise<ManualLockResult> {
    const held = this.cachedAnchor;
    if (held && held.tradeDate === formatDateKeyIST() && held.isConfirmed && !held.isLockFailed) {
      return { ok: true, message: 'Already locked for today.' };
    }
    const { totalSeconds } = parseIstSeconds(istTimeStr);
    if (!canRetryLock(totalSeconds)) {
      return { ok: false, message: MANUAL_RETRY_WINDOW_MESSAGE };
    }
    const synced = await this.syncLiveOptionChain().catch(() => false);
    if (!synced) return { ok: false, message: 'Could not fetch the latest option prices. Check the connection and retry.' };

    const liveSpot = spot > 0 ? spot : this.lastLiveSpot ?? 0;
    const today = formatDateKeyIST();
    const opens = await fetchRetryOpens({
      contracts: chooseCandleContracts(
        this.windowContracts(liveSpot),
        { min: SENSEX_MIN_ELIGIBLE_PREMIUM, max: SENSEX_MAX_ELIGIBLE_PREMIUM },
        this.targetPremium,
        true
      ),
      load: (secId) =>
        dhanDirectService.fetchHistoricalIntraday(secId, `${today} 09:20:00`, `${today} 09:22:00`, 'BSE_FNO', 'OPTIDX', '1'),
      pick: openAtOrAfter(CANDLE_0920_IST_SEC),
      zeroIsFinal: zeroIsFinalAfter(totalSeconds, CANDLE_0920_IST_SEC),
    });

    this.manualLock = { opens };
    let anchor: SensexOobtstDayAnchor;
    try {
      anchor = this.getOrCreateDayAnchor(liveSpot, istTimeStr);
    } finally {
      this.manualLock = null;
    }
    if (!anchor.isConfirmed) return { ok: false, message: anchor.lockFailureReason ?? 'Retry failed: no usable prices.' };
    const basis = anchor.lockSource === 'MANUAL_CANDLE' ? 'the 09:20/09:21 candle open' : 'live prices';
    return { ok: true, message: `Locked at ${anchor.confirmedAt} on ${basis}.` };
  }

  /**
   * Re-lock button on a locked strategy: refetches the option chain, selects the strikes by the usual rules from the
   * latest prices and locks on them. Refused once a leg has triggered; a failed re-lock leaves the current lock in place.
   */
  public relock(spot: number, istTimeStr?: string): Promise<ManualLockResult> {
    if (!this.manualRetryInflight) {
      this.manualRetryInflight = this.runRelock(spot, istTimeStr).finally(() => {
        this.manualRetryInflight = null;
      });
    }
    return this.manualRetryInflight;
  }

  private async runRelock(spot: number, istTimeStr?: string): Promise<ManualLockResult> {
    const held = this.cachedAnchor;
    if (!held || held.tradeDate !== formatDateKeyIST() || !held.isConfirmed || held.isLockFailed) {
      return { ok: false, message: 'Nothing to re-lock yet. Use Retry lock once the lock has failed.' };
    }
    const { totalSeconds } = parseIstSeconds(istTimeStr);
    if (!canRetryLock(totalSeconds)) return { ok: false, message: RELOCK_WINDOW_MESSAGE };
    if (this.isOobtstTriggered(held)) return { ok: false, message: RELOCK_TRIGGERED_MESSAGE };
    const synced = await this.syncLiveOptionChain().catch(() => false);
    if (!synced) return { ok: false, message: 'Could not fetch the latest option prices. Check the connection and retry.' };
    // The trade may have triggered while the chain was being fetched
    if (this.isOobtstTriggered(held)) return { ok: false, message: RELOCK_TRIGGERED_MESSAGE };

    const liveSpot = spot > 0 ? spot : this.lastLiveSpot ?? 0;
    this.manualLock = { opens: null, relock: true };
    let anchor: SensexOobtstDayAnchor;
    try {
      anchor = this.getOrCreateDayAnchor(liveSpot, istTimeStr);
    } finally {
      this.manualLock = null;
    }
    if (!anchor.isConfirmed) {
      this.cachedAnchor = held;
      return { ok: false, message: anchor.lockFailureReason ?? 'Re-lock failed: no usable prices.' };
    }
    return { ok: true, message: `Re-locked at ${anchor.confirmedAt} on live prices.` };
  }

  /** True once a leg has been entered or either leg has reached its 1.5x trigger. */
  private isOobtstTriggered(anchor: SensexOobtstDayAnchor): boolean {
    if (anchor.activeLeg) return true;
    const ceHigh = Math.max(anchor.ceArmedHigh ?? 0, this.getLiveOptionPrice(anchor.ceStrike, 'CE'));
    const peHigh = Math.max(anchor.peArmedHigh ?? 0, this.getLiveOptionPrice(anchor.peStrike, 'PE'));
    return (anchor.ceTriggerPrice > 0 && ceHigh >= anchor.ceTriggerPrice) || (anchor.peTriggerPrice > 0 && peHigh >= anchor.peTriggerPrice);
  }

  /**
   * Main evaluation method returning standardized OobtstLiveState
   */
  public evaluateSensexOobtst(spot: number, istTimeStr?: string): OobtstLiveState {
    const { istMinutes, totalSeconds } = parseIstSeconds(istTimeStr);
    const gate0915 = 9 * 3600 + 15 * 60; // 09:15:00 AM
    const gate0920 = 9 * 3600 + 20 * 60; // 09:20:00 AM
    const gate1530 = 15 * 3600 + 30 * 60; // 15:30:00 PM

    const isMarketClosed = totalSeconds < gate0915 || totalSeconds >= gate1530;
    const isConfirmationTime = totalSeconds >= gate0920;

    const anchor = this.getOrCreateDayAnchor(spot, istTimeStr);
    // Also provisional while the lock waits for the 09:20 candle opens, so the card does not claim a lock it has not taken.
    const isProvisional = (totalSeconds >= gate0915 && totalSeconds < gate0920) || Boolean(anchor.isProvisionalLock);
    const { ceCandidates, peCandidates, previewAvailable } = this.selectTopTwoCandidates(spot, this.targetPremium);
    const { expiryStr, daysToExpiry } = tradingCalendarService.getActiveWeeklySensexExpiry(new Date(), true);

    const ceLtp = this.getLiveOptionPrice(anchor.ceStrike, 'CE') || anchor.ceOpen0920;
    const peLtp = this.getLiveOptionPrice(anchor.peStrike, 'PE') || anchor.peOpen0920;

    let status: 'SCANNING' | 'ARMED' | 'ACTIVE' | 'SL_HIT' | 'BTST_HOLD' | 'LOCK_FAILED' = anchor.status;
    let activeLeg = anchor.activeLeg;
    let executedSymbol: string | undefined = undefined;
    let executedPrice = anchor.executedPrice ?? undefined;
    let slPrice = anchor.slPrice ?? undefined;
    let statusBadgeText = 'SCANNING';

    // Step progression & Breakout Evaluation
    let currentStep: 1 | 2 | 3 = 1;

    if (anchor.isLockFailed) {
      currentStep = 1;
      status = 'LOCK_FAILED';
      statusBadgeText = 'LOCK FAILED — DATA UNAVAILABLE';
    } else if (isMarketClosed && !isConfirmationTime) {
      currentStep = 1;
      status = 'SCANNING';
      statusBadgeText = previewAvailable ? 'PREVIEW — NOT CONFIRMED' : 'PREVIEW UNAVAILABLE';
    } else if (isProvisional) {
      currentStep = 1;
      status = 'SCANNING';
      statusBadgeText = 'PROVISIONAL — NOT LOCKED';
    } else if (isConfirmationTime) {
      // Step 2: LOCKED / ARMED_1.5X
      currentStep = 2;
      status = 'ARMED';
      statusBadgeText = 'LOCKED / ARMED_1.5X';

      // The high keeps rising after entry too, so Day High never falls behind the live price
      const prevCeHigh = anchor.ceArmedHigh ?? 0;
      const prevPeHigh = anchor.peArmedHigh ?? 0;
      const ceArmedHigh = Math.max(prevCeHigh, ceLtp);
      const peArmedHigh = Math.max(prevPeHigh, peLtp);
      anchor.ceArmedHigh = ceArmedHigh;
      anchor.peArmedHigh = peArmedHigh;
      if (ceArmedHigh > prevCeHigh || peArmedHigh > prevPeHigh) {
        this.persistLockedAnchor(anchor);
      }
      this.chainFeed.pin([
        { strike: anchor.ceStrike, type: 'CE' },
        { strike: anchor.peStrike, type: 'PE' },
      ]);

      // Check Directional Breakout Trigger under OCO
      if (!activeLeg) {
        const ceCrossed = anchor.ceTriggerPrice > 0 && ceArmedHigh >= anchor.ceTriggerPrice;
        const peCrossed = anchor.peTriggerPrice > 0 && peArmedHigh >= anchor.peTriggerPrice;

        if (ceCrossed && peCrossed) {
          // Simultaneous cross tie-breaker: larger percentage breakout over trigger
          const cePct = (ceArmedHigh - anchor.ceTriggerPrice) / anchor.ceTriggerPrice;
          const pePct = (peArmedHigh - anchor.peTriggerPrice) / anchor.peTriggerPrice;
          activeLeg = cePct >= pePct ? 'CE' : 'PE';
        } else if (ceCrossed) {
          activeLeg = 'CE';
        } else if (peCrossed) {
          activeLeg = 'PE';
        }

        if (activeLeg) {
          anchor.activeLeg = activeLeg;
          anchor.entryTime = istTimeStr || new Date().toLocaleTimeString('en-IN');
          const legLtp = activeLeg === 'CE' ? ceLtp : peLtp;
          const legTrigger = activeLeg === 'CE' ? anchor.ceTriggerPrice : anchor.peTriggerPrice;
          executedPrice = legLtp >= legTrigger ? legLtp : legTrigger;
          anchor.executedPrice = executedPrice;
          slPrice = Number((executedPrice * 0.5).toFixed(2));
          anchor.slPrice = slPrice;
          anchor.peakPrice = executedPrice;
          anchor.status = 'ACTIVE';
          this.persistLockedAnchor(anchor);
        }
      }

      if (activeLeg && executedPrice && slPrice) {
        currentStep = 3;
        executedSymbol = activeLeg === 'CE' ? `SENSEX ${anchor.ceStrike} CE` : `SENSEX ${anchor.peStrike} PE`;
        const currentTradedPrice = activeLeg === 'CE' ? ceLtp : peLtp;

        let boundsChanged = false;
        if (currentTradedPrice > anchor.peakPrice) {
          anchor.peakPrice = currentTradedPrice;
          boundsChanged = true;
        }
        if (currentTradedPrice < anchor.troughPrice && currentTradedPrice > 0) {
          anchor.troughPrice = currentTradedPrice;
          boundsChanged = true;
        }

        // Check 50% Stop-Loss Hit
        if (currentTradedPrice <= slPrice) {
          status = 'SL_HIT';
          anchor.status = 'SL_HIT';
          anchor.exitTime = istTimeStr || new Date().toLocaleTimeString('en-IN');
          statusBadgeText = 'SL_HIT';
          this.persistLockedAnchor(anchor);
        } else if (totalSeconds >= gate1530) {
          // BTST Hold: Position survived until 15:30 IST
          status = 'BTST_HOLD';
          anchor.status = 'BTST_HOLD';
          statusBadgeText = 'BTST_HOLD';
          this.persistLockedAnchor(anchor);
        } else {
          status = 'ACTIVE';
          statusBadgeText = activeLeg === 'CE' ? 'EXECUTED_CE' : 'EXECUTED_PE';
          if (boundsChanged) {
            this.persistLockedAnchor(anchor);
          }
        }
      }
    }

    const ceHigh = anchor.ceArmedHigh ?? ceLtp;
    const peHigh = anchor.peArmedHigh ?? peLtp;
    const ceProgressPct = triggerProgressPct(ceHigh, anchor.ceTriggerPrice);
    const peProgressPct = triggerProgressPct(peHigh, anchor.peTriggerPrice);

    const ceLeg: OobtstLegDetail = {
      type: 'CE',
      strike: anchor.ceStrike,
      symbol: `SENSEX ${anchor.ceStrike} CE`,
      openPrice: anchor.ceOpen0920,
      triggerPrice: anchor.ceTriggerPrice,
      currentLtp: ceLtp,
      progressPct: ceProgressPct,
      armedHigh: ceHigh,
      dayHigh: Math.max(this.getLiveDayHigh(anchor.ceStrike, 'CE'), ceHigh, ceLtp),
      status: activeLeg === 'CE' ? 'EXECUTED' : (activeLeg === 'PE' ? 'DISABLED' : (status === 'SL_HIT' ? 'SL_HIT' : 'ARMED')),
      isProvisional,
    };

    const peLeg: OobtstLegDetail = {
      type: 'PE',
      strike: anchor.peStrike,
      symbol: `SENSEX ${anchor.peStrike} PE`,
      openPrice: anchor.peOpen0920,
      triggerPrice: anchor.peTriggerPrice,
      currentLtp: peLtp,
      progressPct: peProgressPct,
      armedHigh: peHigh,
      dayHigh: Math.max(this.getLiveDayHigh(anchor.peStrike, 'PE'), peHigh, peLtp),
      status: activeLeg === 'PE' ? 'EXECUTED' : (activeLeg === 'CE' ? 'DISABLED' : (status === 'SL_HIT' ? 'SL_HIT' : 'ARMED')),
      isProvisional,
    };

    let pnlPerShare = 0;
    let pnlPerLot = 0;
    let riskPerLot = 0;

    if (executedPrice && slPrice) {
      const currentPrice = activeLeg === 'CE' ? ceLtp : peLtp;
      pnlPerShare = Number((currentPrice - executedPrice).toFixed(2));
      pnlPerLot = Number((pnlPerShare * SENSEX_LOT_SIZE).toFixed(2));
      riskPerLot = Number(((executedPrice - slPrice) * SENSEX_LOT_SIZE).toFixed(2));
    }

    return {
      currentStep,
      status,
      statusBadgeText,
      expiryDate: expiryStr,
      daysToExpiry,
      niftySpot: spot, // holds index spot
      anchorTime: anchor.lockSource?.startsWith('MANUAL') && anchor.confirmedAt ? anchor.confirmedAt : '09:20:00 IST',
      isLocked: anchor.isConfirmed && !anchor.isLockFailed,
      isProvisional,
      isMarketClosed,
      isLockFailed: anchor.isLockFailed,
      lockFailureReason: anchor.lockFailureReason,
      lockSource: anchor.isConfirmed ? anchor.lockSource : undefined,
      previewAvailable,
      targetPremium: this.targetPremium,
      ceCandidates,
      peCandidates,
      ceLeg,
      peLeg,
      activeLeg,
      executedSymbol,
      executedPrice,
      slPrice,
      riskPerLot,
      pnlPerShare,
      pnlPerLot,
      lastUpdated: istTimeStr || new Date().toLocaleTimeString('en-IN'),
      quoteFreshness: this.getQuoteFreshness(),
    };
  }

  public getLiveOptionPrice(strike: number, type: 'CE' | 'PE'): number {
    return this.chainFeed.getLiveOptionPrice(strike, type);
  }

  public getLiveDayHigh(strike: number, type: 'CE' | 'PE'): number {
    return this.chainFeed.getDayHigh(strike, type);
  }
}

export const sensexOptionFeedService = new SensexOptionFeedService();
