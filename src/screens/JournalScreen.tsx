import React from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { colors } from '../theme/colors';
import { useRadarStore } from '../store/useRadarStore';
import { SignalJournalItem } from '../types/mobile';

export function JournalScreen() {
  const { journal, netPointsCaptured } = useRadarStore();

  const renderJournalItem = ({ item }: { item: SignalJournalItem }) => {
    const isBuy = item.signalType === 'BUY';

    return (
      <View style={styles.journalCard}>
        <View style={styles.cardHeader}>
          <View>
            <View style={styles.tagRow}>
              <Text style={styles.strategyName}>{item.strategyName}</Text>
              <View style={[styles.signalBadge, { backgroundColor: isBuy ? colors.bullishGlow : colors.bearishGlow }]}>
                <Text style={[styles.signalBadgeText, { color: isBuy ? colors.bullish : colors.bearish }]}>
                  {item.signalType}
                </Text>
              </View>
            </View>
            <Text style={styles.symbol}>{item.symbol}</Text>
          </View>

          <Text style={styles.timestamp}>{item.timestamp}</Text>
        </View>

        <View style={styles.pricesRow}>
          <Text style={styles.priceItem}>
            Entry: <Text style={styles.priceVal}>₹{item.entryPrice.toFixed(2)}</Text>
          </Text>
          {item.stopLoss && (
            <Text style={styles.priceItem}>
              SL: <Text style={[styles.priceVal, { color: colors.bearish }]}>₹{item.stopLoss.toFixed(2)}</Text>
            </Text>
          )}
          {item.target && (
            <Text style={styles.priceItem}>
              Target: <Text style={[styles.priceVal, { color: colors.bullish }]}>₹{item.target.toFixed(2)}</Text>
            </Text>
          )}
        </View>

        {item.notes && <Text style={styles.notes}>{item.notes}</Text>}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* KPI Summary */}
      <View style={styles.kpiContainer}>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>TOTAL SIGNALS</Text>
          <Text style={styles.kpiValue}>{journal.length}</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>THEORETICAL POINTS</Text>
          <Text style={[styles.kpiValue, { color: colors.cyan }]}>
            +{netPointsCaptured.toFixed(1)} pts
          </Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>WIN RATE EST.</Text>
          <Text style={[styles.kpiValue, { color: colors.bullish }]}>75.0%</Text>
        </View>
      </View>

      <Text style={styles.sectionHeader}>CHRONOLOGICAL SIGNAL AUDIT TRAIL</Text>

      <FlatList
        data={journal}
        keyExtractor={(item) => item.id}
        renderItem={renderJournalItem}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.obsidian,
  },
  kpiContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  kpiCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  kpiLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  kpiValue: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  sectionHeader: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 6,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 20,
  },
  journalCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  strategyName: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  signalBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  signalBadgeText: {
    fontSize: 9,
    fontWeight: '700',
  },
  symbol: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  timestamp: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  pricesRow: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: colors.surface,
    padding: 6,
    borderRadius: 4,
    marginBottom: 6,
  },
  priceItem: {
    color: colors.textMuted,
    fontSize: 11,
  },
  priceVal: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  notes: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },
});
