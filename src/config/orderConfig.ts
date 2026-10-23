/**
 * Which Dhan environments the app may send orders to.
 * LIVE stays off until the live-order phase is deliberately switched on; the order client refuses
 * LIVE placement, modification and cancellation while this is false.
 */

export type OrderEnvironment = 'SANDBOX' | 'LIVE';

export const ORDER_ENVIRONMENTS_ENABLED: Record<OrderEnvironment, boolean> = {
  SANDBOX: true,
  LIVE: false,
};

export const DHAN_BASE_URLS: Record<OrderEnvironment, string> = {
  SANDBOX: 'https://sandbox.dhan.co/v2',
  LIVE: 'https://api.dhan.co/v2',
};
