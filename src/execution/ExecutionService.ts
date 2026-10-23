import { orderRepository, type OrderRepository, type StoredOrder } from '../services/OrderRepository';
import { tradingCalendarService } from '../services/TradingCalendarService';
import { secureVault } from '../services/SecureCredentialVault';
import { notificationService } from '../services/notificationService';
import { formatDateKeyIST } from '../constants/nseHolidays';
import { generateCorrelationId, liveOrderClient, validateOrderRequest, type DhanOrder, type DhanOrderClient, type OrderRequest } from '../services/dhan/DhanOrderClient';
import { LIVE_MAX_LOTS, MANUAL_TEST_ID, MANUAL_TEST_MAX_QTY, MANUAL_TEST_MAX_VALUE, PROPOSAL_TTL_MS } from '../config/orderConfig';
import { loadExecutionSettings } from './executionSettings';
import { ipPreflight } from './ipPreflight';
import { isLiveArmed } from './liveArm';
import { buildOrderRequest, checkLimits, isExecutableStrategy, marketHoursBlock, paperCorrelationId } from './orderMapping';
import type { ExecutableSignal, ExecutionDecision, ExecutionPort, ExecutionSettings } from './types';

export const PAPER_PLANNED = 'PAPER_PLANNED';
export const PAPER_BLOCKED = 'PAPER_BLOCKED';
/** Waiting for the user; nothing has been sent. */
export const PENDING_CONFIRM = 'PENDING_CONFIRM';
/** The user confirmed and the order is being sent right now. */
export const CONFIRMING = 'CONFIRMING';
export const CONFIRMED = 'CONFIRMED';
export const CONFIRM_FAILED = 'CONFIRM_FAILED';
/** The result of sending is not known; check the Dhan order book before doing anything else. */
export const CONFIRM_UNCERTAIN = 'CONFIRM_UNCERTAIN';
export const PROPOSAL_EXPIRED = 'PROPOSAL_EXPIRED';
export const PROPOSAL_DISMISSED = 'PROPOSAL_DISMISSED';

/** Proposals still needing attention in the UI. */
export const isProposalStatus = (status: string): boolean => status === PENDING_CONFIRM || status === CONFIRMING;

const DEAD_LIVE_STATUSES = ['REJECTED', 'CANCELLED', 'EXPIRED'];

export type ConfirmResult =
  | { ok: true; orderId: string; status: string }
  | { ok: false; error: string; uncertain?: boolean };

export interface ExecutionServiceDeps {
  repo?: Pick<OrderRepository, 'upsert' | 'loadForDate'>;
  loadSettings?: () => Promise<ExecutionSettings>;
  now?: () => Date;
  isTradingDay?: (d: Date) => boolean;
  liveClient?: Pick<DhanOrderClient, 'placeAndConfirm'>;
  isArmed?: () => boolean;
  /** Biometric check; must fail closed on devices without biometrics. */
  authenticate?: (prompt: string) => Promise<boolean>;
  /** Returns a refusal message, or null when this device's IP matches the Dhan whitelist. */
  checkIp?: () => Promise<string | null>;
  notify?: (symbol: string, quantity: number, price: number, expiresInSec: number) => void;
  proposalTtlMs?: number;
}

/**
 * Turns latched signals into orders.
 *  - PAPER: the order that would be sent is recorded and nothing leaves the device.
 *  - CONFIRM: the order becomes a proposal. It is sent live only when the user confirms it, after every rule,
 *    the arm switch, the IP check and a biometric check have passed again.
 * Every rule that stops an order is recorded with its reason, so nothing disappears silently.
 */
export class ExecutionService implements ExecutionPort {
  private readonly repo: Pick<OrderRepository, 'upsert' | 'loadForDate'>;
  private readonly loadSettings: () => Promise<ExecutionSettings>;
  private readonly now: () => Date;
  private readonly isTradingDay: (d: Date) => boolean;
  private readonly liveClient: Pick<DhanOrderClient, 'placeAndConfirm'>;
  private readonly isArmed: () => boolean;
  private readonly authenticate: (prompt: string) => Promise<boolean>;
  private readonly checkIp: () => Promise<string | null>;
  private readonly notify: (symbol: string, quantity: number, price: number, expiresInSec: number) => void;
  private readonly ttlMs: number;
  private readonly inFlight = new Set<string>();

  constructor(deps: ExecutionServiceDeps = {}) {
    this.repo = deps.repo ?? orderRepository;
    this.loadSettings = deps.loadSettings ?? loadExecutionSettings;
    this.now = deps.now ?? (() => new Date());
    this.isTradingDay = deps.isTradingDay ?? ((d) => tradingCalendarService.isTradingDay(d));
    this.liveClient = deps.liveClient ?? liveOrderClient;
    this.isArmed = deps.isArmed ?? (() => isLiveArmed(this.now()));
    this.authenticate = deps.authenticate ?? ((prompt) => secureVault.authenticateStrict(prompt));
    this.checkIp = deps.checkIp ?? ipPreflight;
    this.notify =
      deps.notify ??
      ((symbol, quantity, price, sec) => {
        void notificationService.notifyOrderAwaitingConfirm(symbol, quantity, price, sec);
      });
    this.ttlMs = deps.proposalTtlMs ?? PROPOSAL_TTL_MS;
  }

  // ---------------------------------------------------------------- signals

  async onSignal(signal: ExecutableSignal): Promise<ExecutionDecision> {
    const settings = await this.loadSettings();
    if (settings.mode === 'OFF') return { kind: 'SKIPPED' };
    if (!isExecutableStrategy(signal.strategyId) || !settings.strategies[signal.strategyId].enabled) {
      return { kind: 'SKIPPED' };
    }

    const correlationId = paperCorrelationId(signal.journalId);
    const confirmMode = settings.mode === 'CONFIRM';

    // A signal already acted on (confirmed, failed, dismissed...) is never turned back into a fresh proposal.
    const existing = await this.findPaperRecord(correlationId);
    if (existing && ![PAPER_PLANNED, PAPER_BLOCKED].includes(existing.status)) {
      return { kind: 'SKIPPED' };
    }

    if (settings.killSwitch) return this.block(signal, settings, correlationId, 'Kill switch is on.');

    const closed = marketHoursBlock(this.now(), this.isTradingDay);
    if (closed) return this.block(signal, settings, correlationId, closed);

    const mapped = buildOrderRequest(signal, settings);
    if (!mapped.ok) return this.block(signal, settings, correlationId, mapped.reason);

    if (confirmMode && mapped.lots > LIVE_MAX_LOTS) {
      return this.block(
        signal,
        settings,
        correlationId,
        `Live orders are capped at ${LIVE_MAX_LOTS} lot for now; this strategy is set to ${mapped.lots}.`
      );
    }

    const totals = confirmMode ? await this.liveTotals() : await this.paperTotals(correlationId);
    const breach = checkLimits(mapped.request, mapped.lots, totals, settings);
    if (breach) return this.block(signal, settings, correlationId, breach);

    if (!confirmMode) {
      await this.record(signal, settings, correlationId, PAPER_PLANNED, null);
      return { kind: 'PLANNED', correlationId };
    }

    await this.record(signal, settings, correlationId, PENDING_CONFIRM, null);
    try {
      this.notify(signal.hint?.tradingSymbol ?? signal.symbol, mapped.request.quantity, mapped.request.price ?? signal.entryPrice, this.ttlMs / 1000);
    } catch {
      // A failed notification must not lose the proposal; it is still listed in the Orders tab.
    }
    return { kind: 'PROPOSED', correlationId };
  }

  // ------------------------------------------------------- manual test order

  /**
   * Creates a tiny buy-limit proposal that you enter yourself, to test the whole live path without waiting for
   * a signal. It is capped in quantity and value, and goes through the same confirmation as a signal order.
   */
  async createManualProposal(input: {
    securityId: string;
    quantity: number;
    price: number;
  }): Promise<{ ok: true; correlationId: string } | { ok: false; error: string }> {
    const fail = (error: string) => ({ ok: false as const, error });
    const settings = await this.loadSettings();
    if (settings.mode !== 'CONFIRM') return fail('Set the mode to Confirm in Settings first.');
    if (settings.killSwitch) return fail('Kill switch is on.');
    const closed = marketHoursBlock(this.now(), this.isTradingDay);
    if (closed) return fail(closed);

    const request: OrderRequest = {
      correlationId: generateCorrelationId('QSM'),
      transactionType: 'BUY',
      exchangeSegment: 'NSE_EQ',
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: String(input.securityId ?? '').trim(),
      quantity: input.quantity,
      price: input.price,
    };
    const invalid = validateOrderRequest(request);
    if (invalid) return fail(invalid);
    if (request.quantity > MANUAL_TEST_MAX_QTY) return fail(`A test order is limited to ${MANUAL_TEST_MAX_QTY} shares.`);
    const value = (request.price ?? 0) * request.quantity;
    if (value > MANUAL_TEST_MAX_VALUE) return fail(`A test order is limited to ₹${MANUAL_TEST_MAX_VALUE} in value (this one is ₹${Math.round(value)}).`);

    const breach = checkLimits(request, 1, await this.liveTotals(), settings);
    if (breach) return fail(breach);

    await this.repo.upsert(
      'PAPER',
      {
        orderId: `paper-${request.correlationId}`,
        correlationId: request.correlationId as string,
        status: PENDING_CONFIRM,
        transactionType: 'BUY',
        exchangeSegment: request.exchangeSegment,
        productType: request.productType,
        orderType: 'LIMIT',
        validity: 'DAY',
        securityId: request.securityId,
        tradingSymbol: `Test order, security ${request.securityId}`,
        quantity: request.quantity,
        price: request.price as number,
        triggerPrice: 0,
        filledQty: 0,
        remainingQuantity: request.quantity,
        averageTradedPrice: 0,
        createTime: this.now().toISOString(),
        updateTime: null,
        errorCode: null,
        errorMessage: null,
      },
      { source: 'APP', strategyId: MANUAL_TEST_ID }
    );
    return { ok: true, correlationId: request.correlationId as string };
  }

  // ------------------------------------------------------------- proposals

  /** Marks proposals older than the time limit as expired, so a stale price can never be confirmed. */
  async expireStale(): Promise<void> {
    const rows = await this.paperRecords();
    for (const row of rows) {
      if (row.status === PENDING_CONFIRM && this.isExpired(row)) {
        await this.setStatus(row, PROPOSAL_EXPIRED, 'Expired before it was confirmed.');
      }
    }
  }

  async dismissProposal(correlationId: string): Promise<boolean> {
    const row = await this.findPaperRecord(correlationId);
    if (!row || row.status !== PENDING_CONFIRM) return false;
    await this.setStatus(row, PROPOSAL_DISMISSED, 'Dismissed.');
    return true;
  }

  /** Sends a proposed order live. One call per proposal at a time; every check runs again first. */
  async confirmProposal(correlationId: string): Promise<ConfirmResult> {
    if (this.inFlight.has(correlationId)) return { ok: false, error: 'This order is already being sent.' };
    this.inFlight.add(correlationId);
    try {
      return await this.runConfirm(correlationId);
    } finally {
      this.inFlight.delete(correlationId);
    }
  }

  private async runConfirm(correlationId: string): Promise<ConfirmResult> {
    const fail = (error: string): ConfirmResult => ({ ok: false, error });

    const proposal = await this.findPaperRecord(correlationId);
    if (!proposal) return fail('Order proposal not found.');
    if (proposal.status !== PENDING_CONFIRM) return fail(`This order can no longer be confirmed (${proposal.status}).`);
    if (this.isExpired(proposal)) {
      await this.setStatus(proposal, PROPOSAL_EXPIRED, 'Expired before it was confirmed.');
      return fail('This proposal has expired, because its price is out of date. Wait for the next signal.');
    }

    const settings = await this.loadSettings();
    if (settings.mode !== 'CONFIRM') return fail('Confirm mode is not on.');
    if (settings.killSwitch) return fail('Kill switch is on.');
    // The manual test order has no strategy switch; every other check below still applies to it.
    const isManual = proposal.strategyId === MANUAL_TEST_ID;
    if (!isManual && (!proposal.strategyId || !isExecutableStrategy(proposal.strategyId) || !settings.strategies[proposal.strategyId].enabled)) {
      return fail('This strategy is not enabled for execution.');
    }
    const closed = marketHoursBlock(this.now(), this.isTradingDay);
    if (closed) return fail(closed);
    if (!this.isArmed()) return fail('Live trading is not armed. Arm it in Settings first.');

    const request = this.requestFromRecord(proposal);
    const invalid = validateOrderRequest(request);
    if (invalid) return fail(invalid);

    const breach = checkLimits(request, 1, await this.liveTotals(), settings);
    if (breach) return fail(breach);

    const ipProblem = await this.checkIp();
    if (ipProblem) return fail(ipProblem);

    const authed = await this.authenticate(`Authenticate to send a LIVE order: BUY ${proposal.tradingSymbol ?? proposal.securityId}`);
    if (!authed) return fail('Biometric verification is required to send a live order.');

    // The prompt can take a while; the proposal and the arm switch must still be valid when it returns.
    if (this.isExpired(proposal)) {
      await this.setStatus(proposal, PROPOSAL_EXPIRED, 'Expired before it was confirmed.');
      return fail('This proposal expired while waiting for authentication.');
    }
    if (!this.isArmed()) return fail('Live trading is not armed. Arm it in Settings first.');

    await this.setStatus(proposal, CONFIRMING, null);
    const outcome = await this.liveClient.placeAndConfirm(request);

    if (outcome.kind === 'PLACED') {
      await this.repo.upsert(
        'LIVE',
        { ...this.asOrder(proposal), orderId: outcome.orderId, status: outcome.status, createTime: this.now().toISOString(), errorMessage: null },
        { source: 'APP', strategyId: proposal.strategyId }
      );
      await this.setStatus(proposal, CONFIRMED, `Sent to Dhan as order ${outcome.orderId}.`);
      return { ok: true, orderId: outcome.orderId, status: outcome.status };
    }
    if (outcome.kind === 'REJECTED') {
      await this.setStatus(proposal, CONFIRM_FAILED, outcome.error);
      return fail(outcome.error);
    }
    const message = `Result unknown: ${outcome.error}. Check the Dhan order book (ref ${outcome.correlationId}) before trying again.`;
    await this.setStatus(proposal, CONFIRM_UNCERTAIN, message);
    return { ok: false, error: message, uncertain: true };
  }

  // --------------------------------------------------------------- helpers

  private isExpired(row: StoredOrder): boolean {
    const created = Date.parse(row.createTime ?? '');
    return !Number.isFinite(created) || this.now().getTime() - created > this.ttlMs;
  }

  private requestFromRecord(row: StoredOrder): OrderRequest {
    return {
      correlationId: row.correlationId ?? undefined,
      transactionType: 'BUY',
      exchangeSegment: row.exchangeSegment as OrderRequest['exchangeSegment'],
      productType: row.productType as OrderRequest['productType'],
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: row.securityId,
      quantity: row.quantity,
      price: row.price,
    };
  }

  private async paperRecords(): Promise<StoredOrder[]> {
    return this.repo.loadForDate('PAPER', formatDateKeyIST(this.now()));
  }

  private async findPaperRecord(correlationId: string): Promise<StoredOrder | undefined> {
    return (await this.paperRecords()).find((o) => o.correlationId === correlationId);
  }

  /** Orders already planned today, not counting this signal's own record so a repeat is not blocked by itself. */
  private async paperTotals(ownCorrelationId: string): Promise<{ orders: number; value: number }> {
    const planned = (await this.paperRecords()).filter((o) => o.status === PAPER_PLANNED && o.correlationId !== ownCorrelationId);
    return { orders: planned.length, value: planned.reduce((sum, o) => sum + o.price * o.quantity, 0) };
  }

  /** Live orders this app sent today that are not dead, so limits cover real exposure. */
  private async liveTotals(): Promise<{ orders: number; value: number }> {
    const rows = await this.repo.loadForDate('LIVE', formatDateKeyIST(this.now()));
    const sent = rows.filter((o) => o.source === 'APP' && !DEAD_LIVE_STATUSES.includes(o.status));
    return { orders: sent.length, value: sent.reduce((sum, o) => sum + o.price * o.quantity, 0) };
  }

  private async block(
    signal: ExecutableSignal,
    settings: ExecutionSettings,
    correlationId: string,
    reason: string
  ): Promise<ExecutionDecision> {
    await this.record(signal, settings, correlationId, PAPER_BLOCKED, reason);
    return { kind: 'BLOCKED', reason, correlationId };
  }

  private async record(
    signal: ExecutableSignal,
    settings: ExecutionSettings,
    correlationId: string,
    status: string,
    reason: string | null
  ): Promise<void> {
    await this.repo.upsert('PAPER', this.toRecord(signal, settings, correlationId, status, reason), {
      source: 'APP',
      strategyId: signal.strategyId,
    });
  }

  private async setStatus(row: StoredOrder, status: string, message: string | null): Promise<void> {
    await this.repo.upsert(
      'PAPER',
      { ...this.asOrder(row), status, errorMessage: message, updateTime: this.now().toISOString() },
      { source: 'APP', strategyId: row.strategyId }
    );
  }

  private asOrder(row: StoredOrder): DhanOrder {
    const { id: _id, env: _env, tradeDate: _tradeDate, source: _source, strategyId: _strategyId, ...order } = row;
    return order;
  }

  /** The record shows the order as it would have been sent, even when blocked, so the reason has context. */
  private toRecord(
    signal: ExecutableSignal,
    settings: ExecutionSettings,
    correlationId: string,
    status: string,
    reason: string | null
  ): DhanOrder {
    const hint = signal.hint;
    const mapped = buildOrderRequest(signal, settings);
    const lots = isExecutableStrategy(signal.strategyId) ? settings.strategies[signal.strategyId].lots : 1;
    const quantity = mapped.ok ? mapped.request.quantity : hint ? hint.lotSize * lots : 0;
    const price = mapped.ok ? (mapped.request.price ?? signal.entryPrice) : signal.entryPrice;
    return {
      orderId: `paper-${correlationId}`,
      correlationId,
      status,
      transactionType: signal.side,
      exchangeSegment: hint?.exchangeSegment ?? '',
      productType: hint?.productType ?? '',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: hint?.securityId ?? '',
      tradingSymbol: hint?.tradingSymbol ?? signal.symbol,
      quantity,
      price,
      triggerPrice: 0,
      filledQty: 0,
      remainingQuantity: quantity,
      averageTradedPrice: 0,
      createTime: this.now().toISOString(),
      updateTime: null,
      errorCode: null,
      errorMessage: reason,
    };
  }
}

export const executionService = new ExecutionService();
