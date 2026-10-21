import type { DhanParsedPacket } from '../dhan/DhanBinaryCodec';

// `${exchangeSegmentCode}:${securityId}` — the same composite key the feed socket emits.
export type InstrumentKey = string;

export type Freshness = 'FRESH' | 'AGING' | 'STALE' | 'DISCONNECTED';

export type MarketBatch = Record<InstrumentKey, DhanParsedPacket>;

export type Unsubscribe = () => void;

export interface Quote {
  readonly key: InstrumentKey;
  readonly exchangeSegment: number;
  readonly securityId: number;
  readonly ltp?: number;
  readonly atp?: number;
  readonly volume?: number;
  readonly dayOpen?: number;
  readonly dayHigh?: number;
  readonly dayLow?: number;
  readonly dayClose?: number;
  readonly prevClose?: number;
  readonly oi?: number;
  readonly prevOI?: number;
  /** Exchange last-trade time, epoch seconds. */
  readonly exchTs?: number;
  /** Local receive time, epoch ms. */
  readonly recvTs: number;
}

// Dhan exchange segment codes (binary feed header byte 3).
const SEGMENT_CODES: Record<string, number> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURRENCY: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURRENCY: 7,
  BSE_FNO: 8,
};

export function segmentCode(segment: string | number): number {
  if (typeof segment === 'number') return segment;
  return SEGMENT_CODES[segment] ?? -1;
}

export function instrumentKey(segment: string | number, securityId: string | number): InstrumentKey {
  return `${segmentCode(segment)}:${securityId}`;
}
