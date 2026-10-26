import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Switch, ActivityIndicator } from 'react-native';
import { createThemedStyles, useTheme } from '../../theme';
import { secureVault } from '../../services/SecureCredentialVault';
import { detectPublicIp, type DetectIpResult } from '../../services/PublicIpService';
import { relayService } from '../../services/relay/RelayService';
import {
  dhanIpService,
  evaluateIpGuard,
  type DhanIpConfig,
  type IpGuardState,
  type IpSlot,
} from '../../services/dhan/DhanIpService';

const GUARD_LABEL: Record<IpGuardState, string> = {
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  NOT_WHITELISTED: 'NOT WHITELISTED',
  UNKNOWN: 'UNKNOWN',
};

function dateOnly(value: string | null): string {
  return value ? value.slice(0, 10) : '-';
}

export function OrderExecutionCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const [detectedIp, setDetectedIp] = useState<string | null>(null);
  const [config, setConfig] = useState<DhanIpConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [slot, setSlot] = useState<IpSlot | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [usingRelay, setUsingRelay] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    // With an order relay, Dhan sees the relay's fixed IP rather than this phone's, so that is the one to whitelist.
    const viaRelay = await relayService.checkEgress();
    setUsingRelay(viaRelay !== null);
    const ipPromise: Promise<DetectIpResult> = viaRelay
      ? Promise.resolve(
          viaRelay.ok
            ? viaRelay.egressIp
              ? { ok: true as const, ip: viaRelay.egressIp }
              : { ok: false as const, error: 'The relay could not determine its own IP.' }
            : { ok: false as const, error: viaRelay.error }
        )
      : detectPublicIp();
    const [ipRes, cfgRes] = await Promise.all([ipPromise, dhanIpService.getIp()]);
    setDetectedIp(ipRes.ok ? ipRes.ip : null);
    setConfig(cfgRes.ok ? cfgRes.data : null);
    const problems = [!ipRes.ok ? ipRes.error : null, !cfgRes.ok ? cfgRes.error : null].filter(Boolean);
    setMessage(problems.length ? problems.join(' ') : null);
    setBusy(false);
  }, []);

  useEffect(() => {
    refresh().catch(() => setBusy(false));
  }, [refresh]);

  const guard = evaluateIpGuard(detectedIp, config);
  const guardColor =
    guard === 'MATCH' ? colors.bullish : guard === 'UNKNOWN' ? colors.textMuted : colors.bearish;

  const openWhitelist = (target: IpSlot) => {
    setAcknowledged(false);
    setSlot(target);
  };

  const confirmWhitelist = async () => {
    if (!slot || !detectedIp || !config) return;
    const authed = await secureVault.authenticateStrict('Authenticate to whitelist this IP with Dhan');
    if (!authed) {
      setMessage('Biometric verification is required to whitelist an IP.');
      setSlot(null);
      return;
    }
    setSaving(true);
    const res = await dhanIpService.whitelist(detectedIp, slot, config);
    setSaving(false);
    setSlot(null);
    if (!res.ok) {
      setMessage(res.error);
      return;
    }
    setMessage(res.data);
    await refresh();
  };

  const rows: Array<{ label: string; ip: string | null; date: string | null; slot: IpSlot }> = [
    { label: 'Primary IP', ip: config?.primaryIP ?? null, date: config?.modifyDatePrimary ?? null, slot: 'PRIMARY' },
    { label: 'Secondary IP', ip: config?.secondaryIP ?? null, date: config?.modifyDateSecondary ?? null, slot: 'SECONDARY' },
  ];

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.label}>{usingRelay ? 'Order relay IP' : 'This device IP'}</Text>
        <Text style={styles.value} testID="detected-ip">{detectedIp ?? '-'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Status</Text>
        <Text style={[styles.badge, { color: guardColor, borderColor: guardColor }]} testID="ip-guard">
          {GUARD_LABEL[guard]}
        </Text>
      </View>

      {rows.map((r) => (
        <View key={r.slot} style={styles.slotBlock}>
          <View style={styles.row}>
            <Text style={styles.label}>{r.label}</Text>
            <Text style={styles.value}>{r.ip ?? 'not set'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.sub}>Can be changed from {dateOnly(r.date)}</Text>
            <TouchableOpacity
              style={[styles.smallBtn, (!detectedIp || !config) && styles.btnDisabled]}
              disabled={!detectedIp || !config}
              onPress={() => openWhitelist(r.slot)}
              testID={`whitelist-${r.slot}`}
            >
              <Text style={styles.smallBtnText}>{r.ip ? 'Change to this IP' : 'Whitelist this IP'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      <TouchableOpacity style={styles.refreshBtn} onPress={refresh} disabled={busy} testID="ip-refresh">
        {busy ? <ActivityIndicator color={colors.textPrimary} /> : <Text style={styles.refreshText}>Refresh IP status</Text>}
      </TouchableOpacity>

      {message ? <Text style={styles.message}>{message}</Text> : null}
      <Text style={styles.sub}>
        {usingRelay
          ? 'Orders are sent through your order relay, so Dhan sees the relay IP above. Whitelist that IP with Dhan; it stays the same when your phone changes network.'
          : 'Dhan accepts order placement, modification and cancellation only from a whitelisted IP. Mobile network addresses often change; when this device IP stops matching, orders are blocked by the app.'}
      </Text>

      <Modal transparent visible={slot !== null} animationType="fade" onRequestClose={() => setSlot(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Whitelist {detectedIp} as {slot?.toLowerCase()} IP</Text>
            <Text style={styles.sheetBody}>
              {usingRelay
                ? 'Once set, Dhan does not allow this IP to be changed for 7 days. This is the fixed IP of your order relay.'
                : 'Once set, Dhan does not allow this IP to be changed for 7 days. You are on a mobile network, so this address may change soon, and orders will then be blocked until it matches again or you can edit it.'}
            </Text>
            <View style={styles.row}>
              <Text style={[styles.sheetBody, { flex: 1, paddingRight: 10 }]}>
                {usingRelay ? 'I understand this IP is locked for 7 days' : 'I understand the address can change and is locked for 7 days'}
              </Text>
              <Switch
                value={acknowledged}
                onValueChange={setAcknowledged}
                trackColor={{ false: colors.surfaceSubtle, true: colors.bullish }}
                testID="ip-ack"
              />
            </View>
            <View style={styles.row}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setSlot(null)} disabled={saving}>
                <Text style={styles.refreshText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, (!acknowledged || saving) && styles.btnDisabled]}
                disabled={!acknowledged || saving}
                onPress={confirmWhitelist}
                testID="ip-confirm"
              >
                {saving ? <ActivityIndicator color={colors.obsidian} /> : <Text style={styles.confirmText}>Confirm</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  card: {
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 14,
    marginBottom: 16,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  slotBlock: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8, marginTop: 4 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  value: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: 11, flexShrink: 1, paddingRight: 8 },
  badge: { fontSize: 11, fontWeight: '800', borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  smallBtn: { backgroundColor: colors.surfaceSubtle, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  smallBtnText: { color: colors.textPrimary, fontSize: 11, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },
  refreshBtn: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginVertical: 8,
  },
  refreshText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  message: { color: colors.warning ?? colors.textSecondary, fontSize: 11, marginBottom: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: colors.card, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: colors.cardBorder },
  sheetTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '800', marginBottom: 10 },
  sheetBody: { color: colors.textSecondary, fontSize: 12, marginBottom: 12, lineHeight: 18 },
  cancelBtn: { flex: 1, backgroundColor: colors.surfaceSubtle, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginRight: 8 },
  confirmBtn: { flex: 1, backgroundColor: colors.bullish, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  confirmText: { color: colors.obsidian, fontSize: 13, fontWeight: '800' },
}));
