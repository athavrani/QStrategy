import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { colors } from '../theme/colors';
import { useRadarStore } from '../store/useRadarStore';
import { StockRadarItem } from '../types/mobile';
import { TacticalStrikeModal } from '../components/radar/TacticalStrikeModal';
import { LiveOptionChainModal } from '../components/options/LiveOptionChainModal';
import * as Haptics from 'expo-haptics';

type FilterType = 'ALL' | 'NIFTY50' | 'SENSEX' | 'GREEN' | 'RED' | 'NEAR';

interface RadarScreenProps {
  onNavigateToSignals?: () => void;
}

// Helper to format shares in Indian numbering format (Lakhs & Crores)
function formatShares(val: number): string {
  if (val >= 10000000) return `${(val / 10000000).toFixed(2)} Cr`;
  if (val >= 100000) return `${(val / 100000).toFixed(2)} L`;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
  return val.toLocaleString('en-IN');
}

interface StockCardProps {
  item: StockRadarItem;
  onSelect: (item: StockRadarItem) => void;
}

// Memoized Card: Only re-renders if this specific stock's live tick values changed
const StockCard = React.memo(
  function StockCard({ item, onSelect }: StockCardProps) {
    const ratioPercent = Math.min(150, Math.round(item.volumeRatio * 100));
    const priceChangePct = (item.prevClose && item.prevClose > 0 && item.spotPrice > 0)
      ? +(((item.spotPrice - item.prevClose) / item.prevClose) * 100).toFixed(2)
      : item.percentChange;
    const isBullish = priceChangePct >= 0;
    const isPositive = priceChangePct > 0;
    const isNegative = priceChangePct < 0;
    const pctColor = isPositive ? colors.bullish : (isNegative ? colors.bearish : colors.textMuted);
    const formattedPriceChange = isPositive
      ? `+${priceChangePct.toFixed(2)}%`
      : `${priceChangePct.toFixed(2)}%`;

    let circleIcon = '⚪';
    let circleTone = colors.textMuted;
    let circleLabel = 'SCANNING';

    if (item.circleIndicator === 'GREEN') {
      circleIcon = '🟢';
      circleTone = colors.bullish;
      circleLabel = 'BUY (ACCUMULATION)';
    } else if (item.circleIndicator === 'RED') {
      circleIcon = '🔴';
      circleTone = colors.bearish;
      circleLabel = 'SELL (DISTRIBUTION)';
    } else if (item.circleIndicator === 'AMBER') {
      circleIcon = '🟡';
      circleTone = colors.warning;
      circleLabel = 'NEAR CROSS (80%)';
    }

    return (
      <TouchableOpacity
        style={[
          styles.stockCard,
          item.circleIndicator === 'GREEN' && styles.greenCardBorder,
          item.circleIndicator === 'RED' && styles.redCardBorder,
        ]}
        activeOpacity={0.7}
        onPress={() => onSelect(item)}
      >
        {/* Top Row: Circle Indicator, Ticker, Names, and LTP */}
        <View style={styles.cardHeader}>
          <View style={styles.leftGroup}>
            <Text style={styles.circleIcon}>{circleIcon}</Text>
            <View>
              <View style={styles.tickerRow}>
                <Text style={styles.ticker}>{item.ticker}</Text>
                <View style={styles.indexPillRow}>
                  {item.indices.map((idx) => (
                    <View key={idx} style={styles.indexPill}>
                      <Text style={styles.indexPillText}>{idx}</Text>
                    </View>
                  ))}
                </View>
              </View>
              <Text style={styles.companyName} numberOfLines={1}>{item.name}</Text>
            </View>
          </View>

          <View style={styles.priceGroup}>
            <Text style={styles.price}>₹{item.spotPrice.toFixed(2)}</Text>
            <Text style={[styles.percent, { color: pctColor }]}>
              {formattedPriceChange}
            </Text>
          </View>
        </View>

        {/* Middle Volume Metrics Comparison */}
        <View style={styles.volumeDetailsBox}>
          <View style={styles.volMetricCol}>
            <Text style={styles.volMetricLabel}>20D AVG VOLUME</Text>
            <Text style={styles.volMetricVal}>{formatShares(item.avg20DTradedShares)}</Text>
            <Text style={styles.exactSharesSub}>{item.avg20DTradedShares.toLocaleString('en-IN')} shares</Text>
          </View>

          <View style={styles.volDivider} />

          <View style={styles.volMetricCol}>
            <Text style={styles.volMetricLabel}>CURRENT DAY VOLUME</Text>
            <Text style={[styles.volMetricVal, { color: circleTone }]}>
              {formatShares(item.todayTradedShares)}
            </Text>
            <Text style={styles.exactSharesSub}>{item.todayTradedShares.toLocaleString('en-IN')} shares</Text>
          </View>

          <View style={styles.volDivider} />

          <View style={styles.volMetricCol}>
            <Text style={styles.volMetricLabel}>RATIO</Text>
            <Text style={[styles.volMetricVal, { color: circleTone }]}>{ratioPercent}%</Text>
            <Text style={styles.exactSharesSub}>of Benchmark</Text>
          </View>
        </View>

        {/* Progress Bar */}
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${Math.min(100, ratioPercent)}%`,
                backgroundColor: circleTone,
              },
            ]}
          />
        </View>

        {/* Card Footer Status */}
        <View style={styles.cardFooter}>
          <Text style={[styles.statusText, { color: circleTone }]}>
            {circleIcon} {circleLabel} {item.crossoverTime ? `@ ${item.crossoverTime}` : ''}
          </Text>
          <Text style={styles.tapNote}>Tap for ATM Option Strike ↗</Text>
        </View>
      </TouchableOpacity>
    );
  },
  (prev, next) =>
    prev.item.spotPrice === next.item.spotPrice &&
    prev.item.prevClose === next.item.prevClose &&
    prev.item.percentChange === next.item.percentChange &&
    prev.item.todayTradedShares === next.item.todayTradedShares &&
    prev.item.volumeRatio === next.item.volumeRatio &&
    prev.item.circleIndicator === next.item.circleIndicator
);

export function RadarScreen({ onNavigateToSignals }: RadarScreenProps) {
  // Fine-grained Zustand selectors to prevent unnecessary re-renders
  const stocks = useRadarStore((s) => s.stocks);
  const selectedStock = useRadarStore((s) => s.selectedStock);
  const tacticalStrike = useRadarStore((s) => s.tacticalStrike);
  const feedStatus = useRadarStore((s) => s.feedStatus);
  const lastTickTime = useRadarStore((s) => s.lastTickTime);
  const isRefreshing = useRadarStore((s) => s.isRefreshing);
  const refreshAll = useRadarStore((s) => s.refreshAll);
  const selectStock = useRadarStore((s) => s.selectStock);
  const clearSelectedStock = useRadarStore((s) => s.clearSelectedStock);

  const [filter, setFilter] = useState<FilterType>('ALL');
  const [search, setSearch] = useState('');
  const [chainStock, setChainStock] = useState<StockRadarItem | null>(null);

  const handleRefresh = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAll(true);
  }, [refreshAll]);

  const handleSelect = useCallback((stock: StockRadarItem) => {
    Haptics.selectionAsync();
    selectStock(stock.ticker);
  }, [selectStock]);

  const handleFilterPress = useCallback((f: FilterType) => {
    Haptics.selectionAsync();
    setFilter(f);
  }, []);

  // Memoized stock filtering: runs only when filter, search or stocks array changes
  const filteredStocks = useMemo(() => {
    const s = search.trim().toLowerCase();
    return stocks.filter((stock) => {
      if (s) {
        const matches =
          stock.ticker.toLowerCase().includes(s) ||
          stock.name.toLowerCase().includes(s) ||
          (stock.sector && stock.sector.toLowerCase().includes(s));
        if (!matches) return false;
      }

      if (filter === 'NIFTY50') return stock.indices.includes('NIFTY 50');
      if (filter === 'SENSEX') return stock.indices.includes('SENSEX');
      if (filter === 'GREEN') return stock.circleIndicator === 'GREEN';
      if (filter === 'RED') return stock.circleIndicator === 'RED';
      if (filter === 'NEAR') return stock.circleIndicator === 'AMBER';

      return true;
    });
  }, [stocks, search, filter]);

  // Single-pass O(N) counts calculation instead of 3 separate full-array .filter() passes
  const { greenCount, redCount, nearCount } = useMemo(() => {
    let green = 0;
    let red = 0;
    let near = 0;
    for (let i = 0; i < stocks.length; i++) {
      const ind = stocks[i].circleIndicator;
      if (ind === 'GREEN') green++;
      else if (ind === 'RED') red++;
      else if (ind === 'AMBER') near++;
    }
    return { greenCount: green, redCount: red, nearCount: near };
  }, [stocks]);

  const renderStockItem = useCallback(
    ({ item }: { item: StockRadarItem }) => (
      <StockCard item={item} onSelect={handleSelect} />
    ),
    [handleSelect]
  );

  const keyExtractor = useCallback((item: StockRadarItem) => item.ticker, []);

  return (
    <View style={styles.container}>
      {/* Top Navigation Row */}
      {onNavigateToSignals && (
        <View style={styles.topNavRow}>
          <TouchableOpacity
            style={styles.backToSignalsBtn}
            onPress={() => {
              Haptics.selectionAsync();
              onNavigateToSignals();
            }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.backToSignalsText}>← Back to Signals</Text>
          </TouchableOpacity>
          <Text style={styles.topNavTitle}>20D Volume Radar</Text>
        </View>
      )}

      {/* Feed Status Indicator */}
      <View style={styles.feedStatusBar}>
        <View style={styles.feedStatusLeft}>
          <View
            style={[
              styles.feedStatusDot,
              {
                backgroundColor:
                  feedStatus === 'ONLINE'
                    ? colors.bullish
                    : feedStatus === 'ERROR'
                    ? colors.bearish
                    : colors.warning,
              },
            ]}
          />
          <Text style={styles.feedStatusText}>
            {feedStatus === 'ONLINE'
              ? `🟢 DHAN LIVE STREAM (${lastTickTime || 'Streaming'})`
              : feedStatus === 'ERROR'
              ? '⚠️ DHAN STREAM RECONNECTING (Check Settings)'
              : '⚡ CONNECTING DHAN STREAMER...'}
          </Text>
        </View>
        <Text style={styles.feedCountText}>{filteredStocks.length} STOCKS</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search 60 SENSEX & NIFTY 50 Stocks (e.g. RELIANCE)..."
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="characters"
        />
      </View>

      {/* Index & Circle Filter Chips */}
      <View style={styles.filterBar}>
        <TouchableOpacity
          style={[styles.filterChip, filter === 'ALL' && styles.filterChipActive]}
          onPress={() => handleFilterPress('ALL')}
        >
          <Text style={[styles.filterText, filter === 'ALL' && styles.filterTextActive]}>
            All ({stocks.length})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'NIFTY50' && styles.filterChipActive]}
          onPress={() => handleFilterPress('NIFTY50')}
        >
          <Text style={[styles.filterText, filter === 'NIFTY50' && styles.filterTextActive]}>
            NIFTY 50
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'SENSEX' && styles.filterChipActive]}
          onPress={() => handleFilterPress('SENSEX')}
        >
          <Text style={[styles.filterText, filter === 'SENSEX' && styles.filterTextActive]}>
            SENSEX
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'GREEN' && styles.filterChipActiveGreen]}
          onPress={() => handleFilterPress('GREEN')}
        >
          <Text style={[styles.filterText, filter === 'GREEN' && styles.filterTextActiveGreen]}>
            🟢 Buy ({greenCount})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'RED' && styles.filterChipActiveRed]}
          onPress={() => handleFilterPress('RED')}
        >
          <Text style={[styles.filterText, filter === 'RED' && styles.filterChipActiveRed]}>
            🔴 Sell ({redCount})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'NEAR' && styles.filterChipActiveAmber]}
          onPress={() => handleFilterPress('NEAR')}
        >
          <Text style={[styles.filterText, filter === 'NEAR' && styles.filterTextActiveAmber]}>
            🟡 Near ({nearCount})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Screener Stock List */}
      <FlatList
        data={filteredStocks}
        keyExtractor={keyExtractor}
        renderItem={renderStockItem}
        contentContainerStyle={styles.listContent}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={true}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.bullish}
            colors={[colors.bullish]}
          />
        }
      />

      {/* Tactical Strike Modal */}
      <TacticalStrikeModal
        visible={!!selectedStock}
        stock={selectedStock}
        tactical={tacticalStrike}
        onClose={clearSelectedStock}
        onViewOptionChain={(s) => {
          clearSelectedStock();
          setTimeout(() => setChainStock(s), 50);
        }}
      />

      {/* Full Live Option Chain Matrix Modal */}
      <LiveOptionChainModal
        visible={!!chainStock}
        ticker={chainStock?.ticker || 'NIFTY'}
        spotPrice={chainStock?.spotPrice || 0}
        strikeStep={chainStock?.strikeStep || 50}
        onClose={() => setChainStock(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.obsidian,
  },
  topNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  backToSignalsBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  backToSignalsText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
  },
  topNavTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  feedStatusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  feedStatusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  feedStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  feedStatusText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  feedCountText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  searchContainer: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    backgroundColor: colors.surface,
  },
  searchInput: {
    backgroundColor: colors.surfaceSubtle,
    color: colors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: 6,
  },
  filterChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  filterChipActive: {
    backgroundColor: colors.surfaceHover,
    borderColor: colors.textPrimary,
  },
  filterChipActiveGreen: {
    backgroundColor: colors.bullishGlow,
    borderColor: colors.bullish,
  },
  filterChipActiveRed: {
    backgroundColor: colors.bearishGlow,
    borderColor: colors.bearish,
  },
  filterChipActiveAmber: {
    backgroundColor: colors.warningGlow,
    borderColor: colors.warning,
  },
  filterText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  filterTextActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  filterTextActiveGreen: {
    color: colors.bullish,
    fontWeight: '700',
  },
  filterTextActiveRed: {
    color: colors.bearish,
    fontWeight: '700',
  },
  filterTextActiveAmber: {
    color: colors.warning,
    fontWeight: '700',
  },
  listContent: {
    padding: 12,
  },
  stockCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 12,
    marginBottom: 10,
  },
  greenCardBorder: {
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  redCardBorder: {
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  leftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  circleIcon: {
    fontSize: 20,
  },
  tickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ticker: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  indexPillRow: {
    flexDirection: 'row',
    gap: 4,
  },
  indexPill: {
    backgroundColor: colors.surfaceHover,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  indexPillText: {
    color: colors.textSecondary,
    fontSize: 8,
    fontWeight: '700',
  },
  companyName: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
    maxWidth: 180,
  },
  priceGroup: {
    alignItems: 'flex-end',
  },
  price: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  percent: {
    fontSize: 12,
    fontWeight: '700',
  },
  volumeDetailsBox: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginTop: 4,
    marginBottom: 6,
  },
  volMetricCol: {
    flex: 1,
    alignItems: 'center',
  },
  volMetricLabel: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  volMetricVal: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  exactSharesSub: {
    color: colors.textMuted,
    fontSize: 8,
    fontFamily: 'monospace',
    marginTop: 1,
  },
  volDivider: {
    width: 1,
    backgroundColor: colors.divider,
  },
  progressTrack: {
    height: 4,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
  },
  tapNote: {
    color: colors.cyan,
    fontSize: 10,
    fontWeight: '600',
  },
});
