/**
 * Which Dhan environments the app may send orders to, and the fixed safety limits for live orders.
 *
 * LIVE is available, but placing or modifying a live order is refused by the order client itself unless
 * live trading has been armed for the day (see execution/liveArm.ts). Cancelling is never gated, because
 * it only reduces exposure.
 */

export type OrderEnvironment = 'SANDBOX' | 'LIVE';

export const ORDER_ENVIRONMENTS_ENABLED: Record<OrderEnvironment, boolean> = {
  SANDBOX: true,
  LIVE: true,
};

export const DHAN_BASE_URLS: Record<OrderEnvironment, string> = {
  SANDBOX: 'https://sandbox.dhan.co/v2',
  LIVE: 'https://api.dhan.co/v2',
};

/** A proposed order can only be confirmed for this long after the signal, because its price goes stale. */
export const PROPOSAL_TTL_MS = 120_000;

/**
 * Hard cap on lots per live order while live trading is new. It overrides the per-strategy lots setting
 * and should only be raised after the full entry-to-exit cycle has been checked against Dhan.
 */
export const LIVE_MAX_LOTS = 1;

/**
 * The manual test order is a deliberately tiny live order for checking the whole path end to end.
 * It uses the same confirm, arm, IP and biometric checks as a signal order, and is capped in size.
 */
export const MANUAL_TEST_ID = 'MANUAL_TEST';
export const MANUAL_TEST_MAX_QTY = 10;
export const MANUAL_TEST_MAX_VALUE = 5000;
