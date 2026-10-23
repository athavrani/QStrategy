import { create } from 'zustand';
import {
  StockRadarItem,
  NiftyOvernightState,
  NiftyBreakout180State,
  TacticalStrikeSuggestion,
  MarketSessionStatus,
  SignalJournalItem,
} from '../types/mobile';
import { apiService, isSessionVolumeLive } from '../services/apiService';
import { alertLatchService } from '../services/alertLatchService';
import { strategyEngine, STRATEGY_IDS, applyClosedTrades, sumPoints } from '../engine';
import { journalRepository } from '../services/JournalRepository';
import { isNearTrigger, parseClockSeconds } from '../engine/clockTriggers';
import { btstCarryService } from '../services/BtstCarryService';
import type { CarryTrade } from '../engine/types';
import { dhanDirectService } from '../services/dhanDirectService';
import { dhanHqFeedSocket } from '../services/dhan/DhanHqFeedSocket';
import { marketData } from '../services/marketdata/MarketDataService';
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
import { avgVolumeService } from '../services/AvgVolumeService';
import { prevCloseBook } from '../services/marketdata/PrevCloseBook';
import { DailyStrategyLockRecord } from '../db/schema';
import { dailyStrategyLockService } from '../services/DailyStrategyLockService';

interface RadarStoreState {
  // Market Global State
  sessionDate: string;
  marketStatus: MarketSessionStatus;
  istTime: string;
  isRefreshing: boolean;
  latchServiceInitialized: boolean;
  avgLoaded: boolean;
  niftySpot: number;
  bankNiftySpot: number;
  finNiftySpot: number;
  sensexSpot: number;
  feedStatus: 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR' | 'UNCONFIGURED';
  lastTickTime: string | null;
  feedError: string | null;

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
  /** Overnight OOBTST positions from earlier sessions awaiting their morning exit. */
  carryTrades: CarryTrade[];
  signalsTodayCount: number;
  netPointsCaptured: number;

  // Streamer Engine
  isStreamerInitialized: boolean;

  // Date-wise Historical Strike Locks
  availableLockDates: string[];
  selectedLockDate: string | null;
  historicalLocks: DailyStrategyLockRecord[];

  // Date-wise Journal History
  availableJournalDates: string[];
  selectedJournalDate: string | null;
  historicalJournal: SignalJournalItem[];

  // Actions
  initStreamer: () => void;
  refreshAll: (isManual?: boolean) => Promise<void>;
  ensureLatchReady: () => Promise<void>;
  loadCarryTrades: () => Promise<void>;
  selectStock: (ticker: string) => void;
  clearSelectedStock: () => void;
  setIstTime: (timeStr: string) => void;
  runClockEvaluation: () => void;
  setOobtstTargetPremium: (target: number) => Promise<boolean>;
  setBreakoutThreshold: (target: number) => Promise<boolean>;
  setSensexOobtstTargetPremium: (target: number) => Promise<boolean>;
  fetchAvailableLockDates: () => Promise<string[]>;
  selectLockDate: (date: string | null) => Promise<void>;
  fetchAvailableJournalDates: () => Promise<string[]>;
  selectJournalDate: (date: string | null) => Promise<void>;
}

let latchReadyPromise: Promise<void> | null = null;
const lastStockTickAt = new Map<string, number>();
const STOCK_TICK_FRESH_MS = 15_000;
const LOCK_WINDOW_START_SEC = 9 * 3600 + 19 * 60 + 58;
const LOCK_WINDOW_END_SEC = 9 * 3600 + 20 * 60 + 20;
const LOCK_SYNC_INTERVAL_MS = 2000;
let lastLockSyncAt = 0;

function withNewEntries(prev: RadarStoreState, entries: SignalJournalItem[]): Partial<RadarStoreState> {
  return {
    journal: [...entries, ...prev.journal],
    signalsTodayCount: prev.journal.length + entries.length,
  };
}

export const useRadarStore = create<RadarStoreState>((set, get) => ({
  sessionDate: formatDateKeyIST(),
  marketStatus: 'REGULAR_HOURS',
  istTime: '--:--:--',
  isRefreshing: false,
  latchServiceInitialized: false,
  avgLoaded: false,
  niftySpot: 0,
  bankNiftySpot: 0,
  finNiftySpot: 0,
  sensexSpot: 0,
  feedStatus: 'CONNECTING',
  lastTickTime: null,
  feedError: null,
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
  carryTrades: [],
  signalsTodayCount: 0,
  netPointsCaptured: 0,

  availableLockDates: [],
  selectedLockDate: null,
  historicalLocks: [],

  availableJournalDates: [],
  selectedJournalDate: null,
  historicalJournal: [],

  ensureLatchReady: () => {
    if (!latchReadyPromise) {
      latchReadyPromise = (async () => {
      await alertLatchService.initialize();
      set({ latchServiceInitialized: true });

      // Restore today's journal from SQLite; entries created while this ran are kept (merged by id)
      try {
        const persisted = await journalRepository.loadForDate(alertLatchService.getTodayISTDateString());
        if (persisted.length > 0) {
          set((prev) => {
            const known = new Set(prev.journal.map((j) => j.id));
            const journal = [...prev.journal, ...persisted.filter((j) => !known.has(j.id))];
            return { journal, signalsTodayCount: journal.length, netPointsCaptured: sumPoints(journal) };
          });
        }
      } catch {}

      // Point 7.1: Fallback - rebuild session journal from persisted SQLite latches when no journal rows exist
      if (get().journal.length === 0) {
        try {
          // Exit latches only guard trade exits; they are not entries
          const latches = (await alertLatchService.getAllSessionLatches()).filter((l) => !l.ticker.startsWith('EXIT_'));
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
            set({ journal: restoredJournal.reverse(), signalsTodayCount: restoredJournal.length });
          }
        } catch {}
      }
      await get().loadCarryTrades();
      })().catch((err) => {
        latchReadyPromise = null;
        throw err;
      });
    }
    return latchReadyPromise;
  },

  loadCarryTrades: async () => {
    try {
      const { trades, journal } = await btstCarryService.load(alertLatchService.getTodayISTDateString());
      btstCarryService.watch(trades);
      set((prev) => {
        const known = new Set(prev.journal.map((j) => j.id));
        return { carryTrades: trades, journal: [...prev.journal, ...journal.filter((j) => !known.has(j.id))] };
      });
    } catch {
      // Carry data is best-effort; today's trading must not depend on it.
    }
  },

  refreshAll: async (isManual = false) => {
    // Only show pull-to-refresh spinner when user manually pulls down the list
    if (isManual) {
      set({ isRefreshing: true });
    }

    await get().ensureLatchReady();

    // Day rollover detection: if sessionDate !== today, reset daily caches & journal
    const todayIST = formatDateKeyIST();
    const isDayChange = get().sessionDate !== todayIST;
    if (isDayChange) {
      niftyOptionFeedService.resetAnchor(true);
      niftyOptionFeedService.resetBreakout180(true);
      sensexOptionFeedService.resetAnchor(true);
      dhanDirectService.resetPrevCloseIfNewDay(true);
      // Yesterday's quotes (day high, volume) must not survive into the new session
      marketData.clearSnapshots();
      set({
        sessionDate: todayIST,
        avgLoaded: false,
        journal: [],
        carryTrades: [],
        signalsTodayCount: 0,
        netPointsCaptured: 0,
        selectedJournalDate: null,
        historicalJournal: [],
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
      // A session left open overnight must still pick up yesterday's BTST positions
      get().loadCarryTrades();
      get().fetchAvailableJournalDates().catch(() => {});
    }

    // Daily 20D average volume & previous session close computation:
    // Runs on day change or first refresh of the day; served instantly from cache within same day.
    avgVolumeService.refreshAll(todayIST, isDayChange).then((avgMap) => {
      if (!avgMap || avgMap.size === 0) return;
      set((prev) => ({
        avgLoaded: true,
        stocks: prev.stocks.map((s) => {
          const entry = avgMap.get(s.ticker.toUpperCase());
          if (!entry) return s;
          const newAvg = entry.avg20DVolume;
          if (entry.prevClose) prevCloseBook.set(s.ticker, entry.prevClose, 'HISTORY', s.spotPrice);
          const dynamicPrev = prevCloseBook.get(s.ticker)?.value;
          const avgShares = (newAvg && newAvg > 0) ? newAvg : s.avg20DTradedShares;
          const updatedPrevClose = (dynamicPrev && dynamicPrev > 0) ? dynamicPrev : s.prevClose;
          const ratio = s.todayTradedShares > 0 ? +(s.todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = s.todayTradedShares >= avgShares && s.todayTradedShares > 0;
          const pctChange = prevCloseBook.percent(s.ticker, s.spotPrice, s.percentChange);
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
      await get().fetchAvailableLockDates();
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

      const newJournalEntries = await strategyEngine.evaluate({
        istTime: session.istTime,
        stocks,
        breakout,
        niftyOobtst: liveOobtst,
        sensexOobtst: liveSensexOobtst,
        carry: get().carryTrades,
      });

      const volumeLive = isSessionVolumeLive();

      set((prev) => {
        const existingMap = new Map(prev.stocks.map((s) => [s.ticker, s]));
        const mergedStocks = stocks.map((newStock) => {
          const existing = existingMap.get(newStock.ticker);
          if (!existing) return newStock;

          // Websocket price wins while it is fresh; the REST snapshot is older and would pull the price back
          const tickAge = Date.now() - (lastStockTickAt.get(newStock.ticker) ?? 0);
          const spotPrice = (existing.spotPrice > 0 && tickAge < STOCK_TICK_FRESH_MS)
            ? existing.spotPrice
            : (newStock.isLiveQuote && newStock.spotPrice > 0)
              ? newStock.spotPrice
              : (existing.spotPrice > 0 ? existing.spotPrice : newStock.spotPrice);

          // One owner for the previous close: the REST refresh can offer a value but never overrides a better source
          const prevClose = prevCloseBook.get(newStock.ticker)?.value ?? existing.prevClose ?? newStock.prevClose ?? 0;

          const dayOpen = (newStock.dayOpen && newStock.dayOpen > 0 && newStock.isLiveQuote)
            ? newStock.dayOpen
            : (existing.dayOpen && existing.dayOpen > 0 ? existing.dayOpen : spotPrice);

          const dayHigh = Math.max(newStock.dayHigh || 0, existing.dayHigh || 0, spotPrice);
          const dayLow = Math.min(
            newStock.dayLow > 0 ? newStock.dayLow : spotPrice,
            existing.dayLow > 0 ? existing.dayLow : spotPrice
          );

          // Traded volume: Monotonic guarantee, never overwrite live volume with 0
          const todayTradedShares = volumeLive
            ? Math.max(newStock.todayTradedShares || 0, existing.todayTradedShares || 0)
            : 0;
          const cachedAvg = avgVolumeService.getCachedAvg(newStock.ticker);
          const avgShares = (cachedAvg && cachedAvg > 0)
            ? cachedAvg
            : (newStock.avg20DTradedShares > 0 ? newStock.avg20DTradedShares : (existing.avg20DTradedShares > 0 ? existing.avg20DTradedShares : 1));
          const volumeRatio = todayTradedShares > 0 ? +(todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = todayTradedShares >= avgShares && todayTradedShares > 0;

          // Issue 3 Fix: Compute genuine price percentage change strictly with safe bounds (±25% max)
          const fallbackPct = existing.percentChange !== 0 ? existing.percentChange : newStock.percentChange;
          const percentChange = prevCloseBook.percent(newStock.ticker, spotPrice, fallbackPct);

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
          signalsTodayCount: prev.journal.length + newJournalEntries.length,
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
    if (get().istTime === timeStr) return;
    set({ istTime: timeStr });
  },

  // Time-based triggers (09:20 lock, 09:25 lock, 09:45 exit, 15:30 BTST) must not wait for a tick or the 10 s poll.
  runClockEvaluation: () => {
    const s = get();
    const sec = parseClockSeconds(s.istTime);
    // 09:19:58 to 09:20:20 IST: the strike lock needs quotes fresher than the 10 s poll provides
    const inLockWindow = sec !== null && sec >= LOCK_WINDOW_START_SEC && sec <= LOCK_WINDOW_END_SEC;
    // An open breakout trade is re-checked every second so its exit never waits for a tick or the poll
    const breakoutOpen = s.niftyBreakout180?.status === 'IN_TRADE';
    if (!s.latchServiceInitialized || !(inLockWindow || breakoutOpen || isNearTrigger(s.istTime))) return;

    if (inLockWindow && Date.now() - lastLockSyncAt >= LOCK_SYNC_INTERVAL_MS) {
      lastLockSyncAt = Date.now();
      niftyOptionFeedService.syncLiveOptionChain().catch(() => {});
      sensexOptionFeedService.syncLiveOptionChain().catch(() => {});
    }

    const ist = s.istTime;
    const updates: Partial<RadarStoreState> = {};
    if (s.niftySpot > 0) {
      updates.niftyBreakout180 = niftyOptionFeedService.evaluateBreakout180(s.niftySpot, ist);
      updates.oobtstState = niftyOptionFeedService.evaluateOobtst(s.niftySpot, ist);
    }
    if (s.sensexSpot > 0) {
      updates.sensexOobtstState = sensexOptionFeedService.evaluateSensexOobtst(s.sensexSpot, ist);
    }
    if (Object.keys(updates).length === 0) return;
    set(updates);

    const state = get();
    strategyEngine
      .evaluate(
        {
          istTime: ist,
          carry: state.carryTrades,
          breakout: state.niftyBreakout180,
          niftyOobtst: state.oobtstState,
          sensexOobtst: state.sensexOobtstState,
        },
        [STRATEGY_IDS.BREAKOUT_180, STRATEGY_IDS.OOBTST_NIFTY, STRATEGY_IDS.OOBTST_SENSEX, STRATEGY_IDS.BTST_CARRY]
      )
      .then((entries) => {
        if (entries.length > 0) set((prev) => withNewEntries(prev, entries));
      })
      .catch(() => {});
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

  fetchAvailableLockDates: async () => {
    const dates = await dailyStrategyLockService.getAvailableLockDates();
    set({ availableLockDates: dates });
    return dates;
  },

  selectLockDate: async (date: string | null) => {
    if (!date) {
      set({ selectedLockDate: null, historicalLocks: [] });
      return;
    }
    const locks = await dailyStrategyLockService.getLocksForDate(date);
    set({ selectedLockDate: date, historicalLocks: locks });
  },

  fetchAvailableJournalDates: async () => {
    const today = formatDateKeyIST();
    const dates = (await journalRepository.getAvailableDates()).filter((d) => d !== today);
    set({ availableJournalDates: dates });
    return dates;
  },

  selectJournalDate: async (date: string | null) => {
    if (!date || date === formatDateKeyIST()) {
      set({ selectedJournalDate: null, historicalJournal: [] });
      return;
    }
    const items = await journalRepository.loadForDate(date);
    set({ selectedJournalDate: date, historicalJournal: items });
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

    // 3. Batch subscribe (ref-counted under owner 'radar') & start feed
    marketData.start();
    marketData.watch('radar', subscriptions);
    dhanHqFeedSocket.start();

    // 4. Register high-frequency 250ms micro-batch listener (composite segment:securityId keys only)
    marketData.onBatch((tickBatch) => {
      let hasChanged = false;
      let spotChanged = false;
      let newNiftySpot = get().niftySpot;

      // Check if NIFTY spot tick arrived (segment 0: IDX_I)
      const indexTick = tickBatch[`0:${DHAN_NIFTY_INDEX_ID}`];
      if (indexTick && 'ltp' in indexTick && indexTick.ltp > 0 && indexTick.ltp !== newNiftySpot) {
        newNiftySpot = indexTick.ltp;
        spotChanged = true;
        hasChanged = true;
      }

      // Check if BANK NIFTY spot tick arrived (segment 0: IDX_I)
      let bankNiftySpotChanged = false;
      let newBankNiftySpot = get().bankNiftySpot;
      const bankNiftyTick = tickBatch[`0:${DHAN_BANKNIFTY_INDEX_ID}`];
      if (bankNiftyTick && 'ltp' in bankNiftyTick && bankNiftyTick.ltp > 0 && bankNiftyTick.ltp !== newBankNiftySpot) {
        newBankNiftySpot = bankNiftyTick.ltp;
        bankNiftySpotChanged = true;
        hasChanged = true;
      }

      // Check if FIN NIFTY spot tick arrived (segment 0: IDX_I)
      let finNiftySpotChanged = false;
      let newFinNiftySpot = get().finNiftySpot;
      const finNiftyTick = tickBatch[`0:${DHAN_FINNIFTY_INDEX_ID}`];
      if (finNiftyTick && 'ltp' in finNiftyTick && finNiftyTick.ltp > 0 && finNiftyTick.ltp !== newFinNiftySpot) {
        newFinNiftySpot = finNiftyTick.ltp;
        finNiftySpotChanged = true;
        hasChanged = true;
      }

      // Check if SENSEX spot tick arrived (segment 0: IDX_I)
      let sensexSpotChanged = false;
      let newSensexSpot = get().sensexSpot;
      const sensexTick = tickBatch[`0:${DHAN_SENSEX_INDEX_ID}`];
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
      const batchVolumeLive = isSessionVolumeLive();

      // Map ticks across constituent stocks if any are loaded
      if (currentStocks.length > 0) {
        let stockTickFound = false;
        const nextStocks = currentStocks.map((stock) => {
          const secId = getDhanSecurityId(stock.ticker);
          // Cash equity only (segment 1 NSE_EQ / 4 BSE_EQ); the composite key keeps index ticks (e.g. BANKNIFTY id 25) out.
          const tick = tickBatch[`1:${secId}`] || tickBatch[`4:${secId}`];
          if (!tick) return stock;

          let stockUpdated = false;

          // 1. Capture live LTP & official PrevClose with sanity deviation check
          let spotPrice = stock.spotPrice;
          if ('ltp' in tick && tick.ltp > 0) {
            const stockPrev = stock.prevClose ?? 0;
            const baseline: number = stock.spotPrice > 0 ? stock.spotPrice : (stockPrev > 0 ? stockPrev : tick.ltp);
            const deviationPct = Math.abs((tick.ltp - baseline) / baseline * 100);
            if (baseline <= 0 || deviationPct <= 50) {
              spotPrice = tick.ltp;
              lastStockTickAt.set(stock.ticker, Date.now());
              if (spotPrice !== stock.spotPrice) stockUpdated = true;
            }
          }

          // Previous close: exchange packet first, then the quote packet's close; the book keeps the best source
          if ('prevClose' in tick && tick.prevClose && tick.prevClose > 0) {
            if (prevCloseBook.set(stock.ticker, tick.prevClose, 'EXCHANGE', spotPrice)) stockUpdated = true;
          } else if ('dayClose' in tick && tick.dayClose > 0 && tick.dayClose !== spotPrice) {
            if (prevCloseBook.set(stock.ticker, tick.dayClose, 'QUOTE', spotPrice)) stockUpdated = true;
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
          const todayTradedShares = (batchVolumeLive && 'volume' in tick && tick.volume > 0) ? tick.volume : stock.todayTradedShares;
          if (batchVolumeLive && 'volume' in tick && tick.volume > 0 && todayTradedShares !== stock.todayTradedShares) stockUpdated = true;

          if (!stockUpdated) return stock;

          stockTickFound = true;
          hasChanged = true;

          const cachedAvg = avgVolumeService.getCachedAvg(stock.ticker);
          const avgShares = (cachedAvg && cachedAvg > 0) ? cachedAvg : (stock.avg20DTradedShares || 1);
          const ratio = todayTradedShares > 0 ? +(todayTradedShares / avgShares).toFixed(3) : 0;
          const hasCrossed = todayTradedShares >= avgShares && todayTradedShares > 0;

          const baselineClose = prevCloseBook.get(stock.ticker)?.value ?? 0;
          const pctChange = baselineClose > 0
            ? prevCloseBook.percent(stock.ticker, spotPrice, stock.percentChange)
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
          }
          const spot = spotChanged ? newNiftySpot : get().niftySpot;
          // Stop-loss, target and exit are checked on option ticks too, not only when the index moves
          if (spot > 0) {
            stateUpdates.niftyBreakout180 = niftyOptionFeedService.evaluateBreakout180(spot, get().istTime || nowTime);
          }
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

        // Option strategies react to ticks. The 20D crossover joins once real 20D averages are loaded;
        // before that, tick-derived crossings would be measured against placeholder averages.
        const optionsChanged = spotChanged || derivativeTickArrived || sensexSpotChanged || sensexDerivativeTickArrived;
        const crossoverReady = updatedStocks !== currentStocks && get().avgLoaded;
        if ((optionsChanged || crossoverReady) && get().latchServiceInitialized) {
          const state = get();
          const only: string[] = [];
          if (optionsChanged) {
            only.push(STRATEGY_IDS.BREAKOUT_180, STRATEGY_IDS.OOBTST_NIFTY, STRATEGY_IDS.OOBTST_SENSEX);
            if (state.carryTrades.length > 0) only.push(STRATEGY_IDS.BTST_CARRY);
          }
          if (crossoverReady) only.push(STRATEGY_IDS.VOLUME_CROSSOVER);
          strategyEngine
            .evaluate(
              {
                istTime: state.istTime !== '--:--:--' ? state.istTime : nowTime,
                stocks: crossoverReady ? state.stocks : undefined,
                carry: state.carryTrades,
                breakout: state.niftyBreakout180,
                niftyOobtst: state.oobtstState,
                sensexOobtst: state.sensexOobtstState,
              },
              only
            )
            .then((entries) => {
              if (entries.length > 0) set((prev) => withNewEntries(prev, entries));
            })
            .catch(() => {});
        }
      }
    });

    // 5. Register Telemetry Listener
    dhanHqFeedSocket.addTelemetryListener((telem) => {
      if ((telem.lastError ?? null) !== get().feedError) {
        set({ feedError: telem.lastError ?? null });
      }
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

// Closed trades (SL, target, time exit) update the live journal rows and the net points total.
strategyEngine.onClosed((closed) => {
  useRadarStore.setState((prev) => {
    const journal = applyClosedTrades(prev.journal, closed);
    const closedIds = new Set(closed.map((c) => c.journalId).filter(Boolean));
    const carryTrades = closedIds.size > 0 ? prev.carryTrades.filter((t) => !closedIds.has(t.journalId)) : prev.carryTrades;
    if (carryTrades !== prev.carryTrades) btstCarryService.watch(carryTrades);
    return { journal, carryTrades, netPointsCaptured: sumPoints(journal) };
  });
});
