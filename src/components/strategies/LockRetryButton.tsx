import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { createThemedStyles, useTheme } from '../../theme';
import { useRadarStore } from '../../store/useRadarStore';

interface LockRetryButtonProps {
  strategy: 'NIFTY' | 'SENSEX' | 'BREAKOUT';
  /** Re-lock an already locked strategy on the latest prices instead of retrying a failed lock. */
  relock?: boolean;
}

/**
 * Shown while a lock is failed (Retry lock) or after it succeeded (Re-lock): fetches the latest prices, locks on them
 * and reports what happened.
 */
export function LockRetryButton({ strategy, relock = false }: LockRetryButtonProps) {
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
      setResult(relock ? await retryStrategyLock(strategy, true) : await retryStrategyLock(strategy));
    } catch {
      setResult({ ok: false, message: `${relock ? 'Re-lock' : 'Retry'} failed. Try again.` });
    } finally {
      setBusy(false);
    }
  };

  const label = relock ? 'Re-lock' : 'Retry lock';
  const testId = `${relock ? 'lock-relock' : 'lock-retry'}-${strategy.toLowerCase()}`;
  // A failed retry shows why; a re-lock also confirms what it locked, since the card looked locked before it.
  const showMessage = result && (!result.ok || relock);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID={testId}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={styles.buttonText}>{relock ? '🔄 ' : ''}{label}</Text>}
      </TouchableOpacity>
      {result && showMessage && (
        <Text style={[styles.message, { color: result.ok ? colors.bullish : colors.bearish }]} testID={`${testId}-message`}>
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
