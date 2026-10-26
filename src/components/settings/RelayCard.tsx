import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { createThemedStyles, useTheme } from '../../theme';
import { secureVault } from '../../services/SecureCredentialVault';
import { relayService, type RelayConfig } from '../../services/relay/RelayService';

/** Connects this phone to the order relay that places live orders from a whitelisted static IP. */
export function RelayCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const [url, setUrl] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ip: string | null; match: boolean | null } | null>(null);

  useEffect(() => {
    relayService
      .getConfig()
      .then(setConfig)
      .catch(() => {});
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const res = await relayService.checkEgress();
    if (res && res.ok) setStatus({ ip: res.egressIp, match: res.match });
    else {
      setStatus(null);
      setMessage(res ? res.error : 'No relay is set up.');
    }
    setBusy(false);
  }, []);

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    const creds = await secureVault.getEffectiveCredentials();
    const res = await relayService.register({ url, inviteCode: invite, dhanClientId: creds.clientId, label: 'QStrategy phone' });
    setBusy(false);
    if (!res.ok) {
      setMessage(res.error);
      return;
    }
    setConfig(await relayService.getConfig());
    setInvite('');
    setMessage('Connected. Whitelist the relay IP with Dhan in the IP card below, then refresh it.');
  };

  const disconnect = async () => {
    await relayService.disconnect();
    setConfig(null);
    setStatus(null);
    setMessage('Disconnected. Live orders now go straight from this phone, so Dhan needs this phone IP whitelisted.');
  };

  const matchColor = status?.match === true ? colors.bullish : status?.match === false ? colors.bearish : colors.textMuted;

  return (
    <View style={styles.card}>
      <Text style={styles.sub}>
        The order relay sends your live orders to Dhan from one fixed IP, so orders keep working when your phone changes
        network. Ask the relay admin for the address and a single-use invite code. Your Dhan token is sent over HTTPS and
        is not stored on the relay.
      </Text>

      {config ? (
        <>
          <View style={styles.row}>
            <Text style={styles.label}>Relay</Text>
            <Text style={styles.value} testID="relay-url">{config.url}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Device</Text>
            <Text style={styles.value}>{config.deviceId}</Text>
          </View>
          {status ? (
            <View style={styles.row}>
              <Text style={styles.label}>Relay IP</Text>
              <Text style={[styles.value, { color: matchColor }]} testID="relay-ip">
                {status.ip ?? '-'}
                {status.match === true ? '  whitelisted' : status.match === false ? '  not whitelisted' : ''}
              </Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <TouchableOpacity style={styles.saveBtn} onPress={check} disabled={busy} testID="relay-check">
              {busy ? <ActivityIndicator color={colors.obsidian} /> : <Text style={styles.saveText}>Check relay</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.clearBtn} onPress={disconnect} testID="relay-disconnect">
              <Text style={styles.clearText}>Disconnect</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.label}>Relay address</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://relay.example.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="relay-url-input"
          />
          <Text style={styles.label}>Invite code</Text>
          <TextInput
            style={styles.input}
            value={invite}
            onChangeText={setInvite}
            placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            testID="relay-invite-input"
          />
          <TouchableOpacity style={styles.saveBtn} onPress={connect} disabled={busy} testID="relay-connect">
            {busy ? <ActivityIndicator color={colors.obsidian} /> : <Text style={styles.saveText}>Connect to relay</Text>}
          </TouchableOpacity>
        </>
      )}
      {message ? <Text style={styles.message}>{message}</Text> : null}
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
  sub: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 10 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  value: { color: colors.textPrimary, fontSize: 12, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
  input: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    color: colors.textPrimary,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
    fontSize: 13,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 },
  saveBtn: { flex: 1, backgroundColor: colors.bullish, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  saveText: { color: colors.obsidian, fontSize: 12, fontWeight: '800' },
  clearBtn: { backgroundColor: colors.surfaceSubtle, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11, justifyContent: 'center' },
  clearText: { color: colors.bearish, fontSize: 12, fontWeight: '700' },
  message: { color: colors.warning, fontSize: 11, marginTop: 8 },
}));
