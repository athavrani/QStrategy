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
import { useTheme, createThemedStyles } from '../theme';
import { notificationService } from '../services/notificationService';
import { dhanDirectService } from '../services/dhanDirectService';
import { secureVault, isDhanJwtToken, isNumericClientId } from '../services/SecureCredentialVault';
import { dhanHqFeedSocket, testDhanFeedConnection } from '../services/dhan/DhanHqFeedSocket';
import { DhanWebLoginModal } from '../components/settings/DhanWebLoginModal';
import { OrderExecutionCard } from '../components/settings/OrderExecutionCard';
import { RelayCard } from '../components/settings/RelayCard';
import { SandboxCredentialsCard } from '../components/settings/SandboxCredentialsCard';
import { ExecutionSettingsCard } from '../components/settings/ExecutionSettingsCard';
import { LiveTradingCard } from '../components/settings/LiveTradingCard';
import { LiveReadinessCard } from '../components/settings/LiveReadinessCard';
import { useRadarStore } from '../store/useRadarStore';
import { API_CONFIG } from '../config/apiConfig';
import { appUpdateService, UpdateCheckResult } from '../services/appUpdateService';
import { prevCloseBook } from '../services/marketdata/PrevCloseBook';
import {
  isBackgroundMonitorEnabled,
  setBackgroundMonitorEnabled,
  openBatterySettings,
} from '../services/backgroundMonitorService';
import * as Haptics from 'expo-haptics';

export function SettingsScreen() {
  const { mode, effectiveMode, isDark, setMode, colors } = useTheme();
  const styles = useThemedStyles();
  const [pushEnabled, setPushEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [backgroundEnabled, setBackgroundEnabled] = useState(true);

  useEffect(() => {
    isBackgroundMonitorEnabled().then(setBackgroundEnabled).catch(() => {});
  }, []);

  const handleToggleBackground = async (value: boolean) => {
    setBackgroundEnabled(value);
    const running = await setBackgroundMonitorEnabled(value);
    if (value && !running) {
      setBackgroundEnabled(false);
      Alert.alert('Background monitoring', 'Could not start the background service on this device.');
    }
  };
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

  // App Update State
  const currentAppVer = appUpdateService.getCurrentVersionInfo();
  const [updateStatus, setUpdateStatus] = useState<'IDLE' | 'CHECKING' | 'UP_TO_DATE' | 'AVAILABLE'>('IDLE');
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);

  const handleManualCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    setUpdateStatus('CHECKING');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await appUpdateService.checkForUpdate();
      setUpdateInfo(result);
      if (result.updateAvailable) {
        setUpdateStatus('AVAILABLE');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          '🚀 Update Available!',
          `Version ${result.latestVersion} (Build ${result.latestVersionCode}) is ready to install.\n\nRelease Notes:\n${result.releaseNotes}`,
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Download & Install',
              onPress: () => appUpdateService.openApkDownload(result.apkDownloadUrl),
            },
          ]
        );
      } else {
        setUpdateStatus('UP_TO_DATE');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          '✅ Up to Date',
          `You are running the latest version of QStrategy (v${result.currentVersion}).`
        );
      }
    } catch (e: any) {
      setUpdateStatus('IDLE');
      Alert.alert('Update Check Failed', e?.message || 'Could not reach update server.');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  useEffect(() => {
    // Load hardware Keystore credentials on mount
    secureVault.getCredentials().then((creds) => {
      setDhanClientId(creds.clientId);
      setDhanAccessToken(creds.token);
      setIsConnected(Boolean(creds.clientId && creds.token));
    });
  }, []);

  const handleTestWithParams = async (clientId: string, token: string) => {
    setIsTesting(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // 1. Direct REST Data API verification (fetches live NIFTY spot quote from /marketfeed/ltp)
    const restResult = await dhanDirectService.testDirectConnection(clientId, token);

    // 2. Direct Live WebSocket Streamer verification (TLS handshake & auth)
    const wsResult = await testDhanFeedConnection(clientId, token);

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
        `Could not authenticate with DhanHQ Data API:\n\n• REST Data API: ${restResult.error || 'Failed'}\n• WebSocket: ${wsResult.error || 'Failed'}\n\nNote: If you are using your personal Client ID, you must also paste your matching 30-day Data API token from dhanhq.co.`
      );
    }
  };

  const handleTestDhanConnection = async () => {
    const cleanId = dhanClientId.replace(/\s+/g, '').trim();
    const cleanToken = dhanAccessToken.replace(/[\s\r\n]+/g, '').trim();

    if (!cleanId || !cleanToken) {
      Alert.alert('Missing Credentials', 'Please enter your Dhan Client ID and Access/Session Token to test.');
      return;
    }

    if (!isDhanJwtToken(cleanToken)) {
      Alert.alert(
        '⚠️ API Secret Detected',
        `The value entered ("${cleanToken.slice(0, 12)}...") is an API Secret or Key, NOT an Access Token.\n\nDhan Data APIs require an Access Token (JWT starting with "eyJ...").`
      );
      return;
    }

    if (!isNumericClientId(cleanId)) {
      Alert.alert(
        '⚠️ Invalid Client ID',
        `"${cleanId}" looks like an API Key. Dhan Client ID must be your 10-digit trading account number (e.g. 1234567890).`
      );
      return;
    }

    // Auto-detect if Client ID doesn't match the token owner
    const tokenClientId = secureVault.extractDhanClientId(cleanToken);
    if (tokenClientId && cleanId && tokenClientId !== cleanId) {
      Alert.alert(
        'Client ID & Token Mismatch',
        `The Client ID entered ("${cleanId}") does not match the Client ID embedded in the Access Token ("${tokenClientId}").\n\nDhan HQ rejects requests where the Client ID header does not match the token owner.\n\nWould you like to auto-match your Client ID to "${tokenClientId}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: `Use ${tokenClientId}`,
            onPress: async () => {
              setDhanClientId(tokenClientId);
              await handleTestWithParams(tokenClientId, cleanToken);
            },
          },
        ]
      );
      return;
    }

    await handleTestWithParams(cleanId, cleanToken);
  };

  const handleSaveDhanCredentials = async () => {
    const cleanId = dhanClientId.replace(/\s+/g, '').trim();
    const cleanToken = dhanAccessToken.replace(/[\s\r\n]+/g, '').trim();

    if (!cleanId || !cleanToken) {
      Alert.alert('Incomplete', 'Please provide your Dhan Client ID and Token.');
      return;
    }

    if (!isDhanJwtToken(cleanToken)) {
      Alert.alert(
        '⚠️ API Secret Detected',
        `You entered an API Secret instead of an Access Token.\n\nDhan REST & WebSocket Data APIs strictly require a JWT Access Token starting with "eyJ...". Direct API calls will fail with "Authentication Failed" if an API Secret is used.`
      );
      return;
    }

    const authed = await secureVault.authenticateWithBiometrics('Authenticate to update Dhan credentials');
    if (!authed) {
      Alert.alert('Authentication Failed', 'Biometric verification required to update credentials.');
      return;
    }

    setIsSaving(true);
    await secureVault.saveCredentials(cleanId, cleanToken);
    await dhanDirectService.saveCredentials(cleanId, cleanToken);
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
      {/* APPEARANCE & THEME */}
      <Text style={styles.sectionHeader}>APPEARANCE & THEME</Text>
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View>
            <Text style={styles.gatewayTitle}>Display Theme</Text>
            <Text style={styles.gatewaySub}>
              {mode === 'system'
                ? `System Default (${isDark ? 'Dark' : 'Light'} Active)`
                : mode === 'dark'
                ? 'Obsidian Dark Terminal'
                : 'Clean Slate Financial Light'}
            </Text>
          </View>
          <View style={[styles.statusBadge, styles.themeModeBadge]}>
            <Text style={[styles.statusBadgeText, { color: colors.cyan }]}>
              {mode.toUpperCase()}
            </Text>
          </View>
        </View>

        <View style={styles.themeSelectorGroup}>
          <TouchableOpacity
            style={[styles.themeOptionBtn, mode === 'dark' && styles.themeOptionBtnActive]}
            onPress={() => setMode('dark')}
            activeOpacity={0.7}
          >
            <Text style={styles.themeOptionIcon}>🌙</Text>
            <Text style={[styles.themeOptionText, mode === 'dark' && styles.themeOptionTextActive]}>
              Dark
            </Text>
            <Text style={styles.themeOptionSub}>Obsidian</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.themeOptionBtn, mode === 'light' && styles.themeOptionBtnActive]}
            onPress={() => setMode('light')}
            activeOpacity={0.7}
          >
            <Text style={styles.themeOptionIcon}>☀️</Text>
            <Text style={[styles.themeOptionText, mode === 'light' && styles.themeOptionTextActive]}>
              Light
            </Text>
            <Text style={styles.themeOptionSub}>Slate</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.themeOptionBtn, mode === 'system' && styles.themeOptionBtnActive]}
            onPress={() => setMode('system')}
            activeOpacity={0.7}
          >
            <Text style={styles.themeOptionIcon}>💻</Text>
            <Text style={[styles.themeOptionText, mode === 'system' && styles.themeOptionTextActive]}>
              System
            </Text>
            <Text style={styles.themeOptionSub}>Auto</Text>
          </TouchableOpacity>
        </View>
      </View>

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
          {dhanClientId.trim().length > 0 && !isNumericClientId(dhanClientId) && (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                ⚠️ Dhan Client ID should be your 10-digit trading account number (e.g. 1234567890), NOT an API Key (e.g. 6b70a445).
              </Text>
            </View>
          )}
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
          {dhanAccessToken.trim().length > 0 && !isDhanJwtToken(dhanAccessToken) && (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                ⚠️ API Secret Detected: Dhan Data APIs require a JWT Access Token starting with "eyJ...". Live data stays off until a valid Access Token is saved.
              </Text>
            </View>
          )}
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

      {/* ORDER EXECUTION: DHAN IP WHITELIST */}
      <Text style={styles.sectionHeader}>ORDER EXECUTION · ORDER RELAY (STATIC IP)</Text>
      <RelayCard />

      <Text style={styles.sectionHeader}>ORDER EXECUTION · DHAN IP WHITELIST</Text>
      <OrderExecutionCard />

      <Text style={styles.sectionHeader}>ORDER EXECUTION · DHAN SANDBOX (TEST ORDERS)</Text>
      <SandboxCredentialsCard />

      <Text style={styles.sectionHeader}>ORDER EXECUTION · MODE & LIMITS</Text>
      <ExecutionSettingsCard />

      <Text style={styles.sectionHeader}>ORDER EXECUTION · LIVE TRADING</Text>
      <LiveTradingCard />

      <Text style={styles.sectionHeader}>ORDER EXECUTION · READINESS CHECK</Text>
      <LiveReadinessCard />

      {/* BACKGROUND MONITORING */}
      <Text style={styles.sectionHeader}>BACKGROUND MONITORING</Text>

      <View style={styles.card}>
        <View style={styles.settingRow}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.settingTitle}>Keep running in background</Text>
            <Text style={styles.settingSub}>
              Shows a persistent notification and keeps the live feed so locks, breakouts and exits alert with the app minimised
            </Text>
          </View>
          <Switch
            value={backgroundEnabled}
            onValueChange={handleToggleBackground}
            trackColor={{ false: colors.surfaceSubtle, true: colors.bullish }}
          />
        </View>

        <View style={styles.divider} />

        <TouchableOpacity style={styles.settingRow} onPress={openBatterySettings}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.settingTitle}>Battery settings</Text>
            <Text style={styles.settingSub}>Set QStrategy to Unrestricted so Android does not stop it</Text>
          </View>
          <Text style={styles.settingTitle}>Open</Text>
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

      {/* APP VERSION & UPDATES */}
      <Text style={styles.sectionHeader}>APP VERSION & UPDATES</Text>
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View>
            <Text style={styles.gatewayTitle}>QStrategy Terminal</Text>
            <Text style={styles.gatewaySub}>
              Installed: v{currentAppVer.version} (Build {currentAppVer.versionCode})
            </Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              updateStatus === 'AVAILABLE'
                ? styles.statusBadgeOnline
                : styles.themeModeBadge,
            ]}
          >
            <Text
              style={[
                styles.statusBadgeText,
                updateStatus === 'AVAILABLE'
                  ? styles.textBullish
                  : { color: colors.cyan },
              ]}
            >
              {updateStatus === 'CHECKING'
                ? 'CHECKING...'
                : updateStatus === 'AVAILABLE'
                ? 'UPDATE READY'
                : updateStatus === 'UP_TO_DATE'
                ? 'LATEST'
                : 'CURRENT'}
            </Text>
          </View>
        </View>

        {updateInfo?.updateAvailable && (
          <View style={styles.updateAvailableBanner}>
            <Text style={styles.updateAvailableTitle}>
              🚀 New Version v{updateInfo.latestVersion} Available!
            </Text>
            <Text style={styles.updateAvailableDesc}>
              {updateInfo.releaseNotes}
            </Text>
            <TouchableOpacity
              style={styles.updateDownloadBtn}
              onPress={() => appUpdateService.openApkDownload(updateInfo.apkDownloadUrl)}
              activeOpacity={0.8}
            >
              <Text style={styles.updateDownloadBtnText}>
                ⬇️ Download & Install Update (APK)
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={styles.checkUpdateBtn}
          onPress={handleManualCheckUpdate}
          disabled={isCheckingUpdate}
          activeOpacity={0.7}
        >
          {isCheckingUpdate ? (
            <ActivityIndicator size="small" color={colors.cyan} />
          ) : (
            <Text style={styles.checkUpdateBtnText}>🔄 Check for Updates Now</Text>
          )}
        </TouchableOpacity>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Manifest Source:</Text>
          <Text style={[styles.infoVal, { color: colors.textSecondary }]}>
            GitHub (main/app.json)
          </Text>
        </View>
      </View>

      {/* TEST & DIAGNOSTICS */}
      <Text style={styles.sectionHeader}>TEST & DIAGNOSTICS</Text>

      <View style={styles.card}>
        <TouchableOpacity style={styles.testBtn} onPress={handleTestNotification}>
          <Text style={styles.testBtnText}>🔔 Send Test BUY Signal Notification</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.testBtn}
          onPress={() =>
            Alert.alert(
              `Prev-close log (${prevCloseBook.conflictCount()} conflicts)`,
              prevCloseBook.formatLog(15)
            )
          }
        >
          <Text style={styles.testBtnText}>🧾 Show Previous-Close Diagnostics</Text>
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

const useThemedStyles = createThemedStyles((colors) => ({
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
  themeModeBadge: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.borderActive,
  },
  themeSelectorGroup: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  themeOptionBtn: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeOptionBtnActive: {
    backgroundColor: colors.surfaceHover,
    borderColor: colors.borderActive,
    borderWidth: 1.5,
  },
  themeOptionIcon: {
    fontSize: 18,
    marginBottom: 4,
  },
  themeOptionText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  themeOptionTextActive: {
    color: colors.textPrimary,
    fontWeight: '800',
  },
  themeOptionSub: {
    color: colors.textMuted,
    fontSize: 9,
    marginTop: 2,
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
  warningBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 6,
    padding: 8,
    marginTop: 6,
  },
  warningText: {
    color: '#F87171',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
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
  updateAvailableBanner: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderWidth: 1,
    borderColor: colors.bullish,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  updateAvailableTitle: {
    color: colors.bullish,
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 4,
  },
  updateAvailableDesc: {
    color: '#CBD5E1',
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 10,
  },
  updateDownloadBtn: {
    backgroundColor: colors.bullish,
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: 'center',
  },
  updateDownloadBtnText: {
    color: '#080A0F',
    fontSize: 12,
    fontWeight: '800',
  },
  checkUpdateBtn: {
    backgroundColor: colors.surfaceHover,
    borderRadius: 6,
    paddingVertical: 11,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  checkUpdateBtnText: {
    color: colors.cyan,
    fontSize: 12,
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
}));

