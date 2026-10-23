import { dbManager } from '../db/database';
import { POSITION_COLUMNS } from '../db/schema';
import { formatDateKeyIST } from '../constants/nseHolidays';

/**
 * PROPOSED   a proposal exists; nothing has been sent (inert, kept only so its stop-loss and target are remembered)
 * ENTRY_SENT the entry order is with Dhan and has not filled yet
 * OPEN_UNPROTECTED  shares are held and no stop-loss order is working
 * PROTECTED  shares are held and a stop-loss order is working at the exchange
 * CLOSING    an exit order is in flight
 * CLOSED / ENTRY_FAILED  finished
 */
export type PositionState = 'PROPOSED' | 'ENTRY_SENT' | 'OPEN_UNPROTECTED' | 'PROTECTED' | 'CLOSING' | 'CLOSED' | 'ENTRY_FAILED';

export const ACTIVE_POSITION_STATES: PositionState[] = ['ENTRY_SENT', 'OPEN_UNPROTECTED', 'PROTECTED', 'CLOSING'];
export const isActivePosition = (state: string): boolean => (ACTIVE_POSITION_STATES as string[]).includes(state);

export interface Position {
  /** The entry order's correlation id, which also names the position. */
  id: string;
  tradeDate: string;
  strategyId: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  tradingSymbol: string;
  state: PositionState;
  requestedQty: number;
  filledQty: number;
  entryAvg: number;
  entryOrderId: string | null;
  slPrice: number | null;
  targetPrice: number | null;
  slOrderId: string | null;
  slCorrelationId: string | null;
  slPlacedAt: string | null;
  exitOrderId: string | null;
  exitCorrelationId: string | null;
  exitPlacedAt: string | null;
  exitAvg: number | null;
  pnl: number | null;
  /** Set when the strategy says it is time to leave (target hit, time exit) so the UI can point at it. */
  exitHint: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewPosition = Pick<Position, 'id' | 'strategyId' | 'securityId' | 'exchangeSegment' | 'productType' | 'tradingSymbol' | 'requestedQty'> &
  Partial<Pick<Position, 'slPrice' | 'targetPrice' | 'state' | 'tradeDate'>>;

/** SQLite-backed record of the positions this app opened, so stop-losses and exits survive restarts. */
export class PositionRepository {
  async create(input: NewPosition): Promise<Position> {
    const now = new Date().toISOString();
    const position: Position = {
      tradeDate: formatDateKeyIST(),
      state: 'PROPOSED',
      slPrice: null,
      targetPrice: null,
      filledQty: 0,
      entryAvg: 0,
      entryOrderId: null,
      slOrderId: null,
      slCorrelationId: null,
      slPlacedAt: null,
      exitOrderId: null,
      exitCorrelationId: null,
      exitPlacedAt: null,
      exitAvg: null,
      pnl: null,
      exitHint: null,
      note: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    await this.write(position);
    return position;
  }

  async get(id: string): Promise<Position | null> {
    const db = await dbManager.getDatabase();
    const row = await db.getFirst<any>('SELECT * FROM app_positions WHERE id = ?', [id]);
    return row ? this.toPosition(row) : null;
  }

  /** Merges a change into an existing position. Returns the updated position, or null when it does not exist. */
  async update(id: string, patch: Partial<Omit<Position, 'id' | 'createdAt'>>): Promise<Position | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: Position = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    await this.write(next);
    return next;
  }

  async loadAll(): Promise<Position[]> {
    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>('SELECT * FROM app_positions ORDER BY created_at DESC');
    return rows.map((r) => this.toPosition(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async loadActive(): Promise<Position[]> {
    return (await this.loadAll()).filter((p) => isActivePosition(p.state));
  }

  /** Active positions plus today's finished ones; proposals that never became orders are left out. */
  async loadVisible(today: string = formatDateKeyIST()): Promise<Position[]> {
    return (await this.loadAll()).filter(
      (p) => isActivePosition(p.state) || ((p.state === 'CLOSED' || p.state === 'ENTRY_FAILED') && p.tradeDate === today)
    );
  }

  private async write(p: Position): Promise<void> {
    const db = await dbManager.getDatabase();
    const values: Record<string, unknown> = {
      id: p.id,
      trade_date: p.tradeDate,
      strategy_id: p.strategyId,
      security_id: p.securityId,
      exchange_segment: p.exchangeSegment,
      product_type: p.productType,
      trading_symbol: p.tradingSymbol,
      state: p.state,
      requested_qty: p.requestedQty,
      filled_qty: p.filledQty,
      entry_avg: p.entryAvg,
      entry_order_id: p.entryOrderId,
      sl_price: p.slPrice,
      target_price: p.targetPrice,
      sl_order_id: p.slOrderId,
      sl_correlation_id: p.slCorrelationId,
      sl_placed_at: p.slPlacedAt,
      exit_order_id: p.exitOrderId,
      exit_correlation_id: p.exitCorrelationId,
      exit_placed_at: p.exitPlacedAt,
      exit_avg: p.exitAvg,
      pnl: p.pnl,
      exit_hint: p.exitHint,
      note: p.note,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    };
    await db.run(
      `INSERT OR REPLACE INTO app_positions (${POSITION_COLUMNS.join(', ')}) VALUES (${POSITION_COLUMNS.map(() => '?').join(', ')})`,
      POSITION_COLUMNS.map((c) => values[c])
    );
  }

  private toPosition(r: any): Position {
    return {
      id: r.id,
      tradeDate: r.trade_date,
      strategyId: r.strategy_id,
      securityId: r.security_id,
      exchangeSegment: r.exchange_segment,
      productType: r.product_type,
      tradingSymbol: r.trading_symbol,
      state: r.state,
      requestedQty: r.requested_qty,
      filledQty: r.filled_qty,
      entryAvg: r.entry_avg,
      entryOrderId: r.entry_order_id ?? null,
      slPrice: r.sl_price ?? null,
      targetPrice: r.target_price ?? null,
      slOrderId: r.sl_order_id ?? null,
      slCorrelationId: r.sl_correlation_id ?? null,
      slPlacedAt: r.sl_placed_at ?? null,
      exitOrderId: r.exit_order_id ?? null,
      exitCorrelationId: r.exit_correlation_id ?? null,
      exitPlacedAt: r.exit_placed_at ?? null,
      exitAvg: r.exit_avg ?? null,
      pnl: r.pnl ?? null,
      exitHint: r.exit_hint ?? null,
      note: r.note ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

export const positionRepository = new PositionRepository();
