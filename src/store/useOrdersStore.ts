import { create } from 'zustand';
import { secureVault } from '../services/SecureCredentialVault';
import { orderRepository, type StoredOrder } from '../services/OrderRepository';
import {
  sandboxOrderClient,
  isOpenOrderStatus,
  type DhanOrder,
  type OrderRequest,
  type PlaceOutcome,
} from '../services/dhan/DhanOrderClient';
import { formatDateKeyIST } from '../constants/nseHolidays';
import type { OrderEnvironment } from '../config/orderConfig';

/** Orders are sandbox-only until the live phase; the environment is a constant here, not a user setting. */
const ENV: OrderEnvironment = 'SANDBOX';
const client = sandboxOrderClient;

interface OrdersState {
  env: OrderEnvironment;
  orders: StoredOrder[];
  configured: boolean;
  syncing: boolean;
  lastSynced: string | null;
  error: string | null;

  init: () => Promise<void>;
  sync: () => Promise<void>;
  place: (req: OrderRequest) => Promise<PlaceOutcome>;
  cancel: (order: StoredOrder) => Promise<string | null>;
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

export const useOrdersStore = create<OrdersState>((set, get) => ({
  env: ENV,
  orders: [],
  configured: false,
  syncing: false,
  lastSynced: null,
  error: null,

  init: async () => {
    const creds = await secureVault.getSandboxCredentials();
    const orders = await orderRepository.loadForDate(ENV, formatDateKeyIST());
    set({ configured: Boolean(creds.clientId && creds.token), orders });
  },

  sync: async () => {
    if (get().syncing) return;
    set({ syncing: true });
    try {
      const creds = await secureVault.getSandboxCredentials();
      const configured = Boolean(creds.clientId && creds.token);
      if (!configured) {
        set({ configured: false, error: null, orders: await orderRepository.loadForDate(ENV) });
        return;
      }
      const res = await client.getOrders();
      if (!res.ok) {
        set({ configured: true, error: res.error });
        return;
      }
      for (const order of res.data) await orderRepository.upsert(ENV, order, { source: 'DHAN' });
      set({
        configured: true,
        error: null,
        lastSynced: new Date().toISOString(),
        orders: await orderRepository.loadForDate(ENV),
      });
    } catch (err: any) {
      set({ error: err?.message || 'Could not refresh orders.' });
    } finally {
      set({ syncing: false });
    }
  },

  place: async (req) => {
    const outcome = await client.placeAndConfirm(req);
    if (outcome.kind === 'PLACED') {
      await orderRepository.upsert(ENV, fromRequest(req, outcome), { source: 'APP' });
      set({ orders: await orderRepository.loadForDate(ENV), error: null });
    } else {
      set({ error: outcome.error });
    }
    return outcome;
  },

  cancel: async (order) => {
    if (!isOpenOrderStatus(order.status)) return 'That order is no longer open.';
    const res = await client.cancelOrder(order.orderId);
    if (!res.ok) {
      set({ error: res.error });
      return res.error;
    }
    await get().sync();
    return null;
  },

  clearError: () => set({ error: null }),
}));
