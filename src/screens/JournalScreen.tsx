import React, { useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ScrollView, TouchableOpacity } from 'react-native';
import { useTheme, createThemedStyles } from '../theme';
import { useRadarStore } from '../store/useRadarStore';
import { SignalJournalItem } from '../types/mobile';
import { FinancialValue } from '../components/common/FinancialValue';
import { StatusBadge } from '../components/common/StatusBadge';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1] ?? ''}`;
}

export function JournalScreen(): React.JSX.Element {
  const styles = useThemedStyles();
  const todayJournal = useRadarStore((s) => s.journal);
  const todayNetPoints = useRadarStore((s) => s.netPointsCaptured);
  const sessionDate = useRadarStore((s) => s.sessionDate);
  const availableDates = useRadarStore((s) => s.availableJournalDates);
  const selectedDate = useRadarStore((s) => s.selectedJournalDate);
  const historicalJournal = useRadarStore((s) => s.historicalJournal);
  const fetchAvailableJournalDates = useRadarStore((s) => s.fetchAvailableJournalDates);
  const selectJournalDate = useRadarStore((s) => s.selectJournalDate);

  useEffect(() => {
    fetchAvailableJournalDates().catch(() => {});
  }, [fetchAvailableJournalDates, sessionDate]);

  const isHistorical = selectedDate !== null;
  const journal = isHistorical ? historicalJournal : todayJournal;
  const netPointsCaptured = isHistorical
    ? historicalJournal.reduce((sum, j) => sum + (j.pnlPoints ?? 0), 0)
    : todayNetPoints;

  // Dynamic SEBI-compliant Win Rate calculation from real journal executions (Zero Fabrication)
  const completedTrades = journal.filter(
    (j) => j.outcome === 'WIN' || j.outcome === 'LOSS' || j.outcome === 'TIME_EXIT'
  );
  const winningTrades = completedTrades.filter(
    (j) => j.outcome === 'WIN' || (j.pnlPoints !== undefined && j.pnlPoints > 0)
  );
  const winRate =
    completedTrades.length > 0
      ? (winningTrades.length / completedTrades.length) * 100
      : null;

  const renderJournalItem = ({ item }: { item: SignalJournalItem }) => {
    const isBuy = item.signalType === 'BUY';

    return (
      <View style={styles.journalCard}>
        <View style={styles.cardHeader}>
          <View>
            <View style={styles.tagRow}>
              <Text style={styles.strategyName}>{item.strategyName}</Text>
              <StatusBadge
                label={item.signalType}
                variant={isBuy ? 'bullish' : 'bearish'}
                size="sm"
              />
            </View>
            <Text style={styles.symbol}>{item.symbol}</Text>
          </View>

          <Text style={styles.timestamp}>{item.timestamp}</Text>
        </View>

        <View style={styles.pricesRow}>
          <View style={styles.priceItem}>
            <Text style={styles.priceLabel}>Entry: </Text>
            <FinancialValue
              value={item.entryPrice}
              format="currency"
              size="sm"
              colorize={false}
            />
          </View>
          {item.stopLoss !== undefined && (
            <View style={styles.priceItem}>
              <Text style={styles.priceLabel}>SL: </Text>
              <FinancialValue
                value={item.stopLoss}
                format="currency"
                size="sm"
                colorize={true}
              />
            </View>
          )}
          {item.target !== undefined && (
            <View style={styles.priceItem}>
              <Text style={styles.priceLabel}>Target: </Text>
              <FinancialValue
                value={item.target}
                format="currency"
                size="sm"
                colorize={true}
              />
            </View>
          )}
        </View>

        {Boolean(item.notes) && <Text style={styles.notes}>{item.notes}</Text>}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {availableDates.length > 0 && (
        <View style={styles.dateStripWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dateStrip}>
            <TouchableOpacity
              style={[styles.datePill, !isHistorical && styles.datePillActive]}
              onPress={() => selectJournalDate(null)}
            >
              <Text style={[styles.datePillText, !isHistorical && styles.datePillTextActive]}>Today</Text>
            </TouchableOpacity>
            {availableDates.map((date) => (
              <TouchableOpacity
                key={date}
                style={[styles.datePill, selectedDate === date && styles.datePillActive]}
                onPress={() => selectJournalDate(date)}
              >
                <Text style={[styles.datePillText, selectedDate === date && styles.datePillTextActive]}>
                  {formatDateLabel(date)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* KPI Summary Header */}
      <View style={styles.kpiContainer}>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>TOTAL SIGNALS</Text>
          <Text style={styles.kpiValue}>{journal.length}</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>THEORETICAL PTS</Text>
          <FinancialValue
            value={netPointsCaptured}
            format="points"
            size="lg"
            weight="extrabold"
            showSign={true}
            colorize={true}
          />
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>WIN RATE (REAL)</Text>
          <FinancialValue
            value={winRate}
            format="percent"
            size="lg"
            weight="extrabold"
            fallback="—"
            colorize={winRate !== null}
          />
        </View>
      </View>

      <Text style={styles.sectionHeader}>CHRONOLOGICAL SIGNAL AUDIT TRAIL</Text>

      {journal.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📜</Text>
          <Text style={styles.emptyTitle}>{isHistorical ? 'No Signals Logged' : 'No Signals Logged Today'}</Text>
          <Text style={styles.emptySubtitle}>
            Algo signal executions and trailing stop-loss milestones from 20D Crossover, 09:20 Strangle, and 180 Breakout will automatically persist here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={journal}
          keyExtractor={(item) => item.id}
          renderItem={renderJournalItem}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors, theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
  },
  dateStripWrap: {
    backgroundColor: theme.colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  dateStrip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: 8,
  },
  datePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    backgroundColor: theme.colors.card,
  },
  datePillActive: {
    borderColor: theme.colors.textPrimary,
  },
  datePillText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.xs,
    fontWeight: theme.typography.weights.semibold,
  },
  datePillTextActive: {
    color: theme.colors.textPrimary,
  },
  kpiContainer: {
    flexDirection: 'row',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  kpiCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  kpiLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.micro,
    fontWeight: theme.typography.weights.semibold,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  kpiValue: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.sizes.lg,
    fontWeight: theme.typography.weights.extrabold,
    fontFamily: theme.typography.fontMono,
  },
  sectionHeader: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.xs,
    fontWeight: theme.typography.weights.bold,
    letterSpacing: 0.8,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.xs,
  },
  listContent: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: 24,
  },
  journalCard: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
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
    marginBottom: 4,
  },
  strategyName: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.xs,
    fontWeight: theme.typography.weights.bold,
  },
  symbol: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.sizes.md,
    fontWeight: theme.typography.weights.bold,
    fontFamily: theme.typography.fontMono,
  },
  timestamp: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.xs,
    fontFamily: theme.typography.fontMono,
  },
  pricesRow: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    marginTop: 4,
    alignItems: 'center',
  },
  priceItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  priceLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.sm,
  },
  notes: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.xs,
    marginTop: 6,
    fontStyle: 'italic',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
    minHeight: 320,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: theme.spacing.md,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.sizes.lg,
    fontWeight: theme.typography.weights.bold,
    marginBottom: theme.spacing.xs,
  },
  emptySubtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.sm,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
}));

