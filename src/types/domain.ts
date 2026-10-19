/**
 * QStrategy Cleanroom Domain Types
 * Definitive immutable domain models for the QStrategy trading terminal.
 * Follows strict nullability — never fabricates synthetic quotes.
 */

export type ExchangeSegment = 'NSE_EQ' | 'NSE_FNO' | 'BSE_EQ' | 'IDX_I';

export type OptionType = 'CE' | 'PE';

export type Moneyness = 'ITM' | 'ATM' | 'OTM';

export type MarketStatus = 
  | 'PRE_MARKET'     // 09:00:00 - 09:14:59 IST
  | 'STABILIZING'    // 09:15:00 - 09:15:59 IST (Opening noise gate)
  | 'REGULAR_HOURS'  // 09:16:00 - 15:30:00 IST
  | 'POST_MARKET'    // 15:30:01 - 15:35:00 IST
  | 'CLOSED';        // Weekend, holiday, or post-15:35

export type FeedConnectionStatus = 
  | 'ONLINE' 
  | 'OFFLINE' 
  | 'CONNECTING' 
  | 'RECONNECTING' 
  | 'ERROR';

export type StrategyCategory = 
  | 'INDEX_OPTIONS' 
  | 'EQUITY_RADAR' 
  | 'MOMENTUM_BREAKOUT' 
  | 'OPENING_RANGE' 
  | 'EOD_BTST';

export type StrategyExecutionStatus = 
  | 'IDLE' 
  | 'PREPARING' 
  | 'ARMED' 
  | 'ACTIVE' 
  | 'OVERNIGHT_HOLD' 
  | 'SL_HIT' 
  | 'TARGET_HIT' 
  | 'TIME_EXIT' 
  | 'COMPLETED';

export type BadgeTone = 'bullish' | 'bearish' | 'warning' | 'cyan' | 'purple';

export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export interface StockDomainModel {
  readonly ticker: string;
  readonly securityId: string;
  readonly name: string;
  readonly exchangeSegment: ExchangeSegment;
  readonly spotPrice: number | null;
  readonly dayOpen: number | null;
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
  readonly dayClose: number | null;
  readonly atp: number | null;
  readonly todayVolume: number;
  readonly avg20DVolume: number;
  readonly volumeRatio: number;
  readonly deltaPct: number | null;
  readonly strikeStep: number;
  readonly lotSize: number;
  readonly hasCrossed20D: boolean;
  readonly latchedAt: string | null;
  readonly isNearCross: boolean;
  readonly lastUpdated: string;
}

export interface OptionContractModel {
  readonly securityId: string;
  readonly symbol: string;
  readonly underlying: string;
  readonly strikePrice: number;
  readonly optionType: OptionType;
  readonly expiry: string;
  readonly ltp: number | null;
  readonly dayOpen: number | null;
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
  readonly close: number | null;
  readonly volume: number;
  readonly oi: number | null;
  readonly pcr: number | null;
  readonly greeks: OptionGreeks | null;
  readonly moneyness: Moneyness;
}

export interface OptionStrikeDomainModel {
  readonly strikePrice: number;
  readonly call: OptionContractModel | null;
  readonly put: OptionContractModel | null;
  readonly isAtm: boolean;
}

export interface StrategyPositionModel {
  readonly id: string;
  readonly strategyId: string;
  readonly sessionDate: string;
  readonly legType: 'CE' | 'PE' | 'EQUITY';
  readonly symbol: string;
  readonly securityId: string;
  readonly entryTime: string;
  readonly entryPrice: number;
  readonly quantity: number;
  readonly stopLoss: number;
  readonly targetPrice?: number; // STRICTLY undefined for NIFTY_OVERNIGHT (Zero Target Invariant)
  readonly currentLtp: number;
  readonly pnlPoints: number;
  readonly status: StrategyExecutionStatus;
  readonly exitTime: string | null;
  readonly exitPrice: number | null;
  readonly createdAt: number;
}

export interface StrategyLegOutput {
  readonly legId: string;
  readonly symbol: string;
  readonly legType: 'CE' | 'PE' | 'EQUITY';
  readonly referencePrice: number;
  readonly currentPrice: number | null;
  readonly stopLoss: number;
  readonly targetPrice?: number;
  readonly pnlPoints: number;
  readonly status: 'ACTIVE' | 'SL_HIT' | 'TARGET_HIT' | 'CANCELED' | 'OVERNIGHT_HOLD';
  readonly statusBadgeText: string;
}

export interface StrategySignalOutput {
  readonly strategyId: string;
  readonly status: StrategyExecutionStatus;
  readonly statusBadgeText: string;
  readonly badgeTone: BadgeTone;
  readonly headline: string;
  readonly primaryMetricLabel: string;
  readonly primaryMetricValue: string;
  readonly targetPrice?: number; // STRICTLY undefined for NIFTY_OVERNIGHT (Zero Target Invariant)
  readonly stopLossPrice?: number;
  readonly invariantNotice?: string;
  readonly lastUpdated: string;
  readonly legs?: readonly StrategyLegOutput[];
}

export interface MarketSessionState {
  readonly istTime: string;
  readonly marketStatus: MarketStatus;
  readonly feedStatus: FeedConnectionStatus;
  readonly pingLatencyMs: number;
  readonly packetCount: number;
  readonly lastHeartbeat: string | null;
}

export function calculateVolumeRatio(todayVolume: number, avg20DVolume: number): number {
  if (avg20DVolume <= 0) return 0;
  return todayVolume / avg20DVolume;
}

