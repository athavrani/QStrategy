import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { colors } from '../theme/colors';
import { notificationService } from '../services/notificationService';
import { dhanDirectService } from '../services/dhanDirectService';
import { secureVault } from '../services/SecureCredentialVault';
import { dhanHqFeedSocket, testDhanFeedConnection } from '../services/dhan/DhanHqFeedSocket';
import { DhanWebLoginModal } from '../components/settings/DhanWebLoginModal';
import { useRadarStore } from '../store/useRadarStore';
import { API_CONFIG } from '../config/apiConfig';
import * as Haptics from 'expo-haptics';

export function SettingsScreen() {
  const [pushEnabled, setPushEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [broker, setBroker] = useState<'kite' | 'dhan'>('dhan');

  // Direct Dhan Streamer State
  const [dhanClientId, setDhanClientId] = useState('');
  const [dhanAccessToken, setDhanAccessToken] = useState('');
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoginModalVisible, setIsLoginModalVisible] = useState(false);

  useEffect(() => {
    // Load hardware Keystore credentials on mount
    secureVault.getCredentials().then((creds) => {
      if (creds.clientId) setDhanClientId(creds.clientId);
      if (creds.token) {
        setDhanAccessToken(creds.token);
        setIsConnected(true);
      }
    });
  }, []);

  const handleTestDhanConnection = async () => {
    if (!dhanClientId.trim() || !dhanAccessToken.trim()) {
      Alert.alert('Missing Credentials', 'Please enter your Dhan Client ID and Access/Session Token to test.');
      return;
    }

    setIsTesting(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // 1. Direct REST Data API verification (fetches live NIFTY spot quote from /marketfeed/ltp)
    const restResult = await dhanDirectService.testDirectConnection(dhanClientId, dhanAccessToken);

    // 2. Direct Live WebSocket Streamer verification (TLS handshake & auth)
    const wsResult = await testDhanFeedConnection(dhanClientId, dhanAccessToken);

    setIsTesting(false);

    if (restResult.ok || wsResult.ok) {
      setIsConnected(true);
      const latency = restResult.latencyMs || wsResult.latencyMs;
      setLatencyMs(latency);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const lines: string[] = [
        'Direct connection to DhanHQ Data API successful!\n',
        `• Round-Trip Latency: ${latency}ms`,
      ];
      if (restResult.ok && restResult.spotPrice) {
        lines.push(`• Live NIFTY 50 Spot: ₹${restResult.spotPrice.toLocaleString('en-IN')}`);
      }
      lines.push(`• REST Data API: ${restResult.ok ? '🟢 VERIFIED' : `⚠️ ${restResult.error}`}`);
      lines.push(`• Live WebSocket: ${wsResult.ok ? '🟢 READY' : `⚠️ ${wsResult.error}`}`);
      lines.push('\nStatus: DATA API ACTIVE');

      Alert.alert('⚡ DhanHQ Data API Connected!', lines.join('\n'));
    } else {
      setIsConnected(false);
      setLatencyMs(null);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Connection Failed',
        `Could not authenticate with DhanHQ Data API:\n\n• REST Data API: ${restResult.error || 'Failed'}\n• WebSocket: ${wsResult.error || 'Failed'}\n\nPlease check your Client ID or Token.`
      );
    }
  };

  const handleSaveDhanCredentials = async () => {
    if (!dhanClientId.trim() || !dhanAccessToken.trim()) {
      Alert.alert('Incomplete', 'Please provide your Dhan Client ID and Token.');
      return;
    }

    const authed = await secureVault.authenticateWithBiometrics('Authenticate to update Dhan credentials');
    if (!authed) {
      Alert.alert('Authentication Failed', 'Biometric verification required to update credentials.');
      return;
    }

    setIsSaving(true);
    await secureVault.saveCredentials(dhanClientId, dhanAccessToken);
    await dhanDirectService.saveCredentials(dhanClientId, dhanAccessToken);
    dhanHqFeedSocket.start();
    useRadarStore.getState().initStreamer();
    await useRadarStore.getState().refreshAll();
    setIsSaving(false);
    setIsConnected(true);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('⚡ Live Data Active!', 'Dhan credentials saved to hardware Keystore. Live market feed is now streaming.');
  };

  const handleDisconnectDhan = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await secureVault.clearCredentials();
    await dhanDirectService.clearCredentials();
    dhanHqFeedSocket.stop();
    setDhanClientId('');
    setDhanAccessToken('');
    setIsConnected(false);
    setLatencyMs(null);
    await useRadarStore.getState().refreshAll();
    Alert.alert('Disconnected', 'Dhan credentials wiped from hardware Keystore.');
  };

  const handleTestLaunchDhanApp = async () => {
    await dhanHqFeedSocket.launchDhanApp('NIFTY 25100 CE');
  };

  const handleTestNotification = async () => {
    if (hapticsEnabled) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    await notificationService.notify180BreakoutTriggered('CE', 24850, 182.5, 220, 160);
    Alert.alert('Alert Sent', 'A simulated 180 Breakout BUY notification has been fired to your notification shade.');
  };

  return (
    <ScrollView style={styles.container}>
      {/* DIRECT DHAN LIVE STREAMER */}
      <Text style={styles.sectionHeader}>DHANHQ DATA API (OFFICIAL PLAN)</Text>

      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View>
            <Text style={styles.gatewayTitle}>Direct Phone-to-Dhan Data Feed</Text>
            <Text style={styles.gatewaySub}>https://api.dhan.co/v2 • wss://api-feed.dhan.co</Text>
          </View>
          <View style={[styles.statusBadge, isConnected ? styles.statusBadgeOnline : styles.statusBadgeOffline]}>
            <Text style={[styles.statusBadgeText, isConnected ? styles.textBullish : styles.textMuted]}>
              {isConnected ? (latencyMs ? `🟢 ${latencyMs}ms` : '🟢 ACTIVE') : '⚪ OFFLINE'}
            </Text>
          </View>
        </View>

        {/* 1-Tap Open web.dhan.co & Auto-Capture Button */}
        <TouchableOpacity
          style={styles.webLoginBtn}
          onPress={() => setIsLoginModalVisible(true)}
          activeOpacity={0.8}
        >
          <View style={styles.webLoginIconCircle}>
            <Text style={{ fontSize: 18 }}>🌐</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.webLoginBtnTitle}>Open web.dhan.co & Auto-Sync Token</Text>
            <Text style={styles.webLoginBtnSub}>Log in with Mobile/Password/OTP/QR ➔ Auto-captures token</Text>
          </View>
          <Text style={styles.arrowIcon}>➔</Text>
        </TouchableOpacity>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR ENTER MANUALLY</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>DHAN 10-DIGIT CLIENT ID</Text>
          <TextInput
            style={styles.textInput}
            value={dhanClientId}
            onChangeText={setDhanClientId}
            placeholder="e.g. 10-digit Client ID"
            placeholderTextColor={colors.textMuted}
            keyboardType="numeric"
            autoCapitalize="none"
          />
        </View>

        <View style={styles.inputContainer}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.inputLabel}>DHAN ACCESS TOKEN (DATA API / SESSION)</Text>
            <TouchableOpacity onPress={() => setIsTokenVisible(!isTokenVisible)}>
              <Text style={styles.toggleText}>{isTokenVisible ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.textInput}
            value={dhanAccessToken}
            onChangeText={setDhanAccessToken}
            placeholder="Paste 30-day Data API token or web session token"
            placeholderTextColor={colors.textMuted}
            secureTextEntry={!isTokenVisible}
            autoCapitalize="none"
          />
        </View>

        {/* Fast Token Helper */}
        <View style={styles.helperCard}>
          <Text style={styles.helperTitle}>💡 DhanHQ Data API Token Setup:</Text>
          <Text style={styles.helperDesc}>
            • <Text style={{ fontWeight: '700', color: colors.bullish }}>Option A (Recommended):</Text> Generate a 30-day Access Token from{' '}
            <Text style={{ color: colors.cyan }}>dhanhq.co</Text> or <Text style={{ color: colors.cyan }}>web.dhan.co</Text> (Profile ➔ Access Token ➔ Generate Access Token) and paste it above.
          </Text>
          <Text style={[styles.helperDesc, { marginTop: 6 }]}>
            • <Text style={{ fontWeight: '700', color: colors.bullish }}>Option B:</Text> Tap &quot;Open web.dhan.co &amp; Auto-Sync Token&quot; above to log in and capture your session automatically.
          </Text>
          <Text style={[styles.helperDesc, { marginTop: 6 }]}>
            • <Text style={{ fontWeight: '700', color: colors.bullish }}>Option C (Browser Console):</Text> In web.dhan.co console run:
          </Text>
          <View style={[styles.codeBox, { marginTop: 4 }]}>
            <Text style={styles.codeText}>copy(JSON.parse(sessionStorage.getItem("userdata")).token_id)</Text>
          </View>
        </View>

        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.testPingBtn]}
            onPress={handleTestDhanConnection}
            disabled={isTesting}
          >
            {isTesting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.actionBtnText}>⚡ Test Direct Ping</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.saveBtn]}
            onPress={handleSaveDhanCredentials}
            disabled={isSaving}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.actionBtnText}>💾 Save & Connect</Text>
            )}
          </TouchableOpacity>
        </View>

        {isConnected && (
          <TouchableOpacity style={styles.disconnectBtn} onPress={handleDisconnectDhan}>
            <Text style={styles.disconnectBtnText}>✕ Disconnect & Wipe Token</Text>
          </TouchableOpacity>
        )}

        <View style={styles.infoBox}>
          <Text style={styles.infoBoxText}>
            🔒 <Text style={{ fontWeight: '700' }}>Plain-Text Persistence Active:</Text> Token is stored directly as provided in plain text without hardware keystore encryption.
          </Text>
        </View>
      </View>

      {/* BROKER DEEP LINK PREFERENCE */}
      <Text style={styles.sectionHeader}>BROKER DEEP LINK PREFERENCE</Text>

      <View style={styles.card}>
        <Text style={styles.brokerDesc}>
          Select which broker mobile app should open when you tap &quot;Trade in Broker&quot; on any signal card:
        </Text>

        <View style={styles.brokerRow}>
          <TouchableOpacity
            style={[styles.brokerBtn, broker === 'dhan' && styles.brokerBtnActive]}
            onPress={() => setBroker('dhan')}
          >
            <Text style={[styles.brokerBtnText, broker === 'dhan' && styles.brokerBtnTextActive]}>
              ⚡ Dhan App (dhan://)
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.brokerBtn, broker === 'kite' && styles.brokerBtnActive]}
            onPress={() => setBroker('kite')}
          >
            <Text style={[styles.brokerBtnText, broker === 'kite' && styles.brokerBtnTextActive]}>
              Zerodha Kite (kite://)
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.testAppLaunchBtn} onPress={handleTestLaunchDhanApp}>
          <Text style={styles.testAppLaunchText}>📱 Test 1-Tap Launch Dhan Mobile App</Text>
        </TouchableOpacity>
      </View>

      {/* PUSH NOTIFICATION ALERTS */}
      <Text style={styles.sectionHeader}>PUSH NOTIFICATION ALERTS</Text>

      <View style={styles.card}>
        <View style={styles.settingRow}>
          <View>
            <Text style={styles.settingTitle}>Push Notifications</Text>
            <Text style={styles.settingSub}>Receive lock-screen BUY/SELL signal alerts</Text>
          </View>
          <Switch
            value={pushEnabled}
            onValueChange={setPushEnabled}
            trackColor={{ false: colors.surfaceSubtle, true: colors.bullish }}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.settingRow}>
          <View>
            <Text style={styles.settingTitle}>Tactile Haptics</Text>
            <Text style={styles.settingSub}>Vibrate phone on signal triggers</Text>
          </View>
          <Switch
            value={hapticsEnabled}
            onValueChange={setPushEnabled}
            trackColor={{ false: colors.surfaceSubtle, true: colors.bullish }}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.settingRow}>
          <View>
            <Text style={styles.settingTitle}>Audible Sound Alerts</Text>
            <Text style={styles.settingSub}>Play chime on 20D crossovers and breakouts</Text>
          </View>
          <Switch
            value={soundEnabled}
            onValueChange={setSoundEnabled}
            trackColor={{ false: colors.surfaceSubtle, true: colors.bullish }}
          />
        </View>
      </View>

      {/* TEST & DIAGNOSTICS */}
      <Text style={styles.sectionHeader}>TEST & DIAGNOSTICS</Text>

      <View style={styles.card}>
        <TouchableOpacity style={styles.testBtn} onPress={handleTestNotification}>
          <Text style={styles.testBtnText}>🔔 Send Test BUY Signal Notification</Text>
        </TouchableOpacity>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Live Feed Architecture:</Text>
          <Text style={[styles.infoVal, { color: colors.bullish }]}>Direct DhanHQ Data API (Official Plan)</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Option Chain Engine:</Text>
          <Text style={[styles.infoVal, { color: colors.cyan }]}>DhanHQ /v2/optionchain Direct</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Terminal Mode:</Text>
          <Text style={[styles.infoVal, { color: colors.cyan }]}>Signal Radar & 1-Tap Execution</Text>
        </View>
      </View>

      <View style={{ height: 40 }} />

      <DhanWebLoginModal
        visible={isLoginModalVisible}
        onClose={() => setIsLoginModalVisible(false)}
        onSuccess={async (id, token) => {
          setDhanClientId(id);
          setDhanAccessToken(token);
          setIsConnected(true);
          await secureVault.saveCredentials(id, token);
          await dhanDirectService.saveCredentials(id, token);
          dhanHqFeedSocket.start();
          useRadarStore.getState().initStreamer();
          await useRadarStore.getState().refreshAll();
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.obsidian,
    padding: 14,
  },
  sectionHeader: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 6,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 14,
    marginBottom: 16,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  gatewayTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  gatewaySub: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusBadgeOnline: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: colors.bullish,
  },
  statusBadgeOffline: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  textBullish: {
    color: colors.bullish,
  },
  textMuted: {
    color: colors.textMuted,
  },
  inputContainer: {
    marginBottom: 10,
  },
  inputLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  toggleText: {
    color: colors.cyan,
    fontSize: 10,
    fontWeight: '700',
  },
  textInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.textPrimary,
    fontSize: 12,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  testPingBtn: {
    backgroundColor: '#0284C7',
  },
  saveBtn: {
    backgroundColor: colors.bullish,
  },
  actionBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  disconnectBtn: {
    alignItems: 'center',
    paddingVertical: 6,
    marginBottom: 8,
  },
  disconnectBtnText: {
    color: colors.bearish,
    fontSize: 11,
    fontWeight: '600',
  },
  infoBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    padding: 8,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.cyan,
  },
  infoBoxText: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  settingTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  settingSub: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: 8,
  },
  brokerDesc: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 12,
  },
  brokerRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  brokerBtn: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: 'center',
  },
  brokerBtnActive: {
    backgroundColor: colors.bullishGlow,
    borderColor: colors.bullish,
  },
  brokerBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  brokerBtnTextActive: {
    color: colors.bullish,
    fontWeight: '700',
  },
  testAppLaunchBtn: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: colors.bullish,
    paddingVertical: 9,
    borderRadius: 6,
    alignItems: 'center',
  },
  testAppLaunchText: {
    color: colors.bullish,
    fontSize: 11,
    fontWeight: '700',
  },
  testBtn: {
    backgroundColor: colors.surfaceHover,
    borderRadius: 6,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  testBtnText: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '700',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  infoLabel: {
    color: colors.textMuted,
    fontSize: 11,
  },
  infoVal: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  helperCard: {
    backgroundColor: 'rgba(0, 210, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(0, 210, 255, 0.2)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
  },
  helperTitle: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  helperDesc: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 6,
  },
  codeBox: {
    backgroundColor: '#070D18',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  codeText: {
    color: colors.bullish,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  webLoginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderWidth: 1.5,
    borderColor: colors.bullish,
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
    gap: 8,
  },
  webLoginIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  webLoginBtnTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  webLoginBtnSub: {
    color: colors.textSecondary,
    fontSize: 10,
    marginTop: 2,
  },
  arrowIcon: {
    color: colors.bullish,
    fontSize: 16,
    fontWeight: '700',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  dividerText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
});
