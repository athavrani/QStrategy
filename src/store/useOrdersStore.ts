import { create } from 'zustand';
import { secureVault } from '../services/SecureCredentialVault';
import { orderRepository, type StoredOrder } from '../services/OrderRepository';
import {
  sandboxOrderClient,
  liveOrderClient,
  isOpenOrderStatus,
  isCancellableStatus,
  type DhanOrder,
  type OrderRequest,
  type PlaceOutcome,
} from '../services/dhan/DhanOrderClient';
import { executionService, type ConfirmResult } from '../execution/ExecutionService';
import { positionManager, type ExitResult } from '../execution/PositionManager';
import { positionRepository, type Position } from '../services/PositionRepository';
import { formatDateKeyIST } from '../constants/nseHolidays';
import type { OrderEnvironment } from '../config/orderConfig';

/** The sandbox test-order panel always uses the sandbox; live orders only come from confirmed proposals. */
const TEST_ENV: OrderEnvironment = 'SANDBOX';

interface OrdersState {
  /** Sandbox orders (test panel). */
  orders: StoredOrder[];
  /** Live orders mirrored from the Dhan order book. */
  liveOrders: StoredOrder[];
  /** Orders the execution layer planned, proposed or blocked; never sent to Dhan until a proposal is confirmed. */
  paperOrders: StoredOrder[];
  /** Positions opened by the app: active ones, plus today's finished ones. */
  positions: Position[];
  /** Failure message per position, shown on that position. */
  positionErrors: Record<string, string>;
  configured: boolean;
  liveConfigured: boolean;
  syncing: boolean;
  lastSynced: string | null;
  error: string | null;
  /** Failure message per proposal, so a refused confirmation is shown on that proposal. */
  proposalErrors: Record<string, string>;

  init: () => Promise<void>;
  sync: () => Promise<void>;
  place: (req: OrderRequest) => Promise<PlaceOutcome>;
  cancel: (order: StoredOrder) => Promise<string | null>;
  createTestProposal: (input: { securityId: string; quantity: number; price: number }) => Promise<{ ok: true; correlationId: string } | { ok: false; error: string }>;
  exitPosition: (id: string) => Promise<ExitResult>;
  protectNow: (id: string) => Promise<void>;
  exitAll: () => Promise<{ attempted: number; failed: Array<{ id: string; symbol: string; error: string }> }>;
  confirmProposal: (correlationId: string) => Promise<ConfirmResult>;
  dismissProposal: (correlationId: string) => Promise<void>;
  clearError: () => void;
}

/** A just-placed order as the app knows it, until the order book returns Dhan's own copy. */
function fromRequest(req: OrderRequest, outcome: Extract<PlaceOutcome, { kind: 'PLACED' }>): DhanOrder {
  return {
    orderId: outcome.orderId,
    correlationId: outcome.correlationId,
    status: outcome.status,
    transactionType: req.transactionType,
    exchangeSegment: req.exchangeSegment,
    productType: req.productType,
    orderType: req.orderType,
    validity: req.validity,
    securityId: String(req.securityId),
    tradingSymbol: null,
    quantity: req.quantity,
    price: req.price ?? 0,
    triggerPrice: req.triggerPrice ?? 0,
    filledQty: 0,
    remainingQuantity: req.quantity,
    averageTradedPrice: 0,
    createTime: new Date().toISOString(),
    updateTime: null,
    errorCode: null,
    errorMessage: null,
  };
}

const clientFor = (env: OrderEnvironment) => (env === 'LIVE' ? liveOrderClient : sandboxOrderClient);

async function hasCredentials(env: OrderEnvironment): Promise<boolean> {
  const c = env === 'LIVE' ? await secureVault.getEffectiveCredentials() : await secureVault.getSandboxCredentials();
  return Boolean(c.clientId && c.token);
}

export const useOrdersStore = create<OrdersState>((set, get) => ({
  orders: [],
  liveOrders: [],
  paperOrders: [],
  positions: [],
  positionErrors: {},
  configured: false,
  liveConfigured: false,
  syncing: false,
  lastSynced: null,
  error: null,
  proposalErrors: {},

  init: async () => {
    await executionService.expireStale();
    const today = formatDateKeyIST();
    set({
      configured: await hasCredentials('SANDBOX'),
      liveConfigured: await hasCredentials('LIVE'),
      orders: await orderRepository.loadForDate('SANDBOX', today),
      liveOrders: await orderRepository.loadForDate('LIVE', today),
      paperOrders: await orderRepository.loadForDate('PAPER', today),
      positions: await positionRepository.loadVisible(today),
    });
  },

  sync: async () => {
    if (get().syncing) return;
    set({ syncing: true });
    const errors: string[] = [];
    try {
      await executionService.expireStale();
      set({ paperOrders: await orderRepository.loadForDate('PAPER'), positions: await positionRepository.loadVisible() });

      for (const env of ['SANDBOX', 'LIVE'] as const) {
        const configured = await hasCredentials(env);
        const key = env === 'LIVE' ? 'liveOrders' : 'orders';
        if (!configured) {
          set(env === 'LIVE' ? { liveConfigured: false } : { configured: false });
          set({ [key]: await orderRepository.loadForDate(env) } as Partial<OrdersState>);
          continue;
        }
        const res = await clientFor(env).getOrders();
        if (!res.ok) {
          errors.push(env === 'LIVE' ? `Live: ${res.error}` : res.error);
          set(env === 'LIVE' ? { liveConfigured: true } : { configured: true });
          continue;
        }
        for (const order of res.data) await orderRepository.upsert(env, order, { source: 'DHAN' });
        set({
          ...(env === 'LIVE' ? { liveConfigured: true } : { configured: true }),
          [key]: await orderRepository.loadForDate(env),
        } as Partial<OrdersState>);
      }
      set({
        error: errors.length ? errors.join(' ') : null,
        lastSynced: new Date().toISOString(),
        positions: await positionRepository.loadVisible(),
      });
    } catch (err: any) {
      set({ error: err?.message || 'Could not refresh orders.' });
    } finally {
      set({ syncing: false });
    }
  },

  place: async (req) => {
    const outcome = await sandboxOrderClient.placeAndConfirm(req);
    if (outcome.kind === 'PLACED') {
      await orderRepository.upsert(TEST_ENV, fromRequest(req, outcome), { source: 'APP' });
      set({ orders: await orderRepository.loadForDate(TEST_ENV), error: null });
    } else {
      set({ error: outcome.error });
    }
    return outcome;
  },

  cancel: async (order) => {
    if (!isOpenOrderStatus(order.status)) return 'That order is no longer open.';
    if (!isCancellableStatus(order.status)) {
      return 'This order has not reached the exchange yet (TRANSIT). Dhan allows cancelling once it is pending.';
    }
    const res = await clientFor(order.env === 'LIVE' ? 'LIVE' : 'SANDBOX').cancelOrder(order.orderId);
    if (!res.ok) {
      set({ error: res.error });
      return res.error;
    }
    await get().sync();
    return null;
  },

  createTestProposal: async (input) => {
    const result = await executionService.createManualProposal(input);
    set({ paperOrders: await orderRepository.loadForDate('PAPER') });
    return result;
  },

  exitPosition: async (id) => {
    const result = await positionManager.exitPosition(id);
    set((s) => {
      const { [id]: _old, ...rest } = s.positionErrors;
      return { positionErrors: result.ok ? rest : { ...rest, [id]: result.error } };
    });
    await get().sync();
    return result;
  },

  exitAll: async () => {
    const result = await positionManager.exitAll();
    set((s) => {
      const errors = { ...s.positionErrors };
      result.failed.forEach((f) => {
        errors[f.id] = f.error;
      });
      return { positionErrors: errors };
    });
    await get().sync();
    return result;
  },

  protectNow: async (id) => {
    await positionManager.protectNow(id);
    await get().sync();
  },

  confirmProposal: async (correlationId) => {
    const result = await executionService.confirmProposal(correlationId);
    // A sent entry is picked up straight away, so its stop-loss goes in as soon as it fills.
    if (result.ok || result.uncertain) positionManager.reconcile().catch(() => {});
    set((s) => {
      const { [correlationId]: _old, ...rest } = s.proposalErrors;
      return { proposalErrors: result.ok ? rest : { ...rest, [correlationId]: result.error } };
    });
    await get().sync();
    return result;
  },

  dismissProposal: async (correlationId) => {
    await executionService.dismissProposal(correlationId);
    set({ paperOrders: await orderRepository.loadForDate('PAPER') });
  },

  clearError: () => set({ error: null }),
}));
