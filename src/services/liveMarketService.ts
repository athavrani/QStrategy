// =====================================================================
// QStrategy — Institutional Live Option Chain Service
// Direct Mobile-to-Dhan HQ Data API Engine (Zero Middleman)
// Official DhanHQ Data API /v2/optionchain Integration
// =====================================================================

import { niftyOptionFeedService } from './niftyOptionFeedService';
import { dhanDirectService } from './dhanDirectService';

export interface OptionStrikeRow {
  strikePrice: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  callSymbol: string;
  callLtp: number;
  callBid?: number;
  callAsk?: number;
  callOi: number;
  callIvPct: number;
  putSymbol: string;
  putLtp: number;
  putBid?: number;
  putAsk?: number;
  putOi: number;
  putIvPct: number;
  isOobtstCe?: boolean;
  isOobtstPe?: boolean;
}

export interface LiveOptionChainSummary {
  underlying: string;
  spotPrice: number;
  atmStrike: number;
  expiryDate: string;
  daysToExpiry: number;
  pcrRatio: number;
  totalCallOi: number;
  totalPutOi: number;
  isExpiryDay?: boolean;
  rolledToNextExpiry?: boolean;
  wasPreponed?: boolean;
  holidayReason?: string;
  originalScheduledStr?: string;
  oobtstCeStrike?: number;
  oobtstPeStrike?: number;
  oobtstCeOpen?: number;
  oobtstPeOpen?: number;
  isLiveMarketData?: boolean;
  dataSource?: 'DHAN_LIVE' | 'OFFLINE';
  lastSyncTime?: number;
  strikes: OptionStrikeRow[];
}

export const liveMarketService = {
  // 1. Fetch live quotes for batch of tickers via direct DhanHQ Data API
  async fetchLiveQuotes(tickers?: string[]): Promise<Record<string, any>> {
    if (!tickers || tickers.length === 0) return {};
    try {
      return await dhanDirectService.fetchDirectBatchQuotes(tickers);
    } catch {
      return {};
    }
  },

  // 2. Fetch live multi-strike option chain directly from Dhan HQ Data API
  async fetchLiveOptionChain(
    ticker: string = 'NIFTY',
    spotLtp: number = 0,
    strikeStep: number = 50,
    forOobtst: boolean = true
  ): Promise<LiveOptionChainSummary> {
    // 1. Sync live option chain from Dhan HQ API (/v2/optionchain)
    try {
      await niftyOptionFeedService.syncLiveOptionChain(ticker);
    } catch {}

    // 2. Resolve live spot price
    let resolvedSpot = spotLtp;
    const lastLiveSpot = niftyOptionFeedService.getLastLiveSpot();
    if (lastLiveSpot && lastLiveSpot > 0 && (!resolvedSpot || resolvedSpot <= 0)) {
      resolvedSpot = lastLiveSpot;
    } else if (!resolvedSpot || resolvedSpot <= 0) {
      try {
        const quote = await dhanDirectService.fetchNiftyIndexQuote();
        if (quote && quote.ltp > 0) {
          resolvedSpot = quote.ltp;
        }
      } catch {}
    }

    // 3. Generate option chain matrix overlaid with live Dhan exchange data
    const localMatrix = niftyOptionFeedService.generateLiveOptionChainMatrix(
      resolvedSpot,
      strikeStep,
      12,
      forOobtst
    );

    return localMatrix as LiveOptionChainSummary;
  },
};
