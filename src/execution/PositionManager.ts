import { positionRepository, isActivePosition, type Position, type PositionRepository } from '../services/PositionRepository';
import { notificationService } from '../services/notificationService';
import { secureVault } from '../services/SecureCredentialVault';
import { formatDateKeyIST } from '../constants/nseHolidays';
import {
  liveOrderClient,
  isCancellableStatus,
  isOpenOrderStatus,
  type DhanOrder,
  type DhanOrderClient,
  type OrderRequest,
} from '../services/dhan/DhanOrderClient';
import { PROTECT_RETRY_MS, SL_LIMIT_BUFFER_PCT } from '../config/orderConfig';
import { roundDownToTick } from './orderMapping';
import type { ClosedTrade } from '../engine/types';

type ManagerClient = Pick<
  DhanOrderClient,
  'getOrders' | 'getPositions' | 'cancelOrder' | 'placeClosingOrder' | 'modifyClosingOrder'
>;

export interface PositionManagerDeps {
  positions?: Pick<PositionRepository, 'get' | 'update' | 'loadActive' | 'loadVisible'>;
  client?: ManagerClient;
  now?: () => Date;
  /** Raises a user-visible alert (notification). Failures must never stop reconciliation. */
  alert?: (title: string, body: string) => void;
  slLimitBufferPct?: number;
  retryMs?: number;
  /** Seconds until the live access token expires, or null when unknown. */
  tokenSecondsLeft?: () => Promise<number | null>;
  /** Consecutive failed order-book reads before the user is told positions cannot be managed. */
  unreachableAfter?: number;
}

export type ExitResult = { ok: true } | { ok: false; error: string; uncertain?: boolean };

const DEAD = ['REJECTED', 'CANCELLED', 'EXPIRED'];
const ENTRY_MISSING_MS = 10 * 60_000;
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const slug = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').slice(-10);

/**
 * Looks after the positions this app opened:
 *  - once an entry fills, places a stop-loss order at the exchange and keeps its quantity equal to what was filled;
 *  - notices when the stop-loss or an exit order trades and closes the record with its P&L;
 *  - raises an alert whenever shares are held with no working stop-loss;
 *  - exits a position on request, cancelling the stop-loss first so the shares are never sold twice.
 * All work runs one step at a time, so a reconcile and an exit can never overlap.
 */
export class PositionManager {
  private readonly positions: NonNullable<PositionManagerDeps['positions']>;
  private readonly client: ManagerClient;
  private readonly now: () => Date;
  private readonly alert: (title: string, body: string) => void;
  private readonly bufferPct: number;
  private readonly retryMs: number;
  private readonly tokenSecondsLeft: () => Promise<number | null>;
  private readonly unreachableAfter: number;
  private failures = 0;
  private unreachableAlerted = false;
  private tokenWarned = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: PositionManagerDeps = {}) {
    this.positions = deps.positions ?? positionRepository;
    this.client = deps.client ?? liveOrderClient;
    this.now = deps.now ?? (() => new Date());
    this.alert =
      deps.alert ??
      ((title, body) => {
        void notificationService.notifyPositionAlert(title, body);
      });
    this.bufferPct = deps.slLimitBufferPct ?? SL_LIMIT_BUFFER_PCT;
    this.retryMs = deps.retryMs ?? PROTECT_RETRY_MS;
    this.unreachableAfter = deps.unreachableAfter ?? 3;
    this.tokenSecondsLeft =
      deps.tokenSecondsLeft ??
      (async () => {
        try {
          const creds = await secureVault.getEffectiveCredentials();
          return creds.token ? secureVault.getTokenRemainingSeconds(creds.token) : null;
        } catch {
          return null;
        }
      });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private tell(title: string, body: string): void {
    try {
      this.alert(title, body);
    } catch {
      // An alert that cannot be shown must not stop the work.
    }
  }

  private elapsed(iso: string | null): number {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) ? this.now().getTime() - t : Number.POSITIVE_INFINITY;
  }

  // ------------------------------------------------------------ reconcile

  /** Brings every active position in line with Dhan's order book. Safe to call as often as every few seconds. */
  reconcile(): Promise<{ checked: number; error?: string }> {
    return this.serial(() => this.runReconcile());
  }

  private async runReconcile(): Promise<{ checked: number; error?: string }> {
    const active = await this.positions.loadActive();
    if (active.length === 0) return { checked: 0 };

    await this.warnIfTokenEnding();

    const res = await this.client.getOrders();
    if (!res.ok) {
      this.noteFailure(res.status, res.error);
      return { checked: active.length, error: res.error };
    }
    this.noteRecovered();

    const today = formatDateKeyIST(this.now());
    let broker: any[] | null | undefined;
    const brokerPositions = async () => {
      if (broker === undefined) {
        const r = await this.client.getPositions();
        broker = r.ok ? r.data : null;
      }
      return broker;
    };

    for (const p of active) {
      try {
        await this.reconcileOne(p, res.data, today, brokerPositions);
      } catch {
        // One position failing must not stop the others from being protected.
      }
    }
    return { checked: active.length };
  }

  private async reconcileOne(
    p: Position,
    orders: DhanOrder[],
    today: string,
    brokerPositions: () => Promise<any[] | null>
  ): Promise<void> {
    const byCorr = (corr: string | null) => (corr ? orders.find((o) => o.correlationId === corr) : undefined);
    let pos = p;

    // Entry. Dhan's order book only covers today, so an older position relies on what was stored.
    if (p.tradeDate === today) {
      const entry = byCorr(p.id) ?? (p.entryOrderId ? orders.find((o) => o.orderId === p.entryOrderId) : undefined);
      if (entry) {
        const patch: Partial<Position> = {};
        if (entry.filledQty !== p.filledQty) patch.filledQty = entry.filledQty;
        if (entry.averageTradedPrice > 0 && entry.averageTradedPrice !== p.entryAvg) patch.entryAvg = entry.averageTradedPrice;
        if (entry.orderId && entry.orderId !== p.entryOrderId) patch.entryOrderId = entry.orderId;
        if (p.state === 'ENTRY_SENT') {
          if (entry.filledQty > 0) patch.state = 'OPEN_UNPROTECTED';
          else if (DEAD.includes(entry.status)) {
            patch.state = 'ENTRY_FAILED';
            patch.note = entry.errorMessage ?? `Entry order ${entry.status.toLowerCase()}.`;
          }
        }
        if (Object.keys(patch).length) pos = (await this.positions.update(p.id, patch)) ?? p;
      } else if (p.state === 'ENTRY_SENT' && this.elapsed(p.createdAt) > ENTRY_MISSING_MS) {
        // Every order Dhan accepts shows up in the order book, so one that never does was not placed.
        await this.positions.update(p.id, { state: 'ENTRY_FAILED', note: 'The entry order never appeared at Dhan, so it was not placed.' });
        return;
      }
    } else if (p.state === 'ENTRY_SENT') {
      // An entry from an earlier day: the order book no longer lists it, so ask Dhan what is actually held.
      const list = await brokerPositions();
      if (list === null) return;
      const row = list.find(
        (r) => String(r.securityId) === p.securityId && r.exchangeSegment === p.exchangeSegment && r.productType === p.productType
      );
      const net = Number(row?.netQty ?? 0);
      if (net > 0) {
        pos = (await this.positions.update(p.id, { state: 'OPEN_UNPROTECTED', filledQty: net, entryAvg: Number(row?.buyAvg ?? 0) })) ?? p;
      } else {
        await this.positions.update(p.id, { state: 'ENTRY_FAILED', note: 'Nothing is held at Dhan for this earlier entry.' });
        return;
      }
    }
    if (pos.state === 'ENTRY_SENT' || pos.state === 'ENTRY_FAILED') return;

    if (pos.state === 'CLOSING') {
      const reverted = await this.checkClosing(pos, orders);
      if (!reverted) return;
      pos = reverted; // the exit failed, so the position needs its stop-loss back straight away
    }
    await this.manageProtection(pos, orders, today, brokerPositions);
  }

  /** Returns the position when it went back to needing protection, or null when there is nothing more to do now. */
  private async checkClosing(pos: Position, orders: DhanOrder[]): Promise<Position | null> {
    const exit = pos.exitCorrelationId ? orders.find((o) => o.correlationId === pos.exitCorrelationId) : undefined;
    if (!exit) {
      if (this.elapsed(pos.exitPlacedAt) > this.retryMs) {
        return this.positions.update(pos.id, {
          state: 'OPEN_UNPROTECTED',
          exitOrderId: null,
          exitCorrelationId: null,
          exitPlacedAt: null,
          note: 'The exit order was not found at Dhan. The stop-loss will be placed again.',
        });
      }
      return null;
    }
    if (exit.status === 'TRADED') {
      await this.close(pos, exit.averageTradedPrice, 'Exited at market.', orders);
      return null;
    }
    if (DEAD.includes(exit.status)) {
      const reason = exit.errorMessage ?? exit.status.toLowerCase();
      const reverted = await this.positions.update(pos.id, {
        state: 'OPEN_UNPROTECTED',
        exitOrderId: null,
        exitCorrelationId: null,
        exitPlacedAt: null,
        note: `Exit order ${reason}. The stop-loss will be placed again.`,
      });
      this.tell(`Exit failed: ${pos.tradingSymbol}`, `The exit order was ${exit.status.toLowerCase()}. Re-protecting with a stop-loss. Check Orders.`);
      return reverted;
    }
    return null;
  }

  private async manageProtection(
    start: Position,
    orders: DhanOrder[],
    today: string,
    brokerPositions: () => Promise<any[] | null>
  ): Promise<void> {
    let pos = start;
    const held = pos.filledQty;
    if (held <= 0) return;
    const byCorr = (corr: string | null) => (corr ? orders.find((o) => o.correlationId === corr) : undefined);

    const sl = byCorr(pos.slCorrelationId) ?? (pos.slOrderId ? orders.find((o) => o.orderId === pos.slOrderId) : undefined);
    if (sl) {
      if (sl.status === 'TRADED') {
        await this.close(pos, sl.averageTradedPrice || pos.slPrice || 0, 'Stop-loss hit.', orders);
        return;
      }
      if (isOpenOrderStatus(sl.status)) {
        if (pos.state !== 'PROTECTED' || pos.slOrderId !== sl.orderId) {
          pos = (await this.positions.update(pos.id, { state: 'PROTECTED', slOrderId: sl.orderId, note: null })) ?? pos;
        }
        if (sl.quantity !== held && isCancellableStatus(sl.status)) {
          // The entry filled more (or less) since the stop-loss was placed, so keep the two quantities equal.
          await this.client.modifyClosingOrder(
            sl.orderId,
            { orderType: 'STOP_LOSS', validity: 'DAY', quantity: held, price: sl.price, triggerPrice: sl.triggerPrice },
            held
          );
        }
        return;
      }
      pos =
        (await this.positions.update(pos.id, {
          state: 'OPEN_UNPROTECTED',
          slOrderId: null,
          slCorrelationId: null,
          slPlacedAt: null,
          note: `The stop-loss order was ${sl.status.toLowerCase()}. Placing it again.`,
        })) ?? pos;
    } else if (pos.slCorrelationId) {
      if (this.elapsed(pos.slPlacedAt) < this.retryMs) return; // just sent; the order book may not list it yet
      pos = (await this.positions.update(pos.id, { slCorrelationId: null, slPlacedAt: null })) ?? pos;
    }

    await this.placeStopLoss(pos, today, brokerPositions);
  }

  private async placeStopLoss(pos: Position, today: string, brokerPositions: () => Promise<any[] | null>): Promise<void> {
    const alertOnce = async (note: string, title: string) => {
      const changed = pos.note !== note;
      await this.positions.update(pos.id, { state: 'OPEN_UNPROTECTED', note });
      if (changed) this.tell(title, note);
    };

    // After a rejection wait before trying again, so a persistent problem does not hammer Dhan or the user.
    if (!pos.slCorrelationId && pos.slPlacedAt && this.elapsed(pos.slPlacedAt) < this.retryMs) return;

    if (pos.slPrice == null || !(pos.slPrice > 0)) {
      await alertOnce('No stop-loss price was set for this position. Exit it manually.', `No stop-loss: ${pos.tradingSymbol}`);
      return;
    }

    let qty = pos.filledQty;
    if (pos.tradeDate !== today) {
      // An older position: confirm with Dhan that the shares are still held before selling anything against them.
      const list = await brokerPositions();
      if (list === null) return; // could not check; try again on the next pass
      const row = list.find(
        (r) => String(r.securityId) === pos.securityId && r.exchangeSegment === pos.exchangeSegment && r.productType === pos.productType
      );
      const net = Number(row?.netQty ?? 0);
      if (net <= 0) {
        await this.positions.update(pos.id, { state: 'CLOSED', note: 'No longer held at Dhan (closed elsewhere or expired).' });
        return;
      }
      qty = Math.min(qty, net);
    }

    const corr = `QSS-${slug(pos.id)}-${this.now().getTime().toString(36).slice(-7)}`.slice(0, 30);
    await this.positions.update(pos.id, { slCorrelationId: corr, slPlacedAt: this.now().toISOString() });
    const request: OrderRequest = {
      correlationId: corr,
      transactionType: 'SELL',
      exchangeSegment: pos.exchangeSegment as OrderRequest['exchangeSegment'],
      productType: pos.productType as OrderRequest['productType'],
      orderType: 'STOP_LOSS',
      validity: 'DAY',
      securityId: pos.securityId,
      quantity: qty,
      price: roundDownToTick(pos.slPrice * (1 - this.bufferPct / 100)),
      triggerPrice: pos.slPrice,
    };
    const out = await this.client.placeClosingOrder(request, qty);

    if (out.kind === 'PLACED') {
      await this.positions.update(pos.id, { state: 'PROTECTED', slOrderId: out.orderId, note: null });
    } else if (out.kind === 'REJECTED') {
      await this.positions.update(pos.id, { slCorrelationId: null, slPlacedAt: this.now().toISOString() });
      await alertOnce(`Stop-loss was rejected: ${out.error}`, `NO STOP-LOSS: ${pos.tradingSymbol}`);
    }
    // UNKNOWN: the correlation id is kept, so the next pass finds the order in the book instead of sending a second one.
  }

  private async close(pos: Position, exitAvg: number, why: string, orders: DhanOrder[]): Promise<void> {
    const pnl = Number(((exitAvg - pos.entryAvg) * pos.filledQty).toFixed(2));
    await this.positions.update(pos.id, { state: 'CLOSED', exitAvg, pnl, slOrderId: pos.slOrderId, note: why });
    this.tell(`${why.replace('.', '')}: ${pos.tradingSymbol}`, `P&L ${pnl >= 0 ? '+' : ''}${pnl} (${pos.filledQty} qty, entry ${pos.entryAvg}, exit ${exitAvg}).`);

    // Anything of ours still working for this position must not fire later.
    const entry = orders.find((o) => o.correlationId === pos.id);
    const sl = pos.slCorrelationId ? orders.find((o) => o.correlationId === pos.slCorrelationId) : undefined;
    for (const o of [entry, sl]) {
      if (o && isOpenOrderStatus(o.status) && isCancellableStatus(o.status)) {
        try {
          await this.client.cancelOrder(o.orderId);
        } catch {
          // Best effort; the order book still shows it.
        }
      }
    }
  }

  /** Tries to place the stop-loss now, skipping the cool-down that follows a rejection. */
  protectNow(id: string): Promise<{ checked: number; error?: string }> {
    return this.serial(async () => {
      const pos = await this.positions.get(id);
      if (pos && pos.state === 'OPEN_UNPROTECTED' && !pos.slCorrelationId) {
        await this.positions.update(id, { slPlacedAt: null });
      }
      return this.runReconcile();
    });
  }

  // -------------------------------------------------------------- health

  /** Tells the user once when Dhan cannot be reached (or the token has expired) while positions are open. */
  private noteFailure(status: number, error: string): void {
    this.failures += 1;
    const expired = status === 401;
    if (this.unreachableAlerted || (!expired && this.failures < this.unreachableAfter)) return;
    this.unreachableAlerted = true;
    this.tell(
      expired ? 'Dhan access token expired' : 'Cannot manage your positions',
      `${expired ? 'The access token is no longer valid' : error}. Stop-losses already at the exchange still work, but the app cannot place new ones or exit. Open the Dhan app to check your positions.`
    );
  }

  private noteRecovered(): void {
    if (this.unreachableAlerted) this.tell('Connection to Dhan restored', 'The app is managing your positions again.');
    this.failures = 0;
    this.unreachableAlerted = false;
  }

  private async warnIfTokenEnding(): Promise<void> {
    const left = await this.tokenSecondsLeft();
    if (left === null || left > 30 * 60) {
      if (left !== null) this.tokenWarned = false;
      return;
    }
    if (this.tokenWarned) return;
    this.tokenWarned = true;
    this.tell('Dhan access token ends soon', `It ends in about ${Math.max(0, Math.round(left / 60))} min and you hold positions. Renew it, or manage them in the Dhan app.`);
  }

  // ----------------------------------------------------------------- exit

  /** Sells the whole position at market. The stop-loss is cancelled first so the shares cannot be sold twice. */
  exitPosition(id: string): Promise<ExitResult> {
    return this.serial(() => this.runExit(id));
  }

  private async runExit(id: string): Promise<ExitResult> {
    const fail = (error: string, uncertain = false): ExitResult => ({ ok: false, error, uncertain });
    const pos = await this.positions.get(id);
    if (!pos || (pos.state !== 'PROTECTED' && pos.state !== 'OPEN_UNPROTECTED')) return fail('This position cannot be exited right now.');
    if (pos.filledQty <= 0) return fail('Nothing has been bought yet, so there is nothing to exit.');

    if (pos.slOrderId) {
      const cancelled = await this.client.cancelOrder(pos.slOrderId);
      if (!cancelled.ok) {
        // It may already have traded; the next reconcile will record that. Selling now could sell the shares twice.
        return fail(`Could not cancel the stop-loss (${cancelled.error}). Not selling, so the shares are not sold twice. Refresh and check.`);
      }
    }

    const corr = `QSX-${slug(pos.id)}-${this.now().getTime().toString(36).slice(-7)}`.slice(0, 30);
    await this.positions.update(id, {
      state: 'CLOSING',
      slOrderId: null,
      slCorrelationId: null,
      slPlacedAt: null,
      exitCorrelationId: corr,
      exitPlacedAt: this.now().toISOString(),
      note: 'Exiting at market.',
    });

    const out = await this.client.placeClosingOrder(
      {
        correlationId: corr,
        transactionType: 'SELL',
        exchangeSegment: pos.exchangeSegment as OrderRequest['exchangeSegment'],
        productType: pos.productType as OrderRequest['productType'],
        orderType: 'MARKET',
        validity: 'DAY',
        securityId: pos.securityId,
        quantity: pos.filledQty,
      },
      pos.filledQty
    );

    if (out.kind === 'PLACED') {
      await this.positions.update(id, { exitOrderId: out.orderId });
      return { ok: true };
    }
    if (out.kind === 'REJECTED') {
      await this.positions.update(id, {
        state: 'OPEN_UNPROTECTED',
        exitCorrelationId: null,
        exitPlacedAt: null,
        note: `Exit was rejected: ${out.error}. The stop-loss will be placed again.`,
      });
      this.tell(`Exit failed: ${pos.tradingSymbol}`, `${out.error}. Re-protecting with a stop-loss.`);
      await this.runReconcile(); // the stop-loss was cancelled for this exit, so put it back now
      return fail(out.error);
    }
    return fail(`Result unknown: ${out.error}. Check the Dhan order book (ref ${corr}).`, true);
  }

  /** Panic button: exits every held position, one at a time, and reports which ones could not be exited. */
  exitAll(): Promise<{ attempted: number; failed: Array<{ id: string; symbol: string; error: string }> }> {
    return this.serial(async () => {
      const held = (await this.positions.loadActive()).filter((p) => (p.state === 'PROTECTED' || p.state === 'OPEN_UNPROTECTED') && p.filledQty > 0);
      const failed: Array<{ id: string; symbol: string; error: string }> = [];
      for (const p of held) {
        const result = await this.runExit(p.id);
        if (!result.ok) failed.push({ id: p.id, symbol: p.tradingSymbol, error: result.error });
      }
      return { attempted: held.length, failed };
    });
  }

  // ------------------------------------------------------- strategy exits

  /** A strategy reports a target or time exit: flag the matching position and tell the user. Nothing is sold. */
  async onTradesClosed(trades: ClosedTrade[]): Promise<void> {
    const wanted = trades.filter((t) => t.outcome === 'WIN' || t.outcome === 'TIME_EXIT');
    if (wanted.length === 0) return;
    const active = (await this.positions.loadActive()).filter((p) => p.state === 'PROTECTED' || p.state === 'OPEN_UNPROTECTED');
    for (const trade of wanted) {
      const pos = active.find((p) => p.strategyId === trade.strategyId && norm(p.tradingSymbol) === norm(trade.symbol));
      if (!pos || pos.exitHint) continue;
      const hint = trade.outcome === 'WIN' ? 'Target hit' : 'Time exit';
      await this.positions.update(pos.id, { exitHint: hint });
      this.tell(`${hint}: ${pos.tradingSymbol}`, 'Open Orders and tap Exit now to close the position.');
    }
  }
}

export { isActivePosition };
export const positionManager = new PositionManager();
