import { minuteStartEpoch } from './candleTime';

export interface LiveBar {
  instKey: string;
  /** Epoch seconds of the minute start. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

interface WorkingBar extends LiveBar {
  /** Cumulative day volume when this minute began; the bar's volume is the growth since then. */
  volBase: number;
}

const strip = ({ volBase: _volBase, ...bar }: WorkingBar): LiveBar => bar;

/**
 * Builds one-minute bars from ticks. Pure and clock-free: the caller passes the time of each tick.
 * Bars that changed since the last `takeDirty` are handed out again, so a minute is rewritten until it closes.
 */
export class CandleAggregator {
  private readonly current = new Map<string, WorkingBar>();
  private readonly lastCumVolume = new Map<string, number>();
  private readonly lastOi = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private closed: LiveBar[] = [];

  ingest(instKey: string, ltp: number, nowMs: number, cumVolume?: number, oi?: number): void {
    if (!(ltp > 0)) return;
    const ts = minuteStartEpoch(nowMs);
    const cum = cumVolume !== undefined && cumVolume > 0 ? cumVolume : undefined;
    if (oi !== undefined && oi > 0) this.lastOi.set(instKey, oi);

    let bar = this.current.get(instKey);
    // A late tick from an earlier minute (clock stepped back) must not reopen a closed bar
    if (bar && bar.ts > ts) return;

    if (!bar || bar.ts < ts) {
      if (bar && this.dirty.has(instKey)) {
        this.closed.push(strip(bar));
        this.dirty.delete(instKey);
      }
      bar = {
        instKey,
        ts,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        volume: 0,
        oi: this.lastOi.get(instKey) ?? 0,
        // Volume of the first minute seen is unknown; the end-of-day API candles fill it in
        volBase: cum !== undefined ? this.lastCumVolume.get(instKey) ?? cum : 0,
      };
      this.current.set(instKey, bar);
    } else {
      bar.high = Math.max(bar.high, ltp);
      bar.low = Math.min(bar.low, ltp);
      bar.close = ltp;
    }

    if (cum !== undefined) {
      if (cum < bar.volBase) bar.volBase = cum;
      bar.volume = cum - bar.volBase;
      this.lastCumVolume.set(instKey, cum);
    }
    const knownOi = this.lastOi.get(instKey);
    if (knownOi) bar.oi = knownOi;
    this.dirty.add(instKey);
  }

  /** An open-interest update that arrived without a price. */
  noteOi(instKey: string, oi: number): void {
    if (!(oi > 0)) return;
    this.lastOi.set(instKey, oi);
    const bar = this.current.get(instKey);
    if (bar) {
      bar.oi = oi;
      this.dirty.add(instKey);
    }
  }

  /** Bars that closed or changed since the last call. */
  takeDirty(): LiveBar[] {
    const out = this.closed;
    this.closed = [];
    for (const key of this.dirty) {
      const bar = this.current.get(key);
      if (bar) out.push(strip(bar));
    }
    this.dirty.clear();
    return out;
  }

  /** Puts bars back after a failed write, so the next flush sends them again. */
  requeue(bars: LiveBar[]): void {
    for (const bar of bars) {
      const live = this.current.get(bar.instKey);
      if (live && live.ts === bar.ts) this.dirty.add(bar.instKey);
      else this.closed.push(bar);
    }
  }

  reset(): void {
    this.current.clear();
    this.lastCumVolume.clear();
    this.lastOi.clear();
    this.dirty.clear();
    this.closed = [];
  }
}
