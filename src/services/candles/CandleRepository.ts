import { dbManager } from '../../db/database';
import { CANDLE_COLUMNS, CANDLE_INSTRUMENT_COLUMNS } from '../../db/schema';
import type { LiveBar } from './CandleAggregator';

export type CandleSource = 'LIVE' | 'API';

export interface CandleRow extends LiveBar {
  source: CandleSource;
}

export interface CandleInstrument {
  instKey: string;
  segment: string;
  securityId: string;
  underlying: string;
  kind: 'INDEX' | 'CE' | 'PE';
  strike: number | null;
  expiry: string | null;
  symbol: string;
  tradeDate: string;
}

// 9 bound values per row; stays well under SQLite's variable limit
const CHUNK_ROWS = 50;

const COLUMN_LIST = CANDLE_COLUMNS.join(', ');
const ROW_MARKS = `(${CANDLE_COLUMNS.map(() => '?').join(', ')})`;

function flatten(rows: CandleRow[]): any[] {
  return rows.flatMap((r) => [r.instKey, r.ts, r.open, r.high, r.low, r.close, r.volume, r.oi, r.source]);
}

/** On-device store of one-minute candles; only today's session is kept. */
export class CandleRepository {
  /**
   * Writes bars built from ticks. A minute that already has a LIVE row (a restart in the middle of it) keeps its
   * original open and widens its range; a row the API has already filled is left alone.
   */
  async upsertLive(bars: LiveBar[]): Promise<void> {
    if (bars.length === 0) return;
    const db = await dbManager.getDatabase();
    for (let i = 0; i < bars.length; i += CHUNK_ROWS) {
      const rows: CandleRow[] = bars.slice(i, i + CHUNK_ROWS).map((b) => ({ ...b, source: 'LIVE' }));
      await db.run(
        `INSERT INTO candles_1m (${COLUMN_LIST}) VALUES ${rows.map(() => ROW_MARKS).join(', ')}
         ON CONFLICT(inst_key, ts) DO UPDATE SET
           high = MAX(high, excluded.high),
           low = MIN(low, excluded.low),
           close = excluded.close,
           volume = MAX(volume, excluded.volume),
           oi = CASE WHEN excluded.oi > 0 THEN excluded.oi ELSE oi END
         WHERE source = 'LIVE'`,
        flatten(rows)
      );
    }
  }

  /** Writes the exchange candles from Dhan, replacing whatever the ticks produced for those minutes. */
  async replaceApi(bars: LiveBar[]): Promise<void> {
    if (bars.length === 0) return;
    const db = await dbManager.getDatabase();
    for (let i = 0; i < bars.length; i += CHUNK_ROWS) {
      const rows: CandleRow[] = bars.slice(i, i + CHUNK_ROWS).map((b) => ({ ...b, source: 'API' }));
      await db.run(
        `INSERT OR REPLACE INTO candles_1m (${COLUMN_LIST}) VALUES ${rows.map(() => ROW_MARKS).join(', ')}`,
        flatten(rows)
      );
    }
  }

  /** Candles of one instrument with fromTs <= ts < toTs (epoch seconds), oldest first. */
  async getCandles(instKey: string, fromTs = 0, toTs = Number.MAX_SAFE_INTEGER): Promise<CandleRow[]> {
    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>(
      'SELECT * FROM candles_1m WHERE inst_key = ? AND ts >= ? AND ts < ? ORDER BY ts',
      [instKey, fromTs, toTs]
    );
    return rows.map((r) => ({
      instKey: r.inst_key,
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      oi: r.oi,
      source: r.source,
    }));
  }

  async saveInstruments(list: CandleInstrument[]): Promise<void> {
    if (list.length === 0) return;
    const db = await dbManager.getDatabase();
    const sql = `INSERT OR REPLACE INTO candle_instruments (${CANDLE_INSTRUMENT_COLUMNS.join(', ')})
                 VALUES (${CANDLE_INSTRUMENT_COLUMNS.map(() => '?').join(', ')})`;
    for (const i of list) {
      await db.run(sql, [i.instKey, i.segment, i.securityId, i.underlying, i.kind, i.strike, i.expiry, i.symbol, i.tradeDate]);
    }
  }

  async getInstruments(tradeDate: string): Promise<CandleInstrument[]> {
    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>('SELECT * FROM candle_instruments WHERE trade_date = ?', [tradeDate]);
    return rows.map((r) => ({
      instKey: r.inst_key,
      segment: r.segment,
      securityId: r.security_id,
      underlying: r.underlying,
      kind: r.kind,
      strike: r.strike ?? null,
      expiry: r.expiry ?? null,
      symbol: r.symbol,
      tradeDate: r.trade_date,
    }));
  }

  /** Keeps only today: drops candles that started before `dayStartEpoch` and instruments of earlier dates. */
  async pruneBefore(dayStartEpoch: number, tradeDate: string): Promise<void> {
    const db = await dbManager.getDatabase();
    await db.run('DELETE FROM candles_1m WHERE ts < ?', [dayStartEpoch]);
    await db.run('DELETE FROM candle_instruments WHERE trade_date < ?', [tradeDate]);
  }
}

export const candleRepository = new CandleRepository();
