import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createThemedStyles } from '../../theme';
import { secureVault } from '../../services/SecureCredentialVault';

export const ONBOARDING_DISMISSED_KEY = '@qstrategy_onboarding_dismissed';

/** Show the prompt only when no valid Dhan credentials are stored and the user has not dismissed it. */
export function shouldShowOnboarding(creds: { clientId: string; token: string }, dismissed: boolean): boolean {
  return !dismissed && !(creds.clientId && creds.token);
}

interface Props {
  onOpenSettings: () => void;
}

export function FirstRunOnboarding({ onOpenSettings }: Props): React.JSX.Element | null {
  const styles = useThemedStyles();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [creds, dismissed] = await Promise.all([
          secureVault.getEffectiveCredentials(),
          AsyncStorage.getItem(ONBOARDING_DISMISSED_KEY),
        ]);
        if (active && shouldShowOnboarding(creds, dismissed === 'true')) setVisible(true);
      } catch {
        // Cannot read the keystore: stay quiet; the feed health banner still explains the problem.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!visible) return null;

  const handleSkip = () => {
    setVisible(false);
    AsyncStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true').catch(() => {});
  };

  const handleOpenSettings = () => {
    setVisible(false);
    onOpenSettings();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleSkip}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Connect your Dhan account</Text>
          <Text style={styles.body}>QStrategy needs your own DhanHQ Data API access to show live prices and signals.</Text>
          <Text style={styles.step}>1. Open web.dhan.co and go to Profile, then Access DhanHQ APIs.</Text>
          <Text style={styles.step}>2. Generate an Access Token (starts with "eyJ").</Text>
          <Text style={styles.step}>3. Enter your Client ID and the token in Settings, then tap Save &amp; Connect.</Text>
          <Text style={styles.note}>Your token is stored only in this phone's secure keystore.</Text>
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.secondary]} onPress={handleSkip}>
              <Text style={styles.secondaryText}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.primary]} onPress={handleOpenSettings}>
              <Text style={styles.primaryText}>Open Settings</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.surfaceElevated, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: colors.divider },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 8 },
  body: { color: colors.textSecondary, fontSize: 13, marginBottom: 12 },
  step: { color: colors.textPrimary, fontSize: 13, marginBottom: 6 },
  note: { color: colors.textMuted, fontSize: 11, marginTop: 6, marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  secondary: { backgroundColor: colors.surfaceHover },
  secondaryText: { color: colors.textPrimary, fontWeight: '600' },
  primary: { backgroundColor: colors.bullish },
  primaryText: { color: '#FFFFFF', fontWeight: '700' },
}));
