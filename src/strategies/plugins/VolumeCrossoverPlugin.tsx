import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BaseStrategyPlugin, StrategyContext, StrategySignalOutput } from '../types';
import { useTheme, createThemedStyles } from '../../theme';

export const VolumeCrossoverPlugin: BaseStrategyPlugin = {
  id: '20D_CROSSOVER',
  name: '20-Day Cumulative Volume Crossover',
  tagline: 'Institutional Accumulation Breakout Screener',
  icon: '📊',
  category: 'EQUITY_RADAR',
  executionStyle: 'CONTINUOUS_SCREENER',
  operatingWindow: {
    startIST: '09:16:00',
    endIST: '15:30:00',
    isOvernightAllowed: false,
  },

  evaluate: (ctx: StrategyContext): StrategySignalOutput => {
    const isClosed = ctx.marketStatus === 'CLOSED' || ctx.marketStatus === 'POST_MARKET';
    const isPreMarket = ctx.marketStatus === 'PRE_MARKET' || ctx.marketStatus === 'STABILIZING';

    // Before market opens (09:00 - 09:15), continuous session volume has not started yet
    if (isPreMarket) {
      return {
        status: 'ACTIVE',
        statusBadgeText: 'PRE-MARKET (OPENS 09:15)',
        badgeTone: 'warning',
        headline: 'Pre-market session active. Monitoring 55+ F&O stocks for volume accumulation at 09:15 open.',
        primaryMetricLabel: 'CROSSED / NEAR 80%',
        primaryMetricValue: '0 / 0',
        target: '1:2 R:R (+40% Option / +2% Spot) & π% Targets',
        stopLoss: '-20% Option / -1% Spot (TSL BE @ +1R)',
        invariantNotice: '⚡ Monotonic Latch: Trigger is 1-way per stock. Bullish filter enforces LTP ≥ Day Open & Change ≥ 0%.',
        lastUpdated: ctx.istTime,
        legs: undefined,
      };
    }

    const crossedStocks = ctx.stocks.filter((s) => s.hasCrossed20D && s.todayTradedShares > 0);
    const nearStocks = ctx.stocks.filter((s) => !s.hasCrossed20D && s.todayTradedShares > 0 && s.volumeRatio >= 0.8);
    const bullishCrossed = crossedStocks.filter((s) => s.crossoverDirection === 'BULLISH' || (s.spotPrice >= s.dayOpen && s.percentChange >= 0));

    const topCrossed = bullishCrossed[0] || crossedStocks[0];
    const statusText = isClosed
      ? (bullishCrossed.length > 0
          ? `EOD: ${bullishCrossed.length} CROSSED`
          : nearStocks.length > 0
          ? `EOD: ${nearStocks.length} NEAR 80%`
          : 'EOD DATA LOADED')
      : (bullishCrossed.length > 0
          ? `${bullishCrossed.length} STOCKS CROSSED`
          : nearStocks.length > 0
          ? `${nearStocks.length} NEAR CROSS (>80%)`
          : 'SCANNING 55+ STOCKS');

    const headline = topCrossed
      ? `Top Breakout: ${topCrossed.ticker} @ ₹${topCrossed.spotPrice.toFixed(2)} (${topCrossed.percentChange >= 0 ? '+' : ''}${topCrossed.percentChange}%) • Vol: ${(topCrossed.volumeRatio * 100).toFixed(0)}%`
      : isClosed
      ? `EOD Scan: Monitoring 55+ F&O stocks (${ctx.stocks.length} loaded). Cumulative volume updated from Dhan.`
      : 'Monitoring 55+ F&O stocks for cumulative volume exceeding 20D average';

    return {
      status: bullishCrossed.length > 0 ? 'TRIGGERED' : nearStocks.length > 0 ? 'ARMED' : 'ACTIVE',
      statusBadgeText: statusText,
      badgeTone: bullishCrossed.length > 0 ? 'bullish' : nearStocks.length > 0 ? 'warning' : isClosed ? 'cyan' : 'warning',
      headline,
      primaryMetricLabel: 'CROSSED / NEAR 80%',
      primaryMetricValue: `${bullishCrossed.length} / ${nearStocks.length}`,
      target: '1:2 R:R (+40% Option / +2% Spot) & π% Targets',
      stopLoss: '-20% Option / -1% Spot (TSL BE @ +1R)',
      invariantNotice: isClosed
        ? '🌙 Session Closed • Showing Dhan EOD volume & institutional accumulation baselines.'
        : '⚡ Monotonic Latch: Trigger is 1-way per stock. Bullish filter enforces LTP ≥ Day Open & Change ≥ 0%.',
      lastUpdated: ctx.istTime,
      legs: topCrossed
        ? [
            {
              type: 'CE',
              symbol: `${topCrossed.ticker} ${Math.round(topCrossed.spotPrice / (topCrossed.strikeStep || 20)) * (topCrossed.strikeStep || 20)} CE`,
              currentLtp: 0,
              status: 'ACTIVE',
            },
          ]
        : undefined,
    };
  },

  renderCard: (props) => <VolumeCrossoverCard {...props} />,
};

function VolumeCrossoverCard({ state, onOpenBroker }: { state: StrategySignalOutput; onOpenBroker: (symbol: string) => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const isTriggered = state.status === 'TRIGGERED';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.icon}>📊</Text>
          <View>
            <Text style={styles.title}>20-Day Volume Crossover Screener</Text>
            <Text style={styles.sub}>Institutional Accumulation (Today Vol ≥ 20D Avg)</Text>
          </View>
        </View>
        <View style={[styles.badge, { backgroundColor: isTriggered ? colors.bullishGlow : colors.warningGlow }]}>
          <Text style={[styles.badgeText, { color: isTriggered ? colors.bullish : colors.warning }]}>
            {state.statusBadgeText}
          </Text>
        </View>
      </View>

      {/* Highlight Banner */}
      <View style={styles.headlineBox}>
        <Text style={styles.headlineText}>{state.headline}</Text>
      </View>

      {/* Parameters Grid */}
      <View style={styles.metricsBox}>
        <View style={styles.metricItem}>
          <Text style={styles.metricLabel}>CONFIRMED CROSSED</Text>
          <Text style={[styles.metricVal, { color: colors.bullish }]}>{state.primaryMetricValue}</Text>
        </View>
        <View style={styles.metricItem}>
          <Text style={styles.metricLabel}>TARGET RULE</Text>
          <Text style={[styles.metricVal, { color: colors.cyan }]}>1:2 R:R (+40%)</Text>
        </View>
        <View style={styles.metricItem}>
          <Text style={styles.metricLabel}>STOP LOSS (TSL)</Text>
          <Text style={[styles.metricVal, { color: colors.bearish }]}>-20% (BE @ +1R)</Text>
        </View>
      </View>

      {state.invariantNotice && (
        <View style={styles.noticeBox}>
          <Text style={styles.noticeText}>{state.invariantNotice}</Text>
        </View>
      )}

      {state.legs && state.legs.length > 0 && (
        <View style={styles.topStockRow}>
          <Text style={styles.topStockLabel}>Recommended ATM Call:</Text>
          <TouchableOpacity onPress={() => onOpenBroker(state.legs![0].symbol)}>
            <Text style={styles.brokerLink}>
              {state.legs![0].symbol} {state.legs![0].currentLtp > 0 ? `(₹${state.legs![0].currentLtp.toFixed(2)})` : ''} ↗
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.footer}>
        <Text style={styles.footerNote}>Continuous Scan: 09:16:00 – 15:30:00 IST</Text>
        <Text style={[styles.viewRadarText, { color: colors.bullish }]}>Switch to Tab 2: Radar 📡</Text>
      </View>
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
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
  headlineBox: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 10,
  },
  headlineText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  metricsBox: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 10,
  },
  metricItem: {
    flex: 1,
    alignItems: 'center',
  },
  metricLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    marginBottom: 2,
  },
  metricVal: {
    fontSize: 12,
    fontWeight: '700',
  },
  noticeBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 10,
  },
  noticeText: {
    color: colors.bullish,
    fontSize: 10,
    fontWeight: '600',
  },
  topStockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    padding: 8,
    borderRadius: 6,
    marginBottom: 10,
  },
  topStockLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  brokerLink: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
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
  viewRadarText: {
    fontSize: 11,
    fontWeight: '700',
  },
}));
