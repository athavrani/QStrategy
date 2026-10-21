import type { OptionChainResult, OptionLegData } from '../services/dhan/DhanOptionChainService';
import type { InstrumentSubscription } from '../services/dhan/DhanBinaryCodec';
import { instrumentKey } from '../services/marketdata/types';

export const CHAIN_REFRESH_INTERVAL_MS = 12_000;
/** A leg that ticked within this window keeps its live price over the REST snapshot. */
export const LIVE_TICK_PRIORITY_MS = 15_000;

function mergeLeg(
  prev: OptionLegData | undefined,
  next: OptionLegData,
  lastTickAt: Map<string, number>,
  now: number
): OptionLegData {
  const id = next.securityId;
  const tickedAt = id ? lastTickAt.get(id) : undefined;
  const liveWins = tickedAt !== undefined && now - tickedAt < LIVE_TICK_PRIORITY_MS && prev?.ltp != null && prev.ltp > 0;
  return liveWins ? { ...next, ltp: prev!.ltp } : next;
}

/** Applies a fresh REST chain but keeps live-streamed prices for legs that ticked recently. */
export function mergeRefreshedChain(
  prev: OptionChainResult | null,
  next: OptionChainResult,
  lastTickAt: Map<string, number>,
  now: number
): OptionChainResult {
  if (!prev || prev.underlyingScrip !== next.underlyingScrip) return next;
  const prevByStrike = new Map(prev.strikes.map((s) => [s.strikePrice, s]));
  return {
    ...next,
    strikes: next.strikes.map((s) => {
      const old = prevByStrike.get(s.strikePrice);
      return {
        ...s,
        ce: mergeLeg(old?.ce, s.ce, lastTickAt, now),
        pe: mergeLeg(old?.pe, s.pe, lastTickAt, now),
      };
    }),
  };
}

export function chainSubscriptions(chain: OptionChainResult, segment: string): InstrumentSubscription[] {
  const subs: InstrumentSubscription[] = [];
  for (const s of chain.strikes ?? []) {
    if (s.ce?.securityId) subs.push({ exchangeSegment: segment, securityId: s.ce.securityId });
    if (s.pe?.securityId) subs.push({ exchangeSegment: segment, securityId: s.pe.securityId });
  }
  return subs;
}

/** Splits the wanted set against what is already subscribed so unchanged contracts are never re-sent. */
export function diffSubscriptions(
  current: Map<string, InstrumentSubscription>,
  wanted: InstrumentSubscription[]
): { toAdd: InstrumentSubscription[]; toDrop: InstrumentSubscription[] } {
  const wantedMap = new Map(wanted.map((w) => [instrumentKey(w.exchangeSegment, w.securityId), w]));
  const toAdd = [...wantedMap].filter(([k]) => !current.has(k)).map(([, v]) => v);
  const toDrop = [...current].filter(([k]) => !wantedMap.has(k)).map(([, v]) => v);
  return { toAdd, toDrop };
}
