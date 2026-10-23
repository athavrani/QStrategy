import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { createThemedStyles, useTheme } from '../../theme';
import { secureVault } from '../../services/SecureCredentialVault';
import { useOrdersStore } from '../../store/useOrdersStore';

/** Credentials for Dhan's sandbox (test) environment. They are stored apart from the live Dhan credentials. */
export function SandboxCredentialsCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const [clientId, setClientId] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    secureVault
      .getSandboxCredentials()
      .then((c) => {
        setClientId(c.clientId);
        setSaved(Boolean(c.clientId && c.token));
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    const id = clientId.trim();
    const tok = token.replace(/\s+/g, '');
    if (!id || tok.length < 20) {
      setMessage('Enter the sandbox client ID and the full sandbox access token.');
      return;
    }
    const authed = await secureVault.authenticateStrict('Authenticate to save the Dhan sandbox token');
    if (!authed) {
      setMessage('Biometric verification is required to save the sandbox token.');
      return;
    }
    await secureVault.saveSandboxCredentials(id, tok);
    setToken('');
    setSaved(true);
    setMessage('Sandbox credentials saved to the secure keystore.');
    await useOrdersStore.getState().init();
  };

  const clear = async () => {
    await secureVault.clearSandboxCredentials();
    setClientId('');
    setToken('');
    setSaved(false);
    setMessage('Sandbox credentials removed.');
    await useOrdersStore.getState().init();
  };

  return (
    <View style={styles.card}>
      <Text style={styles.sub}>
        Test orders go to Dhan's sandbox (sandbox.dhan.co), never to your live account. Generate a sandbox
        token at cloud.dhanhq.co and paste it here. It is separate from your live access token.
      </Text>
      <Text style={styles.label}>Sandbox client ID</Text>
      <TextInput
        style={styles.input}
        value={clientId}
        onChangeText={setClientId}
        placeholder="Client ID"
        placeholderTextColor={colors.textMuted}
        keyboardType="number-pad"
        autoCapitalize="none"
        testID="sandbox-client-id"
      />
      <Text style={styles.label}>Sandbox access token {saved ? '(saved, enter a new one to replace)' : ''}</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder={saved ? 'Saved' : 'Paste sandbox token'}
        placeholderTextColor={colors.textMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        testID="sandbox-token"
      />
      <View style={styles.row}>
        <TouchableOpacity style={styles.saveBtn} onPress={save} testID="sandbox-save">
          <Text style={styles.saveText}>Save sandbox token</Text>
        </TouchableOpacity>
        {saved ? (
          <TouchableOpacity style={styles.clearBtn} onPress={clear} testID="sandbox-clear">
            <Text style={styles.clearText}>Remove</Text>
          </TouchableOpacity>
        ) : null}
      </View>
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
  row: { flexDirection: 'row', gap: 8 },
  saveBtn: { flex: 1, backgroundColor: colors.bullish, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  saveText: { color: colors.obsidian, fontSize: 12, fontWeight: '800' },
  clearBtn: { backgroundColor: colors.surfaceSubtle, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  clearText: { color: colors.bearish, fontSize: 12, fontWeight: '700' },
  message: { color: colors.warning, fontSize: 11, marginTop: 8 },
}));
