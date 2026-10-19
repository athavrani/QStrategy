import React from 'react';
import { MarketSessionStatus, StockRadarItem, NiftyBreakout180State } from '../types/mobile';

export type StrategyCategory = 
  | 'INDEX_OPTIONS' 
  | 'EQUITY_RADAR' 
  | 'MOMENTUM_BREAKOUT' 
  | 'MEAN_REVERSION';

export type StrategyExecutionStyle = 
  | 'TIME_TRIGGERED'      // Fires at exact clock tick (e.g. 09:20:00)
  | 'CANDLE_BREAKOUT'     // Evaluates 1-min / 5-min candle high/low crosses
  | 'CONTINUOUS_SCREENER' // Continuous volume / price scanning
  | 'EOD_CLOSE';          // 15:10 - 15:30 EOD momentum

export interface OobtstLegDetail {
  type: 'CE' | 'PE';
  strike: number;
  symbol: string;
  openPrice: number;
  triggerPrice: number;
  currentLtp: number;
  progressPct: number;
  status: 'ARMED' | 'EXECUTED' | 'DISABLED' | 'SL_HIT' | 'SCANNING';
  isProvisional?: boolean;
}

export interface OobtstLiveState {
  currentStep: 1 | 2 | 3;
  status: 'SCANNING' | 'ARMED' | 'ACTIVE' | 'SL_HIT' | 'BTST_HOLD';
  statusBadgeText: string;
  expiryDate: string;
  daysToExpiry: number;
  niftySpot: number;
  anchorTime: string;
  isLocked: boolean;
  isProvisional: boolean;
  isMarketClosed: boolean;
  ceLeg: OobtstLegDetail;
  peLeg: OobtstLegDetail;
  activeLeg?: 'CE' | 'PE' | null;
  executedSymbol?: string;
  executedPrice?: number;
  slPrice?: number;
  riskPerLot?: number;
  pnlPerShare?: number;
  pnlPerLot?: number;
  lastUpdated: string;
}

export interface StrategyContext {
  istTime: string;
  marketStatus: MarketSessionStatus;
  niftySpot?: number;
  stocks: StockRadarItem[];
  oobtstLiveState?: OobtstLiveState;
  breakout180LiveState?: NiftyBreakout180State;
}

export interface StrategySignalOutput {
  status: 'IDLE' | 'PREPARING' | 'ARMED' | 'ACTIVE' | 'TRIGGERED' | 'SL_HIT' | 'TARGET_HIT' | 'TIME_EXIT' | 'COMPLETED';
  statusBadgeText: string;
  badgeTone: 'bullish' | 'bearish' | 'warning' | 'cyan' | 'purple';
  headline: string;
  primaryMetricLabel: string;
  primaryMetricValue: string;
  target?: string;
  stopLoss?: string;
  invariantNotice?: string;
  lastUpdated: string;
  legs?: {
    type: 'CE' | 'PE' | 'EQUITY';
    symbol: string;
    strike?: number;
    refPrice?: number;
    currentLtp: number;
    slPrice?: number;
    targetPrice?: number;
    status: 'ACTIVE' | 'SL_HIT' | 'TARGET_HIT' | 'DISABLED';
  }[];
  stepDetails?: {
    currentStep: 1 | 2 | 3;
    step1?: {
      ceStrike: string;
      ceOpen: number;
      peStrike: string;
      peOpen: number;
      timestamp: string;
      isLocked?: boolean;
      isProvisional?: boolean;
      isMarketClosed?: boolean;
    };
    step2?: {
      ceTrigger: number;
      ceLtp: number;
      peTrigger: number;
      peLtp: number;
      multiplier: number;
    };
    step3?: {
      executedSymbol: string;
      executedPrice: number;
      slPrice: number;
      status: string;
      riskPerLot: number;
    };
  };
}

export interface BaseStrategyPlugin {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  category: StrategyCategory;
  executionStyle: StrategyExecutionStyle;
  operatingWindow: {
    startIST: string;       // e.g. "09:20:00"
    endIST: string;         // e.g. "15:30:00"
    isOvernightAllowed: boolean;
  };
  hasZeroTargetInvariant?: boolean;

  // Evaluates live ticks & state
  evaluate: (ctx: StrategyContext) => StrategySignalOutput;

  // Renders custom interactive strategy card on the Signals dashboard
  renderCard: (props: {
    state: StrategySignalOutput;
    onOpenBroker: (symbol: string) => void;
    onViewDetails?: (strategyId: string) => void;
  }) => React.ReactElement;
}
