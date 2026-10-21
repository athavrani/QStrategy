import type { DhanParsedPacket } from '../dhan/DhanBinaryCodec';
import type { InstrumentKey, Quote } from './types';

const POSITIVE_FIELDS = ['ltp', 'atp', 'volume', 'dayOpen', 'dayHigh', 'dayLow', 'dayClose', 'prevClose'] as const;

/** Latest merged quote per instrument. Quotes are immutable; every update yields a new object. */
export class SnapshotStore {
  private quotes = new Map<InstrumentKey, Quote>();

  apply(key: InstrumentKey, packet: DhanParsedPacket, recvTs: number): Quote {
    const p = packet as unknown as Record<string, number | undefined>;
    const prev = this.quotes.get(key);
    const next: { -readonly [K in keyof Quote]: Quote[K] } = {
      ...(prev ?? {}),
      key,
      exchangeSegment: packet.exchangeSegment,
      securityId: packet.securityId,
      recvTs,
    };

    // Zero means "not supplied" in partial packets, so only positive values overwrite.
    for (const field of POSITIVE_FIELDS) {
      const v = p[field];
      if (typeof v === 'number' && v > 0) next[field] = v;
    }
    if (typeof p.oi === 'number' && p.oi >= 0) next.oi = p.oi;
    if (typeof p.prevOI === 'number' && p.prevOI >= 0) next.prevOI = p.prevOI;
    if (typeof p.ltt === 'number' && p.ltt > 0) next.exchTs = p.ltt;

    this.quotes.set(key, next);
    return next;
  }

  get(key: InstrumentKey): Quote | undefined {
    return this.quotes.get(key);
  }

  size(): number {
    return this.quotes.size;
  }

  clear(): void {
    this.quotes.clear();
  }
}
