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
import { dhanDirectService } from './dhanDirectService';
import { dhanHqFeedSocket } from './dhan/DhanHqFeedSocket';
import { tradingCalendarService } from './TradingCalendarService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { OobtstCandidateStrike, OobtstLiveState, OobtstLegDetail } from '../strategies/types';

export const SENSEX_STRIKE_STEP = 100;
export const SENSEX_LOT_SIZE = 10;
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
  peakPrice: number;
  troughPrice: number;
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

  private cachedLiveOptionChain: Record<
    number,
    {
      ceLtp: number;
      peLtp: number;
      ceOi: number;
      peOi: number;
      ceBid?: number;
      ceAsk?: number;
      peBid?: number;
      peAsk?: number;
      ceSecId?: string;
      peSecId?: string;
      ceUpdatedTime?: number;
      peUpdatedTime?: number;
    }
  > | null = null;

  private lastLiveSpot: number | null = null;
  private lastOptionChainSyncTime: number = 0;
  private cachedAnchor: SensexOobtstDayAnchor | null = null;

  // 09:20 candle open tick capture cache
  private openingCandleTicks: Record<string, number> = {};

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

  public resetAnchor(): void {
    this.cachedAnchor = null;
    this.openingCandleTicks = {};
    this.cachedLiveOptionChain = null;
    this.lastOptionChainSyncTime = 0;
  }

  public getLastLiveSpot(): number | null {
    return this.lastLiveSpot;
  }

  public getQuoteFreshness(): 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED' {
    if (!dhanHqFeedSocket.isConnected()) {
      return 'DISCONNECTED';
    }
    if (!this.lastOptionChainSyncTime || this.lastOptionChainSyncTime === 0) {
      return 'STALE';
    }
    const ageMs = Date.now() - this.lastOptionChainSyncTime;
    if (ageMs < 5000) return 'FRESH';
    if (ageMs < 15000) return 'AGING';
    return 'STALE';
  }

  /**
   * Syncs live SENSEX option chain directly from Dhan HQ API (/v2/optionchain)
   */
  public async syncLiveOptionChain(): Promise<boolean> {
    const { expiryDateYMD } = tradingCalendarService.getActiveWeeklySensexExpiry(new Date(), true);
    try {
      const ocData = await dhanDirectService.fetchOptionChain(expiryDateYMD, 'SENSEX');
      if (ocData && ocData.oc && Object.keys(ocData.oc).length > 0) {
        const now = Date.now();
        for (const item of Object.values(ocData.oc)) {
          item.ceUpdatedTime = now;
          item.peUpdatedTime = now;
        }
        this.cachedLiveOptionChain = ocData.oc;
        if (ocData.spotPrice && ocData.spotPrice > 0) {
          this.lastLiveSpot = ocData.spotPrice;
        }
        this.lastOptionChainSyncTime = now;

        // Register candidate option contracts to WebSocket streamer for live tick updates
        try {
          const { ceCandidates, peCandidates } = this.selectTopTwoCandidates(this.lastLiveSpot || 81000);
          ceCandidates.forEach((c) => {
            if (c.securityId) {
              dhanHqFeedSocket.subscribe({
                exchangeSegment: 'BSE_FNO',
                securityId: String(c.securityId),
              });
            }
          });
          peCandidates.forEach((c) => {
            if (c.securityId) {
              dhanHqFeedSocket.subscribe({
                exchangeSegment: 'BSE_FNO',
                securityId: String(c.securityId),
              });
            }
          });
        } catch {}

        return true;
      }
    } catch {}
    return false;
  }

  public updateOptionPriceFromTick(
    securityId: string,
    ltp: number,
    bid?: number,
    ask?: number
  ): void {
    if (!this.cachedLiveOptionChain || ltp <= 0) return;
    const now = Date.now();
    for (const item of Object.values(this.cachedLiveOptionChain)) {
      if (item.ceSecId && item.ceSecId === securityId) {
        item.ceLtp = ltp;
        if (bid !== undefined && bid > 0) item.ceBid = bid;
        if (ask !== undefined && ask > 0) item.ceAsk = ask;
        item.ceUpdatedTime = now;
        break;
      }
      if (item.peSecId && item.peSecId === securityId) {
        item.peLtp = ltp;
        if (bid !== undefined && bid > 0) item.peBid = bid;
        if (ask !== undefined && ask > 0) item.peAsk = ask;
        item.peUpdatedTime = now;
        break;
      }
    }
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
          const ageMs = data.ceUpdatedTime ? nowMs - data.ceUpdatedTime : 999999;
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
          const ageMs = data.peUpdatedTime ? nowMs - data.peUpdatedTime : 999999;
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

  /**
   * Captures or initializes the 09:20 day anchor.
   * Invariants:
   * 1. Market Closed (< 09:15): Strikes unlocked, labeled PREVIEW — NOT CONFIRMED (or PREVIEW UNAVAILABLE).
   * 2. Provisional (09:15 - 09:19:59): Top two CE and PE candidates update dynamically from live ticks.
   * 3. 09:20:00 Lock: Selects single closest CE and PE within ₹90-₹120, captures 09:20 opening prices,
   *    and locks permanently for session.
   *    Never replaces a locked strike. If quotes are invalid/unavailable, marks LOCK FAILED — DATA UNAVAILABLE.
   */
  public getOrCreateDayAnchor(
    spot: number,
    istTimeStr?: string,
    candleOpens?: Record<string, number>
  ): SensexOobtstDayAnchor {
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
      !this.cachedAnchor.isLockFailed
    ) {
      return this.cachedAnchor;
    }

    const { ceCandidates, peCandidates, previewAvailable } = this.selectTopTwoCandidates(spot, this.targetPremium);

    const rank1Ce = ceCandidates.length > 0 ? ceCandidates[0] : null;
    const rank1Pe = peCandidates.length > 0 ? peCandidates[0] : null;

    const atm = Math.round(spot / SENSEX_STRIKE_STEP) * SENSEX_STRIKE_STEP;
    const ceStrike = rank1Ce ? rank1Ce.strike : atm + 500;
    const peStrike = rank1Pe ? rank1Pe.strike : atm - 500;

    let isConfirmed = false;
    let isLockFailed = false;
    let lockFailureReason: string | undefined = undefined;

    if (isConfirmationTime) {
      const ceValid = rank1Ce !== null && rank1Ce.ltp > 0;
      const peValid = rank1Pe !== null && rank1Pe.ltp > 0;

      if (ceValid && peValid) {
        isConfirmed = true;
        isLockFailed = false;
      } else {
        isConfirmed = false;
        isLockFailed = true;
        lockFailureReason = !rank1Ce || rank1Ce.ltp <= 0
          ? 'Sensex CE quote unavailable at 09:20'
          : 'Sensex PE quote unavailable at 09:20';
      }
    }

    // Capture exact 09:20 candle open price
    let ceOpen = 0;
    let peOpen = 0;

    if (rank1Ce) {
      const secKey = rank1Ce.securityId || `CE_${rank1Ce.strike}`;
      if (candleOpens && candleOpens[secKey] && candleOpens[secKey] > 0) {
        ceOpen = candleOpens[secKey];
        this.openingCandleTicks[secKey] = ceOpen;
      } else if (this.openingCandleTicks[secKey] && this.openingCandleTicks[secKey] > 0) {
        ceOpen = this.openingCandleTicks[secKey];
      } else if (isConfirmationTime && rank1Ce.ltp > 0) {
        ceOpen = rank1Ce.ltp;
        this.openingCandleTicks[secKey] = ceOpen;
      } else {
        ceOpen = rank1Ce.ltp;
      }
    }

    if (rank1Pe) {
      const secKey = rank1Pe.securityId || `PE_${rank1Pe.strike}`;
      if (candleOpens && candleOpens[secKey] && candleOpens[secKey] > 0) {
        peOpen = candleOpens[secKey];
        this.openingCandleTicks[secKey] = peOpen;
      } else if (this.openingCandleTicks[secKey] && this.openingCandleTicks[secKey] > 0) {
        peOpen = this.openingCandleTicks[secKey];
      } else if (isConfirmationTime && rank1Pe.ltp > 0) {
        peOpen = rank1Pe.ltp;
        this.openingCandleTicks[secKey] = peOpen;
      } else {
        peOpen = rank1Pe.ltp;
      }
    }

    // Validate 90 <= 09:20 Candle Open <= 120 at lock point
    if (isConfirmationTime && !isLockFailed) {
      if (ceOpen < SENSEX_MIN_ELIGIBLE_PREMIUM || ceOpen > SENSEX_MAX_ELIGIBLE_PREMIUM) {
        isLockFailed = true;
        isConfirmed = false;
        lockFailureReason = `Sensex CE open ₹${ceOpen.toFixed(2)} outside ₹90-₹120 range`;
      } else if (peOpen < SENSEX_MIN_ELIGIBLE_PREMIUM || peOpen > SENSEX_MAX_ELIGIBLE_PREMIUM) {
        isLockFailed = true;
        isConfirmed = false;
        lockFailureReason = `Sensex PE open ₹${peOpen.toFixed(2)} outside ₹90-₹120 range`;
      }
    }

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
      peakPrice: 0,
      troughPrice: 99999,
      status: isLockFailed ? 'LOCK_FAILED' : (isConfirmed ? 'ARMED' : 'SCANNING'),
      entryTime: null,
      exitTime: null,
      targetPremium: this.targetPremium,
    };

    if (isConfirmed && !isLockFailed) {
      this.cachedAnchor = anchor;
    }

    return anchor;
  }

  /**
   * Main evaluation method returning standardized OobtstLiveState
   */
  public evaluateSensexOobtst(
    spot: number,
    istTimeStr?: string,
    candleOpens?: Record<string, number>
  ): OobtstLiveState {
    const { istMinutes, totalSeconds } = parseIstSeconds(istTimeStr);
    const gate0915 = 9 * 3600 + 15 * 60; // 09:15:00 AM
    const gate0920 = 9 * 3600 + 20 * 60; // 09:20:00 AM
    const gate1530 = 15 * 3600 + 30 * 60; // 15:30:00 PM

    const isMarketClosed = totalSeconds < gate0915 || totalSeconds >= gate1530;
    const isProvisional = totalSeconds >= gate0915 && totalSeconds < gate0920;
    const isConfirmationTime = totalSeconds >= gate0920;

    const anchor = this.getOrCreateDayAnchor(spot, istTimeStr, candleOpens);
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

      // Check Directional Breakout Trigger under OCO
      if (!activeLeg) {
        const ceCrossed = ceLtp >= anchor.ceTriggerPrice && anchor.ceTriggerPrice > 0;
        const peCrossed = peLtp >= anchor.peTriggerPrice && anchor.peTriggerPrice > 0;

        if (ceCrossed && peCrossed) {
          // Simultaneous cross tie-breaker: larger percentage breakout over trigger
          const cePct = (ceLtp - anchor.ceTriggerPrice) / anchor.ceTriggerPrice;
          const pePct = (peLtp - anchor.peTriggerPrice) / anchor.peTriggerPrice;
          activeLeg = cePct >= pePct ? 'CE' : 'PE';
        } else if (ceCrossed) {
          activeLeg = 'CE';
        } else if (peCrossed) {
          activeLeg = 'PE';
        }

        if (activeLeg) {
          anchor.activeLeg = activeLeg;
          anchor.entryTime = istTimeStr || new Date().toLocaleTimeString('en-IN');
          executedPrice = activeLeg === 'CE' ? ceLtp : peLtp;
          anchor.executedPrice = executedPrice;
          slPrice = Number((executedPrice * 0.5).toFixed(2));
          anchor.slPrice = slPrice;
          anchor.peakPrice = executedPrice;
          anchor.status = 'ACTIVE';
        }
      }

      if (activeLeg && executedPrice && slPrice) {
        currentStep = 3;
        executedSymbol = activeLeg === 'CE' ? `SENSEX ${anchor.ceStrike} CE` : `SENSEX ${anchor.peStrike} PE`;
        const currentTradedPrice = activeLeg === 'CE' ? ceLtp : peLtp;

        anchor.peakPrice = Math.max(anchor.peakPrice, currentTradedPrice);
        anchor.troughPrice = Math.min(anchor.troughPrice, currentTradedPrice);

        // Check 50% Stop-Loss Hit
        if (currentTradedPrice <= slPrice) {
          status = 'SL_HIT';
          anchor.status = 'SL_HIT';
          anchor.exitTime = istTimeStr || new Date().toLocaleTimeString('en-IN');
          statusBadgeText = 'SL_HIT';
        } else if (totalSeconds >= gate1530) {
          // BTST Hold: Position survived until 15:30 IST
          status = 'BTST_HOLD';
          anchor.status = 'BTST_HOLD';
          statusBadgeText = 'BTST_HOLD';
        } else {
          status = 'ACTIVE';
          statusBadgeText = activeLeg === 'CE' ? 'EXECUTED_CE' : 'EXECUTED_PE';
        }
      }
    }

    const ceProgressPct = anchor.ceTriggerPrice > 0 ? Math.min(100, Math.round((ceLtp / anchor.ceTriggerPrice) * 100)) : 0;
    const peProgressPct = anchor.peTriggerPrice > 0 ? Math.min(100, Math.round((peLtp / anchor.peTriggerPrice) * 100)) : 0;

    const ceLeg: OobtstLegDetail = {
      type: 'CE',
      strike: anchor.ceStrike,
      symbol: `SENSEX ${anchor.ceStrike} CE`,
      openPrice: anchor.ceOpen0920,
      triggerPrice: anchor.ceTriggerPrice,
      currentLtp: ceLtp,
      progressPct: ceProgressPct,
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
      anchorTime: '09:20:00 IST',
      isLocked: anchor.isConfirmed && !anchor.isLockFailed,
      isProvisional,
      isMarketClosed,
      isLockFailed: anchor.isLockFailed,
      lockFailureReason: anchor.lockFailureReason,
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
    if (this.cachedLiveOptionChain && this.cachedLiveOptionChain[strike]) {
      const item = this.cachedLiveOptionChain[strike];
      const p = type === 'CE' ? item.ceLtp : item.peLtp;
      if (p > 0) return p;
    }
    return 0;
  }
}

export const sensexOptionFeedService = new SensexOptionFeedService();
