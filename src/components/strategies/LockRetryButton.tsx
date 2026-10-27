import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { createThemedStyles, useTheme } from '../../theme';
import { useRadarStore } from '../../store/useRadarStore';

interface LockRetryButtonProps {
  strategy: 'NIFTY' | 'SENSEX' | 'BREAKOUT';
}

/** Shown while a 09:20 lock is failed: fetches the latest prices, locks on them and reports what happened. */
export function LockRetryButton({ strategy }: LockRetryButtonProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const retryStrategyLock = useRadarStore((s) => s.retryStrategyLock);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const onPress = async () => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    setResult(null);
    try {
      setResult(await retryStrategyLock(strategy));
    } catch {
      setResult({ ok: false, message: 'Retry failed. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Retry lock"
        testID={`lock-retry-${strategy.toLowerCase()}`}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={styles.buttonText}>Retry lock</Text>}
      </TouchableOpacity>
      {result && !result.ok && (
        <Text style={[styles.message, { color: colors.bearish }]} testID={`lock-retry-${strategy.toLowerCase()}-message`}>
          {result.message}
        </Text>
      )}
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  wrap: { marginTop: 8 },
  button: {
    backgroundColor: colors.purple,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: 'center' as const,
    alignSelf: 'flex-start' as const,
    minWidth: 110,
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' as const },
  message: { marginTop: 6, fontSize: 11, fontWeight: '600' as const },
}));
