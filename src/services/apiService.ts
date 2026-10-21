import { API_CONFIG } from '../config/apiConfig';
import {
  StockRadarItem,
  NiftyOvernightState,
  NiftyBreakout180State,
  TacticalStrikeSuggestion,
  SignalJournalItem,
  MarketSessionStatus,
} from '../types/mobile';
import { SENSEX_NIFTY_MASTER_CATALOG } from '../constants/stockUniverse';
import { dhanDirectService } from './dhanDirectService';
import { niftyOptionFeedService, getActiveWeeklyExpiry } from './niftyOptionFeedService';
import { isTradingDay } from '../constants/nseHolidays';

export function isMarketSessionBeforeOpen(): boolean {
  const now = new Date();
  const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
  const istMinutes = (now.getUTCMinutes() + 30) % 60;
  const totalMinutes = istHours * 60 + istMinutes;
  // Continuous trading session is 09:15 - 15:30 IST (555 to 930 mins).
  // Before 09:15 AM on any day, trading has not started, volume is strictly 0.
  return totalMinutes < 555;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const customUrl = (process.env as Record<string, string | undefined>)?.EXPO_PUBLIC_API_URL;
  if (!customUrl) {
    throw new Error('Using direct Dhan HQ API (zero middleman mode)');
  }
  const url = `${API_CONFIG.BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Server returned status: ${res.status}`);
    }

    return await res.json();
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }
}

export const apiService = {
  // 1. Market Session & Status
  async fetchMarketSession(): Promise<{ status: MarketSessionStatus; istTime: string; isTradingDay: boolean }> {
    try {
      const data = await request<any>(API_CONFIG.ENDPOINTS.MARKET_SESSION);
      return data;
    } catch {
      const now = new Date();
      const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
      const istMinutes = (now.getUTCMinutes() + 30) % 60;
      const istTimeStr = `${String(istHours).padStart(2, '0')}:${String(istMinutes).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
      
      const totalMinutes = istHours * 60 + istMinutes;
      let status: MarketSessionStatus = 'CLOSED';
      if (totalMinutes >= 540 && totalMinutes < 555) status = 'PRE_MARKET';
      else if (totalMinutes >= 555 && totalMinutes < 556) status = 'STABILIZING';
      else if (totalMinutes >= 556 && totalMinutes < 930) status = 'REGULAR_HOURS';
      else if (totalMinutes >= 930 && totalMinutes < 935) status = 'POST_MARKET';

      return { status, istTime: istTimeStr, isTradingDay: true };
    }
  },

  // 2. Strategy 1: 20D Volume Crossover Screener (All SENSEX & NIFTY 50 Stocks)
  async fetchStockRadarList(): Promise<StockRadarItem[]> {
    const isBeforeOpen = isMarketSessionBeforeOpen() || !isTradingDay(new Date());

    // Priority 1: Direct Mobile-to-Dhan HQ Live Market Feed (Official Data API Plan)
    await dhanDirectService.initialize();
    let liveQuotes: Record<string, any> = {};

    if (dhanDirectService.isConfigured()) {
      try {
        const allTickers = SENSEX_NIFTY_MASTER_CATALOG.map((s) => s.ticker);
        liveQuotes = await dhanDirectService.fetchDirectBatchQuotes(allTickers);
      } catch (dhanErr: any) {
        console.warn('[ApiService] Direct Dhan Data API quote fetch error:', dhanErr?.message);
      }
    }

    return SENSEX_NIFTY_MASTER_CATALOG.map((m) => {
      const q = liveQuotes[m.ticker];
      const isLiveQuote = Boolean(q && q.ltp > 0);
      const spotPrice = isLiveQuote ? q.ltp : m.approxLtp;
      const dayOpen = q && q.open > 0 ? q.open : spotPrice;
      const dayHigh = q && q.high > 0 ? q.high : spotPrice;
      const dayLow = q && q.low > 0 ? q.low : spotPrice;
      const todayShares = (q && q.volume > 0) ? q.volume : 0;
      const avgShares = m.avg20DTradedShares || 1;
      const ratio = todayShares > 0 ? +(todayShares / avgShares).toFixed(3) : 0;
      const hasCrossed = todayShares >= avgShares && todayShares > 0;
      // Resolve authentic prevClose from quote, without rejecting close === spotPrice
      let prevClose = (q && q.prevClose && q.prevClose > 0) ? q.prevClose : undefined;
      if (!prevClose && q && q.close && q.close > 0) {
        prevClose = q.close;
      }
      if (!prevClose && m.prevClose > 0) {
        prevClose = m.prevClose;
      }

      const pctChange = (prevClose && prevClose > 0 && spotPrice > 0)
        ? +(((spotPrice - prevClose) / prevClose) * 100).toFixed(2)
        : (q && q.changePercent !== undefined ? q.changePercent : 0);
      const isBullish = pctChange >= 0 || spotPrice >= dayOpen;

      let circleIndicator: 'GREEN' | 'RED' | 'AMBER' | 'GREY' = 'GREY';
      if (hasCrossed) {
        circleIndicator = isBullish ? 'GREEN' : 'RED';
      } else if (ratio >= 0.8) {
        circleIndicator = 'AMBER';
      }

      return {
        ticker: m.ticker,
        name: m.name,
        exchange: 'NSE',
        sector: m.sector,
        indices: m.indices,
        spotPrice,
        prevClose,
        dayOpen,
        dayHigh,
        dayLow,
        percentChange: pctChange,
        todayTradedShares: todayShares,
        avg20DTradedShares: avgShares,
        volumeRatio: ratio,
        hasCrossed20D: hasCrossed,
        crossoverTime: hasCrossed ? (q?.lastUpdated || new Date().toLocaleTimeString('en-IN')) : undefined,
        crossoverDirection: isBullish ? 'BULLISH' : 'BEARISH',
        circleIndicator,
        strikeStep: m.strikeStep,
        lotSize: m.lotSize,
        isLiveQuote,
      };
    });
  },

  // 3. Strategy 2: NIFTY 09:20 Overnight (62.5)
  async fetchNiftyOvernightState(): Promise<NiftyOvernightState> {
    await dhanDirectService.initialize();
    await niftyOptionFeedService.loadPersistedAnchor();
    let spot = 0;

    try {
      const indexQuote = await dhanDirectService.fetchNiftyIndexQuote();
      if (indexQuote && indexQuote.ltp > 0) {
        spot = indexQuote.ltp;
      }
    } catch {}

    if (spot === 0) {
      spot = 24350.0; // fallback to approximate prevailing Nifty index level if feed is offline
    }

    // Sync live option chain from Dhan HQ API (/v2/optionchain)
    try {
      await niftyOptionFeedService.syncLiveOptionChain();
    } catch {}

    try {
      const data = await request<any>(API_CONFIG.ENDPOINTS.NIFTY_OVERNIGHT);
      if (data && data.state) return data.state;
    } catch {}

    let istTimeStr: string | undefined;
    try {
      const session = await this.fetchMarketSession();
      istTimeStr = session.istTime;
    } catch {}

    const oobtst = niftyOptionFeedService.evaluateOobtst(spot, istTimeStr);

    return {
      strategyId: 'NIFTY_0920_PREMIUM_625_OVERNIGHT',
      tradeDate: new Date().toISOString().split('T')[0],
      selectedExpiry: oobtst.expiryDate,
      isExpiryOverridden: false,
      status: oobtst.status === 'BTST_HOLD' ? 'OVERNIGHT_HOLD' : oobtst.status === 'ACTIVE' ? 'ACTIVE_HOLD' : 'SCANNING',
      ceLeg: {
        type: 'CE',
        strike: oobtst.ceLeg.strike,
        expiry: oobtst.expiryDate,
        referencePrice: oobtst.ceLeg.openPrice,
        currentPrice: oobtst.ceLeg.currentLtp,
        stopLoss: +(oobtst.ceLeg.openPrice * 0.75).toFixed(2),
        status: oobtst.ceLeg.status === 'SL_HIT' ? 'SL_HIT' : 'ACTIVE',
      },
      peLeg: {
        type: 'PE',
        strike: oobtst.peLeg.strike,
        expiry: oobtst.expiryDate,
        referencePrice: oobtst.peLeg.openPrice,
        currentPrice: oobtst.peLeg.currentLtp,
        stopLoss: +(oobtst.peLeg.openPrice * 0.75).toFixed(2),
        status: oobtst.peLeg.status === 'SL_HIT' ? 'SL_HIT' : 'ACTIVE',
      },
      netPointsPnl: +(oobtst.pnlPerShare ?? 0),
      lastUpdated: oobtst.lastUpdated,
    };
  },

  // 4. Strategy 3: NIFTY 09:25 ₹180 Breakout
  async fetchNiftyBreakout180State(): Promise<NiftyBreakout180State> {
    await niftyOptionFeedService.loadPersistedBreakoutState();
    try {
      const data = await request<any>(API_CONFIG.ENDPOINTS.NIFTY_BREAKOUT_180);
      if (data && data.state) return data.state;
    } catch {}

    let spot = 0;
    try {
      const indexQuote = await dhanDirectService.fetchNiftyIndexQuote();
      if (indexQuote && indexQuote.ltp > 0) {
        spot = indexQuote.ltp;
      }
    } catch {}

    return niftyOptionFeedService.evaluateBreakout180(spot);
  },

  // 5. Tactical Strike Calculation for Strategy 1
  calculateTacticalStrike(stock: StockRadarItem): TacticalStrikeSuggestion {
    const step = stock.strikeStep || 50;
    const atmStrike = Math.round(stock.spotPrice / step) * step;

    // In pre-market before 09:15, trading hasn't started yet.
    // When market is closed/post-market, provide estimated ~2% ATM premium baseline for analysis.
    const isMarketBeforeOpen = isMarketSessionBeforeOpen();
    const estAtmPremium = stock.spotPrice > 0 ? +(stock.spotPrice * 0.02).toFixed(2) : 0;
    const liveCePrem = isMarketBeforeOpen ? 0 : estAtmPremium;
    const livePePrem = isMarketBeforeOpen ? 0 : estAtmPremium;

    return {
      underlying: stock.ticker,
      spotLtp: stock.spotPrice,
      recommendedCeStrike: atmStrike,
      recommendedPeStrike: atmStrike,
      estimatedCePremium: liveCePrem,
      estimatedPePremium: livePePrem,
      ceStopLoss: liveCePrem > 0 ? +(liveCePrem * 0.80).toFixed(2) : 0,
      ceTarget1: liveCePrem > 0 ? +(liveCePrem * 1.40).toFixed(2) : 0,
      cePiTarget1: liveCePrem > 0 ? +(liveCePrem * 1.031416).toFixed(2) : 0,
      cePiTarget2: liveCePrem > 0 ? +(liveCePrem * 1.062832).toFixed(2) : 0,
      peStopLoss: livePePrem > 0 ? +(livePePrem * 0.80).toFixed(2) : 0,
      peTarget1: livePePrem > 0 ? +(livePePrem * 1.40).toFixed(2) : 0,
    };
  },
};

