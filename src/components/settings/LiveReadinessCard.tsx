import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { createThemedStyles, useTheme } from '../../theme';
import { runReadinessChecks, summarizeReadiness, type CheckStatus, type ReadinessCheck } from '../../execution/readiness';

const LABEL: Record<CheckStatus, string> = { PASS: 'OK', WARN: 'CHECK', FAIL: 'FIX' };

/** A checklist to run before the market opens: token, IP, mode, arming, monitoring and any unprotected position. */
export function LiveReadinessCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const [checks, setChecks] = useState<ReadinessCheck[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      setChecks(await runReadinessChecks());
    } finally {
      setRunning(false);
    }
  };

  const color = (s: CheckStatus) => (s === 'PASS' ? colors.bullish : s === 'WARN' ? colors.warning : colors.bearish);
  const summary = checks ? summarizeReadiness(checks) : null;

  return (
    <View style={styles.card}>
      <Text style={styles.sub}>Run this before the market opens. It checks everything the app needs to place and protect an order.</Text>
      <TouchableOpacity style={styles.btn} onPress={run} disabled={running} testID="readiness-run">
        {running ? <ActivityIndicator color={colors.textPrimary} /> : <Text style={styles.btnText}>Run checks</Text>}
      </TouchableOpacity>
      {summary ? (
        <Text style={[styles.summary, { color: summary.fails ? colors.bearish : summary.warns ? colors.warning : colors.bullish }]} testID="readiness-summary">
          {summary.ready ? 'All clear' : `${summary.fails} to fix, ${summary.warns} to check`}
        </Text>
      ) : null}
      {checks?.map((c) => (
        <View key={c.id} style={styles.row} testID={`check-${c.id}`}>
          <Text style={[styles.badge, { color: color(c.status), borderColor: color(c.status) }]} testID={`check-status-${c.id}`}>
            {LABEL[c.status]}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{c.label}</Text>
            <Text style={styles.detail}>{c.detail}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  card: { backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.cardBorder, padding: 14, marginBottom: 16 },
  sub: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 8 },
  btn: { backgroundColor: colors.surfaceSubtle, borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginBottom: 8 },
  btnText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  summary: { fontSize: 13, fontWeight: '800', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.divider },
  badge: { fontSize: 10, fontWeight: '800', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, minWidth: 48, textAlign: 'center' },
  label: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: 11, lineHeight: 15 },
}));
