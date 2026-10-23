import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch } from 'react-native';
import { createThemedStyles, useTheme } from '../../theme';
import {
  defaultExecutionSettings,
  loadExecutionSettings,
  saveExecutionSettings,
} from '../../execution/executionSettings';
import { EXECUTABLE_STRATEGIES, type ExecutableStrategyId, type ExecutionMode, type ExecutionSettings } from '../../execution/types';

const STRATEGY_LABEL: Record<ExecutableStrategyId, string> = {
  NIFTY_BREAKOUT_180: 'NIFTY 09:25 ₹180 Breakout (intraday)',
  OOBTST_NIFTY: '09:20 OOBTST NIFTY (overnight)',
  OOBTST_SENSEX: '09:20 OOBTST SENSEX (overnight)',
};

/** Mode, kill switch, per-strategy switches and order limits. Paper mode records orders and sends nothing. */
export function ExecutionSettingsCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const [settings, setSettings] = useState<ExecutionSettings>(defaultExecutionSettings());
  const [limitText, setLimitText] = useState({ lots: '', orders: '', order: '', daily: '', buffer: '' });
  const [message, setMessage] = useState<string | null>(null);

  const syncText = (s: ExecutionSettings) =>
    setLimitText({
      lots: String(s.limits.maxLotsPerOrder),
      orders: String(s.limits.maxOrdersPerDay),
      order: String(s.limits.maxOrderValue),
      daily: String(s.limits.maxDailyValue),
      buffer: String(s.limitBufferPct),
    });

  useEffect(() => {
    loadExecutionSettings()
      .then((s) => {
        setSettings(s);
        syncText(s);
      })
      .catch(() => {});
  }, []);

  const apply = async (next: ExecutionSettings, note?: string) => {
    const saved = await saveExecutionSettings(next);
    setSettings(saved);
    syncText(saved);
    setMessage(note ?? null);
  };

  const setMode = (mode: ExecutionMode) => apply({ ...settings, mode });
  const setKill = (killSwitch: boolean) =>
    apply({ ...settings, killSwitch }, killSwitch ? 'Kill switch on: every signal is blocked.' : 'Kill switch off.');
  const setStrategy = (id: ExecutableStrategyId, patch: Partial<{ enabled: boolean; lots: number }>) =>
    apply({ ...settings, strategies: { ...settings.strategies, [id]: { ...settings.strategies[id], ...patch } } });

  const saveLimits = () =>
    apply(
      {
        ...settings,
        limitBufferPct: Number(limitText.buffer),
        limits: {
          maxLotsPerOrder: Number(limitText.lots),
          maxOrdersPerDay: Number(limitText.orders),
          maxOrderValue: Number(limitText.order),
          maxDailyValue: Number(limitText.daily),
        },
      },
      'Limits saved.'
    );

  const modeBtn = (mode: ExecutionMode, label: string) => (
    <TouchableOpacity
      style={[styles.modeBtn, settings.mode === mode && styles.modeBtnActive]}
      onPress={() => setMode(mode)}
      testID={`mode-${mode}`}
    >
      <Text style={styles.modeText}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Mode</Text>
      <View style={styles.row}>
        {modeBtn('OFF', 'Off')}
        {modeBtn('PAPER', 'Paper')}
        {modeBtn('CONFIRM', 'Confirm')}
      </View>
      <Text style={styles.sub}>
        Paper records the order each signal would place and sends nothing. Confirm turns each signal into a
        proposal; a real order is sent only after you confirm it and live trading is armed.
      </Text>

      <View style={styles.rowBetween}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={styles.title}>Kill switch</Text>
          <Text style={styles.sub}>Blocks every signal immediately and records why.</Text>
        </View>
        <Switch
          value={settings.killSwitch}
          onValueChange={setKill}
          trackColor={{ false: colors.surfaceSubtle, true: colors.bearish }}
          testID="kill-switch"
        />
      </View>

      <Text style={[styles.label, { marginTop: 12 }]}>Strategies</Text>
      {EXECUTABLE_STRATEGIES.map((id) => (
        <View key={id} style={styles.strategyRow}>
          <View style={styles.rowBetween}>
            <Text style={[styles.title, { flex: 1, paddingRight: 8 }]}>{STRATEGY_LABEL[id]}</Text>
            <Switch
              value={settings.strategies[id].enabled}
              onValueChange={(enabled) => setStrategy(id, { enabled })}
              trackColor={{ false: colors.surfaceSubtle, true: colors.bullish }}
              testID={`strategy-${id}`}
            />
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.sub}>Lots per order</Text>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={styles.stepBtn}
                onPress={() => setStrategy(id, { lots: Math.max(1, settings.strategies[id].lots - 1) })}
                testID={`lots-down-${id}`}
              >
                <Text style={styles.title}>-</Text>
              </TouchableOpacity>
              <Text style={styles.lotsText}>{settings.strategies[id].lots}</Text>
              <TouchableOpacity
                style={styles.stepBtn}
                onPress={() => setStrategy(id, { lots: settings.strategies[id].lots + 1 })}
                testID={`lots-up-${id}`}
              >
                <Text style={styles.title}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ))}
      <Text style={styles.sub}>The 20D volume screener stays alert-only.</Text>

      <Text style={[styles.label, { marginTop: 12 }]}>Limits</Text>
      {(
        [
          ['Max lots per order', 'lots'],
          ['Max orders per day', 'orders'],
          ['Max value per order (₹)', 'order'],
          ['Max value per day (₹)', 'daily'],
          ['Limit price buffer (%)', 'buffer'],
        ] as const
      ).map(([label, key]) => (
        <View key={key} style={styles.rowBetween}>
          <Text style={styles.sub}>{label}</Text>
          <TextInput
            style={styles.input}
            value={limitText[key]}
            onChangeText={(t) => setLimitText((prev) => ({ ...prev, [key]: t }))}
            keyboardType="decimal-pad"
            testID={`limit-${key}`}
          />
        </View>
      ))}
      <TouchableOpacity style={styles.saveBtn} onPress={saveLimits} testID="limits-save">
        <Text style={styles.saveText}>Save limits</Text>
      </TouchableOpacity>
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  card: { backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.cardBorder, padding: 14, marginBottom: 16 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 6 },
  title: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 6, flexShrink: 1 },
  tiny: { color: colors.textMuted, fontSize: 9 },
  modeBtn: { flex: 1, backgroundColor: colors.surfaceSubtle, borderRadius: 6, paddingVertical: 9, alignItems: 'center' },
  modeBtnActive: { backgroundColor: colors.surfaceHover, borderWidth: 1.5, borderColor: colors.borderActive },
  modeText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },
  strategyRow: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8, marginTop: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { backgroundColor: colors.surfaceSubtle, borderRadius: 6, width: 30, height: 28, alignItems: 'center', justifyContent: 'center' },
  lotsText: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', minWidth: 20, textAlign: 'center' },
  input: {
    width: 90,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    color: colors.textPrimary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    textAlign: 'right',
    fontSize: 13,
  },
  saveBtn: { backgroundColor: colors.bullish, borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 6 },
  saveText: { color: colors.obsidian, fontSize: 12, fontWeight: '800' },
  message: { color: colors.warning, fontSize: 11, marginTop: 8 },
}));
