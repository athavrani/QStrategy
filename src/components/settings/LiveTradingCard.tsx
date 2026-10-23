import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { createThemedStyles, useTheme } from '../../theme';
import { secureVault } from '../../services/SecureCredentialVault';
import { isLiveArmed, useLiveArm } from '../../execution/liveArm';
import { LIVE_MAX_LOTS, PROPOSAL_TTL_MS } from '../../config/orderConfig';

/**
 * The switch that lets the app place real orders. It needs a biometric check, lasts until 15:30 IST today,
 * and is never saved, so restarting the app switches it off.
 */
export function LiveTradingCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const armedDate = useLiveArm((s) => s.armedDate);
  const armed = armedDate !== null && isLiveArmed();
  const [message, setMessage] = useState<string | null>(null);

  const arm = async () => {
    const ok = await secureVault.authenticateStrict('Authenticate to arm LIVE order placement');
    if (!ok) {
      setMessage('Biometric verification is required to arm live trading.');
      return;
    }
    useLiveArm.getState().arm();
    if (!isLiveArmed()) {
      // Arming only lasts until the 15:30 IST close, so after it there is nothing to arm.
      useLiveArm.getState().disarm();
      setMessage('The market has closed for today, so live trading cannot be armed now.');
      return;
    }
    setMessage('Live trading is armed until 15:30 IST today.');
  };

  const disarm = () => {
    useLiveArm.getState().disarm();
    setMessage('Live trading is disarmed.');
  };

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.label}>Live order placement</Text>
        <Text style={[styles.badge, { color: armed ? colors.bearish : colors.textMuted, borderColor: armed ? colors.bearish : colors.textMuted }]} testID="live-status">
          {armed ? 'ARMED' : 'DISARMED'}
        </Text>
      </View>
      <Text style={styles.sub}>
        Real orders are sent to your Dhan account only when this is armed, Confirm mode is on, and you confirm each
        order. Arming ends at 15:30 IST, or when the app restarts.
      </Text>
      <Text style={styles.sub}>
        Limits while live trading is new: {LIVE_MAX_LOTS} lot per order, and a proposal can only be confirmed for{' '}
        {Math.round(PROPOSAL_TTL_MS / 60000)} minutes. Before each order the app also checks that this device's IP matches the
        Dhan whitelist.
      </Text>
      {armed ? (
        <TouchableOpacity style={styles.disarmBtn} onPress={disarm} testID="live-disarm">
          <Text style={styles.disarmText}>Disarm live trading</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.armBtn} onPress={arm} testID="live-arm">
          <Text style={styles.armText}>Arm live trading</Text>
        </TouchableOpacity>
      )}
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  card: { backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.cardBorder, padding: 14, marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  label: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  badge: { fontSize: 11, fontWeight: '800', borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  sub: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 8 },
  armBtn: { backgroundColor: colors.bearish, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  armText: { color: colors.obsidian, fontSize: 12, fontWeight: '800' },
  disarmBtn: { backgroundColor: colors.surfaceSubtle, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  disarmText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  message: { color: colors.warning, fontSize: 11, marginTop: 8 },
}));
