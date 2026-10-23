import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, RefreshControl, Alert } from 'react-native';
import { createThemedStyles, useTheme } from '../theme';
import { useOrdersStore } from '../store/useOrdersStore';
import { isOpenOrderStatus, isCancellableStatus, type OrderRequest } from '../services/dhan/DhanOrderClient';
import type { StoredOrder } from '../services/OrderRepository';

const POLL_MS = 5000;

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
  const { orders, configured, syncing, error, lastSynced, init, sync, cancel } = useOrdersStore();

  useEffect(() => {
    init().then(() => sync()).catch(() => {});
  }, [init, sync]);

  const hasOpen = orders.some((o) => isOpenOrderStatus(o.status));
  useEffect(() => {
    if (!configured || !hasOpen) return;
    const timer = setInterval(() => {
      sync().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [configured, hasOpen, sync]);

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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 30 }}
      refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void sync()} />}
    >
      <View style={styles.rowBetween}>
        <Text style={styles.title}>Orders</Text>
        <Text style={styles.envPill} testID="orders-env">SANDBOX</Text>
      </View>

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
