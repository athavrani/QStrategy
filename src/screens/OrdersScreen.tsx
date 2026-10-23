import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, RefreshControl, Alert } from 'react-native';
import { createThemedStyles, useTheme } from '../theme';
import { useOrdersStore } from '../store/useOrdersStore';
import { isOpenOrderStatus, isCancellableStatus, type OrderRequest } from '../services/dhan/DhanOrderClient';
import type { StoredOrder } from '../services/OrderRepository';
import { buildExecutionReport } from '../execution/executionReport';
import { isActivePosition, type Position } from '../services/PositionRepository';
import { isProposalStatus, CONFIRMING } from '../execution/ExecutionService';
import { useLiveArm, isLiveArmed } from '../execution/liveArm';
import { marketData } from '../services/marketdata/MarketDataService';
import { MANUAL_TEST_MAX_QTY, MANUAL_TEST_MAX_VALUE, PROPOSAL_TTL_MS } from '../config/orderConfig';

const POLL_MS = 5000;

/** Plain labels for the statuses the execution layer writes. */
const SIGNAL_STATUS_LABEL: Record<string, string> = {
  PAPER_PLANNED: 'PLANNED',
  PAPER_BLOCKED: 'BLOCKED',
  CONFIRMED: 'SENT',
  CONFIRM_FAILED: 'FAILED',
  CONFIRM_UNCERTAIN: 'UNCERTAIN',
  PROPOSAL_EXPIRED: 'EXPIRED',
  PROPOSAL_DISMISSED: 'DISMISSED',
};

interface OrdersScreenProps {
  onOpenSettings?: () => void;
}

function OrderCard({
  order,
  onCancel,
  actionError,
}: {
  order: StoredOrder;
  onCancel: (o: StoredOrder) => void;
  actionError?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const open = isOpenOrderStatus(order.status);
  const sideColor = order.transactionType === 'BUY' ? colors.bullish : colors.bearish;
  const statusColor =
    order.status === 'TRADED' ? colors.bullish : order.status === 'REJECTED' || order.status === 'CANCELLED' ? colors.bearish : colors.warning;
  const priceText =
    order.orderType === 'MARKET' ? 'MKT' : order.triggerPrice > 0 && order.price > 0 ? `${order.price} / trg ${order.triggerPrice}` : order.triggerPrice > 0 ? `trg ${order.triggerPrice}` : String(order.price);

  return (
    <View style={styles.orderCard} testID={`order-${order.orderId}`}>
      <View style={styles.rowBetween}>
        <Text style={styles.symbol}>
          <Text style={{ color: sideColor }}>{order.transactionType} </Text>
          {order.tradingSymbol ?? `ID ${order.securityId}`}
        </Text>
        <Text style={[styles.status, { color: statusColor, borderColor: statusColor }]}>{order.status}</Text>
      </View>
      <Text style={styles.meta}>
        {order.orderType} · {order.productType} · qty {order.quantity} · {priceText}
      </Text>
      <Text style={styles.meta}>
        filled {order.filledQty}/{order.quantity}
        {order.averageTradedPrice > 0 ? ` @ ${order.averageTradedPrice}` : ''} · {order.source === 'APP' ? 'placed here' : 'from Dhan'} · {order.env}
      </Text>
      {order.errorMessage ? <Text style={styles.errorText}>{order.errorMessage}</Text> : null}
      {actionError ? <Text style={styles.errorText} testID={`action-error-${order.orderId}`}>{actionError}</Text> : null}
      <Text style={styles.metaSmall}>Order {order.orderId}</Text>
      {open && isCancellableStatus(order.status) ? (
        <TouchableOpacity style={styles.cancelBtn} onPress={() => onCancel(order)} testID={`cancel-${order.orderId}`}>
          <Text style={styles.cancelText}>Cancel order</Text>
        </TouchableOpacity>
      ) : null}
      {open && !isCancellableStatus(order.status) ? (
        <Text style={styles.metaSmall} testID={`transit-${order.orderId}`}>
          Waiting for the exchange to accept this order. Cancel becomes available once it is pending.
        </Text>
      ) : null}
    </View>
  );
}

/** An order the execution layer planned (or blocked, with the reason) from a signal. Never sent to Dhan. */
function PaperOrderCard({ order }: { order: StoredOrder }) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const bad = ['PAPER_BLOCKED', 'CONFIRM_FAILED', 'CONFIRM_UNCERTAIN'].includes(order.status);
  const blocked = bad;
  return (
    <View style={styles.orderCard} testID={`paper-${order.orderId}`}>
      <View style={styles.rowBetween}>
        <Text style={styles.symbol}>
          <Text style={{ color: colors.bullish }}>{order.transactionType} </Text>
          {order.tradingSymbol ?? order.securityId}
        </Text>
        <Text
          style={[styles.status, { color: blocked ? colors.bearish : colors.cyan, borderColor: blocked ? colors.bearish : colors.cyan }]}
        >
          {SIGNAL_STATUS_LABEL[order.status] ?? order.status}
        </Text>
      </View>
      <Text style={styles.meta}>
        LIMIT {order.price} · qty {order.quantity} · {order.productType || 'no product'} · {order.strategyId ?? 'strategy'}
      </Text>
      {order.errorMessage ? <Text style={styles.errorText}>{order.errorMessage}</Text> : null}
    </View>
  );
}

const POSITION_LABEL: Record<string, string> = {
  ENTRY_SENT: 'ENTRY PENDING',
  OPEN_UNPROTECTED: 'NO STOP-LOSS',
  PROTECTED: 'PROTECTED',
  CLOSING: 'EXITING',
  CLOSED: 'CLOSED',
  ENTRY_FAILED: 'NOT FILLED',
};

/** A position the app opened: what is held, whether a stop-loss is working at the exchange, and how to leave it. */
function PositionCard({
  position,
  error,
  busy,
  onExit,
  onProtect,
}: {
  position: Position;
  error?: string;
  busy: boolean;
  onExit: (p: Position) => void;
  onProtect: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const unprotected = position.state === 'OPEN_UNPROTECTED';
  const color =
    unprotected ? colors.bearish : position.state === 'PROTECTED' ? colors.bullish : position.state === 'CLOSED' || position.state === 'ENTRY_FAILED' ? colors.textMuted : colors.warning;
  const holding = position.filledQty > 0 && (position.state === 'PROTECTED' || unprotected || position.state === 'CLOSING');
  let ltp: number | undefined;
  try {
    ltp = marketData.getQuote(position.exchangeSegment, position.securityId)?.ltp;
  } catch {
    ltp = undefined;
  }
  const unrealized = holding && ltp !== undefined ? Number(((ltp - position.entryAvg) * position.filledQty).toFixed(2)) : null;

  return (
    <View style={[styles.orderCard, unprotected && { borderColor: colors.bearish }]} testID={`position-${position.id}`}>
      <View style={styles.rowBetween}>
        <Text style={styles.symbol}>{position.tradingSymbol}</Text>
        <Text style={[styles.status, { color, borderColor: color }]} testID={`position-state-${position.id}`}>
          {POSITION_LABEL[position.state] ?? position.state}
        </Text>
      </View>
      <Text style={styles.meta}>
        qty {position.filledQty}/{position.requestedQty}
        {position.entryAvg > 0 ? ` · entry ${position.entryAvg}` : ''}
        {position.slPrice != null ? ` · stop-loss ${position.slPrice}` : ' · no stop-loss price'}
        {position.targetPrice != null ? ` · target ${position.targetPrice}` : ''}
      </Text>
      {unrealized !== null ? (
        <Text style={[styles.meta, { color: unrealized >= 0 ? colors.bullish : colors.bearish }]}>
          Price now {ltp} · {unrealized >= 0 ? '+' : ''}{unrealized}
        </Text>
      ) : null}
      {position.state === 'CLOSED' && position.pnl !== null ? (
        <Text style={[styles.meta, { color: position.pnl >= 0 ? colors.bullish : colors.bearish }]}>
          Closed at {position.exitAvg} · P&L {position.pnl >= 0 ? '+' : ''}{position.pnl}
        </Text>
      ) : null}
      {position.exitHint && holding ? (
        <Text style={[styles.meta, { color: colors.warning }]} testID={`position-hint-${position.id}`}>
          Exit suggested: {position.exitHint}
        </Text>
      ) : null}
      {position.note ? <Text style={unprotected ? styles.errorText : styles.metaSmall}>{position.note}</Text> : null}
      {error ? <Text style={styles.errorText} testID={`position-error-${position.id}`}>{error}</Text> : null}
      {holding && position.state !== 'CLOSING' ? (
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.placeBtn, { flex: 1, backgroundColor: colors.bearish }, busy && { opacity: 0.5 }]}
            disabled={busy}
            onPress={() => onExit(position)}
            testID={`exit-${position.id}`}
          >
            <Text style={styles.placeText}>{busy ? 'Exiting...' : 'Exit now (market)'}</Text>
          </TouchableOpacity>
          {unprotected && position.slPrice != null ? (
            <TouchableOpacity style={[styles.cancelBtn, { marginTop: 0, paddingHorizontal: 14, justifyContent: 'center' }]} onPress={onProtect} testID={`protect-${position.id}`}>
              <Text style={styles.cancelText}>Place stop-loss</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** How the day's signals turned into orders, fills and profit or loss. Shown only once there is something to report. */
function ExecutionReportCard({ paperOrders, positions }: { paperOrders: StoredOrder[]; positions: Position[] }) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const r = buildExecutionReport(paperOrders, positions);
  if (r.signals === 0 && r.filled === 0) return null;
  return (
    <View style={styles.panel} testID="exec-report">
      <Text style={styles.panelTitle}>Today's execution report</Text>
      <Text style={styles.meta} testID="report-signals">
        {r.signals} signal{r.signals === 1 ? '' : 's'}: {r.sent} sent, {r.missed} missed (expired), {r.dismissed} dismissed, {r.blocked} blocked
        {r.failed ? `, ${r.failed} refused by Dhan` : ''}
        {r.uncertain ? `, ${r.uncertain} uncertain` : ''}
      </Text>
      {r.blockedReasons.slice(0, 3).map((b) => (
        <Text key={b.reason} style={styles.metaSmall}>Blocked {b.count}x: {b.reason}</Text>
      ))}
      <Text style={styles.meta} testID="report-fills">
        {r.filled} filled{r.avgFillVsLimit !== null ? `, on average ${r.avgFillVsLimit >= 0 ? '+' : ''}${r.avgFillVsLimit} per share against the limit price` : ''}
      </Text>
      <Text style={[styles.meta, { color: r.pnl >= 0 ? colors.bullish : colors.bearish }]} testID="report-pnl">
        {r.closed} closed ({r.wins} won, {r.losses} lost): {r.pnl >= 0 ? '+' : ''}{r.pnl}{r.open ? ` · ${r.open} still open` : ''}
      </Text>
    </View>
  );
}

/** A live order waiting for the user. Nothing has been sent; confirming re-runs every check and asks for biometrics. */
function ProposalCard({
  order,
  error,
  sending,
  onConfirm,
  onDismiss,
}: {
  order: StoredOrder;
  error?: string;
  sending: boolean;
  onConfirm: (o: StoredOrder) => void;
  onDismiss: (o: StoredOrder) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const busy = sending || order.status === CONFIRMING;
  const value = Math.round(order.price * order.quantity);
  const expires = new Date(Date.parse(order.createTime ?? '') + PROPOSAL_TTL_MS);
  let ltp: number | undefined;
  try {
    ltp = marketData.getQuote(order.exchangeSegment, order.securityId)?.ltp;
  } catch {
    ltp = undefined;
  }

  return (
    <View style={[styles.orderCard, { borderColor: colors.warning }]} testID={`proposal-${order.correlationId}`}>
      <View style={styles.rowBetween}>
        <Text style={styles.symbol}>
          <Text style={{ color: colors.bullish }}>BUY </Text>
          {order.tradingSymbol ?? order.securityId}
        </Text>
        <Text style={[styles.status, { color: colors.warning, borderColor: colors.warning }]}>{busy ? 'SENDING' : 'CONFIRM'}</Text>
      </View>
      <Text style={styles.meta}>
        LIMIT {order.price} · qty {order.quantity} · about ₹{value} · {order.productType}
      </Text>
      <Text style={styles.meta}>
        {ltp !== undefined ? `Price now ${ltp}` : 'Price now unavailable'} · expires {Number.isFinite(expires.getTime()) ? expires.toLocaleTimeString() : '-'}
      </Text>
      <Text style={styles.metaSmall}>{order.strategyId ?? 'strategy'} · REAL MONEY: this sends a live order to Dhan</Text>
      {error ? <Text style={styles.errorText} testID={`proposal-error-${order.correlationId}`}>{error}</Text> : null}
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.placeBtn, { flex: 1 }, busy && { opacity: 0.5 }]}
          disabled={busy}
          onPress={() => onConfirm(order)}
          testID={`confirm-${order.correlationId}`}
        >
          <Text style={styles.placeText}>{busy ? 'Sending...' : 'Confirm and send live'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.cancelBtn, { marginTop: 0, paddingHorizontal: 16, justifyContent: 'center' }, busy && { opacity: 0.5 }]}
          disabled={busy}
          onPress={() => onDismiss(order)}
          testID={`dismiss-${order.correlationId}`}
        >
          <Text style={styles.cancelText}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * A tiny live test order for checking the whole path end to end. It only creates a proposal; sending still needs
 * the arm switch, the confirmation prompt, the IP check and a biometric check. Pick a price well below the
 * market so the order rests unfilled, then cancel it from the live list.
 */
function LiveTestPanel() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const createTestProposal = useOrdersStore((s) => s.createTestProposal);
  const [securityId, setSecurityId] = useState('1333');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [result, setResult] = useState<string | null>(null);

  let ltp: number | undefined;
  try {
    ltp = marketData.getQuote('NSE_EQ', securityId.trim())?.ltp;
  } catch {
    ltp = undefined;
  }

  const submit = async () => {
    const res = await createTestProposal({ securityId, quantity: parseInt(qty, 10), price: parseFloat(price) });
    setResult(res.ok ? 'Proposal created above. Confirm it there to send it.' : res.error);
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Live test order</Text>
      <Text style={styles.metaSmall}>
        A real order, capped at {MANUAL_TEST_MAX_QTY} shares and ₹{MANUAL_TEST_MAX_VALUE}. NSE equity, intraday, buy limit.
        Set the price well below the market so it does not fill, then cancel it.
      </Text>
      <View style={[styles.row, { marginTop: 8 }]}>
        <TextInput style={styles.input} value={securityId} onChangeText={setSecurityId} placeholder="Security ID" placeholderTextColor={colors.textMuted} keyboardType="number-pad" testID="livetest-security" />
        <TextInput style={styles.input} value={qty} onChangeText={setQty} placeholder="Qty" placeholderTextColor={colors.textMuted} keyboardType="number-pad" testID="livetest-qty" />
        <TextInput style={styles.input} value={price} onChangeText={setPrice} placeholder="Limit price" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" testID="livetest-price" />
      </View>
      <Text style={styles.metaSmall} testID="livetest-ltp">{ltp !== undefined ? `Price now ${ltp}` : 'Price now unavailable'}</Text>
      <TouchableOpacity style={[styles.cancelBtn, { marginTop: 8 }]} onPress={submit} testID="livetest-create">
        <Text style={styles.cancelText}>Create test proposal</Text>
      </TouchableOpacity>
      {result ? <Text style={styles.result} testID="livetest-result">{result}</Text> : null}
    </View>
  );
}

/** Sandbox-only form for placing a test order and watching it appear in the list below. */
function TestOrderPanel() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const place = useOrdersStore((s) => s.place);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'LIMIT' | 'MARKET'>('LIMIT');
  const [securityId, setSecurityId] = useState('1333');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const req: OrderRequest = {
      transactionType: side,
      exchangeSegment: 'NSE_EQ',
      productType: 'INTRADAY',
      orderType: type,
      validity: 'DAY',
      securityId: securityId.trim(),
      quantity: parseInt(qty, 10),
      ...(type === 'LIMIT' ? { price: parseFloat(price) } : {}),
    };
    setBusy(true);
    const outcome = await place(req);
    setBusy(false);
    setResult(
      outcome.kind === 'PLACED'
        ? `Placed: order ${outcome.orderId} (${outcome.status})`
        : outcome.kind === 'REJECTED'
          ? `Rejected: ${outcome.error}`
          : `Result unknown: ${outcome.error}. Refresh before trying again (ref ${outcome.correlationId}).`
    );
  };

  const toggle = (active: boolean) => [styles.toggle, active && styles.toggleActive];

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Sandbox test order</Text>
      <View style={styles.row}>
        <TouchableOpacity style={toggle(side === 'BUY')} onPress={() => setSide('BUY')} testID="side-BUY">
          <Text style={styles.toggleText}>BUY</Text>
        </TouchableOpacity>
        <TouchableOpacity style={toggle(side === 'SELL')} onPress={() => setSide('SELL')} testID="side-SELL">
          <Text style={styles.toggleText}>SELL</Text>
        </TouchableOpacity>
        <TouchableOpacity style={toggle(type === 'LIMIT')} onPress={() => setType('LIMIT')} testID="type-LIMIT">
          <Text style={styles.toggleText}>LIMIT</Text>
        </TouchableOpacity>
        <TouchableOpacity style={toggle(type === 'MARKET')} onPress={() => setType('MARKET')} testID="type-MARKET">
          <Text style={styles.toggleText}>MARKET</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <TextInput style={styles.input} value={securityId} onChangeText={setSecurityId} placeholder="Security ID" placeholderTextColor={colors.textMuted} keyboardType="number-pad" testID="test-security" />
        <TextInput style={styles.input} value={qty} onChangeText={setQty} placeholder="Qty" placeholderTextColor={colors.textMuted} keyboardType="number-pad" testID="test-qty" />
        {type === 'LIMIT' ? (
          <TextInput style={styles.input} value={price} onChangeText={setPrice} placeholder="Price" placeholderTextColor={colors.textMuted} keyboardType="decimal-pad" testID="test-price" />
        ) : null}
      </View>
      <TouchableOpacity style={[styles.placeBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={submit} testID="test-place">
        <Text style={styles.placeText}>{busy ? 'Placing...' : 'Place sandbox order (NSE equity, intraday)'}</Text>
      </TouchableOpacity>
      {result ? <Text style={styles.result} testID="test-result">{result}</Text> : null}
    </View>
  );
}

export function OrdersScreen({ onOpenSettings }: OrdersScreenProps) {
  const styles = useThemedStyles();
  const { colors } = useTheme();
  const {
    orders, liveOrders, paperOrders, configured, liveConfigured, syncing, error, lastSynced, proposalErrors,
    positions, positionErrors, exitPosition, exitAll, protectNow,
    init, sync, cancel, confirmProposal, dismissProposal,
  } = useOrdersStore();
  const armedDate = useLiveArm((s) => s.armedDate);
  const armed = armedDate !== null && isLiveArmed();
  const [sending, setSending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    init().then(() => sync()).catch(() => {});
  }, [init, sync]);

  const proposals = paperOrders.filter((o) => isProposalStatus(o.status));
  const signalLog = paperOrders.filter((o) => !isProposalStatus(o.status));
  const hasOpen =
    orders.some((o) => isOpenOrderStatus(o.status)) ||
    liveOrders.some((o) => isOpenOrderStatus(o.status)) ||
    positions.some((p) => isActivePosition(p.state));
  const needsPolling = (configured || liveConfigured) && hasOpen;
  useEffect(() => {
    // Open orders change status, and proposals must expire on time, so refresh while either exists.
    if (!needsPolling && proposals.length === 0) return;
    const timer = setInterval(() => {
      sync().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [needsPolling, proposals.length, sync]);

  const runConfirm = useCallback(
    async (order: StoredOrder) => {
      const key = order.correlationId ?? order.id;
      setSending((prev) => ({ ...prev, [key]: true }));
      try {
        await confirmProposal(key);
      } finally {
        setSending((prev) => ({ ...prev, [key]: false }));
      }
    },
    [confirmProposal]
  );

  const askConfirm = useCallback(
    (order: StoredOrder) => {
      Alert.alert(
        'Send LIVE order?',
        `BUY ${order.tradingSymbol ?? order.securityId}\n${order.quantity} qty, LIMIT ${order.price}, about ₹${Math.round(order.price * order.quantity)}\n\nThis places a real order with Dhan.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Send live order', style: 'destructive', onPress: () => void runConfirm(order) },
        ]
      );
    },
    [runConfirm]
  );

  const heldCount = positions.filter((p) => (p.state === 'PROTECTED' || p.state === 'OPEN_UNPROTECTED') && p.filledQty > 0).length;
  const [exitAllMessage, setExitAllMessage] = useState<string | null>(null);
  const askExitAll = useCallback(() => {
    Alert.alert(
      'Exit ALL positions?',
      `Sell every position the app holds (${heldCount}) at market now. Each stop-loss is cancelled first. Market orders can fill at a worse price than the last one shown.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Exit all now',
          style: 'destructive',
          onPress: () => {
            exitAll().then((r) =>
              setExitAllMessage(
                r.failed.length === 0
                  ? `Exit sent for ${r.attempted} position${r.attempted === 1 ? '' : 's'}.`
                  : `${r.attempted - r.failed.length} of ${r.attempted} exits sent. Not exited: ${r.failed.map((f) => `${f.symbol} (${f.error})`).join('; ')}`
              )
            );
          },
        },
      ]
    );
  }, [exitAll, heldCount]);

  const [exiting, setExiting] = useState<Record<string, boolean>>({});
  const askExit = useCallback(
    (p: Position) => {
      Alert.alert(
        'Exit position?',
        `Sell all ${p.filledQty} of ${p.tradingSymbol} at market now.

The stop-loss order is cancelled first so the shares are not sold twice. A market order fills at the best available price, which can be worse than the last price shown.`,
        [
          { text: 'Keep', style: 'cancel' },
          {
            text: 'Exit now',
            style: 'destructive',
            onPress: () => {
              setExiting((prev) => ({ ...prev, [p.id]: true }));
              exitPosition(p.id).finally(() => setExiting((prev) => ({ ...prev, [p.id]: false })));
            },
          },
        ]
      );
    },
    [exitPosition]
  );

  const dismiss = useCallback((order: StoredOrder) => void dismissProposal(order.correlationId ?? order.id), [dismissProposal]);

  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const runCancel = useCallback(
    async (order: StoredOrder) => {
      setActionErrors((prev) => {
        const { [order.orderId]: _gone, ...rest } = prev;
        return rest;
      });
      const err = await cancel(order);
      if (err) setActionErrors((prev) => ({ ...prev, [order.orderId]: `Cancel failed: ${err}` }));
    },
    [cancel]
  );

  const confirmCancel = useCallback(
    (order: StoredOrder) => {
      Alert.alert('Cancel order', `Cancel ${order.transactionType} ${order.tradingSymbol ?? order.securityId} (${order.orderId})?`, [
        { text: 'Keep', style: 'cancel' },
        { text: 'Cancel order', style: 'destructive', onPress: () => void runCancel(order) },
      ]);
    },
    [runCancel]
  );

  const active = orders.filter((o) => isOpenOrderStatus(o.status));
  const done = orders.filter((o) => !isOpenOrderStatus(o.status));
  const liveActive = liveOrders.filter((o) => isOpenOrderStatus(o.status));
  const liveDone = liveOrders.filter((o) => !isOpenOrderStatus(o.status));

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 30 }}
      refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void sync()} />}
    >
      <View style={styles.rowBetween}>
        <Text style={styles.title}>Orders</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Text style={[styles.envPill, armed && styles.livePill]} testID="live-pill">{armed ? 'LIVE ARMED' : 'LIVE OFF'}</Text>
          <Text style={styles.envPill} testID="orders-env">SANDBOX</Text>
        </View>
      </View>

      {proposals.length > 0 ? (
        <>
          <Text style={styles.section}>AWAITING YOUR CONFIRMATION ({proposals.length})</Text>
          {proposals.map((o) => (
            <ProposalCard
              key={o.id}
              order={o}
              error={proposalErrors[o.correlationId ?? o.id]}
              sending={Boolean(sending[o.correlationId ?? o.id])}
              onConfirm={askConfirm}
              onDismiss={dismiss}
            />
          ))}
        </>
      ) : null}

      {positions.length > 0 ? (
        <>
          <Text style={styles.section}>POSITIONS ({positions.length})</Text>
          {heldCount > 0 ? (
            <TouchableOpacity style={[styles.placeBtn, { backgroundColor: colors.bearish, marginBottom: 8 }]} onPress={askExitAll} testID="exit-all">
              <Text style={styles.placeText}>Exit ALL positions ({heldCount})</Text>
            </TouchableOpacity>
          ) : null}
          {exitAllMessage ? <Text style={styles.errorText} testID="exit-all-result">{exitAllMessage}</Text> : null}
          {positions.map((p) => (
            <PositionCard
              key={p.id}
              position={p}
              error={positionErrors[p.id]}
              busy={Boolean(exiting[p.id])}
              onExit={askExit}
              onProtect={() => void protectNow(p.id)}
            />
          ))}
        </>
      ) : null}

      {liveConfigured ? (
        <>
          <LiveTestPanel />
          <Text style={styles.section}>LIVE ORDERS ({liveOrders.length})</Text>
          {liveOrders.length === 0 ? <Text style={styles.none} testID="live-none">No live orders today</Text> : null}
          {liveActive.map((o) => (
            <OrderCard key={o.id} order={o} onCancel={confirmCancel} actionError={actionErrors[o.orderId]} />
          ))}
          {liveDone.map((o) => (
            <OrderCard key={o.id} order={o} onCancel={confirmCancel} actionError={actionErrors[o.orderId]} />
          ))}
        </>
      ) : null}

      <ExecutionReportCard paperOrders={paperOrders} positions={positions} />

      <Text style={styles.section}>SIGNAL ORDER LOG ({signalLog.length})</Text>
      <Text style={styles.metaSmall}>Recorded on this device. Only orders you confirm are sent to Dhan.</Text>
      {signalLog.length === 0 ? <Text style={styles.none} testID="paper-none">No signal orders today</Text> : null}
      {signalLog.map((o) => (
        <PaperOrderCard key={o.id} order={o} />
      ))}

      {!configured ? (
        <View style={styles.card}>
          <Text style={styles.emptyTitle} testID="orders-empty">Sandbox not set up</Text>
          <Text style={styles.emptySub}>
            Add your Dhan sandbox token in Settings to place and view test orders. Nothing is sent to your live account.
          </Text>
          {onOpenSettings ? (
            <TouchableOpacity style={styles.btn} onPress={onOpenSettings} testID="orders-open-settings">
              <Text style={styles.btnText}>Open Settings</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <>
          {error ? <Text style={styles.errorBanner} testID="orders-error">{error}</Text> : null}
          <TestOrderPanel />

          <Text style={styles.section}>ACTIVE ({active.length})</Text>
          {active.length === 0 ? <Text style={styles.none} testID="orders-none-active">No open orders</Text> : null}
          {active.map((o) => (
            <OrderCard key={o.id} order={o} onCancel={confirmCancel} actionError={actionErrors[o.orderId]} />
          ))}

          <Text style={styles.section}>TODAY ({done.length})</Text>
          {done.length === 0 ? <Text style={styles.none}>Nothing completed yet</Text> : null}
          {done.map((o) => (
            <OrderCard key={o.id} order={o} onCancel={confirmCancel} actionError={actionErrors[o.orderId]} />
          ))}

          <Text style={styles.metaSmall}>
            {lastSynced ? `Updated ${new Date(lastSynced).toLocaleTimeString()}` : 'Not refreshed yet'} · pull down to refresh
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.obsidian, padding: 14 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 12 },
  livePill: { color: colors.bearish, borderColor: colors.bearish },
  envPill: { color: colors.warning, borderColor: colors.warning, borderWidth: 1, borderRadius: 6, fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 2, marginBottom: 12 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  card: { backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.cardBorder, padding: 18, alignItems: 'center' },
  emptyTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  emptySub: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: 14 },
  btn: { backgroundColor: colors.surfaceSubtle, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 10 },
  btnText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  errorBanner: { color: colors.bearish, fontSize: 12, marginBottom: 10 },
  section: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginTop: 12, marginBottom: 8 },
  none: { color: colors.textMuted, fontSize: 12, marginBottom: 8 },
  orderCard: { backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.cardBorder, padding: 12, marginBottom: 8 },
  symbol: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  status: { fontSize: 10, fontWeight: '800', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  meta: { color: colors.textSecondary, fontSize: 11, marginTop: 4 },
  metaSmall: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  errorText: { color: colors.bearish, fontSize: 11, marginTop: 4 },
  cancelBtn: { marginTop: 8, backgroundColor: colors.surfaceSubtle, borderRadius: 6, paddingVertical: 8, alignItems: 'center' },
  cancelText: { color: colors.bearish, fontSize: 12, fontWeight: '700' },
  panel: { backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.cardBorder, padding: 12, marginBottom: 6 },
  panelTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '800', marginBottom: 8 },
  toggle: { flex: 1, backgroundColor: colors.surfaceSubtle, borderRadius: 6, paddingVertical: 8, alignItems: 'center' },
  toggleActive: { backgroundColor: colors.surfaceHover, borderWidth: 1, borderColor: colors.borderActive },
  toggleText: { color: colors.textPrimary, fontSize: 11, fontWeight: '700' },
  input: { flex: 1, backgroundColor: colors.surfaceSubtle, borderRadius: 6, borderWidth: 1, borderColor: colors.cardBorder, color: colors.textPrimary, paddingHorizontal: 8, paddingVertical: 6, fontSize: 13 },
  placeBtn: { backgroundColor: colors.bullish, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  placeText: { color: colors.obsidian, fontSize: 12, fontWeight: '800' },
  result: { color: colors.textSecondary, fontSize: 11, marginTop: 8 },
}));
