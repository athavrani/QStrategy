import { create } from 'zustand';
import {
  StockRadarItem,
  NiftyOvernightState,
  NiftyBreakout180State,
  TacticalStrikeSuggestion,
  MarketSessionStatus,
  SignalJournalItem,
} from '../types/mobile';
import { apiService } from '../services/apiService';
import { alertLatchService } from '../services/alertLatchService';
import { notificationService } from '../services/notificationService';
import { dhanDirectService } from '../services/dhanDirectService';
import { dhanHqFeedSocket } from '../services/dhan/DhanHqFeedSocket';
import { InstrumentSubscription, DhanFeedResponseCode } from '../services/dhan/DhanBinaryCodec';
import {
  DHAN_SECURITY_MAP,
  DHAN_NIFTY_INDEX_ID,
  DHAN_BANKNIFTY_INDEX_ID,
  DHAN_FINNIFTY_INDEX_ID,
  DHAN_SENSEX_INDEX_ID,
  getDhanSecurityId,
} from '../constants/dhanSecurityMaster';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { OobtstLiveState } from '../strategies/types';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { resolvePrevClose, safeChangePct } from '../utils/marketDataUtils';
import { avgVolumeService } from '../services/AvgVolumeService';

interface RadarStoreState {
  // Market Global State
  sessionDate: string;
  marketStatus: MarketSessionStatus;
  istTime: string;
  isRefreshing: boolean;
  latchServiceInitialized: boolean;
  niftySpot: number;
  bankNiftySpot: number;
  finNiftySpot: number;
  sensexSpot: number;
  feedStatus: 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR' | 'UNCONFIGURED';
  lastTickTime: string | null;

  // Strategy 1: 20D Volume Screener
  stocks: StockRadarItem[];
  selectedStock: StockRadarItem | null;
  tacticalStrike: TacticalStrikeSuggestion | null;

  // Strategy 2: NIFTY 09:20 Overnight (62.5)
  niftyOvernight: NiftyOvernightState | null;
  oobtstState: OobtstLiveState | null;
  oobtstTargetPremium: number;

  // Strategy 3: NIFTY 09:25 Breakout
  niftyBreakout180: NiftyBreakout180State | null;
  breakoutThreshold: number;

  // Strategy 4: SENSEX 09:20 OOBTST
  sensexOobtstState: OobtstLiveState | null;
  sensexOobtstTargetPremium: number;

  // Audit Journal
  journal: SignalJournalItem[];
  signalsTodayCount: number;
  netPointsCaptured: number;

  // Streamer Engine
  isStreamerInitialized: boolean;

  // Actions
  initStreamer: () => void;
  refreshAll: (isManual?: boolean) => Promise<void>;
  selectStock: (ticker: string) => void;
  clearSelectedStock: () => void;
  setIstTime: (timeStr: string) => void;
  setOobtstTargetPremium: (target: number) => Promise<boolean>;
  setBreakoutThreshold: (target: number) => Promise<boolean>;
  setSensexOobtstTargetPremium: (target: number) => Promise<boolean>;
}

export const useRadarStore = create<RadarStoreState>((set, get) => ({
  sessionDate: formatDateKeyIST(),
  marketStatus: 'REGULAR_HOURS',
  istTime: '--:--:--',
  isRefreshing: false,
  latchServiceInitialized: false,
  niftySpot: 0,
  bankNiftySpot: 0,
  finNiftySpot: 0,
  sensexSpot: 0,
  feedStatus: 'CONNECTING',
  lastTickTime: null,
  isStreamerInitialized: false,

  stocks: [],
  selectedStock: null,
  tacticalStrike: null,

  niftyOvernight: null,
  oobtstState: null,
  oobtstTargetPremium: 62.50,
  niftyBreakout180: null,
  breakoutThreshold: 180.00,
  sensexOobtstState: null,
  sensexOobtstTargetPremium: 100.00,

  journal: [],
  signalsTodayCount: 0,
  netPointsCaptured: 0,

  refreshAll: async (isManual = false) => {
    // Only show pull-to-refresh spinner when user manually pulls down the list
    if (isManual) {
      set({ isRefreshing: true });
    }

    // Initialize Monotonic Alert Latch Guarantee if not already done
    if (!get().latchServiceInitialized) {
      await alertLatchService.initialize();
      set({ latchServiceInitialized: true });

      // Point 7.1: Restore session journal from persisted SQLite latches on startup
      if (get().journal.length === 0) {
        try {
          const latches = await alertLatchService.getAllSessionLatches();
          if (latches.length > 0) {
            const restoredJournal: SignalJournalItem[] = latches.map((item, idx) => {
              const strategyId = item.strategyId || '20D_CROSSOVER';
              if (strategyId === 'NIFTY_BREAKOUT_180') {
                return {
                  id: `sig-restored-breakout-${idx}-${item.crossoverTime}`,
                  timestamp: item.crossoverTime,
                  strategyId: 'NIFTY_BREAKOUT_180',
                  strategyName: 'NIFTY 09:25 ₹180 Breakout',
                  symbol: item.ticker.startsWith('NIFTY') ? item.ticker : `NIFTY ${item.ticker}`,
                  signalType: 'BUY' as const,
                  entryPrice: item.spotPrice || 180,
                  stopLoss: 160.00,
                  target: 220.00,
                  outcome: 'OPEN' as const,
                  notes: `🚀 09:25 Candle Open < ₹180 Breakout Triggered @ ₹${(item.spotPrice || 180).toFixed(2)}. Target: ₹220, SL: ₹160.`,
                };
              }
              if (strategyId === 'OOBTST_NIFTY') {
                return {
                  id: `sig-restored-oobtst-nifty-${idx}-${item.crossoverTime}`,
                  timestamp: item.crossoverTime,
                  strategyId: 'OOBTST_NIFTY',
                  strategyName: '09:20 OOBTST NIFTY',
                  symbol: item.ticker,
                  signalType: 'BUY' as const,
                  entryPrice: item.spotPrice,
                  stopLoss: +(item.spotPrice / 1.5).toFixed(2),
                  outcome: 'OPEN' as const,
                  notes: `⚡ 09:20 1.5X Trigger Breached for ${item.ticker} @ ₹${item.spotPrice.toFixed(2)}.`,
                };
              }
              if (strategyId === 'OOBTST_SENSEX') {
                return {
                  id: `sig-restored-oobtst-sensex-${idx}-${item.crossoverTime}`,
                  timestamp: item.crossoverTime,
                  strategyId: 'OOBTST_SENSEX',
                  strategyName: '09:20 OOBTST SENSEX',
                  symbol: item.ticker,
                  signalType: 'BUY' as const,
                  entryPrice: item.spotPrice,
                  stopLoss: +(item.spotPrice / 1.5).toFixed(2),
                  outcome: 'OPEN' as const,
                  notes: `⚡ Sensex 09:20 1.5X Trigger Breached for ${item.ticker} @ ₹${item.spotPrice.toFixed(2)}.`,
                };
              }
              // Default: 20D Volume Crossover
              const isGreen = item.state === 'GREEN';
              return {
                id: `sig-restored-crossover-${idx}-${item.crossoverTime}`,
                timestamp: item.crossoverTime,
                strategyId: '20D_CROSSOVER',
                strategyName: '20D Volume Crossover',
                symbol: item.ticker,
                signalType: (isGreen ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
                entryPrice: item.spotPrice,
                outcome: 'OPEN' as const,
                notes: isGreen
                  ? `🟢 Crossed 100% of 20D Avg (${(item.volumeRatio * 100).toFixed(1)}% Vol). Bullish LTP > Open.`
                  : `🔴 Crossed 100% of 20D Avg (${(item.volumeRatio * 100).toFixed(1)}% Vol). Bearish LTP < Open (Distribution).`,
              };
            });
            set({ journal: restoredJournal.reverse() });
          }
        } catch {}
      }
    }

    // Day rollover detection: if sessionDate !== today, reset daily caches & journal
    const todayIST = formatDateKeyIST();
    if (get().sessionDate !== todayIST) {
      niftyOptionFeedService.resetAnchor(true);
      niftyOptionFeedService.resetBreakout180(true);
      sensexOptionFeedService.resetAnchor(true);
      set({
        sessionDate: todayIST,
        journal: [],
        signalsTodayCount: 0,
        netPointsCaptured: 0,
        stocks: get().stocks.map((s) => ({
          ...s,
          todayTradedShares: 0,
          volumeRatio: 0,
          hasCrossed20D: false,
          crossoverTime: undefined,
          crossoverDirection: 'BULLISH',
          circleIndicator: 'GREY',
        })),
      });
    }

    // Daily 20D average volume & previous session close computation:
    // Runs on day change or first refresh of the day; served instantly from cache within same day.
    avgVolumeService.refreshAll(todayIST).then((avgMap) => {
      if (!avgMap || avgMap.size === 0) return;
      set((prev) => ({
        stocks: prev.stocks.map((s) => {
          const entry = avgMap.get(s.ticker.toUpperCase());
          if (!entry) return s;
          const newAvg = entry.avg20DVolume;
          const dynamicPrev = entry.prevClose || dhanDirectService.getPrevClose(s.ticker);
          const avgShares = (newAvg && newAvg > 0) ? newAvg : s.avg20DTradedShares;
          const updatedPrevClose = (dynamicPrev && dynamicPrev > 0) ? dynamicPrev : s.prevClose;
          const ratio = s.todayTradedShares > 0 ? +(s.todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = s.todayTradedShares >= avgShares && s.todayTradedShares > 0;
          const pctChange = (updatedPrevClose && updatedPrevClose > 0 && s.spotPrice > 0)
            ? safeChangePct(s.spotPrice, updatedPrevClose, s.percentChange)
            : s.percentChange;
          return {
            ...s,
            avg20DTradedShares: avgShares,
            prevClose: updatedPrevClose,
            percentChange: pctChange,
            volumeRatio: ratio,
            hasCrossed20D: hasCrossed,
          };
        }),
      }));
    }).catch(() => {
      // Silently fail — catalog static values remain as fallback
    });

    try {
      await niftyOptionFeedService.loadSavedTargetPremium();
      await niftyOptionFeedService.loadSavedBreakoutThreshold();
      await niftyOptionFeedService.loadPersistedAnchor();
      await niftyOptionFeedService.loadPersistedBreakoutState();
      await sensexOptionFeedService.loadSavedTargetPremium();
      await sensexOptionFeedService.loadPersistedAnchor();
      const [
        sessionRes,
        stocksRes,
        overnightRes,
        breakoutRes,
        niftyIndexQuoteRes,
        _chainRes,
        sensexIndexQuoteRes,
        _sensexChainRes,
        bankNiftyIndexQuoteRes,
        finNiftyIndexQuoteRes,
      ] =
        await Promise.allSettled([
          apiService.fetchMarketSession(),
          apiService.fetchStockRadarList(),
          apiService.fetchNiftyOvernightState(),
          apiService.fetchNiftyBreakout180State(),
          dhanDirectService.fetchNiftyIndexQuote(),
          niftyOptionFeedService.syncLiveOptionChain(),
          dhanDirectService.fetchSensexIndexQuote(),
          sensexOptionFeedService.syncLiveOptionChain(),
          dhanDirectService.fetchBankNiftyIndexQuote(),
          dhanDirectService.fetchFinNiftyIndexQuote(),
        ]);

      const session =
        sessionRes.status === 'fulfilled'
          ? sessionRes.value
          : {
              status: 'CLOSED' as const,
              istTime: new Date().toLocaleTimeString('en-IN'),
              isTradingDay: true,
            };
      const stocks = stocksRes.status === 'fulfilled' ? stocksRes.value : get().stocks;
      const overnight = overnightRes.status === 'fulfilled' ? overnightRes.value : get().niftyOvernight;
      const breakout = breakoutRes.status === 'fulfilled' ? breakoutRes.value : get().niftyBreakout180;
      const niftyIndexQuote = niftyIndexQuoteRes.status === 'fulfilled' ? niftyIndexQuoteRes.value : null;

      // Point 5.1: Monotonic Alert Latch Check & Journal Audit Recording
      // Process crossover triggers and fire notifications ONLY if unlatched for today's session
      const newJournalEntries: SignalJournalItem[] = [];

      for (const stock of stocks) {
        if (stock.hasCrossed20D && stock.todayTradedShares > 0) {
          if (stock.circleIndicator === 'GREEN') {
            const isLocked = alertLatchService.isAlertLatched(stock.ticker, 'GREEN');
            if (!isLocked) {
              const acquired = await alertLatchService.acquireAlertLatch(stock.ticker, 'GREEN', {
                spotPrice: stock.spotPrice,
                todayTradedShares: stock.todayTradedShares,
                avg20DTradedShares: stock.avg20DTradedShares,
                volumeRatio: stock.volumeRatio,
                crossoverTime: stock.crossoverTime,
              });
              if (acquired) {
                const tactical = apiService.calculateTacticalStrike(stock);
                notificationService.notify20DCrossover(
                  stock.ticker,
                  stock.volumeRatio,
                  stock.spotPrice,
                  tactical.recommendedCeStrike
                );
                newJournalEntries.push({
                  id: `sig-${stock.ticker}-${Date.now()}`,
                  timestamp: session.istTime || new Date().toLocaleTimeString('en-IN'),
                  strategyId: '20D_CROSSOVER',
                  strategyName: '20D Volume Crossover',
                  symbol: stock.ticker,
                  signalType: 'BUY',
                  entryPrice: stock.spotPrice,
                  outcome: 'OPEN',
                  notes: `🟢 Crossed 100% of 20D Avg (${(stock.volumeRatio * 100).toFixed(1)}% Vol). Bullish LTP > Open. Tactical: ${tactical.recommendedCeStrike} CE.`,
                });
              }
            }
          } else if (stock.circleIndicator === 'RED') {
            const isLocked = alertLatchService.isAlertLatched(stock.ticker, 'RED');
            if (!isLocked) {
              const acquired = await alertLatchService.acquireAlertLatch(stock.ticker, 'RED', {
                spotPrice: stock.spotPrice,
                todayTradedShares: stock.todayTradedShares,
                avg20DTradedShares: stock.avg20DTradedShares,
                volumeRatio: stock.volumeRatio,
                crossoverTime: stock.crossoverTime,
              });
              if (acquired) {
                newJournalEntries.push({
                  id: `sig-${stock.ticker}-${Date.now()}`,
                  timestamp: session.istTime || new Date().toLocaleTimeString('en-IN'),
                  strategyId: '20D_CROSSOVER',
                  strategyName: '20D Volume Crossover',
                  symbol: stock.ticker,
                  signalType: 'SELL',
                  entryPrice: stock.spotPrice,
                  outcome: 'OPEN',
                  notes: `🔴 Crossed 100% of 20D Avg (${(stock.volumeRatio * 100).toFixed(1)}% Vol). Bearish LTP < Open (Distribution).`,
                });
              }
            }
          }
        }
      }

      // Check for NIFTY Breakout 180 trigger journal logging and push notification
      if (breakout && breakout.status === 'IN_TRADE' && breakout.activeContract && breakout.ceCandidate && breakout.peCandidate) {
        const symbol = breakout.activeContract === 'CE' ? `${breakout.ceCandidate.strike} CE` : `${breakout.peCandidate.strike} PE`;
        const lockKey = `BREAKOUT_180_${symbol.replace(/\s+/g, '_')}`;
        if (!alertLatchService.isAlertLatched(lockKey, 'GREEN')) {
          const acquired = await alertLatchService.acquireAlertLatch(lockKey, 'GREEN', {
            spotPrice: breakout.currentPrice || 180,
            todayTradedShares: 0,
            avg20DTradedShares: 0,
            volumeRatio: 1,
            crossoverTime: breakout.entryTime || session.istTime,
            strategyId: 'NIFTY_BREAKOUT_180',
          });
          if (acquired) {
            notificationService.notify180BreakoutTriggered(
              breakout.activeContract,
              breakout.activeContract === 'CE' ? breakout.ceCandidate.strike : breakout.peCandidate.strike,
              breakout.entryPrice || 180,
              breakout.fixedTarget,
              breakout.fixedStopLoss
            );
            newJournalEntries.push({
              id: `sig-breakout-${Date.now()}`,
              timestamp: breakout.entryTime || session.istTime,
              strategyId: 'NIFTY_BREAKOUT_180',
              strategyName: 'NIFTY 09:25 ₹180 Breakout',
              symbol: `NIFTY ${symbol}`,
              signalType: 'BUY',
              entryPrice: breakout.entryPrice || 180,
              stopLoss: breakout.fixedStopLoss,
              target: breakout.fixedTarget,
              outcome: 'OPEN',
              notes: `🚀 09:25 Candle Open < ₹180 Breakout Triggered @ ₹${(breakout.entryPrice || 180).toFixed(2)}. Target: ₹220, SL: ₹160.`,
            });
          }
        }
      }

      const greenCount = stocks.filter((s) => s.hasCrossed20D && s.todayTradedShares > 0 && s.circleIndicator === 'GREEN').length;
      const redCount = stocks.filter((s) => s.hasCrossed20D && s.todayTradedShares > 0 && s.circleIndicator === 'RED').length;
      const telemetry = dhanDirectService.getTelemetry();

      const resolvedSpot = niftyIndexQuote && niftyIndexQuote.ltp > 0 ? niftyIndexQuote.ltp : get().niftySpot;
      const liveOobtst = niftyOptionFeedService.evaluateOobtst(resolvedSpot, session.istTime);

      const sensexIndexQuote = sensexIndexQuoteRes.status === 'fulfilled' ? sensexIndexQuoteRes.value : null;
      const resolvedSensexSpot = sensexIndexQuote && sensexIndexQuote.ltp > 0 ? sensexIndexQuote.ltp : (get().sensexSpot || 81000);
      const liveSensexOobtst = sensexOptionFeedService.evaluateSensexOobtst(resolvedSensexSpot, session.istTime);

      const bankNiftyIndexQuote = bankNiftyIndexQuoteRes.status === 'fulfilled' ? bankNiftyIndexQuoteRes.value : null;
      const resolvedBankNiftySpot = bankNiftyIndexQuote && bankNiftyIndexQuote.ltp > 0 ? bankNiftyIndexQuote.ltp : (get().bankNiftySpot || 51200);

      const finNiftyIndexQuote = finNiftyIndexQuoteRes.status === 'fulfilled' ? finNiftyIndexQuoteRes.value : null;
      const resolvedFinNiftySpot = finNiftyIndexQuote && finNiftyIndexQuote.ltp > 0 ? finNiftyIndexQuote.ltp : (get().finNiftySpot || 23800);

      // Check for NIFTY 09:20 OOBTST trigger latch and push alert
      if (liveOobtst && (liveOobtst.status === 'ACTIVE' || liveOobtst.status === 'BTST_HOLD') && liveOobtst.activeLeg) {
        const leg = liveOobtst.activeLeg === 'CE' ? liveOobtst.ceLeg : liveOobtst.peLeg;
        const lockKey = `OOBTST_NIFTY_${leg.symbol.replace(/\s+/g, '_')}`;
        if (!alertLatchService.isAlertLatched(lockKey, 'GREEN')) {
          const acquired = await alertLatchService.acquireAlertLatch(lockKey, 'GREEN', {
            spotPrice: leg.currentLtp || +(leg.openPrice * 1.5).toFixed(2),
            todayTradedShares: 0,
            avg20DTradedShares: 0,
            volumeRatio: 1,
            crossoverTime: liveOobtst.lastUpdated || session.istTime,
            strategyId: 'OOBTST_NIFTY',
          });
          if (acquired) {
            notificationService.notify0920StrangleEntry(
              liveOobtst.ceLeg.strike,
              liveOobtst.peLeg.strike,
              liveOobtst.ceLeg.openPrice,
              liveOobtst.peLeg.openPrice
            );
            newJournalEntries.push({
              id: `sig-oobtst-nifty-${Date.now()}`,
              timestamp: liveOobtst.lastUpdated || session.istTime || new Date().toLocaleTimeString('en-IN'),
              strategyId: 'OOBTST_NIFTY',
              strategyName: '09:20 OOBTST NIFTY',
              symbol: leg.symbol,
              signalType: 'BUY',
              entryPrice: +(leg.openPrice * 1.5).toFixed(2),
              stopLoss: leg.openPrice,
              outcome: 'OPEN',
              notes: `⚡ 09:20 1.5X Trigger Breached for ${leg.symbol} (Open: ₹${leg.openPrice.toFixed(2)}, Trigger: ₹${(leg.openPrice * 1.5).toFixed(2)}). SL: ₹${leg.openPrice.toFixed(2)}.`,
            });
          }
        }
      }

      // Check for SENSEX 09:20 OOBTST trigger latch and push alert
      if (liveSensexOobtst && (liveSensexOobtst.status === 'ACTIVE' || liveSensexOobtst.status === 'BTST_HOLD') && liveSensexOobtst.activeLeg) {
        const leg = liveSensexOobtst.activeLeg === 'CE' ? liveSensexOobtst.ceLeg : liveSensexOobtst.peLeg;
        const lockKey = `OOBTST_SENSEX_${leg.symbol.replace(/\s+/g, '_')}`;
        if (!alertLatchService.isAlertLatched(lockKey, 'GREEN')) {
          const acquired = await alertLatchService.acquireAlertLatch(lockKey, 'GREEN', {
            spotPrice: leg.currentLtp || +(leg.openPrice * 1.5).toFixed(2),
            todayTradedShares: 0,
            avg20DTradedShares: 0,
            volumeRatio: 1,
            crossoverTime: liveSensexOobtst.lastUpdated || session.istTime,
            strategyId: 'OOBTST_SENSEX',
          });
          if (acquired) {
            notificationService.notify0920StrangleEntry(
              liveSensexOobtst.ceLeg.strike,
              liveSensexOobtst.peLeg.strike,
              liveSensexOobtst.ceLeg.openPrice,
              liveSensexOobtst.peLeg.openPrice
            );
            newJournalEntries.push({
              id: `sig-oobtst-sensex-${Date.now()}`,
              timestamp: liveSensexOobtst.lastUpdated || session.istTime || new Date().toLocaleTimeString('en-IN'),
              strategyId: 'OOBTST_SENSEX',
              strategyName: '09:20 OOBTST SENSEX',
              symbol: leg.symbol,
              signalType: 'BUY',
              entryPrice: +(leg.openPrice * 1.5).toFixed(2),
              stopLoss: leg.openPrice,
              outcome: 'OPEN',
              notes: `⚡ Sensex 09:20 1.5X Trigger Breached for ${leg.symbol} (Open: ₹${leg.openPrice.toFixed(2)}, Trigger: ₹${(leg.openPrice * 1.5).toFixed(2)}). SL: ₹${leg.openPrice.toFixed(2)}.`,
            });
          }
        }
      }

      const isOvernightActive = overnight && (overnight.status === 'ACTIVE_HOLD' || overnight.status === 'OVERNIGHT_HOLD');
      const isBreakoutActive = breakout && breakout.status === 'IN_TRADE';
      const isSensexActive = liveSensexOobtst && (liveSensexOobtst.status === 'ACTIVE' || liveSensexOobtst.status === 'BTST_HOLD');
      const signalsTodayCount = Math.max(
        greenCount + redCount + (isOvernightActive ? 1 : 0) + (isBreakoutActive ? 1 : 0) + (isSensexActive ? 1 : 0),
        get().journal.length + newJournalEntries.length
      );

      set((prev) => {
        const existingMap = new Map(prev.stocks.map((s) => [s.ticker, s]));
        const mergedStocks = stocks.map((newStock) => {
          const existing = existingMap.get(newStock.ticker);
          if (!existing) return newStock;

          // Preserve live non-zero spot price against placeholder approxLtp
          const spotPrice = (newStock.isLiveQuote && newStock.spotPrice > 0)
            ? newStock.spotPrice
            : (existing.spotPrice > 0 ? existing.spotPrice : newStock.spotPrice);

          // Issue 4 Fix: Canonical previous close resolution with sanity validation
          const catalogBaseline = dhanDirectService.getPrevClose(newStock.ticker) || 0;
          const prevClose = resolvePrevClose(
            spotPrice,
            0,
            {
              close: newStock.prevClose && newStock.prevClose > 0 ? newStock.prevClose : undefined,
            },
            existing.prevClose && existing.prevClose > 0 ? existing.prevClose : 0,
            catalogBaseline
          );

          const dayOpen = (newStock.dayOpen && newStock.dayOpen > 0 && newStock.isLiveQuote)
            ? newStock.dayOpen
            : (existing.dayOpen && existing.dayOpen > 0 ? existing.dayOpen : spotPrice);

          const dayHigh = Math.max(newStock.dayHigh || 0, existing.dayHigh || 0, spotPrice);
          const dayLow = Math.min(
            newStock.dayLow > 0 ? newStock.dayLow : spotPrice,
            existing.dayLow > 0 ? existing.dayLow : spotPrice
          );

          // Traded volume: Monotonic guarantee, never overwrite live volume with 0
          const todayTradedShares = Math.max(newStock.todayTradedShares || 0, existing.todayTradedShares || 0);
          const cachedAvg = avgVolumeService.getCachedAvg(newStock.ticker);
          const avgShares = (cachedAvg && cachedAvg > 0)
            ? cachedAvg
            : (existing.avg20DTradedShares > 0 ? existing.avg20DTradedShares : (newStock.avg20DTradedShares || 1));
          const volumeRatio = todayTradedShares > 0 ? +(todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = todayTradedShares >= avgShares && todayTradedShares > 0;

          // Issue 3 Fix: Compute genuine price percentage change strictly with safe bounds (±25% max)
          const fallbackPct = existing.percentChange !== 0 ? existing.percentChange : newStock.percentChange;
          const percentChange = prevClose > 0
            ? safeChangePct(spotPrice, prevClose, fallbackPct)
            : fallbackPct;

          const isBullish = percentChange >= 0 || spotPrice >= dayOpen;
          let circleIndicator: 'GREEN' | 'RED' | 'AMBER' | 'GREY' = 'GREY';
          if (hasCrossed) {
            circleIndicator = isBullish ? 'GREEN' : 'RED';
          } else if (volumeRatio >= 0.8) {
            circleIndicator = 'AMBER';
          }

          return {
            ...newStock,
            spotPrice,
            prevClose,
            dayOpen,
            dayHigh,
            dayLow,
            percentChange,
            todayTradedShares,
            avg20DTradedShares: avgShares,
            volumeRatio,
            hasCrossed20D: hasCrossed,
            crossoverTime: hasCrossed ? (existing.crossoverTime || newStock.crossoverTime || new Date().toLocaleTimeString('en-IN')) : undefined,
            crossoverDirection: (isBullish ? 'BULLISH' : 'BEARISH') as 'BULLISH' | 'BEARISH',
            circleIndicator,
          };
        });

        return {
          marketStatus: session.status,
          istTime: session.istTime,
          stocks: mergedStocks,
          niftySpot: resolvedSpot,
          bankNiftySpot: resolvedBankNiftySpot,
          finNiftySpot: resolvedFinNiftySpot,
          sensexSpot: resolvedSensexSpot,
          niftyOvernight: overnight,
          oobtstState: liveOobtst,
          sensexOobtstState: liveSensexOobtst,
          niftyBreakout180: breakout,
          oobtstTargetPremium: niftyOptionFeedService.getTargetPremium(),
          breakoutThreshold: niftyOptionFeedService.getBreakoutThreshold(),
          sensexOobtstTargetPremium: sensexOptionFeedService.getTargetPremium(),
          signalsTodayCount,
          feedStatus: telemetry.status,
          lastTickTime: telemetry.lastTickTime || session.istTime,
          journal: newJournalEntries.length > 0 ? [...newJournalEntries, ...prev.journal] : prev.journal,
          isRefreshing: false,
        };
      });
    } catch {
      set({ isRefreshing: false });
    }
  },

  selectStock: (ticker: string) => {
    const stock = get().stocks.find((s) => s.ticker === ticker);
    if (!stock) return;
    const tactical = apiService.calculateTacticalStrike(stock);
    set({ selectedStock: stock, tacticalStrike: tactical });
  },

  clearSelectedStock: () => {
    set({ selectedStock: null, tacticalStrike: null });
  },

  setIstTime: (timeStr: string) => {
    set({ istTime: timeStr });
  },

  setOobtstTargetPremium: async (target: number) => {
    const ok = await niftyOptionFeedService.setTargetPremium(target);
    if (ok) {
      const spot = get().niftySpot || 24850;
      const ist = get().istTime !== '--:--:--' ? get().istTime : undefined;
      const updated = niftyOptionFeedService.evaluateOobtst(spot, ist);
      set({ oobtstTargetPremium: target, oobtstState: updated });
    }
    return ok;
  },

  setBreakoutThreshold: async (threshold: number) => {
    const ok = await niftyOptionFeedService.setBreakoutThreshold(threshold);
    if (ok) {
      const spot = get().niftySpot || 24850;
      const ist = get().istTime !== '--:--:--' ? get().istTime : undefined;
      const updated = niftyOptionFeedService.evaluateBreakout180(spot, ist);
      set({ breakoutThreshold: threshold, niftyBreakout180: updated });
    }
    return ok;
  },

  setSensexOobtstTargetPremium: async (target: number) => {
    const ok = await sensexOptionFeedService.setTargetPremium(target);
    if (ok) {
      const spot = get().sensexSpot || 81000;
      const ist = get().istTime !== '--:--:--' ? get().istTime : undefined;
      const updated = sensexOptionFeedService.evaluateSensexOobtst(spot, ist);
      set({ sensexOobtstTargetPremium: target, sensexOobtstState: updated });
    }
    return ok;
  },

  initStreamer: () => {
    if (get().isStreamerInitialized) return;
    set({ isStreamerInitialized: true });

    // 1. Batch subscribe to all 60 constituent stocks
    const subscriptions: InstrumentSubscription[] = Object.values(DHAN_SECURITY_MAP).map((meta) => ({
      exchangeSegment: 'NSE_EQ',
      securityId: meta.securityId,
    }));

    // 2. Add NIFTY 50, BANK NIFTY, FIN NIFTY, and SENSEX Spot Indices
    subscriptions.push({
      exchangeSegment: 'IDX_I',
      securityId: DHAN_NIFTY_INDEX_ID,
    });
    subscriptions.push({
      exchangeSegment: 'IDX_I',
      securityId: DHAN_BANKNIFTY_INDEX_ID,
    });
    subscriptions.push({
      exchangeSegment: 'IDX_I',
      securityId: DHAN_FINNIFTY_INDEX_ID,
    });
    subscriptions.push({
      exchangeSegment: 'IDX_I',
      securityId: DHAN_SENSEX_INDEX_ID,
    });

    // 3. Batch subscribe & start feed
    dhanHqFeedSocket.subscribeBatch(subscriptions);
    dhanHqFeedSocket.start();

    // 4. Register high-frequency 250ms micro-batch tick listener
    dhanHqFeedSocket.addTickListener((tickBatch) => {
      let hasChanged = false;
      let spotChanged = false;
      let newNiftySpot = get().niftySpot;

      // Check if NIFTY spot tick arrived
      const indexTick = tickBatch[DHAN_NIFTY_INDEX_ID];
      if (indexTick && 'ltp' in indexTick && indexTick.ltp > 0 && indexTick.ltp !== newNiftySpot) {
        newNiftySpot = indexTick.ltp;
        spotChanged = true;
        hasChanged = true;
      }

      // Check if BANK NIFTY spot tick arrived
      let bankNiftySpotChanged = false;
      let newBankNiftySpot = get().bankNiftySpot;
      const bankNiftyTick = tickBatch[DHAN_BANKNIFTY_INDEX_ID];
      if (bankNiftyTick && 'ltp' in bankNiftyTick && bankNiftyTick.ltp > 0 && bankNiftyTick.ltp !== newBankNiftySpot) {
        newBankNiftySpot = bankNiftyTick.ltp;
        bankNiftySpotChanged = true;
        hasChanged = true;
      }

      // Check if FIN NIFTY spot tick arrived
      let finNiftySpotChanged = false;
      let newFinNiftySpot = get().finNiftySpot;
      const finNiftyTick = tickBatch[DHAN_FINNIFTY_INDEX_ID];
      if (finNiftyTick && 'ltp' in finNiftyTick && finNiftyTick.ltp > 0 && finNiftyTick.ltp !== newFinNiftySpot) {
        newFinNiftySpot = finNiftyTick.ltp;
        finNiftySpotChanged = true;
        hasChanged = true;
      }

      // Check if SENSEX spot tick arrived
      let sensexSpotChanged = false;
      let newSensexSpot = get().sensexSpot;
      const sensexTick = tickBatch[DHAN_SENSEX_INDEX_ID];
      if (sensexTick && 'ltp' in sensexTick && sensexTick.ltp > 0 && sensexTick.ltp !== newSensexSpot) {
        newSensexSpot = sensexTick.ltp;
        sensexSpotChanged = true;
        hasChanged = true;
      }

      let derivativeTickArrived = false;
      let sensexDerivativeTickArrived = false;
      // Check if derivative ticks arrived (NSE_FNO = 2, BSE_FNO = 8)
      for (const tick of Object.values(tickBatch)) {
        if ('ltp' in tick && (tick.exchangeSegment === 2 || (tick as any).exchangeSegment === 'NSE_FNO')) {
          niftyOptionFeedService.updateOptionPriceFromTick(String(tick.securityId), tick.ltp);
          hasChanged = true;
          derivativeTickArrived = true;
        } else if ('ltp' in tick && (tick.exchangeSegment === 8 || (tick as any).exchangeSegment === 'BSE_FNO')) {
          sensexOptionFeedService.updateOptionPriceFromTick(String(tick.securityId), tick.ltp);
          hasChanged = true;
          sensexDerivativeTickArrived = true;
        }
      }

      const currentStocks = get().stocks;
      let updatedStocks = currentStocks;

      // Map ticks across constituent stocks if any are loaded
      if (currentStocks.length > 0) {
        let stockTickFound = false;
        const nextStocks = currentStocks.map((stock) => {
          const secId = getDhanSecurityId(stock.ticker);
          const tick = tickBatch[secId];
          if (!tick) return stock;

          let stockUpdated = false;

          // 1. Capture live LTP & official PrevClose
          const spotPrice = ('ltp' in tick && tick.ltp > 0) ? tick.ltp : stock.spotPrice;
          if ('ltp' in tick && tick.ltp > 0 && spotPrice !== stock.spotPrice) stockUpdated = true;

          let prevClose = stock.prevClose || dhanDirectService.getPrevClose(stock.ticker) || 0;
          if ('prevClose' in tick && tick.prevClose && tick.prevClose > 0) {
            prevClose = tick.prevClose;
            dhanDirectService.updatePrevClose(stock.ticker, prevClose, spotPrice);
            stockUpdated = true;
          } else if ('dayClose' in tick && tick.dayClose > 0 && prevClose <= 0 && tick.dayClose !== spotPrice) {
            prevClose = tick.dayClose;
            dhanDirectService.updatePrevClose(stock.ticker, prevClose, spotPrice);
            stockUpdated = true;
          }

          // 2. Capture day open, high, low from Quote
          const dayOpen = ('dayOpen' in tick && tick.dayOpen > 0) ? tick.dayOpen : stock.dayOpen;
          if ('dayOpen' in tick && tick.dayOpen > 0 && dayOpen !== stock.dayOpen) stockUpdated = true;

          const tickHigh = ('dayHigh' in tick && tick.dayHigh > 0) ? tick.dayHigh : 0;
          const tickLow = ('dayLow' in tick && tick.dayLow > 0) ? tick.dayLow : 0;
          const dayHigh = Math.max(stock.dayHigh || 0, tickHigh, spotPrice);
          const dayLow = Math.min(
            stock.dayLow > 0 ? stock.dayLow : spotPrice,
            tickLow > 0 ? tickLow : spotPrice,
            spotPrice
          );

          // 4. Capture cumulative day volume (never reset to 0)
          const todayTradedShares = ('volume' in tick && tick.volume > 0) ? tick.volume : stock.todayTradedShares;
          if ('volume' in tick && tick.volume > 0 && todayTradedShares !== stock.todayTradedShares) stockUpdated = true;

          if (!stockUpdated) return stock;

          stockTickFound = true;
          hasChanged = true;

          const avgShares = stock.avg20DTradedShares || 1;
          const ratio = todayTradedShares > 0 ? +(todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = todayTradedShares >= avgShares && todayTradedShares > 0;

          // Issue 3 Fix: Use canonical resolvePrevClose() with sanity-range check.
          // Prevents ADANI ENT-style 1900%+ errors from stale catalog / wrong mapping.
          const catalogPrevClose = dhanDirectService.getPrevClose(stock.ticker) ?? 0;
          const baselineClose = resolvePrevClose(
            spotPrice,
            0, // netChange not available directly from tick packet
            {
              // dayClose from tick is the prev session close during market hours
              close: ('dayClose' in tick && (tick as any).dayClose > 0) ? (tick as any).dayClose : undefined,
            },
            prevClose > 0 ? prevClose : (stock.prevClose ?? 0),
            catalogPrevClose
          );
          // safeChangePct applies ±25% sanity gate — returns existing value for garbage inputs
          const pctChange = baselineClose > 0
            ? safeChangePct(spotPrice, baselineClose, stock.percentChange)
            : stock.percentChange;

          const isBullish = pctChange >= 0 || spotPrice >= dayOpen;
          let circleIndicator: 'GREEN' | 'RED' | 'AMBER' | 'GREY' = 'GREY';
          if (hasCrossed) {
            circleIndicator = isBullish ? 'GREEN' : 'RED';
          } else if (ratio >= 0.8) {
            circleIndicator = 'AMBER';
          }

          return {
            ...stock,
            spotPrice,
            prevClose: baselineClose,
            dayOpen,
            dayHigh,
            dayLow,
            percentChange: pctChange,
            todayTradedShares,
            avg20DTradedShares: avgShares,
            volumeRatio: ratio,
            hasCrossed20D: hasCrossed,
            crossoverTime: hasCrossed ? (stock.crossoverTime || new Date().toLocaleTimeString('en-IN')) : stock.crossoverTime,
            crossoverDirection: (isBullish ? 'BULLISH' : 'BEARISH') as 'BULLISH' | 'BEARISH',
            circleIndicator,
          };
        });

        if (stockTickFound) {
          updatedStocks = nextStocks;
        }
      }

      if (hasChanged) {
        const nowTime = new Date().toLocaleTimeString('en-IN');
        const stateUpdates: Partial<RadarStoreState> = {
          feedStatus: 'ONLINE',
          lastTickTime: nowTime,
        };

        if (updatedStocks !== currentStocks) {
          stateUpdates.stocks = updatedStocks;
        }

        if (spotChanged || derivativeTickArrived) {
          if (spotChanged) {
            stateUpdates.niftySpot = newNiftySpot;
            stateUpdates.niftyBreakout180 = niftyOptionFeedService.evaluateBreakout180(newNiftySpot, get().istTime || nowTime);
          }
          const spot = spotChanged ? newNiftySpot : get().niftySpot;
          stateUpdates.oobtstState = niftyOptionFeedService.evaluateOobtst(spot, get().istTime || nowTime);
        }

        if (bankNiftySpotChanged) {
          stateUpdates.bankNiftySpot = newBankNiftySpot;
        }

        if (finNiftySpotChanged) {
          stateUpdates.finNiftySpot = newFinNiftySpot;
        }

        if (sensexSpotChanged || sensexDerivativeTickArrived) {
          if (sensexSpotChanged) {
            stateUpdates.sensexSpot = newSensexSpot;
          }
          const spot = sensexSpotChanged ? newSensexSpot : get().sensexSpot;
          stateUpdates.sensexOobtstState = sensexOptionFeedService.evaluateSensexOobtst(spot, get().istTime || nowTime);
        }

        set(stateUpdates);
      }
    });

    // 5. Register Telemetry Listener
    dhanHqFeedSocket.addTelemetryListener((telem) => {
      if (telem.status === 'STREAMING') {
        set({
          feedStatus: 'ONLINE',
          lastTickTime: telem.lastTickTime || get().lastTickTime,
        });
      } else if (telem.status === 'CONNECTING') {
        set({ feedStatus: 'CONNECTING' });
      } else if (telem.status === 'DISCONNECTED') {
        set({ feedStatus: 'DISCONNECTED' });
      } else if (telem.status === 'TOKEN_EXPIRED') {
        set({ feedStatus: 'OFFLINE' });
      } else if (telem.status === 'ERROR') {
        set({ feedStatus: 'ERROR' });
      }
    });
  },
}));
