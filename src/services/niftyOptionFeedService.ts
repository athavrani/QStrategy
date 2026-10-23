// =====================================================================
// QStrategy — Institutional NIFTY Option Feed & OOBTST Strategy Engine
// Real-time Multi-Tier Option Feed, Black-Scholes Pricing & OOBTST State
// Mathematical invariants: Anchor ~62.50, 1.5x Dual Breakout, 50% SL, OCO
// =====================================================================

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OobtstLiveState, OobtstLegDetail, OobtstCandidateStrike } from '../strategies/types';
import { NiftyBreakout180State, Candidate180Contract } from '../types/mobile';
import { dhanDirectService } from './dhanDirectService';
import { marketData } from './marketdata/MarketDataService';
import { OptionChainFeed, OptionChainRows } from './marketdata/OptionChainFeed';
import { assessLockFreshness, RANK_WINDOW_STRIKES } from './marketdata/lockFreshness';
import { getAdjustedExpiryDate, formatDateKey, formatDateKeyIST } from '../constants/nseHolidays';
import { dailyStrategyLockService } from './DailyStrategyLockService';
import { NIFTY_LOT_SIZE } from '../constants/lotSizes';
import { triggerProgressPct } from '../utils/triggerProgress';

const NIFTY_STRIKE_STEP = 50;
const ANCHOR_TARGET_PREMIUM = 62.50;

/**
 * Computes current active weekly Tuesday expiry date, remaining time, and holiday preponements.
 * Source: NSE Circulars NSE/FAOP/68685 & NSE/CMTR/71775
 * 
 * Rules:
 * 1. NIFTY Weekly options expire every Tuesday (shifted from Thursday per NSE circular).
 * 2. If Tuesday is an exchange holiday (e.g. Dussehra Oct 20), expiry prepones to preceding trading day (Monday Oct 19).
 * 3. RULE FOR OOBTST BTST: If today is expiry day, we roll over to the NEXT weekly expiry (+7 days)
 *    because OOBTST is a BTST (Buy Today, Sell Tomorrow) overnight carry system and contracts expiring
 *    today cease trading at 15:30.
 */
export function getActiveWeeklyExpiry(
  now = new Date(),
  forOobtst = true
): {
  expiryStr: string;
  expiryDateYMD: string;
  daysToExpiry: number;
  tYears: number;
  isExpiryDay: boolean;
  rolledToNextExpiry: boolean;
  wasPreponed: boolean;
  holidayReason?: string;
  originalScheduledStr?: string;
} {
  const currentDay = now.getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, ...
  // Days until scheduled Tuesday (day 2)
  const daysUntilTuesday = (2 - currentDay + 7) % 7;
  let candidateTuesday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilTuesday);

  let { adjustedDate, wasPreponed, holidayName, scheduledDate } = getAdjustedExpiryDate(candidateTuesday);

  const nowDateStr = formatDateKey(now);
  let adjDateStr = formatDateKey(adjustedDate);

  let isExpiryDay = nowDateStr === adjDateStr;
  let rolledToNextExpiry = false;

  const nowHours = now.getHours();
  const nowMins = now.getMinutes();
  const isPastExpiryTime = isExpiryDay && (nowHours > 15 || (nowHours === 15 && nowMins >= 30));
  const isPastDate = now.getTime() > adjustedDate.getTime() && !isExpiryDay && nowDateStr > adjDateStr;

  if ((forOobtst && isExpiryDay) || isPastExpiryTime || isPastDate) {
    // Roll over to next weekly Tuesday (+7 days)
    candidateTuesday = new Date(candidateTuesday.getFullYear(), candidateTuesday.getMonth(), candidateTuesday.getDate() + 7);
    const nextAdjustment = getAdjustedExpiryDate(candidateTuesday);
    adjustedDate = nextAdjustment.adjustedDate;
    wasPreponed = nextAdjustment.wasPreponed;
    holidayName = nextAdjustment.holidayName;
    scheduledDate = nextAdjustment.scheduledDate;
    adjDateStr = formatDateKey(adjustedDate);
    isExpiryDay = nowDateStr === adjDateStr;
    rolledToNextExpiry = true;
  }

  // Set official expiry time to 15:30:00 IST
  adjustedDate.setHours(15, 30, 0, 0);

  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const dayStr = String(adjustedDate.getDate()).padStart(2, '0');
  const monthStr = months[adjustedDate.getMonth()];
  const yearStr = adjustedDate.getFullYear();
  const expiryStr = `${dayStr}-${monthStr}-${yearStr}`;

  const mNumStr = String(adjustedDate.getMonth() + 1).padStart(2, '0');
  const dNumStr = String(adjustedDate.getDate()).padStart(2, '0');
  const expiryDateYMD = `${yearStr}-${mNumStr}-${dNumStr}`;

  let originalScheduledStr: string | undefined;
  if (wasPreponed && scheduledDate) {
    const sDay = String(scheduledDate.getDate()).padStart(2, '0');
    const sMonth = months[scheduledDate.getMonth()];
    const sYear = scheduledDate.getFullYear();
    originalScheduledStr = `${sDay}-${sMonth}-${sYear}`;
  }

  const diffMs = Math.max(60000, adjustedDate.getTime() - now.getTime());
  const minutesRemaining = diffMs / (1000 * 60);
  const daysToExpiry = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  const tYears = Math.max(0.0005, minutesRemaining / (365 * 24 * 60));

  return {
    expiryStr,
    expiryDateYMD,
    daysToExpiry,
    tYears,
    isExpiryDay,
    rolledToNextExpiry,
    wasPreponed,
    holidayReason: holidayName,
    originalScheduledStr,
  };
}

/**
 * Day Anchor Cache for 09:20:00 Selection
 */
interface OobtstDayAnchor {
  tradeDate: string;
  anchorSpot: number;
  ceStrike: number;
  ceOpen: number;
  ceTrigger: number;
  peStrike: number;
  peOpen: number;
  peTrigger: number;
  expiryStr: string;
  isConfirmed: boolean;
  isProvisional: boolean;
  isMarketClosed: boolean;
  isLockFailed?: boolean;
  lockFailureReason?: string;
  confirmedAt?: string;
  targetPremium: number;
  ceCandidates: OobtstCandidateStrike[];
  peCandidates: OobtstCandidateStrike[];
}

export function parseIstSeconds(istTimeStr?: string): { totalMinutes: number; totalSeconds: number } {
  if (istTimeStr) {
    const match = istTimeStr.match(/(\d{1,2}):(\d{2}):?(\d{2})?\s*(AM|PM)?/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = match[3] ? parseInt(match[3], 10) : 0;
      const meridiem = match[4]?.toUpperCase();
      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
      const totalMinutes = hours * 60 + minutes;
      return { totalMinutes, totalSeconds: totalMinutes * 60 + seconds };
    }
  }
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMins = now.getUTCMinutes();
  const istH = (utcHours + 5 + Math.floor((utcMins + 30) / 60)) % 24;
  const istM = (utcMins + 30) % 60;
  const totalMinutes = istH * 60 + istM;
  return { totalMinutes, totalSeconds: totalMinutes * 60 + now.getUTCSeconds() };
}

class NiftyOptionFeedService {
  private cachedAnchor: OobtstDayAnchor | null = null;
  private peakCeLtp: number = 0;
  private peakPeLtp: number = 0;
  private targetPremium: number = ANCHOR_TARGET_PREMIUM;
  private isTargetPremiumLoaded: boolean = false;
  private chainFeed = new OptionChainFeed({
    owner: 'nifty-options',
    underlying: 'NIFTY',
    optionSegment: 'NSE_FNO',
    fallbackSpot: 24850,
    streamWindow: { step: NIFTY_STRIKE_STEP, strikes: RANK_WINDOW_STRIKES },
    resolveExpiryYmd: () => getActiveWeeklyExpiry(new Date(), true).expiryDateYMD,
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

  public getTargetPremium(): number {
    return this.targetPremium;
  }

  public async loadSavedTargetPremium(): Promise<number> {
    if (this.isTargetPremiumLoaded) return this.targetPremium;
    try {
      const saved = await AsyncStorage.getItem('@qstrategy_oobtst_target_premium');
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
      await AsyncStorage.setItem('@qstrategy_oobtst_target_premium', String(clean));
    } catch {}

    // If anchor is not confirmed/locked yet, reset cached provisional anchor so it recalculates with new target
    if (this.cachedAnchor && !this.cachedAnchor.isConfirmed) {
      this.cachedAnchor = null;
    }
    return true;
  }

  // Strategy 3: Configurable Breakout Threshold (Default: ₹180.00)
  private breakoutThreshold = 180.00;
  private isBreakoutThresholdLoaded = false;

  public getBreakoutThreshold(): number {
    return this.breakoutThreshold;
  }

  public async loadSavedBreakoutThreshold(): Promise<number> {
    if (this.isBreakoutThresholdLoaded) return this.breakoutThreshold;
    try {
      const saved = await AsyncStorage.getItem('@qstrategy_breakout180_threshold');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed > 0) {
          this.breakoutThreshold = Number(parsed.toFixed(2));
        }
      }
    } catch {}
    this.isBreakoutThresholdLoaded = true;
    return this.breakoutThreshold;
  }

  public async setBreakoutThreshold(val: number): Promise<boolean> {
    if (typeof val !== 'number' || isNaN(val) || val <= 0) {
      return false;
    }
    const clean = Number(val.toFixed(2));
    this.breakoutThreshold = clean;
    try {
      await AsyncStorage.setItem('@qstrategy_breakout180_threshold', String(clean));
    } catch {}

    // If breakout candidates are not locked yet, reset cached provisional so it recalculates with new threshold
    if (this.cachedBreakout180 && !this.cachedBreakout180.isLocked) {
      this.cachedBreakout180 = null;
    }
    return true;
  }

  public updateOptionPriceFromTick(securityId: string, ltp: number): void {
    this.chainFeed.updateFromTick(securityId, ltp);
  }

  public getLastLiveSpot(): number | null {
    return this.chainFeed.lastSpot;
  }

  /**
   * Syncs live option chain directly from Dhan HQ API (/v2/optionchain).
   * Tickers other than NIFTY are fetched but never stored in the NIFTY chain.
   */
  public syncLiveOptionChain(ticker: string = 'NIFTY'): Promise<boolean> {
    return this.chainFeed.sync(ticker);
  }

  public getLiveOptionPrice(strike: number, type: 'CE' | 'PE'): number {
    return this.chainFeed.getLiveOptionPrice(strike, type);
  }

  public getLiveDayHigh(strike: number, type: 'CE' | 'PE'): number {
    return this.chainFeed.getDayHigh(strike, type);
  }

  /**
   * Evaluates the quote freshness of the option chain feed.
   */
  public getQuoteFreshness(): 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED' {
    return this.chainFeed.getQuoteFreshness();
  }

  /**
   * Evaluates the two CE and two PE strikes closest to target premium.
   * Calculates absolute difference and quote freshness. Never fabricates prices.
   */
  public selectTopTwoCandidates(
    spot: number,
    targetPremium: number = this.targetPremium
  ): {
    ceCandidates: OobtstCandidateStrike[];
    peCandidates: OobtstCandidateStrike[];
    previewAvailable: boolean;
  } {
    const reach = RANK_WINDOW_STRIKES * NIFTY_STRIKE_STEP;

    if (!this.cachedLiveOptionChain || Object.keys(this.cachedLiveOptionChain).length === 0) {
      return { ceCandidates: [], peCandidates: [], previewAvailable: false };
    }

    const now = Date.now();
    const ceList: { strike: number; ltp: number; diff: number; secId?: string; lastUpdated: number }[] = [];
    const peList: { strike: number; ltp: number; diff: number; secId?: string; lastUpdated: number }[] = [];

    for (const [strikeStr, data] of Object.entries(this.cachedLiveOptionChain)) {
      const strike = Number(strikeStr);
      // Every strike near spot competes on premium distance alone; there is no ATM cut-off.
      if (Math.abs(strike - spot) > reach) continue;
      if (data.ceLtp > 0) {
        ceList.push({
          strike,
          ltp: data.ceLtp,
          diff: Math.abs(data.ceLtp - targetPremium),
          secId: data.ceSecId,
          lastUpdated: data.ceUpdatedTime || this.lastOptionChainSyncTime || now,
        });
      }
      if (data.peLtp > 0) {
        peList.push({
          strike,
          ltp: data.peLtp,
          diff: Math.abs(data.peLtp - targetPremium),
          secId: data.peSecId,
          lastUpdated: data.peUpdatedTime || this.lastOptionChainSyncTime || now,
        });
      }
    }

    // Fallback if the window has too few priced strikes: search all strikes with price > 0
    if (ceList.length < 2) {
      for (const [strikeStr, data] of Object.entries(this.cachedLiveOptionChain)) {
        const strike = Number(strikeStr);
        if (data.ceLtp > 0 && !ceList.some((c) => c.strike === strike)) {
          ceList.push({
            strike,
            ltp: data.ceLtp,
            diff: Math.abs(data.ceLtp - targetPremium),
            secId: data.ceSecId,
            lastUpdated: data.ceUpdatedTime || this.lastOptionChainSyncTime || now,
          });
        }
      }
    }
    if (peList.length < 2) {
      for (const [strikeStr, data] of Object.entries(this.cachedLiveOptionChain)) {
        const strike = Number(strikeStr);
        if (data.peLtp > 0 && !peList.some((p) => p.strike === strike)) {
          peList.push({
            strike,
            ltp: data.peLtp,
            diff: Math.abs(data.peLtp - targetPremium),
            secId: data.peSecId,
            lastUpdated: data.peUpdatedTime || this.lastOptionChainSyncTime || now,
          });
        }
      }
    }

    ceList.sort((a, b) => a.diff - b.diff);
    peList.sort((a, b) => a.diff - b.diff);

    const formatCandidate = (
      item: { strike: number; ltp: number; diff: number; secId?: string; lastUpdated: number },
      type: 'CE' | 'PE',
      rank: 1 | 2
    ): OobtstCandidateStrike => {
      const ageMs = Math.max(0, now - item.lastUpdated);
      const isStale = ageMs > 15000;
      const quoteTime = item.lastUpdated > 0 ? new Date(item.lastUpdated).toLocaleTimeString('en-IN') : '--:--:--';
      return {
        rank,
        type,
        strike: item.strike,
        symbol: `NIFTY ${item.strike} ${type}`,
        ltp: item.ltp,
        diffFromTarget: Number(item.diff.toFixed(2)),
        quoteTimestamp: quoteTime,
        quoteAgeMs: ageMs,
        isStale,
        securityId: item.secId,
      };
    };

    const ceCandidates: OobtstCandidateStrike[] = [];
    if (ceList.length > 0) ceCandidates.push(formatCandidate(ceList[0], 'CE', 1));
    if (ceList.length > 1) ceCandidates.push(formatCandidate(ceList[1], 'CE', 2));

    const peCandidates: OobtstCandidateStrike[] = [];
    if (peList.length > 0) peCandidates.push(formatCandidate(peList[0], 'PE', 1));
    if (peList.length > 1) peCandidates.push(formatCandidate(peList[1], 'PE', 2));

    return {
      ceCandidates,
      peCandidates,
      previewAvailable: ceCandidates.length > 0 && peCandidates.length > 0,
    };
  }

  /**
   * Backward-compatible helper for single anchor strike selection
   */
  public selectAnchorStrikes(
    spot: number,
    tYears?: number,
    targetPremium = this.targetPremium
  ): {
    ceStrike: number;
    ceOpen: number;
    peStrike: number;
    peOpen: number;
  } {
    const { ceCandidates, peCandidates } = this.selectTopTwoCandidates(spot, targetPremium);
    if (ceCandidates.length > 0 && peCandidates.length > 0) {
      return {
        ceStrike: ceCandidates[0].strike,
        ceOpen: ceCandidates[0].ltp,
        peStrike: peCandidates[0].strike,
        peOpen: peCandidates[0].ltp,
      };
    }
    const atm = Math.round(spot / NIFTY_STRIKE_STEP) * NIFTY_STRIKE_STEP;
    return {
      ceStrike: atm + 250,
      ceOpen: 0,
      peStrike: atm - 250,
      peOpen: 0,
    };
  }

  /**
   * Retrieves or initializes the 09:20 day anchor.
   * Invariants:
   * 1. Market Closed (< 09:15): Strikes unlocked, labeled PREVIEW — NOT CONFIRMED (or PREVIEW UNAVAILABLE).
   * 2. Provisional (09:15 - 09:19:59): Top two CE and PE candidates update dynamically from live ticks.
   * 3. 09:20:00 Lock: Selects single closest CE and PE, captures 09:20 opening prices, and locks permanently for session.
   *    Never replaces a locked strike. If quotes are invalid/unavailable, marks LOCK FAILED — DATA UNAVAILABLE.
   */
  public getOrCreateDayAnchor(spot: number, istTimeStr?: string): OobtstDayAnchor {
    const today = formatDateKeyIST();
    const { expiryStr } = getActiveWeeklyExpiry(new Date(), true);
    const { totalSeconds } = parseIstSeconds(istTimeStr);

    const gate0915 = 9 * 3600 + 15 * 60; // 33,300s (09:15:00 AM)
    const gate0920 = 9 * 3600 + 20 * 60; // 33,600s (09:20:00 AM)

    const isMarketClosed = totalSeconds < gate0915;
    const isProvisional = totalSeconds >= gate0915 && totalSeconds < gate0920;
    const isConfirmationTime = totalSeconds >= gate0920;

    // Rule 4: If anchor was already confirmed today at or after 09:20:00, it is permanently locked for today's session
    if (
      this.cachedAnchor &&
      this.cachedAnchor.tradeDate === today &&
      this.cachedAnchor.expiryStr === expiryStr &&
      this.cachedAnchor.isConfirmed &&
      !this.cachedAnchor.isLockFailed
    ) {
      return this.cachedAnchor;
    }

    const { ceCandidates, peCandidates, previewAvailable } = this.selectTopTwoCandidates(spot, this.targetPremium);

    const rank1Ce = ceCandidates.length > 0 ? ceCandidates[0] : null;
    const rank1Pe = peCandidates.length > 0 ? peCandidates[0] : null;

    const atm = Math.round(spot / NIFTY_STRIKE_STEP) * NIFTY_STRIKE_STEP;
    const ceStrike = rank1Ce ? rank1Ce.strike : atm + 250;
    const peStrike = rank1Pe ? rank1Pe.strike : atm - 250;

    let isConfirmed = false;
    let isLockFailed = false;
    let isProvisionalLock = false;
    let lockFailureReason: string | undefined = undefined;

    if (isConfirmationTime) {
      // Validate that valid quotes exist for both selected contracts
      const ceValid = rank1Ce !== null && rank1Ce.ltp > 0;
      const peValid = rank1Pe !== null && rank1Pe.ltp > 0;
      const freshness = ceValid && peValid
        ? assessLockFreshness([rank1Ce!.quoteAgeMs, rank1Pe!.quoteAgeMs], totalSeconds - gate0920)
        : 'FRESH';

      if (ceValid && peValid && freshness === 'WAIT') {
        // Keep re-ranking on fresh quotes; the lock is taken as soon as both legs are current.
        isProvisionalLock = true;
      } else if (ceValid && peValid && freshness === 'FRESH') {
        isConfirmed = true;
        isLockFailed = false;
      } else {
        // Rule 4: If quotes unavailable, show LOCK FAILED — DATA UNAVAILABLE and disarm until validated
        isConfirmed = false;
        isLockFailed = true;
        lockFailureReason = !rank1Ce || rank1Ce.ltp <= 0
          ? 'CE quote unavailable at 09:20'
          : !rank1Pe || rank1Pe.ltp <= 0
          ? 'PE quote unavailable at 09:20'
          : 'Stale quote data at 09:20 lock point';
      }
    }

    const ceOpen = isConfirmed && rank1Ce ? rank1Ce.ltp : 0;
    const peOpen = isConfirmed && rank1Pe ? rank1Pe.ltp : 0;
    const ceTrigger = isConfirmed && ceOpen > 0 ? +(ceOpen * 1.5).toFixed(2) : 0;
    const peTrigger = isConfirmed && peOpen > 0 ? +(peOpen * 1.5).toFixed(2) : 0;

    const newAnchor: OobtstDayAnchor = {
      tradeDate: today,
      anchorSpot: spot,
      ceStrike,
      ceOpen,
      ceTrigger,
      peStrike,
      peOpen,
      peTrigger,
      expiryStr,
      isConfirmed,
      isProvisional: isProvisional || isProvisionalLock,
      isMarketClosed,
      isLockFailed,
      lockFailureReason,
      confirmedAt: isConfirmed ? '09:20:00 IST' : undefined,
      targetPremium: this.targetPremium,
      ceCandidates,
      peCandidates,
    };

    if (isConfirmed) {
      this.cachedAnchor = newAnchor;
      this.peakCeLtp = ceOpen;
      this.peakPeLtp = peOpen;
      this.persistLockedAnchor(newAnchor);
    } else {
      this.cachedAnchor = newAnchor;
    }

    return newAnchor;
  }

  /**
   * Persists confirmed 09:20 day anchor and peak quote memory to SQLite and AsyncStorage
   */
  public async persistLockedAnchor(anchor: OobtstDayAnchor): Promise<void> {
    if (!anchor || !anchor.isConfirmed) return;
    try {
      const payload = {
        anchor,
        peakCeLtp: this.peakCeLtp,
        peakPeLtp: this.peakPeLtp,
      };
      await AsyncStorage.setItem(`@qstrategy_oobtst_anchor_${anchor.tradeDate}`, JSON.stringify(payload));

      await dailyStrategyLockService.saveLock({
        trade_date: anchor.tradeDate,
        strategy_id: 'NIFTY_OOBTST',
        lock_time: anchor.confirmedAt || '09:20:00 IST',
        underlying_symbol: 'NIFTY',
        underlying_spot: anchor.anchorSpot,
        expiry_str: anchor.expiryStr,
        target_param: anchor.targetPremium,
        ce_strike: anchor.ceStrike,
        ce_symbol: `NIFTY ${anchor.ceStrike} CE`,
        ce_open_price: anchor.ceOpen,
        ce_trigger_price: anchor.ceTrigger,
        ce_sec_id: anchor.ceCandidates?.[0]?.securityId,
        pe_strike: anchor.peStrike,
        pe_symbol: `NIFTY ${anchor.peStrike} PE`,
        pe_open_price: anchor.peOpen,
        pe_trigger_price: anchor.peTrigger,
        pe_sec_id: anchor.peCandidates?.[0]?.securityId,
        status: anchor.isLockFailed ? 'LOCK_FAILED' : 'LOCKED',
        lock_failure_reason: anchor.lockFailureReason,
        raw_payload: JSON.stringify(payload),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  /**
   * Restores locked 09:20 day anchor from SQLite / AsyncStorage across app restarts
   */
  public async loadPersistedAnchor(dateKey?: string): Promise<OobtstDayAnchor | null> {
    const today = dateKey || formatDateKeyIST();
    try {
      // 1. Try SQLite multi-tier store
      const record = await dailyStrategyLockService.getLock(today, 'NIFTY_OOBTST');
      if (record && record.raw_payload) {
        try {
          const parsed = JSON.parse(record.raw_payload);
          if (parsed && parsed.anchor && parsed.anchor.tradeDate === today && parsed.anchor.isConfirmed) {
            this.cachedAnchor = parsed.anchor;
            if (typeof parsed.peakCeLtp === 'number') this.peakCeLtp = Math.max(this.peakCeLtp, parsed.peakCeLtp);
            if (typeof parsed.peakPeLtp === 'number') this.peakPeLtp = Math.max(this.peakPeLtp, parsed.peakPeLtp);
            return this.cachedAnchor;
          }
        } catch {}

        const reconstructed: OobtstDayAnchor = {
          tradeDate: record.trade_date,
          anchorSpot: record.underlying_spot,
          ceStrike: record.ce_strike,
          ceOpen: record.ce_open_price,
          ceTrigger: record.ce_trigger_price || +(record.ce_open_price * 1.5).toFixed(2),
          peStrike: record.pe_strike,
          peOpen: record.pe_open_price,
          peTrigger: record.pe_trigger_price || +(record.pe_open_price * 1.5).toFixed(2),
          expiryStr: record.expiry_str,
          isConfirmed: true,
          isProvisional: false,
          isMarketClosed: false,
          confirmedAt: record.lock_time,
          targetPremium: record.target_param,
          ceCandidates: [],
          peCandidates: [],
        };
        this.cachedAnchor = reconstructed;
        return reconstructed;
      }

      // 2. Fallback to AsyncStorage
      const json = await AsyncStorage.getItem(`@qstrategy_oobtst_anchor_${today}`);
      if (json) {
        const parsed = JSON.parse(json);
        if (parsed && parsed.anchor && parsed.anchor.tradeDate === today && parsed.anchor.isConfirmed) {
          this.cachedAnchor = parsed.anchor;
          if (typeof parsed.peakCeLtp === 'number') this.peakCeLtp = Math.max(this.peakCeLtp, parsed.peakCeLtp);
          if (typeof parsed.peakPeLtp === 'number') this.peakPeLtp = Math.max(this.peakPeLtp, parsed.peakPeLtp);
          return this.cachedAnchor;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Generates a complete institutional-grade Black-Scholes option chain matrix
   * Spans ATM ± range strikes (default: ±12 strikes = ±600 points) with 0ms latency.
   * Prominently highlights the 09:20 OOBTST anchor strikes (~₹62.50).
   */
  public generateLiveOptionChainMatrix(
    spot: number,
    step = NIFTY_STRIKE_STEP,
    range = 12,
    forOobtst = true
  ) {
    // If passed spot is zero or default placeholder, fallback to live spot if available
    let resolvedSpot = spot;
    if ((!resolvedSpot || resolvedSpot <= 0) && this.lastLiveSpot && this.lastLiveSpot > 0) {
      resolvedSpot = this.lastLiveSpot;
    }

    const {
      expiryStr,
      daysToExpiry,
      tYears,
      isExpiryDay,
      rolledToNextExpiry,
      wasPreponed,
      holidayReason,
      originalScheduledStr,
    } = getActiveWeeklyExpiry(new Date(), forOobtst);
    const atm = Math.round(resolvedSpot / step) * step;
    const anchor = this.getOrCreateDayAnchor(resolvedSpot);

    const strikes = [];
    let totalCallOi = 0;
    let totalPutOi = 0;
    let liveQuoteCount = 0;

    for (let i = -range; i <= range; i++) {
      const strikePrice = atm + i * step;
      const moneyness: 'ITM' | 'ATM' | 'OTM' = i === 0 ? 'ATM' : i < 0 ? 'ITM' : 'OTM';

      const live = this.cachedLiveOptionChain ? this.cachedLiveOptionChain[strikePrice] : undefined;

      let callLtp = 0;
      let putLtp = 0;
      let callOi = 0;
      let putOi = 0;
      let callIvPct = 14.5;
      let putIvPct = 14.8;
      let callBid: number | undefined = undefined;
      let callAsk: number | undefined = undefined;
      let putBid: number | undefined = undefined;
      let putAsk: number | undefined = undefined;

      if (live) {
        if (live.ceLtp > 0) {
          callLtp = live.ceLtp;
          liveQuoteCount++;
        }
        if (live.peLtp > 0) {
          putLtp = live.peLtp;
          liveQuoteCount++;
        }
        if (live.ceOi !== undefined && live.ceOi > 0) {
          callOi = live.ceOi;
        }
        if (live.peOi !== undefined && live.peOi > 0) {
          putOi = live.peOi;
        }
        if (live.ceIv) callIvPct = live.ceIv;
        if (live.peIv) putIvPct = live.peIv;
        if (live.ceBid) callBid = live.ceBid;
        if (live.ceAsk) callAsk = live.ceAsk;
        if (live.peBid) putBid = live.peBid;
        if (live.peAsk) putAsk = live.peAsk;
      }

      totalCallOi += callOi;
      totalPutOi += putOi;

      const isOobtstCe = strikePrice === anchor.ceStrike;
      const isOobtstPe = strikePrice === anchor.peStrike;

      strikes.push({
        strikePrice,
        moneyness,
        callSymbol: `NIFTY ${strikePrice} CE`,
        callLtp,
        callBid,
        callAsk,
        callOi,
        callIvPct,
        putSymbol: `NIFTY ${strikePrice} PE`,
        putLtp,
        putBid,
        putAsk,
        putOi,
        putIvPct,
        isOobtstCe,
        isOobtstPe,
      });
    }

    const pcrRatio = totalCallOi > 0 ? +(totalPutOi / totalCallOi).toFixed(2) : 1.0;
    const isLiveMarketData = liveQuoteCount > 0;
    const dataSource: 'DHAN_LIVE' | 'OFFLINE' = isLiveMarketData
      ? 'DHAN_LIVE'
      : 'OFFLINE';

    return {
      underlying: 'NIFTY',
      spotPrice: resolvedSpot,
      atmStrike: atm,
      expiryDate: expiryStr,
      daysToExpiry,
      pcrRatio,
      totalCallOi,
      totalPutOi,
      isExpiryDay,
      rolledToNextExpiry,
      wasPreponed,
      holidayReason,
      originalScheduledStr,
      oobtstCeStrike: anchor.ceStrike,
      oobtstPeStrike: anchor.peStrike,
      oobtstCeOpen: anchor.ceOpen,
      oobtstPeOpen: anchor.peOpen,
      isLiveMarketData,
      dataSource,
      lastSyncTime: this.lastOptionChainSyncTime,
      strikes,
    };
  }

  /**
   * Evaluates the full 3-step OOBTST engine in real time
   * Called on every live NIFTY tick from Dhan WebSocket (up to 60 FPS)
   */
  public evaluateOobtst(spot: number, istTimeStr?: string): OobtstLiveState {
    const nowTime = istTimeStr || new Date().toLocaleTimeString('en-IN');
    const { expiryStr, daysToExpiry } = getActiveWeeklyExpiry(new Date(), true);
    const { totalSeconds } = parseIstSeconds(istTimeStr);

    const gate0915 = 9 * 3600 + 15 * 60; // 33,300s (09:15:00 AM)
    const gate0920 = 9 * 3600 + 20 * 60; // 33,600s (09:20:00 AM)

    const isMarketClosed = totalSeconds < gate0915;
    const isProvisional = totalSeconds >= gate0915 && totalSeconds < gate0920;
    const isConfirmed = totalSeconds >= gate0920;

    const anchor = this.getOrCreateDayAnchor(spot, istTimeStr);

    // Live options pricing based on real-time Dhan Option Chain
    let ceLtp = this.getLiveOptionPrice(anchor.ceStrike, 'CE');
    let peLtp = this.getLiveOptionPrice(anchor.peStrike, 'PE');

    // Case 1: Market Closed (Before 09:15 IST)
    // Invariant: Do NOT display locked strikes when the market is closed.
    if (isMarketClosed) {
      const previewAvailable = anchor.ceCandidates.length > 0 && anchor.peCandidates.length > 0;
      const statusBadgeText = previewAvailable ? 'PREVIEW — NOT CONFIRMED' : 'PREVIEW UNAVAILABLE';

      const ceLeg: OobtstLegDetail = {
        type: 'CE',
        strike: anchor.ceStrike,
        symbol: `NIFTY ${anchor.ceStrike} CE`,
        openPrice: 0,
        triggerPrice: 0,
        currentLtp: ceLtp,
        progressPct: 0,
        status: 'SCANNING',
        isProvisional: false,
      };

      const peLeg: OobtstLegDetail = {
        type: 'PE',
        strike: anchor.peStrike,
        symbol: `NIFTY ${anchor.peStrike} PE`,
        openPrice: 0,
        triggerPrice: 0,
        currentLtp: peLtp,
        progressPct: 0,
        status: 'SCANNING',
        isProvisional: false,
      };

      return {
        currentStep: 1,
        status: 'SCANNING',
        statusBadgeText,
        expiryDate: expiryStr,
        daysToExpiry,
        niftySpot: spot,
        anchorTime: '09:20:00 IST',
        isLocked: false,
        isProvisional: false,
        isMarketClosed: true,
        previewAvailable,
        targetPremium: this.targetPremium,
        ceCandidates: anchor.ceCandidates,
        peCandidates: anchor.peCandidates,
        ceLeg,
        peLeg,
        activeLeg: null,
        lastUpdated: nowTime,
        quoteFreshness: this.getQuoteFreshness(),
      };
    }

    // Case 2: Pre-Confirmation Window (09:15:00 - 09:19:59 IST)
    // Invariant: Lock future strikes provisionally, but update them if the target strike changes before confirmation.
    if (isProvisional) {
      const ceProgress = anchor.ceTrigger > 0 ? Math.min(100, Math.round((ceLtp / anchor.ceTrigger) * 100)) : 0;
      const peProgress = anchor.peTrigger > 0 ? Math.min(100, Math.round((peLtp / anchor.peTrigger) * 100)) : 0;

      const ceLeg: OobtstLegDetail = {
        type: 'CE',
        strike: anchor.ceStrike,
        symbol: `NIFTY ${anchor.ceStrike} CE`,
        openPrice: anchor.ceOpen,
        triggerPrice: anchor.ceTrigger,
        currentLtp: ceLtp,
        progressPct: ceProgress,
        status: 'SCANNING',
        isProvisional: true,
      };

      const peLeg: OobtstLegDetail = {
        type: 'PE',
        strike: anchor.peStrike,
        symbol: `NIFTY ${anchor.peStrike} PE`,
        openPrice: anchor.peOpen,
        triggerPrice: anchor.peTrigger,
        currentLtp: peLtp,
        progressPct: peProgress,
        status: 'SCANNING',
        isProvisional: true,
      };

      return {
        currentStep: 1,
        status: 'SCANNING',
        statusBadgeText: 'PROVISIONAL_STRIKES',
        expiryDate: expiryStr,
        daysToExpiry,
        niftySpot: spot,
        anchorTime: '09:20:00 IST',
        isLocked: false,
        isProvisional: true,
        isMarketClosed: false,
        previewAvailable: false,
        targetPremium: this.targetPremium,
        ceCandidates: anchor.ceCandidates,
        peCandidates: anchor.peCandidates,
        ceLeg,
        peLeg,
        activeLeg: null,
        lastUpdated: nowTime,
        quoteFreshness: this.getQuoteFreshness(),
      };
    }

    // Case 2.5: Lock Failure at 09:20:00 (Missing or invalid quote data prevents arming)
    if (anchor.isLockFailed) {
      const ceLeg: OobtstLegDetail = {
        type: 'CE',
        strike: anchor.ceStrike,
        symbol: `NIFTY ${anchor.ceStrike} CE`,
        openPrice: 0,
        triggerPrice: 0,
        currentLtp: ceLtp,
        progressPct: 0,
        status: 'SCANNING',
        isProvisional: false,
      };

      const peLeg: OobtstLegDetail = {
        type: 'PE',
        strike: anchor.peStrike,
        symbol: `NIFTY ${anchor.peStrike} PE`,
        openPrice: 0,
        triggerPrice: 0,
        currentLtp: peLtp,
        progressPct: 0,
        status: 'SCANNING',
        isProvisional: false,
      };

      return {
        currentStep: 1,
        status: 'LOCK_FAILED',
        statusBadgeText: 'LOCK FAILED — DATA UNAVAILABLE',
        expiryDate: expiryStr,
        daysToExpiry,
        niftySpot: spot,
        anchorTime: '09:20:00 IST',
        isLocked: false,
        isProvisional: false,
        isMarketClosed: false,
        isLockFailed: true,
        lockFailureReason: anchor.lockFailureReason || 'Exact opening price or valid quote unavailable at 09:20 lock point',
        previewAvailable: false,
        targetPremium: this.targetPremium,
        ceCandidates: anchor.ceCandidates,
        peCandidates: anchor.peCandidates,
        ceLeg,
        peLeg,
        activeLeg: null,
        lastUpdated: nowTime,
        quoteFreshness: this.getQuoteFreshness(),
      };
    }

    // Case 3: Confirmed & Locked at or after 09:20:00 IST
    let peakUpdated = false;
    if (ceLtp > this.peakCeLtp) {
      this.peakCeLtp = ceLtp;
      peakUpdated = true;
    }
    if (peLtp > this.peakPeLtp) {
      this.peakPeLtp = peLtp;
      peakUpdated = true;
    }
    if (peakUpdated) {
      this.persistLockedAnchor(anchor);
    }

    const ceProgress = triggerProgressPct(this.peakCeLtp, anchor.ceTrigger);
    const peProgress = triggerProgressPct(this.peakPeLtp, anchor.peTrigger);
    const ceDayHigh = Math.max(this.getLiveDayHigh(anchor.ceStrike, 'CE'), this.peakCeLtp, ceLtp);
    const peDayHigh = Math.max(this.getLiveDayHigh(anchor.peStrike, 'PE'), this.peakPeLtp, peLtp);
    this.chainFeed.pin([
      { strike: anchor.ceStrike, type: 'CE' },
      { strike: anchor.peStrike, type: 'PE' },
    ]);

    const isCeBreached = anchor.ceTrigger > 0 && (ceLtp >= anchor.ceTrigger || this.peakCeLtp >= anchor.ceTrigger);
    const isPeBreached = anchor.peTrigger > 0 && (peLtp >= anchor.peTrigger || this.peakPeLtp >= anchor.peTrigger);

    // Check if after 15:30 IST for BTST Overnight Hold
    const isAfter330 = (() => {
      if (istTimeStr) {
        const match = istTimeStr.match(/(\d{1,2}):(\d{2}):?(\d{2})?\s*(AM|PM)?/i);
        if (match) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const meridiem = match[4]?.toUpperCase();
          if (meridiem === 'PM' && hours < 12) hours += 12;
          if (meridiem === 'AM' && hours === 12) hours = 0;
          return hours > 15 || (hours === 15 && minutes >= 30);
        }
      }
      const now = new Date();
      return now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 30);
    })();

    // Initial state: Step 2 ARMED
    let currentStep: 1 | 2 | 3 = 2;
    let status: 'SCANNING' | 'ARMED' | 'ACTIVE' | 'SL_HIT' | 'BTST_HOLD' = 'ARMED';
    let statusBadgeText = 'LOCKED / ARMED_1.5X';
    let activeLeg: 'CE' | 'PE' | null = null;
    let executedSymbol: string | undefined;
    let executedPrice: number | undefined;
    let slPrice: number | undefined;
    let riskPerLot: number | undefined;
    let pnlPerShare: number | undefined;
    let pnlPerLot: number | undefined;

    let ceStatus: 'ARMED' | 'EXECUTED' | 'DISABLED' | 'SL_HIT' = 'ARMED';
    let peStatus: 'ARMED' | 'EXECUTED' | 'DISABLED' | 'SL_HIT' = 'ARMED';

    if (isCeBreached && (!isPeBreached || this.peakCeLtp >= anchor.ceTrigger)) {
      // CE Leg Triggered First (OOBTST Active)
      currentStep = 3;
      activeLeg = 'CE';
      executedSymbol = `NIFTY ${anchor.ceStrike} CE`;
      executedPrice = anchor.ceTrigger;
      // Invariant: Stop Loss is strictly half of buy price (50%)
      slPrice = +(executedPrice / 2).toFixed(2);
      riskPerLot = +((executedPrice - slPrice) * NIFTY_LOT_SIZE).toFixed(2);
      pnlPerShare = +(ceLtp - executedPrice).toFixed(2);
      pnlPerLot = +(pnlPerShare * NIFTY_LOT_SIZE).toFixed(2);

      ceStatus = 'EXECUTED';
      peStatus = 'DISABLED'; // Opposite leg cancelled (OCO)

      if (ceLtp <= slPrice) {
        status = 'SL_HIT';
        statusBadgeText = 'SL_HIT';
        ceStatus = 'SL_HIT';
      } else if (isAfter330) {
        status = 'BTST_HOLD';
        statusBadgeText = 'BTST_HOLD';
      } else {
        status = 'ACTIVE';
        statusBadgeText = 'OOBTST_ACTIVE';
      }
    } else if (isPeBreached) {
      // PE Leg Triggered First (OOBTST Active)
      currentStep = 3;
      activeLeg = 'PE';
      executedSymbol = `NIFTY ${anchor.peStrike} PE`;
      executedPrice = anchor.peTrigger;
      slPrice = +(executedPrice / 2).toFixed(2);
      riskPerLot = +((executedPrice - slPrice) * NIFTY_LOT_SIZE).toFixed(2);
      pnlPerShare = +(peLtp - executedPrice).toFixed(2);
      pnlPerLot = +(pnlPerShare * NIFTY_LOT_SIZE).toFixed(2);

      peStatus = 'EXECUTED';
      ceStatus = 'DISABLED'; // Opposite leg cancelled (OCO)

      if (peLtp <= slPrice) {
        status = 'SL_HIT';
        statusBadgeText = 'SL_HIT';
        peStatus = 'SL_HIT';
      } else if (isAfter330) {
        status = 'BTST_HOLD';
        statusBadgeText = 'BTST_HOLD';
      } else {
        status = 'ACTIVE';
        statusBadgeText = 'OOBTST_ACTIVE';
      }
    }

    const ceLeg: OobtstLegDetail = {
      type: 'CE',
      strike: anchor.ceStrike,
      symbol: `NIFTY ${anchor.ceStrike} CE`,
      openPrice: anchor.ceOpen,
      triggerPrice: anchor.ceTrigger,
      currentLtp: ceLtp,
      progressPct: ceProgress,
      armedHigh: this.peakCeLtp,
      dayHigh: ceDayHigh,
      status: ceStatus,
    };

    const peLeg: OobtstLegDetail = {
      type: 'PE',
      strike: anchor.peStrike,
      symbol: `NIFTY ${anchor.peStrike} PE`,
      openPrice: anchor.peOpen,
      triggerPrice: anchor.peTrigger,
      currentLtp: peLtp,
      progressPct: peProgress,
      armedHigh: this.peakPeLtp,
      dayHigh: peDayHigh,
      status: peStatus,
    };

    return {
      currentStep,
      status,
      statusBadgeText,
      expiryDate: expiryStr,
      daysToExpiry,
      niftySpot: spot,
      anchorTime: '09:20:00 IST',
      isLocked: true,
      isProvisional: false,
      isMarketClosed: false,
      isLockFailed: false,
      previewAvailable: false,
      targetPremium: this.targetPremium,
      ceCandidates: anchor.ceCandidates,
      peCandidates: anchor.peCandidates,
      ceLeg,
      peLeg,
      activeLeg,
      executedSymbol,
      executedPrice,
      slPrice,
      riskPerLot,
      pnlPerShare,
      pnlPerLot,
      lastUpdated: nowTime,
      quoteFreshness: this.getQuoteFreshness(),
    };
  }

  // Strategy 3: NIFTY 09:25 ₹180 Breakout Engine Cache
  private cachedBreakout180: {
    date: string;
    ceStrike: number;
    peStrike: number;
    ceOpen0925: number;
    peOpen0925: number;
    expiryStr: string;
    triggeredSide: 'CE' | 'PE' | null;
    entryPrice: number | null;
    entryTime: string | null;
    peakPrice: number;
    troughPrice: number;
    slPrice?: number;
    targetPrice?: number;
    ceArmedHigh?: number;
    peArmedHigh?: number;
    lastActiveLtp?: number;
    exitStatus?: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT';
    exitPrice?: number;
    exitTime?: string;
    lockedThreshold?: number;
    isLocked?: boolean;
    isLockFailed?: boolean;
    lockFailureReason?: string;
    noEligibleSide?: 'CE' | 'PE' | 'BOTH' | null;
    isHistoricalSession?: boolean;
    historicalDate?: string;
    historicalStatus?: 'HISTORICAL SESSION RESULTS' | 'HISTORICAL DATA UNAVAILABLE';
  } | null = null;

  /**
   * Persists 09:25 Breakout Engine state across app restarts
   */
  public async persistBreakoutState(state = this.cachedBreakout180): Promise<void> {
    if (!state || (!state.isLocked && !state.isLockFailed)) return;
    try {
      await AsyncStorage.setItem(`@qstrategy_breakout180_state_${state.date}`, JSON.stringify(state));

      await dailyStrategyLockService.saveLock({
        trade_date: state.date,
        strategy_id: 'NIFTY_BREAKOUT_180',
        lock_time: '09:25:00 IST',
        underlying_symbol: 'NIFTY',
        underlying_spot: this.lastLiveSpot || 24850,
        expiry_str: state.expiryStr || '',
        target_param: state.lockedThreshold || this.breakoutThreshold,
        ce_strike: state.ceStrike,
        ce_symbol: `NIFTY ${state.ceStrike} CE`,
        ce_open_price: state.ceOpen0925,
        ce_trigger_price: state.lockedThreshold || this.breakoutThreshold,
        pe_strike: state.peStrike,
        pe_symbol: `NIFTY ${state.peStrike} PE`,
        pe_open_price: state.peOpen0925,
        pe_trigger_price: state.lockedThreshold || this.breakoutThreshold,
        execution_side: state.triggeredSide,
        execution_price: state.entryPrice,
        execution_time: state.entryTime,
        status: state.isLockFailed ? 'LOCK_FAILED' : state.triggeredSide ? 'TRIGGERED' : 'LOCKED',
        lock_failure_reason: state.lockFailureReason,
        raw_payload: JSON.stringify(state),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }

  /**
   * Restores 09:25 Breakout Engine state from SQLite / AsyncStorage across app restarts
   */
  public async loadPersistedBreakoutState(dateKey?: string): Promise<any> {
    const today = dateKey || formatDateKeyIST();
    // A locked in-memory session is newer than storage; reloading would roll back peak, trough or exit
    const live = this.cachedBreakout180;
    if (live && live.date === today && (live.isLocked || live.isLockFailed)) return live;
    try {
      // 1. Check AsyncStorage for instant exact state
      const json = await AsyncStorage.getItem(`@qstrategy_breakout180_state_${today}`);
      if (json) {
        const parsed = JSON.parse(json);
        if (parsed && parsed.date === today && (parsed.isLocked || parsed.isLockFailed)) {
          this.cachedBreakout180 = parsed;
          return this.cachedBreakout180;
        }
      }

      // 2. Check SQLite multi-tier store
      const record = await dailyStrategyLockService.getLock(today, 'NIFTY_BREAKOUT_180');
      if (record && record.raw_payload) {
        try {
          const parsed = JSON.parse(record.raw_payload);
          if (parsed && parsed.date === today && (parsed.isLocked || parsed.isLockFailed)) {
            this.cachedBreakout180 = parsed;
            return this.cachedBreakout180;
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  /**
   * Selects top 2 CE and top 2 PE candidates strictly below the breakout threshold.
   * CE: strike >= ATM, premium < threshold, ranked descending
   * PE: strike <= ATM, premium < threshold, ranked descending
   */
  public selectTopTwoBreakoutCandidates(
    spot: number,
    threshold: number = this.breakoutThreshold
  ): {
    ceCandidates: Candidate180Contract[];
    peCandidates: Candidate180Contract[];
    hasValidQuotes: boolean;
  } {
    const atm = Math.round(spot / NIFTY_STRIKE_STEP) * NIFTY_STRIKE_STEP;
    const now = Date.now();
    const { expiryStr } = getActiveWeeklyExpiry(new Date(), false);
    const isFeedOnline = dhanDirectService.isConfigured();

    const ceList: {
      strike: number;
      ltp: number;
      diff: number;
      secId?: string;
      lastUpdated: number;
    }[] = [];

    const peList: {
      strike: number;
      ltp: number;
      diff: number;
      secId?: string;
      lastUpdated: number;
    }[] = [];

    if (this.cachedLiveOptionChain && Object.keys(this.cachedLiveOptionChain).length > 0) {
      for (const [strikeStr, data] of Object.entries(this.cachedLiveOptionChain)) {
        const strike = Number(strikeStr);
        // CE: strike >= atm, live premium strictly < threshold and > 0
        if (strike >= atm && data.ceLtp > 0 && data.ceLtp < threshold) {
          ceList.push({
            strike,
            ltp: data.ceLtp,
            diff: Number((threshold - data.ceLtp).toFixed(2)),
            secId: data.ceSecId,
            lastUpdated: data.ceUpdatedTime || now,
          });
        }
        // PE: strike <= atm, live premium strictly < threshold and > 0
        if (strike <= atm && data.peLtp > 0 && data.peLtp < threshold) {
          peList.push({
            strike,
            ltp: data.peLtp,
            diff: Number((threshold - data.peLtp).toFixed(2)),
            secId: data.peSecId,
            lastUpdated: data.peUpdatedTime || now,
          });
        }
      }
    }

    // Rank descending by premium (highest premium strictly under threshold comes first)
    ceList.sort((a, b) => b.ltp - a.ltp);
    peList.sort((a, b) => b.ltp - a.ltp);

    const formatFreshness = (lastUpdated: number): 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED' => {
      if (!isFeedOnline) return 'DISCONNECTED';
      const age = now - lastUpdated;
      if (age <= 3000) return 'FRESH';
      if (age <= 10000) return 'AGING';
      return 'STALE';
    };

    const topCe: Candidate180Contract[] = ceList.slice(0, 2).map((item, idx) => ({
      type: 'CE',
      strike: item.strike,
      expiry: expiryStr,
      price0925: item.ltp,
      distanceTo180: item.diff,
      currentLtp: item.ltp,
      isTriggered: false,
      isDisabled: false,
      rank: (idx + 1) as 1 | 2,
      securityId: item.secId,
      lastTradeTimestamp: new Date(item.lastUpdated).toLocaleTimeString('en-IN'),
      quoteFreshness: formatFreshness(item.lastUpdated),
    }));

    const topPe: Candidate180Contract[] = peList.slice(0, 2).map((item, idx) => ({
      type: 'PE',
      strike: item.strike,
      expiry: expiryStr,
      price0925: item.ltp,
      distanceTo180: item.diff,
      currentLtp: item.ltp,
      isTriggered: false,
      isDisabled: false,
      rank: (idx + 1) as 1 | 2,
      securityId: item.secId,
      lastTradeTimestamp: new Date(item.lastUpdated).toLocaleTimeString('en-IN'),
      quoteFreshness: formatFreshness(item.lastUpdated),
    }));

    return {
      ceCandidates: topCe,
      peCandidates: topPe,
      hasValidQuotes: topCe.length > 0 || topPe.length > 0,
    };
  }

  /**
   * Evaluates the NIFTY 09:25 Breakout Strategy Engine
   *
   * Core Invariants:
   * 1. 09:25 AM Candle Open < configuredThreshold (Default: ₹180.00).
   * 2. Closest Option Candidate Selection:
   *    Select highest 09:25 candle open strictly below threshold for CE (>= ATM) and PE (<= ATM).
   * 3. Pre-Lock Window (09:15:00 - 09:24:59):
   *    Displays 2 CE and 2 PE provisional candidates, ranked descending by premium < threshold.
   *    Provisional candidates must never trigger orders.
   * 4. Exact 09:25 Candle Open Strike Lock:
   *    Captures actual 09:25 candle open (or first valid trade tick of 09:25 candle).
   *    Once locked, strikes and lockedThreshold are immutable for the session.
   * 5. Execution Rules:
   *    A locked leg at or above the threshold at 09:30 (higher LTP if both) is bought; otherwise the first cross until 09:45.
   *    OCO: permanently disables opposite leg.
   *    Target: ₹220.00 (+40 pts), Stop-Loss: ₹160.00 (-20 pts). 1:2 R:R.
   *    09:45:00 AM IST Hard Cutoff: Square-off at market, strictly no overnight hold.
   * 6. Market-Closed Historical Lookup:
   *    Shows HISTORICAL SESSION RESULTS if historical 09:25 candles are available.
   *    Shows HISTORICAL DATA UNAVAILABLE if unavailable. Never fabricate prices.
   */
  public evaluateBreakout180(
    spot: number,
    istTimeStr?: string,
    candleOpens?: Record<string, number>
  ): NiftyBreakout180State {
    const now = new Date();
    const todayDateKey = formatDateKeyIST(now);
    const nowTime = istTimeStr || now.toLocaleTimeString('en-IN');
    const { expiryStr } = getActiveWeeklyExpiry(now, false);
    const threshold = this.breakoutThreshold;

    // Calculate current minutes from midnight IST to evaluate time gates
    let istMinutes = 572; // Default ~09:32 AM for offline preview
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
      const utcHours = now.getUTCHours();
      const utcMins = now.getUTCMinutes();
      const istH = (utcHours + 5 + Math.floor((utcMins + 30) / 60)) % 24;
      const istM = (utcMins + 30) % 60;
      istMinutes = istH * 60 + istM;
      istSeconds = now.getUTCSeconds();
    }

    const totalSeconds = istMinutes * 60 + istSeconds;
    const gate0915 = 9 * 60 + 15; // 555 mins (09:15:00 AM)
    const gate0925 = 9 * 60 + 25; // 565 mins (09:25:00 AM)
    const gate0930 = 9 * 60 + 30; // 570 mins (09:30:00 AM): strikes lock at 09:25, entry opens at 09:30
    const gate0945 = 9 * 60 + 45; // 585 mins (09:45:00 AM)
    const gate1530 = 15 * 60 + 30; // 930 mins (15:30:00 PM)
    const SL_POINTS = 20;
    const TARGET_POINTS = 40;

    const isMarketClosed = istMinutes < gate0915 || istMinutes >= gate1530;
    const atm = Math.round(spot / NIFTY_STRIKE_STEP) * NIFTY_STRIKE_STEP;

    // Get live candidates
    const liveCandidateLookup = this.selectTopTwoBreakoutCandidates(spot, threshold);
    const topCeCandidates = liveCandidateLookup.ceCandidates;
    const topPeCandidates = liveCandidateLookup.peCandidates;

    // STEP 1: Initialize or Retrieve Daily Session State
    if (!this.cachedBreakout180 || this.cachedBreakout180.date !== todayDateKey) {
      this.cachedBreakout180 = {
        date: todayDateKey,
        ceStrike: topCeCandidates[0]?.strike || atm + 100,
        peStrike: topPeCandidates[0]?.strike || atm - 100,
        ceOpen0925: topCeCandidates[0]?.currentLtp || 0,
        peOpen0925: topPeCandidates[0]?.currentLtp || 0,
        expiryStr,
        triggeredSide: null,
        entryPrice: null,
        entryTime: null,
        peakPrice: 0,
        troughPrice: 99999,
        isLocked: false,
        isLockFailed: false,
        noEligibleSide: null,
      };

      // Market-Closed Historical Lookup Handler
      if (isMarketClosed) {
        if (candleOpens && Object.keys(candleOpens).length > 0) {
          this.cachedBreakout180.isHistoricalSession = true;
          this.cachedBreakout180.historicalDate = todayDateKey;
          this.cachedBreakout180.historicalStatus = 'HISTORICAL SESSION RESULTS';
        } else {
          this.cachedBreakout180.historicalStatus = 'HISTORICAL DATA UNAVAILABLE';
        }
      }
    }

    const cache = this.cachedBreakout180;
    const effectiveThreshold = cache.lockedThreshold ?? threshold;

    // STEP 2: Time Gate & Strike Locking Evaluation
    let status: NiftyBreakout180State['status'] = 'WAITING_0925';
    let timeRemainingSec = Math.max(0, gate0945 * 60 - totalSeconds);

    if (istMinutes < gate0915) {
      // Prior to 09:15:00 Market Open
      status = 'WAITING_0925';
    } else if (istMinutes < gate0925) {
      // Pre-Lock Candidate Monitoring Window (09:15:00 - 09:24:59 IST)
      status = 'PROVISIONAL_MONITORING';
      cache.isLocked = false;
      // Continuously update provisional candidates
      if (topCeCandidates.length > 0) {
        cache.ceStrike = topCeCandidates[0].strike;
        cache.ceOpen0925 = topCeCandidates[0].currentLtp;
      }
      if (topPeCandidates.length > 0) {
        cache.peStrike = topPeCandidates[0].strike;
        cache.peOpen0925 = topPeCandidates[0].currentLtp;
      }
    } else {
      // 09:25:00 or Later: Strike Lock & Breakout Execution
      if (!cache.isLocked && !cache.isLockFailed) {
        // Perform 09:25 Candle Open Lock
        let bestCeStrike: number | null = null;
        let bestCeOpen = -Infinity;
        let bestCeSecId: string | undefined = undefined;

        let bestPeStrike: number | null = null;
        let bestPeOpen = -Infinity;
        let bestPeSecId: string | undefined = undefined;

        if (this.cachedLiveOptionChain && Object.keys(this.cachedLiveOptionChain).length > 0) {
          for (const [strikeStr, data] of Object.entries(this.cachedLiveOptionChain)) {
            const k = Number(strikeStr);
            const ceOpen = candleOpens?.[`CE_${k}`] ?? data.ceLtp;
            const peOpen = candleOpens?.[`PE_${k}`] ?? data.peLtp;

            // CE: strike >= atm, 09:25 Open < threshold, select highest Open
            if (k >= atm && ceOpen > 0 && ceOpen < threshold && ceOpen > bestCeOpen) {
              bestCeOpen = ceOpen;
              bestCeStrike = k;
              bestCeSecId = data.ceSecId;
            }

            // PE: strike <= atm, 09:25 Open < threshold, select highest Open
            if (k <= atm && peOpen > 0 && peOpen < threshold && peOpen > bestPeOpen) {
              bestPeOpen = peOpen;
              bestPeStrike = k;
              bestPeSecId = data.peSecId;
            }
          }
        }

        if (candleOpens && Object.keys(candleOpens).length > 0) {
          for (const [key, openPrice] of Object.entries(candleOpens)) {
            if (key.startsWith('CE_') && openPrice < threshold) {
              const k = parseInt(key.replace('CE_', ''), 10);
              if (k >= atm && openPrice > bestCeOpen) {
                bestCeOpen = openPrice;
                bestCeStrike = k;
              }
            } else if (key.startsWith('PE_') && openPrice < threshold) {
              const k = parseInt(key.replace('PE_', ''), 10);
              if (k <= atm && openPrice > bestPeOpen) {
                bestPeOpen = openPrice;
                bestPeStrike = k;
              }
            }
          }
        }

        // Validate Lock Eligibility
        if (bestCeStrike === null && bestPeStrike === null) {
          cache.isLockFailed = true;
          cache.lockFailureReason = 'LOCK FAILED — DATA UNAVAILABLE';
          cache.noEligibleSide = 'BOTH';
          status = 'LOCK_FAILED';
        } else if (bestCeStrike === null) {
          cache.noEligibleSide = 'CE';
          status = 'NO_ELIGIBLE_STRIKE';
        } else if (bestPeStrike === null) {
          cache.noEligibleSide = 'PE';
          status = 'NO_ELIGIBLE_STRIKE';
        } else {
          // Successfully lock strikes and threshold for the session
          cache.isLocked = true;
          cache.lockedThreshold = threshold;
          cache.ceStrike = bestCeStrike;
          cache.ceOpen0925 = bestCeOpen;
          cache.peStrike = bestPeStrike;
          cache.peOpen0925 = bestPeOpen;
          status = 'CANDIDATES_LOCKED';
          this.persistBreakoutState(cache);

          // Locked contracts stay streamed for the session under their own owner
          const lockedSubs = [bestCeSecId, bestPeSecId]
            .filter((id): id is string => Boolean(id))
            .map((securityId) => ({ exchangeSegment: 'NSE_FNO', securityId }));
          if (lockedSubs.length > 0) {
            marketData.acquire('nifty-breakout', lockedSubs);
          }
        }
      }

      // If already locked, proceed to breakout monitoring or trade progression
      if (cache.isLocked) {
        status = 'MONITORING_BREAKOUT';
      } else if (cache.isLockFailed) {
        status = 'LOCK_FAILED';
        this.persistBreakoutState(cache);
      } else if (cache.noEligibleSide) {
        status = 'NO_ELIGIBLE_STRIKE';
      }
    }

    // STEP 3: Breakout Execution, OCO, and Time Exit Cutoff
    const currentCeLtp = this.getLiveOptionPrice(cache.ceStrike, 'CE');
    const currentPeLtp = this.getLiveOptionPrice(cache.peStrike, 'PE');

    const armTrade = (side: 'CE' | 'PE', price: number) => {
      cache.triggeredSide = side;
      cache.entryPrice = price;
      cache.entryTime = nowTime;
      cache.peakPrice = price;
      cache.troughPrice = price;
      cache.lastActiveLtp = price;
      cache.slPrice = +(price - SL_POINTS).toFixed(2);
      cache.targetPrice = +(price + TARGET_POINTS).toFixed(2);
      this.persistBreakoutState(cache);
    };
    // The first exit wins and is never recomputed, at the live price when it happened
    const freezeExit = (exit: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT', price: number) => {
      cache.exitStatus = exit;
      cache.exitPrice = +price.toFixed(2);
      cache.exitTime = nowTime;
      this.persistBreakoutState(cache);
    };

    if (cache.exitStatus) {
      status = cache.exitStatus;
      timeRemainingSec = 0;
    } else if (istMinutes >= gate0945) {
      if (cache.triggeredSide) {
        const liveLtp = cache.triggeredSide === 'CE' ? currentCeLtp : currentPeLtp;
        freezeExit('TIME_EXIT', liveLtp > 0 ? liveLtp : (cache.lastActiveLtp ?? cache.entryPrice ?? 0));
        status = 'TIME_EXIT';
      } else {
        status = 'NO_TRADE_TODAY';
      }
      timeRemainingSec = 0;
    } else if (cache.isLocked && istMinutes >= gate0930 && istMinutes < gate0945) {
      // Highest price per leg since the entry window opened; drives the Step 2 progress bar
      const prevCeHigh = cache.ceArmedHigh ?? 0;
      const prevPeHigh = cache.peArmedHigh ?? 0;
      cache.ceArmedHigh = Math.max(prevCeHigh, currentCeLtp);
      cache.peArmedHigh = Math.max(prevPeHigh, currentPeLtp);
      if (cache.ceArmedHigh > prevCeHigh || cache.peArmedHigh > prevPeHigh) {
        this.persistBreakoutState(cache);
      }

      if (!cache.triggeredSide) {
        // At 09:30 a leg already at or above the threshold is bought; otherwise the first cross until 09:45
        if (currentCeLtp >= effectiveThreshold && currentPeLtp < effectiveThreshold) {
          armTrade('CE', +currentCeLtp.toFixed(2));
        } else if (currentPeLtp >= effectiveThreshold && currentCeLtp < effectiveThreshold) {
          armTrade('PE', +currentPeLtp.toFixed(2));
        } else if (currentCeLtp >= effectiveThreshold && currentPeLtp >= effectiveThreshold) {
          // Both qualify: the higher LTP wins
          const side = currentCeLtp >= currentPeLtp ? 'CE' : 'PE';
          armTrade(side, +(side === 'CE' ? currentCeLtp : currentPeLtp).toFixed(2));
        } else {
          status = 'MONITORING_BREAKOUT';
        }
      }

      if (cache.triggeredSide) {
        const activeLtp = cache.triggeredSide === 'CE' ? currentCeLtp : currentPeLtp;
        const entry = cache.entryPrice ?? effectiveThreshold;
        const slPrice = cache.slPrice ?? +(entry - SL_POINTS).toFixed(2);
        const targetPrice = cache.targetPrice ?? +(entry + TARGET_POINTS).toFixed(2);

        // A missing quote (0) must never read as a stop-loss
        if (activeLtp > 0) {
          cache.lastActiveLtp = activeLtp;
          let boundsChanged = false;
          if (activeLtp > cache.peakPrice) {
            cache.peakPrice = activeLtp;
            boundsChanged = true;
          }
          if (activeLtp < cache.troughPrice) {
            cache.troughPrice = activeLtp;
            boundsChanged = true;
          }
          if (boundsChanged) {
            this.persistBreakoutState(cache);
          }
        }

        if (activeLtp > 0 && activeLtp >= targetPrice) {
          freezeExit('TARGET_HIT', activeLtp);
          status = 'TARGET_HIT';
        } else if (activeLtp > 0 && activeLtp <= slPrice) {
          freezeExit('SL_HIT', activeLtp);
          status = 'SL_HIT';
        } else {
          status = 'IN_TRADE';
        }
      }
    }

    const primaryCeLtp = currentCeLtp > 0 ? currentCeLtp : cache.ceOpen0925;
    const primaryPeLtp = currentPeLtp > 0 ? currentPeLtp : cache.peOpen0925;

    const ceArmedHigh = istMinutes >= gate0930 ? Math.max(cache.ceArmedHigh ?? 0, primaryCeLtp) : primaryCeLtp;
    const peArmedHigh = istMinutes >= gate0930 ? Math.max(cache.peArmedHigh ?? 0, primaryPeLtp) : primaryPeLtp;

    const ceCandidate: Candidate180Contract = {
      type: 'CE',
      strike: cache.ceStrike,
      expiry: cache.expiryStr,
      price0925: cache.ceOpen0925,
      distanceTo180: +Math.max(0, effectiveThreshold - primaryCeLtp).toFixed(2),
      currentLtp: primaryCeLtp,
      armedHigh: ceArmedHigh,
      dayHigh: Math.max(this.getLiveDayHigh(cache.ceStrike, 'CE'), ceArmedHigh),
      isTriggered: cache.triggeredSide === 'CE',
      isDisabled: cache.triggeredSide === 'PE',
      rank: 1,
      quoteFreshness: this.getQuoteFreshness(),
      lastTradeTimestamp: nowTime,
    };

    const peCandidate: Candidate180Contract = {
      type: 'PE',
      strike: cache.peStrike,
      expiry: cache.expiryStr,
      price0925: cache.peOpen0925,
      distanceTo180: +Math.max(0, effectiveThreshold - primaryPeLtp).toFixed(2),
      currentLtp: primaryPeLtp,
      armedHigh: peArmedHigh,
      dayHigh: Math.max(this.getLiveDayHigh(cache.peStrike, 'PE'), peArmedHigh),
      isTriggered: cache.triggeredSide === 'PE',
      isDisabled: cache.triggeredSide === 'CE',
      rank: 1,
      quoteFreshness: this.getQuoteFreshness(),
      lastTradeTimestamp: nowTime,
    };

    const livePrice = cache.triggeredSide === 'CE'
      ? (currentCeLtp > 0 ? currentCeLtp : cache.lastActiveLtp ?? primaryCeLtp)
      : cache.triggeredSide === 'PE'
      ? (currentPeLtp > 0 ? currentPeLtp : cache.lastActiveLtp ?? primaryPeLtp)
      : null;
    const currentPrice = cache.exitPrice ?? livePrice;

    const pnlPoints = cache.entryPrice && currentPrice
      ? +(currentPrice - cache.entryPrice).toFixed(2)
      : 0;
    const pnlText = `${pnlPoints >= 0 ? '+' : ''}${pnlPoints.toFixed(2)} pts`;
    const levelBase = cache.entryPrice ?? effectiveThreshold;
    const targetLevel = cache.targetPrice ?? +(levelBase + TARGET_POINTS).toFixed(2);
    const stopLevel = cache.slPrice ?? +(levelBase - SL_POINTS).toFixed(2);

    let currentStep: 1 | 2 | 3 = 1;
    let outcomeText: string | undefined = undefined;

    if (status === 'TARGET_HIT') {
      currentStep = 3;
      outcomeText = `TARGET BOOKED (${pnlText})`;
    } else if (status === 'SL_HIT') {
      currentStep = 3;
      outcomeText = `STOP LOSS HIT (${pnlText})`;
    } else if (status === 'TIME_EXIT') {
      currentStep = 3;
      outcomeText = `SQUARED OFF @ 09:45 AM (${pnlText})`;
    } else if (status === 'NO_TRADE_TODAY') {
      currentStep = 3;
      outcomeText = 'NO TRADE (NO BREAKOUT)';
    } else if (status === 'IN_TRADE') {
      currentStep = 2;
    } else {
      currentStep = 1;
    }

    return {
      strategyId: 'NIFTY_BREAKOUT_180',
      tradeDate: todayDateKey,
      currentStep,
      status,
      threshold,
      lockedThreshold: cache.lockedThreshold,
      ceCandidate,
      peCandidate,
      ceCandidates: topCeCandidates.length > 0 ? topCeCandidates : [ceCandidate],
      peCandidates: topPeCandidates.length > 0 ? topPeCandidates : [peCandidate],
      activeContract: cache.triggeredSide,
      entryPrice: cache.entryPrice,
      entryTime: cache.entryTime,
      fixedTarget: targetLevel,
      fixedStopLoss: stopLevel,
      currentPrice: currentPrice ?? null,
      exitPrice: cache.exitPrice ?? null,
      exitTime: cache.exitTime ?? null,
      pnlPoints,
      timeRemainingSec,
      outcomeText,
      isHistoricalSession: cache.isHistoricalSession,
      historicalDate: cache.historicalDate,
      historicalStatus: cache.historicalStatus,
      isLockFailed: cache.isLockFailed,
      lockFailureReason: cache.lockFailureReason,
      noEligibleSide: cache.noEligibleSide,
    };
  }

  /**
   * Reset Day Anchor (for manual simulation or testing)
   */
  public async resetAnchor(clearStorage = false) {
    this.cachedAnchor = null;
    this.peakCeLtp = 0;
    this.peakPeLtp = 0;
    this.chainFeed.reset();
    if (clearStorage) {
      try {
        const today = formatDateKeyIST();
        await AsyncStorage.removeItem(`@qstrategy_oobtst_anchor_${today}`);
      } catch {}
    }
  }

  /**
   * Reset 09:25 Breakout Engine (for manual simulation or testing)
   */
  public async resetBreakout180(clearStorage = false) {
    this.cachedBreakout180 = null;
    marketData.releaseOwner('nifty-breakout');
    if (clearStorage) {
      try {
        const today = formatDateKeyIST();
        await AsyncStorage.removeItem(`@qstrategy_breakout180_state_${today}`);
      } catch {}
    }
  }
}

export const niftyOptionFeedService = new NiftyOptionFeedService();

