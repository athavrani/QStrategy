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
import { DHAN_SECURITY_MAP, DHAN_NIFTY_INDEX_ID, getDhanSecurityId } from '../constants/dhanSecurityMaster';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { OobtstLiveState } from '../strategies/types';
import { formatDateKeyIST } from '../constants/nseHolidays';

interface RadarStoreState {
  // Market Global State
  sessionDate: string;
  marketStatus: MarketSessionStatus;
  istTime: string;
  isRefreshing: boolean;
  latchServiceInitialized: boolean;
  niftySpot: number;
  feedStatus: 'ONLINE' | 'ERROR' | 'UNCONFIGURED';
  lastTickTime: string | null;

  // Strategy 1: 20D Volume Screener
  stocks: StockRadarItem[];
  selectedStock: StockRadarItem | null;
  tacticalStrike: TacticalStrikeSuggestion | null;

  // Strategy 2: NIFTY 09:20 Overnight (62.5)
  niftyOvernight: NiftyOvernightState | null;
  oobtstState: OobtstLiveState | null;
  oobtstTargetPremium: number;

  // Strategy 3: NIFTY 09:30 ₹180 Breakout
  niftyBreakout180: NiftyBreakout180State | null;

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
}

export const useRadarStore = create<RadarStoreState>((set, get) => ({
  sessionDate: formatDateKeyIST(),
  marketStatus: 'REGULAR_HOURS',
  istTime: '--:--:--',
  isRefreshing: false,
  latchServiceInitialized: false,
  niftySpot: 0,
  feedStatus: 'UNCONFIGURED',
  lastTickTime: null,
  isStreamerInitialized: false,

  stocks: [],
  selectedStock: null,
  tacticalStrike: null,

  niftyOvernight: null,
  oobtstState: null,
  oobtstTargetPremium: 62.50,
  niftyBreakout180: null,

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
    }

    // Day rollover detection: if sessionDate !== today, reset daily caches & journal
    const todayIST = formatDateKeyIST();
    if (get().sessionDate !== todayIST) {
      niftyOptionFeedService.resetAnchor();
      niftyOptionFeedService.resetBreakout180();
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

    try {
      await niftyOptionFeedService.loadSavedTargetPremium();
      const [sessionRes, stocksRes, overnightRes, breakoutRes, niftyIndexQuoteRes, _chainRes] =
        await Promise.allSettled([
          apiService.fetchMarketSession(),
          apiService.fetchStockRadarList(),
          apiService.fetchNiftyOvernightState(),
          apiService.fetchNiftyBreakout180State(),
          dhanDirectService.fetchNiftyIndexQuote(),
          niftyOptionFeedService.syncLiveOptionChain(),
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

      // Check for NIFTY Breakout 180 trigger journal logging
      if (breakout && breakout.status === 'IN_TRADE' && breakout.activeContract && breakout.ceCandidate && breakout.peCandidate) {
        const symbol = breakout.activeContract === 'CE' ? `${breakout.ceCandidate.strike} CE` : `${breakout.peCandidate.strike} PE`;
        const lockKey = `BREAKOUT_180_${symbol}`;
        if (!alertLatchService.isAlertLatched(lockKey, 'GREEN')) {
          await alertLatchService.acquireAlertLatch(lockKey, 'GREEN', {
            spotPrice: breakout.currentPrice || 180,
            todayTradedShares: 0,
            avg20DTradedShares: 0,
            volumeRatio: 1,
            crossoverTime: breakout.entryTime || session.istTime,
          });
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

      const greenCount = stocks.filter((s) => s.hasCrossed20D && s.todayTradedShares > 0 && s.circleIndicator === 'GREEN').length;
      const redCount = stocks.filter((s) => s.hasCrossed20D && s.todayTradedShares > 0 && s.circleIndicator === 'RED').length;
      const telemetry = dhanDirectService.getTelemetry();

      const resolvedSpot = niftyIndexQuote && niftyIndexQuote.ltp > 0 ? niftyIndexQuote.ltp : get().niftySpot;
      const liveOobtst = niftyOptionFeedService.evaluateOobtst(resolvedSpot, session.istTime);

      const isOvernightActive = overnight && (overnight.status === 'ACTIVE_HOLD' || overnight.status === 'OVERNIGHT_HOLD');
      const isBreakoutActive = breakout && breakout.status === 'IN_TRADE';
      const signalsTodayCount = greenCount + redCount + (isOvernightActive ? 1 : 0) + (isBreakoutActive ? 1 : 0);

      set((prev) => {
        const existingMap = new Map(prev.stocks.map((s) => [s.ticker, s]));
        const mergedStocks = stocks.map((newStock) => {
          const existing = existingMap.get(newStock.ticker);
          if (!existing) return newStock;

          // Preserve live non-zero spot price against placeholder approxLtp
          const spotPrice = (existing.spotPrice > 0 && (!newStock.spotPrice || newStock.spotPrice === existing.spotPrice))
            ? existing.spotPrice
            : (newStock.spotPrice > 0 ? newStock.spotPrice : existing.spotPrice);

          // Preserve verified previous close
          const prevClose = (newStock.prevClose && newStock.prevClose > 0)
            ? newStock.prevClose
            : (existing.prevClose && existing.prevClose > 0
              ? existing.prevClose
              : (dhanDirectService.getPrevClose(newStock.ticker) || undefined));

          const dayOpen = (newStock.dayOpen && newStock.dayOpen > 0)
            ? newStock.dayOpen
            : (existing.dayOpen && existing.dayOpen > 0 ? existing.dayOpen : spotPrice);

          const dayHigh = Math.max(newStock.dayHigh || 0, existing.dayHigh || 0, spotPrice);
          const dayLow = Math.min(
            newStock.dayLow > 0 ? newStock.dayLow : spotPrice,
            existing.dayLow > 0 ? existing.dayLow : spotPrice
          );

          // Traded volume: Monotonic guarantee, never overwrite live volume with 0
          const todayTradedShares = Math.max(newStock.todayTradedShares || 0, existing.todayTradedShares || 0);
          const avgShares = newStock.avg20DTradedShares || existing.avg20DTradedShares || 1;
          const volumeRatio = todayTradedShares > 0 ? +(todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = todayTradedShares >= avgShares && todayTradedShares > 0;

          // Compute genuine price percentage change
          const percentChange = (prevClose && prevClose > 0 && spotPrice > 0)
            ? +(((spotPrice - prevClose) / prevClose) * 100).toFixed(2)
            : (newStock.percentChange !== 0 ? newStock.percentChange : existing.percentChange);

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
          niftyOvernight: overnight,
          oobtstState: liveOobtst,
          niftyBreakout180: breakout,
          oobtstTargetPremium: niftyOptionFeedService.getTargetPremium(),
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

  initStreamer: () => {
    if (get().isStreamerInitialized) return;
    set({ isStreamerInitialized: true });

    // 1. Batch subscribe to all 60 constituent stocks
    const subscriptions: InstrumentSubscription[] = Object.values(DHAN_SECURITY_MAP).map((meta) => ({
      exchangeSegment: 'NSE_EQ',
      securityId: meta.securityId,
    }));

    // 2. Add NIFTY 50 Spot Index
    subscriptions.push({
      exchangeSegment: 'IDX_I',
      securityId: DHAN_NIFTY_INDEX_ID,
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

      let derivativeTickArrived = false;
      // Check if derivative ticks arrived (NSE_FNO, segment 2)
      for (const tick of Object.values(tickBatch)) {
        if ('ltp' in tick && (tick.exchangeSegment === 2 || (tick as any).exchangeSegment === 'NSE_FNO')) {
          niftyOptionFeedService.updateOptionPriceFromTick(String(tick.securityId), tick.ltp);
          hasChanged = true;
          derivativeTickArrived = true;
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

          // 1. Capture official PrevClose from Code 6 (PREV_CLOSE) or Quote dayClose
          let prevClose = stock.prevClose || dhanDirectService.getPrevClose(stock.ticker) || 0;
          if ('prevClose' in tick && tick.prevClose && tick.prevClose > 0) {
            prevClose = tick.prevClose;
            dhanDirectService.updatePrevClose(stock.ticker, prevClose);
            stockUpdated = true;
          } else if ('dayClose' in tick && tick.dayClose > 0 && prevClose <= 0 && tick.dayClose !== ('ltp' in tick ? tick.ltp : stock.spotPrice)) {
            prevClose = tick.dayClose;
            dhanDirectService.updatePrevClose(stock.ticker, prevClose);
            stockUpdated = true;
          }

          // 2. Capture day open, high, low from Quote
          const dayOpen = ('dayOpen' in tick && tick.dayOpen > 0) ? tick.dayOpen : stock.dayOpen;
          if ('dayOpen' in tick && tick.dayOpen > 0 && dayOpen !== stock.dayOpen) stockUpdated = true;

          // 3. Capture live LTP
          const spotPrice = ('ltp' in tick && tick.ltp > 0) ? tick.ltp : stock.spotPrice;
          if ('ltp' in tick && tick.ltp > 0 && spotPrice !== stock.spotPrice) stockUpdated = true;

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

          // Determine accurate priceChangePct strictly from spotPrice and verified prevClose
          const baselineClose = prevClose > 0 ? prevClose : (stock.prevClose || dhanDirectService.getPrevClose(stock.ticker) || (dayOpen > 0 ? dayOpen : spotPrice));
          const pctChange = (baselineClose > 0 && spotPrice > 0)
            ? +(((spotPrice - baselineClose) / baselineClose) * 100).toFixed(2)
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
      } else if (telem.status === 'ERROR') {
        set({ feedStatus: 'ERROR' });
      }
    });
  },
}));
