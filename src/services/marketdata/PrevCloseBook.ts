import { SENSEX_NIFTY_MASTER_CATALOG } from '../../constants/stockUniverse';
import { formatDateKeyIST } from '../../constants/nseHolidays';
import { calcChangePct, isReasonableChangePct } from '../../utils/marketDataUtils';

/** Higher rank wins; a value is only replaced by a higher-ranked source. */
export type PrevCloseSource = 'EXCHANGE' | 'REST' | 'QUOTE' | 'HISTORY' | 'CATALOG';

const RANK: Record<PrevCloseSource, number> = {
  EXCHANGE: 4, // previous-close packet on the websocket
  REST: 3, // net_change / previous_close from the REST quote
  QUOTE: 2, // close field of the websocket quote packet
  HISTORY: 1, // last daily candle
  CATALOG: 0, // static seed, last resort
};

const AUTHORITATIVE: PrevCloseSource[] = ['EXCHANGE', 'REST'];
const CONFLICT_TOLERANCE_PCT = 0.1;
const MAX_LOG = 300;

export interface PrevCloseEntry {
  value: number;
  source: PrevCloseSource;
}

export interface PrevCloseLogEntry {
  at: number;
  ticker: string;
  event: 'SET' | 'CONFLICT' | 'REJECT';
  source: PrevCloseSource;
  value: number;
  heldValue?: number;
  heldSource?: PrevCloseSource;
}

/**
 * Single owner of each stock's previous close for the trading day. A value is set by the best source
 * available and never replaced by a lower-ranked one, so the displayed percentage cannot flip between sources.
 */
export class PrevCloseBook {
  private entries = new Map<string, PrevCloseEntry>();
  private sessionDate = '';
  private log: PrevCloseLogEntry[] = [];

  constructor(
    private readonly dateKey: () => string = formatDateKeyIST,
    private readonly seed: () => Array<[string, number]> = () =>
      SENSEX_NIFTY_MASTER_CATALOG.map((s): [string, number] => [s.ticker, s.prevClose])
  ) {}

  /** Clears yesterday's values and reseeds the catalog baseline when the trading day changes. */
  ensureDay(force = false): void {
    const today = this.dateKey();
    if (!force && this.sessionDate === today) return;
    this.sessionDate = today;
    this.entries = new Map();
    for (const [ticker, value] of this.seed()) {
      if (value > 0) this.entries.set(ticker.toUpperCase(), { value, source: 'CATALOG' });
    }
  }

  get(ticker: string): PrevCloseEntry | undefined {
    this.ensureDay();
    return this.entries.get(ticker.toUpperCase());
  }

  /** Returns true when the stored value or its source changed. */
  set(ticker: string, value: number, source: PrevCloseSource, ltp?: number): boolean {
    this.ensureDay();
    const key = ticker.toUpperCase();
    if (!(value > 0) || !isFinite(value)) return false;
    const next = Number(value.toFixed(2));

    // Exchange values are trusted as-is; everything else must be plausible against the live price.
    if (source !== 'EXCHANGE' && ltp && ltp > 0) {
      const pct = calcChangePct(ltp, next);
      if (pct === null || !isReasonableChangePct(pct)) {
        this.record({ ticker: key, event: 'REJECT', source, value: next });
        return false;
      }
    }

    const held = this.entries.get(key);
    if (!held) {
      this.entries.set(key, { value: next, source });
      this.record({ ticker: key, event: 'SET', source, value: next });
      return true;
    }

    const differs = Math.abs(next - held.value) / held.value * 100 > CONFLICT_TOLERANCE_PCT;
    const rankDiff = RANK[source] - RANK[held.source];

    if (rankDiff > 0 || (rankDiff === 0 && source === 'EXCHANGE' && differs)) {
      this.entries.set(key, { value: next, source });
      this.record({ ticker: key, event: 'SET', source, value: next, heldValue: held.value, heldSource: held.source });
      return true;
    }

    if (differs) {
      this.record({
        ticker: key,
        event: 'CONFLICT',
        source,
        value: next,
        heldValue: held.value,
        heldSource: held.source,
      });
    }
    return false;
  }

  /** Percentage vs the held previous close; trusted sources skip the sanity gate. */
  percent(ticker: string, spot: number, fallbackPct: number): number {
    const held = this.get(ticker);
    if (!held || spot <= 0) return fallbackPct;
    const pct = calcChangePct(spot, held.value);
    if (pct === null) return fallbackPct;
    if (AUTHORITATIVE.includes(held.source) || isReasonableChangePct(pct)) return pct;
    return fallbackPct;
  }

  getLog(): PrevCloseLogEntry[] {
    return [...this.log];
  }

  conflictCount(): number {
    return this.log.filter((e) => e.event === 'CONFLICT').length;
  }

  /** Most recent entries, newest last, one line each. */
  formatLog(limit = 15): string {
    const rows = this.log.slice(-limit).map((e) => {
      const t = new Date(e.at).toLocaleTimeString('en-IN');
      const held = e.heldValue !== undefined ? ` (held ${e.heldValue} ${e.heldSource})` : '';
      return `${t} ${e.event} ${e.ticker} ${e.value} ${e.source}${held}`;
    });
    return rows.length > 0 ? rows.join('\n') : 'No previous-close events yet';
  }

  resetForTest(): void {
    this.entries = new Map();
    this.sessionDate = '';
    this.log = [];
  }

  private record(entry: Omit<PrevCloseLogEntry, 'at'>): void {
    this.log.push({ at: Date.now(), ...entry });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }
}

export const prevCloseBook = new PrevCloseBook();
