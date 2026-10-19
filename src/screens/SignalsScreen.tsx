import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { colors } from '../theme/colors';
import { useRadarStore } from '../store/useRadarStore';
import { strategyRegistry } from '../strategies';
import { StrategyCategory, StrategyContext } from '../strategies/types';
import { LiveOptionChainModal } from '../components/options/LiveOptionChainModal';
import { OobtstDetailModal } from '../components/strategies/OobtstDetailModal';
import { BreakoutDetailModal } from '../components/strategies/BreakoutDetailModal';
import { dhanDirectService } from '../services/dhanDirectService';
import * as Haptics from 'expo-haptics';

export function SignalsScreen() {
  const {
    stocks,
    marketStatus,
    istTime,
    niftySpot,
    oobtstState,
    niftyBreakout180,
    signalsTodayCount,
    netPointsCaptured,
    isRefreshing,
    refreshAll,
  } = useRadarStore();

  const [categoryFilter, setCategoryFilter] = useState<StrategyCategory | 'ALL'>('ALL');
  const [optionChainVisible, setOptionChainVisible] = useState(false);
  const [oobtstModalVisible, setOobtstModalVisible] = useState(false);
  const [breakoutModalVisible, setBreakoutModalVisible] = useState(false);

  const handleRefresh = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAll(true);
  };

  const handleOpenBroker = (symbol: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dhanDirectService.launchDhanApp(symbol);
  };

  const activeSpot = niftySpot || 23146.15;
  const ctx: StrategyContext = {
    istTime,
    marketStatus,
    niftySpot: activeSpot,
    stocks,
    oobtstLiveState: oobtstState || undefined,
    breakout180LiveState: niftyBreakout180 || undefined,
  };

  const allPlugins = strategyRegistry.getAll();
  const filteredPlugins = categoryFilter === 'ALL'
    ? allPlugins
    : allPlugins.filter((p) => p.category === categoryFilter);

  return (
    <View style={styles.container}>
      {/* KPI Bar */}
      <View style={styles.kpiContainer}>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>ACTIVE STRATEGIES</Text>
          <Text style={styles.kpiValue}>{allPlugins.length}</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>SIGNALS TODAY</Text>
          <Text style={[styles.kpiValue, { color: colors.bullish }]}>{signalsTodayCount}</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>NET PTS CAPTURED</Text>
          <Text style={[styles.kpiValue, { color: colors.cyan }]}>
            {netPointsCaptured >= 0 ? `+${netPointsCaptured.toFixed(1)}` : netPointsCaptured.toFixed(1)}
          </Text>
        </View>
      </View>

      {/* Live Option Chain Quick Action Banner */}
      <View style={styles.liveOptionBanner}>
        <View>
          <Text style={styles.optionBannerTitle}>NIFTY Live Option Chain</Text>
          <Text style={styles.optionBannerSub}>Live ATM/ITM/OTM Strikes, OI & PCR Matrix</Text>
        </View>
        <TouchableOpacity
          style={styles.openChainBtn}
          onPress={() => {
            Haptics.selectionAsync();
            setOptionChainVisible(true);
          }}
        >
          <Text style={styles.openChainBtnText}>📊 View Chain</Text>
        </TouchableOpacity>
      </View>

      {/* Category Filter Chips */}
      <View style={styles.filterBar}>
        <TouchableOpacity
          style={[styles.chip, categoryFilter === 'ALL' && styles.chipActive]}
          onPress={() => setCategoryFilter('ALL')}
        >
          <Text style={[styles.chipText, categoryFilter === 'ALL' && styles.chipTextActive]}>
            All ({allPlugins.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.chip, categoryFilter === 'EQUITY_RADAR' && styles.chipActive]}
          onPress={() => setCategoryFilter('EQUITY_RADAR')}
        >
          <Text style={[styles.chipText, categoryFilter === 'EQUITY_RADAR' && styles.chipTextActive]}>
            📊 20D Volume
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.chip, categoryFilter === 'INDEX_OPTIONS' && styles.chipActive]}
          onPress={() => setCategoryFilter('INDEX_OPTIONS')}
        >
          <Text style={[styles.chipText, categoryFilter === 'INDEX_OPTIONS' && styles.chipTextActive]}>
            🌙 09:20 OOBTST
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.chip, categoryFilter === 'MOMENTUM_BREAKOUT' && styles.chipActive]}
          onPress={() => setCategoryFilter('MOMENTUM_BREAKOUT')}
        >
          <Text style={[styles.chipText, categoryFilter === 'MOMENTUM_BREAKOUT' && styles.chipTextActive]}>
            🚀 9:25 Breakout
          </Text>
        </TouchableOpacity>
      </View>

      {/* Dynamic Pluggable Strategy Cards Stream */}
      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.bullish}
            colors={[colors.bullish]}
          />
        }
      >
        <Text style={styles.sectionHeader}>REGISTERED QUANTITATIVE STRATEGIES</Text>

        {filteredPlugins.map((plugin) => {
          const state = plugin.evaluate(ctx);
          return (
            <View key={plugin.id}>
              {plugin.renderCard({
                state,
                onOpenBroker: handleOpenBroker,
                onViewDetails: (strategyId) => {
                  if (strategyId === 'NIFTY_OVERNIGHT') {
                    setOobtstModalVisible(true);
                  } else if (strategyId === 'NIFTY_BREAKOUT_180') {
                    setBreakoutModalVisible(true);
                  }
                },
              })}
            </View>
          );
        })}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Live Option Chain Modal */}
      <LiveOptionChainModal
        visible={optionChainVisible}
        ticker="NIFTY"
        spotPrice={activeSpot}
        strikeStep={50}
        onClose={() => setOptionChainVisible(false)}
      />

      {/* 3-Step OOBTST Strategy Detail Modal */}
      <OobtstDetailModal
        visible={oobtstModalVisible}
        onClose={() => setOobtstModalVisible(false)}
        istTime={istTime}
        stepDetails={allPlugins.find((p) => p.id === 'NIFTY_OVERNIGHT')?.evaluate(ctx).stepDetails}
      />

      {/* 3-Step 09:25 ₹180 Breakout Strategy Detail Modal */}
      <BreakoutDetailModal
        visible={breakoutModalVisible}
        onClose={() => setBreakoutModalVisible(false)}
        istTime={istTime}
        data={niftyBreakout180}
        niftySpot={activeSpot}
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
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  kpiValue: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  liveOptionBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.2)',
  },
  optionBannerTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  optionBannerSub: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 1,
  },
  openChainBtn: {
    backgroundColor: colors.cyan,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  openChainBtnText: {
    color: colors.obsidian,
    fontSize: 11,
    fontWeight: '800',
  },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: 6,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  chipActive: {
    backgroundColor: colors.bullishGlow,
    borderColor: colors.bullish,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.bullish,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  sectionHeader: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 10,
  },
});
