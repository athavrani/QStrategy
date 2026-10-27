// TypeScript definitions for QStrategy Radar Mobile

export type MarketSessionStatus = 
  | 'PRE_MARKET'      // 09:00 - 09:15
  | 'STABILIZING'     // 09:15 - 09:16 (Opening Noise Gate)
  | 'REGULAR_HOURS'   // 09:16 - 15:30
  | 'POST_MARKET'     // 15:30 - 15:35
  | 'CLOSED';

// ==========================================
// Strategy 1: 20D Volume Crossover Screener
// ==========================================
export interface StockRadarItem {
  ticker: string;
  name: string;
  isin?: string;
  exchange: string;
  sector?: string;
  indices: ('NIFTY 50' | 'SENSEX')[];
  spotPrice: number;
  prevClose?: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  percentChange: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  volumeRatio: number;          // todayTradedShares / avg20DTradedShares
  hasCrossed20D: boolean;
  crossoverTime?: string;
  crossoverDirection?: 'BULLISH' | 'BEARISH';
  circleIndicator: 'GREEN' | 'RED' | 'AMBER' | 'GREY';
  /** Epoch ms when the stock entered its current Buy/Sell/Near state; drives the Radar's newest-first order. */
  signalAt?: number;
  strikeStep?: number;
  lotSize?: number;
  isLiveQuote?: boolean;
}

export interface TacticalStrikeSuggestion {
  underlying: string;
  spotLtp: number;
  recommendedCeStrike: number;
  recommendedPeStrike: number;
  estimatedCePremium: number;
  estimatedPePremium: number;
  ceStopLoss: number;           // Premium - 20%
  ceTarget1: number;            // Premium + 40% (1:2 R:R)
  cePiTarget1: number;          // +3.1416%
  cePiTarget2: number;          // +6.2832%
  peStopLoss: number;
  peTarget1: number;
}

// ==========================================
// Strategy 2: NIFTY 09:20 Overnight (₹62.5)
// ==========================================
export interface NiftyOvernightLeg {
  type: 'CE' | 'PE';
  strike: number;
  expiry: string;
  referencePrice: number;       // locked at 09:20:00
  currentPrice: number;
  stopLoss: number;             // referencePrice * 0.75 (Strict 25% SL)
  status: 'ACTIVE' | 'SL_HIT' | 'OVERNIGHT_HOLD' | 'EXITED';
  exitPrice?: number;
  exitTime?: string;
  exitReason?: 'SL_HIT' | 'NEXT_DAY_0925_EXIT' | 'MANUAL_OVERRIDE';
}

export interface NiftyOvernightState {
  strategyId: 'NIFTY_0920_PREMIUM_625_OVERNIGHT';
  tradeDate: string;
  selectedExpiry: string;
  isExpiryOverridden: boolean;  // true if today's expiry was skipped
  status: 'COUNTDOWN' | 'SCANNING' | 'ACTIVE_HOLD' | 'OVERNIGHT_HOLD' | 'CLOSED';
  ceLeg: NiftyOvernightLeg | null;
  peLeg: NiftyOvernightLeg | null;
  netPointsPnl: number;
  lastUpdated: string;
}

// ==========================================
// Strategy 3: NIFTY 09:25 ₹180 Breakout (3 Steps)
// ==========================================
export interface Candidate180Contract {
  type: 'CE' | 'PE';
  strike: number;
  expiry: string;
  price0925: number;
  distanceTo180: number;        // difference from threshold: |price - threshold|
  currentLtp: number;
  armedHigh?: number;           // highest price since the 09:30 entry window opened
  dayHigh?: number;             // exchange day high
  isTriggered: boolean;
  isDisabled: boolean;
  rank?: 1 | 2;
  securityId?: string;
  lastTradeTimestamp?: string;
  quoteFreshness?: 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED';
}

export interface NiftyBreakout180State {
  strategyId: 'NIFTY_BREAKOUT_180';
  tradeDate: string;
  currentStep: 1 | 2 | 3;
  status: 
    | 'WAITING_0925'            // Prior to 09:25:00
    | 'PROVISIONAL_MONITORING'  // 09:15:00 - 09:24:59 Provisional Monitoring
    | 'CANDIDATES_LOCKED'       // 09:25:00 Locked (< threshold)
    | 'MONITORING_BREAKOUT'     // 09:25:00 - 09:45:00
    | 'IN_TRADE'                // 1st leg broke > threshold (ACTIVE)
    | 'TARGET_HIT'              // ₹220 Hit (TARGET BOOKED)
    | 'SL_HIT'                  // ₹160 Hit (STOP LOSS HIT)
    | 'TIME_EXIT'               // 09:45:00 Force Exit
    | 'NO_TRADE_TODAY'
    | 'LOCK_FAILED'
    | 'NO_ELIGIBLE_STRIKE';
  threshold: number;            // Configurable threshold (default ₹180.00)
  lockedThreshold?: number;     // Session immutable threshold locked at 09:25:00
  ceCandidate: Candidate180Contract | null; // Top selected CE
  peCandidate: Candidate180Contract | null; // Top selected PE
  ceCandidates: Candidate180Contract[];    // Two CE candidates (Rank 1 & 2)
  peCandidates: Candidate180Contract[];    // Two PE candidates (Rank 1 & 2)
  activeContract: 'CE' | 'PE' | null;
  entryPrice: number | null;
  entryTime: string | null;
  fixedTarget: number;          // entry + 40 (₹220.00 at a 180 entry)
  fixedStopLoss: number;        // entry - 20 (₹160.00 at a 180 entry)
  currentPrice: number | null;
  exitPrice?: number | null;    // live price at the moment of the first exit, then frozen
  exitTime?: string | null;
  pnlPoints: number;
  timeRemainingSec: number;
  outcomeText?: string;
  isHistoricalSession?: boolean;
  historicalDate?: string;
  historicalStatus?: 'HISTORICAL SESSION RESULTS' | 'HISTORICAL DATA UNAVAILABLE';
  isLockFailed?: boolean;
  lockFailureReason?: string;
  /** Set when the Retry button locked the strikes: on the 09:25/09:26 candle open, or on live prices. */
  lockSource?: 'MANUAL_CANDLE' | 'MANUAL_LIVE';
  lockedAt?: string;
  noEligibleSide?: 'CE' | 'PE' | 'BOTH' | null;
}

// ==========================================
// Universal Signal Audit Journal Record
// ==========================================
export interface SignalJournalItem {
  id: string;
  timestamp: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  signalType: 'BUY' | 'SELL' | 'EXIT' | 'SL_HIT' | 'TARGET_HIT';
  entryPrice: number;
  exitPrice?: number;
  stopLoss?: number;
  target?: number;
  pnlPoints?: number;
  outcome: 'WIN' | 'LOSS' | 'OPEN' | 'TIME_EXIT';
  notes?: string;
}

// ==========================================
// User Alert & Broker Preferences
// ==========================================
export interface UserPreferences {
  pushNotificationsEnabled: boolean;
  hapticFeedbackEnabled: boolean;
  soundAlertsEnabled: boolean;
  preferredBrokerScheme: 'kite' | 'dhan' | 'web';
  crossoverVolumeThreshold: number; // e.g. 0.8 for 80% or 1.0 for 100%
}
