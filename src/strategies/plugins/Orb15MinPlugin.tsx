import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BaseStrategyPlugin, StrategyContext, StrategySignalOutput } from '../types';
import { colors } from '../../theme/colors';

export const Orb15MinPlugin: BaseStrategyPlugin = {
  id: 'ORB_15MIN',
  name: 'NIFTY 15-Min ORB Breakout',
  tagline: 'Opening Range (09:15–09:30) Breakout System',
  icon: '⏱️',
  category: 'MOMENTUM_BREAKOUT',
  executionStyle: 'CANDLE_BREAKOUT',
  operatingWindow: {
    startIST: '09:30:00',
    endIST: '11:30:00',
    isOvernightAllowed: false,
  },

  evaluate: (ctx: StrategyContext): StrategySignalOutput => {
    return {
      status: 'ARMED',
      statusBadgeText: 'ORB RANGE LOCKED',
      badgeTone: 'warning',
      headline: 'Range: High ₹24,890 • Low ₹24,810 (80 pts Range)',
      primaryMetricLabel: 'BREAKOUT TRIGGER',
      primaryMetricValue: '> 24890 (CE) or < 24810 (PE)',
      target: '1:2 R:R (160 pts)',
      stopLoss: 'Range Midpoint (₹24,850)',
      invariantNotice: '⚡ 15-Min Bar (09:15–09:30) defines session boundary. Trade only on 5-min candle close outside range.',
      lastUpdated: ctx.istTime,
      legs: [
        {
          type: 'CE',
          symbol: 'NIFTY 24900 CE',
          strike: 24900,
          currentLtp: 112.40,
          status: 'ACTIVE',
        },
        {
          type: 'PE',
          symbol: 'NIFTY 24800 PE',
          strike: 24800,
          currentLtp: 98.60,
          status: 'ACTIVE',
        },
      ],
    };
  },

  renderCard: ({ state, onOpenBroker }) => {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Text style={styles.icon}>⏱️</Text>
            <View>
              <Text style={styles.title}>15-Min Opening Range Breakout (ORB)</Text>
              <Text style={styles.sub}>High/Low Range: 09:15 – 09:30 IST</Text>
            </View>
          </View>
          <View style={[styles.badge, { backgroundColor: colors.warningGlow }]}>
            <Text style={[styles.badgeText, { color: colors.warning }]}>{state.statusBadgeText}</Text>
          </View>
        </View>

        <View style={styles.rangeBox}>
          <View style={styles.rangeItem}>
            <Text style={styles.rangeLabel}>ORB HIGH (BUY CE TRIGGER)</Text>
            <TouchableOpacity onPress={() => onOpenBroker('NIFTY 24900 CE')}>
              <Text style={[styles.rangeVal, { color: colors.bullish }]}>₹24,890.00 ↗</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.rangeItem}>
            <Text style={styles.rangeLabel}>ORB LOW (BUY PE TRIGGER)</Text>
            <TouchableOpacity onPress={() => onOpenBroker('NIFTY 24800 PE')}>
              <Text style={[styles.rangeVal, { color: colors.bearish }]}>₹24,810.00 ↗</Text>
            </TouchableOpacity>
          </View>
        </View>

        {state.invariantNotice && (
          <View style={styles.noticeBox}>
            <Text style={styles.noticeText}>{state.invariantNotice}</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text style={styles.footerNote}>SL: Range Mid (₹24,850) | Target: 1:2 R:R</Text>
          <Text style={[styles.statusText, { color: colors.warning }]}>MONITORING</Text>
        </View>
      </View>
    );
  },
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 14,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    fontSize: 20,
    marginRight: 8,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  sub: {
    color: colors.textMuted,
    fontSize: 11,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  rangeBox: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 10,
    gap: 8,
  },
  rangeItem: {
    flex: 1,
    alignItems: 'center',
  },
  rangeLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    marginBottom: 2,
  },
  rangeVal: {
    fontSize: 13,
    fontWeight: '700',
  },
  noticeBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.25)',
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 10,
  },
  noticeText: {
    color: colors.warning,
    fontSize: 10,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  footerNote: {
    color: colors.textMuted,
    fontSize: 11,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
  },
});
