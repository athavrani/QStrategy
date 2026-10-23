import { dbManager } from '../db/database';
import { ORDER_COLUMNS } from '../db/schema';
import { formatDateKeyIST } from '../constants/nseHolidays';
import type { OrderEnvironment } from '../config/orderConfig';
import { isOpenOrderStatus, type DhanOrder } from './dhan/DhanOrderClient';

export type OrderSource = 'APP' | 'DHAN';

/** An order as stored locally: what Dhan reports plus where it came from. */
export interface StoredOrder extends DhanOrder {
  id: string;
  env: OrderEnvironment;
  tradeDate: string;
  source: OrderSource;
  strategyId: string | null;
}

/** One row per order and environment. Orders are matched on correlation id, falling back to the Dhan order id. */
export function orderKey(env: OrderEnvironment, order: Pick<DhanOrder, 'orderId' | 'correlationId'>): string {
  return `${env}:${order.correlationId || `dhan-${order.orderId}`}`;
}

/** SQLite-backed local copy of the Dhan order book, keyed by environment and session date. */
export class OrderRepository {
  async upsert(
    env: OrderEnvironment,
    order: DhanOrder,
    meta: { source?: OrderSource; strategyId?: string | null; tradeDate?: string } = {}
  ): Promise<void> {
    const db = await dbManager.getDatabase();
    const id = orderKey(env, order);
    const existing = await db.getFirst<any>('SELECT * FROM orders WHERE id = ?', [id]);
    const now = new Date().toISOString();
    const values: Record<string, unknown> = {
      id,
      env,
      trade_date: meta.tradeDate ?? existing?.trade_date ?? formatDateKeyIST(),
      order_id: order.orderId,
      correlation_id: order.correlationId,
      // An order we placed stays ours even when it is later re-read from the Dhan book.
      source: existing?.source ?? meta.source ?? 'DHAN',
      strategy_id: meta.strategyId ?? existing?.strategy_id ?? null,
      status: order.status,
      transaction_type: order.transactionType,
      exchange_segment: order.exchangeSegment,
      product_type: order.productType,
      order_type: order.orderType,
      validity: order.validity,
      security_id: order.securityId,
      trading_symbol: order.tradingSymbol,
      quantity: order.quantity,
      price: order.price,
      trigger_price: order.triggerPrice,
      filled_qty: order.filledQty,
      remaining_qty: order.remainingQuantity,
      avg_price: order.averageTradedPrice,
      error_code: order.errorCode,
      error_message: order.errorMessage,
      create_time: order.createTime ?? existing?.create_time ?? now,
      update_time: order.updateTime,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await db.run(
      `INSERT OR REPLACE INTO orders (${ORDER_COLUMNS.join(', ')}) VALUES (${ORDER_COLUMNS.map(() => '?').join(', ')})`,
      ORDER_COLUMNS.map((c) => values[c])
    );
  }

  /** Newest first. */
  async loadForDate(env: OrderEnvironment, tradeDate: string = formatDateKeyIST()): Promise<StoredOrder[]> {
    const db = await dbManager.getDatabase();
    const rows = await db.getAll<any>(
      'SELECT * FROM orders WHERE env = ? AND trade_date = ? ORDER BY create_time DESC',
      [env, tradeDate]
    );
    return rows.map((r) => this.toOrder(r));
  }

  async loadOpen(env: OrderEnvironment, tradeDate?: string): Promise<StoredOrder[]> {
    return (await this.loadForDate(env, tradeDate)).filter((o) => isOpenOrderStatus(o.status));
  }

  private toOrder(r: any): StoredOrder {
    return {
      id: r.id,
      env: r.env,
      tradeDate: r.trade_date,
      source: r.source,
      strategyId: r.strategy_id ?? null,
      orderId: r.order_id,
      correlationId: r.correlation_id ?? null,
      status: r.status,
      transactionType: r.transaction_type,
      exchangeSegment: r.exchange_segment,
      productType: r.product_type,
      orderType: r.order_type,
      validity: r.validity,
      securityId: r.security_id,
      tradingSymbol: r.trading_symbol ?? null,
      quantity: r.quantity,
      price: r.price,
      triggerPrice: r.trigger_price,
      filledQty: r.filled_qty,
      remainingQuantity: r.remaining_qty,
      averageTradedPrice: r.avg_price,
      createTime: r.create_time ?? null,
      updateTime: r.update_time ?? null,
      errorCode: r.error_code ?? null,
      errorMessage: r.error_message ?? null,
    };
  }
}

export const orderRepository = new OrderRepository();
