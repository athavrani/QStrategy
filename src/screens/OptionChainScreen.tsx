// Dhan-Grade Option Chain Screen with On-Device Black-Scholes Greeks Engine
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  FlatList,
  RefreshControl,
  SafeAreaView,
} from 'react-native';
import { useTheme, createThemedStyles } from '../theme';
import { useRadarStore } from '../store/useRadarStore';
import { DhanOptionChainService, OptionChainResult, OptionStrikeData } from '../services/dhan/DhanOptionChainService';
import { calculateGreeks, OptionGreeks } from '../services/quant/BlackScholes';
import { FinancialValue } from '../components/common/FinancialValue';
import { StatusBadge } from '../components/common/StatusBadge';
import { SkeletonLoader } from '../components/common/SkeletonLoader';
import { dhanDirectService } from '../services/dhanDirectService';
import * as Haptics from 'expo-haptics';

export interface UnderlyingPreset {
  symbol: string;
  name: string;
  scripId: number;
  segment: string;
  strikeStep: number;
}

export const UNDERLYING_PRESETS: UnderlyingPreset[] = [
  { symbol: 'NIFTY', name: 'NIFTY 50', scripId: 13, segment: 'IDX_I', strikeStep: 50 },
  { symbol: 'BANKNIFTY', name: 'NIFTY BANK', scripId: 25, segment: 'IDX_I', strikeStep: 100 },
  { symbol: 'FINNIFTY', name: 'FIN NIFTY', scripId: 27, segment: 'IDX_I', strikeStep: 50 },
  { symbol: 'SENSEX', name: 'BSE SENSEX', scripId: 51, segment: 'IDX_I', strikeStep: 100 },
];

type ViewMode = 'QUOTES_OI' | 'GREEKS';
export type StrikeRange = '6' | '10' | 'ALL';

function formatExpiryDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  const day = parts[2];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = parseInt(parts[1], 10) - 1;
  const monthName = months[monthIdx] || parts[1];
  return `${day} ${monthName}`;
}

export function formatOi(oi: number | undefined | null): string {
  if (!oi || oi <= 0) return '—';
  if (oi >= 10000000) {
    return `${(oi / 10000000).toFixed(2)}Cr`;
  }
  if (oi >= 100000) {
    return `${(oi / 100000).toFixed(1)}L`;
  }
  if (oi >= 1000) {
    return `${(oi / 1000).toFixed(0)}k`;
  }
  return oi.toLocaleString('en-IN');
}

export function OptionChainScreen(): React.JSX.Element {
  const { theme, colors, isDark } = useTheme();
  const styles = useThemedStyles();
  const [selectedPreset, setSelectedPreset] = useState<UnderlyingPreset>(UNDERLYING_PRESETS[0]);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const [strikeRange, setStrikeRange] = useState<StrikeRange>('6');
  const [viewMode, setViewMode] = useState<ViewMode>('QUOTES_OI');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chainData, setChainData] = useState<OptionChainResult | null>(null);

  const niftySpotFromStore = useRadarStore((s) => s.niftySpot);
  const feedStatus = useRadarStore((s) => s.feedStatus);

  const optionChainService = useMemo(() => new DhanOptionChainService(), []);

  // Compute time to expiry in years (e.g. 3 days / 365 = 0.0082)
  const timeToExpiryYears = useMemo(() => {
    // Default 4 calendar days until weekly expiry
    return Math.max(1 / 365, 4 / 365);
  }, []);

  const loadOptionChain = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) {
        setIsRefreshing(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        setIsLoading(true);
      }

      try {
        const result = await optionChainService.getOptionChain(
          selectedPreset.scripId,
          selectedPreset.segment,
          selectedExpiry,
          selectedPreset.strikeStep
        );
        setChainData(result);
        if (result?.expiry && !selectedExpiry) {
          setSelectedExpiry(result.expiry);
        }
      } catch (err) {
        // Handled silently
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [selectedPreset, selectedExpiry, optionChainService]
  );

  useEffect(() => {
    loadOptionChain();
  }, [loadOptionChain]);

  const activeSpot = chainData?.spotPrice ?? (selectedPreset.symbol === 'NIFTY' ? niftySpotFromStore : null);
  const atmStrike = chainData?.atmStrike ?? (activeSpot ? Math.round(activeSpot / selectedPreset.strikeStep) * selectedPreset.strikeStep : null);

  // Filter strikes around ATM for responsive, high-density mobile viewing (6 ITM + 1 ATM + 6 OTM)
  const displayedStrikes = useMemo(() => {
    if (!chainData || !chainData.strikes || chainData.strikes.length === 0) return [];
    if (strikeRange === 'ALL' || !atmStrike) return chainData.strikes;

    const count = parseInt(strikeRange, 10);
    const atmIndex = chainData.strikes.findIndex((s) => s.strikePrice === atmStrike);
    let centerIndex = atmIndex;
    if (centerIndex === -1) {
      let minDiff = Infinity;
      chainData.strikes.forEach((s, idx) => {
        const diff = Math.abs(s.strikePrice - atmStrike);
        if (diff < minDiff) {
          minDiff = diff;
          centerIndex = idx;
        }
      });
    }

    if (centerIndex === -1) return chainData.strikes;

    const start = Math.max(0, centerIndex - count);
    const end = Math.min(chainData.strikes.length, centerIndex + count + 1);
    return chainData.strikes.slice(start, end);
  }, [chainData, atmStrike, strikeRange]);

  // PCR Analysis
  const pcr = chainData?.pcr ?? null;
  let pcrTag = 'NEUTRAL';
  let pcrVariant: 'bullish' | 'bearish' | 'warning' = 'warning';
  if (pcr !== null) {
    if (pcr >= 1.2) {
      pcrTag = 'BULLISH (SUPPORT)';
      pcrVariant = 'bullish';
    } else if (pcr <= 0.8) {
      pcrTag = 'BEARISH (CALL RESIST)';
      pcrVariant = 'bearish';
    }
  }

  const handleSelectPreset = (preset: UnderlyingPreset) => {
    Haptics.selectionAsync();
    setSelectedPreset(preset);
    setSelectedExpiry('');
  };

  const handleSelectExpiry = (exp: string) => {
    Haptics.selectionAsync();
    setSelectedExpiry(exp);
  };

  const handleToggleViewMode = (mode: ViewMode) => {
    Haptics.selectionAsync();
    setViewMode(mode);
  };

  const handleLegPress = (symbol: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dhanDirectService.launchDhanApp(symbol);
  };

  const renderStrikeRow = ({ item }: { item: OptionStrikeData }) => {
    const isATM = atmStrike !== null && item.strikePrice === atmStrike;
    const isCallITM = atmStrike !== null ? item.strikePrice < atmStrike : (activeSpot !== null && item.strikePrice < activeSpot);
    const isPutITM = atmStrike !== null ? item.strikePrice > atmStrike : (activeSpot !== null && item.strikePrice > activeSpot);

    // On-Device Greeks calculations
    let ceGreeks: OptionGreeks | null = null;
    let peGreeks: OptionGreeks | null = null;

    if (viewMode === 'GREEKS' && activeSpot) {
      if (item.ce.ltp && item.ce.ltp > 0) {
        ceGreeks = calculateGreeks(activeSpot, item.strikePrice, timeToExpiryYears, 0.07, item.ce.ltp, true);
      }
      if (item.pe.ltp && item.pe.ltp > 0) {
        peGreeks = calculateGreeks(activeSpot, item.strikePrice, timeToExpiryYears, 0.07, item.pe.ltp, false);
      }
    }

    return (
      <View
        style={[
          styles.strikeRow,
          isATM && styles.strikeRowATM,
        ]}
      >
        {/* CALL SIDE (LEFT) */}
        <TouchableOpacity
          style={[
            styles.legCell,
            styles.callCell,
            isCallITM && styles.cellITM,
          ]}
          activeOpacity={0.7}
          onPress={() => handleLegPress(`${selectedPreset.symbol}${item.strikePrice}CE`)}
        >
          {viewMode === 'QUOTES_OI' ? (
            <View style={styles.cellContentLeft}>
              <View style={styles.cellTopRow}>
                <FinancialValue
                  value={item.ce.ltp}
                  format="currency"
                  size="sm"
                  colorize={false}
                  style={styles.cellLtp}
                />
                {isCallITM && (
                  <View style={styles.itmTag}>
                    <Text style={styles.itmTagText}>ITM</Text>
                  </View>
                )}
              </View>
              <Text style={styles.cellSubText} numberOfLines={1}>
                OI: {formatOi(item.ce.oi)}
                {item.ce.iv ? ` · ${item.ce.iv}%` : ''}
              </Text>
            </View>
          ) : (
            <View style={styles.cellContentLeft}>
              <Text style={styles.greekDeltaText}>
                Δ {ceGreeks ? ceGreeks.delta.toFixed(2) : (item.ce.iv ? `${item.ce.iv}%` : '—')}
              </Text>
              <Text style={styles.greekSubText} numberOfLines={1}>
                θ {ceGreeks ? ceGreeks.theta.toFixed(1) : '—'}
                {ceGreeks ? ` · ν ${ceGreeks.vega.toFixed(1)}` : ''}
              </Text>
            </View>
          )}
        </TouchableOpacity>

        {/* STRIKE CENTER */}
        <View style={[styles.strikeCenter, isATM && styles.strikeCenterATM]}>
          <Text style={[styles.strikeText, isATM && styles.strikeTextATM]}>
            {item.strikePrice.toLocaleString('en-IN')}
          </Text>
          {isATM ? (
            <View style={styles.atmBadge}>
              <Text style={styles.atmBadgeText}>ATM</Text>
            </View>
          ) : isCallITM ? (
            <Text style={styles.moneynessText}>CE ITM</Text>
          ) : isPutITM ? (
            <Text style={styles.moneynessText}>PE ITM</Text>
          ) : null}
        </View>

        {/* PUT SIDE (RIGHT) */}
        <TouchableOpacity
          style={[
            styles.legCell,
            styles.putCell,
            isPutITM && styles.cellITM,
          ]}
          activeOpacity={0.7}
          onPress={() => handleLegPress(`${selectedPreset.symbol}${item.strikePrice}PE`)}
        >
          {viewMode === 'QUOTES_OI' ? (
            <View style={styles.cellContentRight}>
              <View style={styles.cellTopRowRight}>
                {isPutITM && (
                  <View style={styles.itmTag}>
                    <Text style={styles.itmTagText}>ITM</Text>
                  </View>
                )}
                <FinancialValue
                  value={item.pe.ltp}
                  format="currency"
                  size="sm"
                  colorize={false}
                  style={styles.cellLtp}
                />
              </View>
              <Text style={styles.cellSubText} numberOfLines={1}>
                {item.pe.iv ? `${item.pe.iv}% · ` : ''}
                OI: {formatOi(item.pe.oi)}
              </Text>
            </View>
          ) : (
            <View style={styles.cellContentRight}>
              <Text style={styles.greekDeltaText}>
                Δ {peGreeks ? peGreeks.delta.toFixed(2) : (item.pe.iv ? `${item.pe.iv}%` : '—')}
              </Text>
              <Text style={styles.greekSubText} numberOfLines={1}>
                {peGreeks ? `ν ${peGreeks.vega.toFixed(1)} · ` : ''}
                θ {peGreeks ? peGreeks.theta.toFixed(1) : '—'}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Underlying Scrip Selector Chips */}
      <View style={styles.presetBar}>
        {UNDERLYING_PRESETS.map((p) => {
          const isSelected = p.symbol === selectedPreset.symbol;
          return (
            <TouchableOpacity
              key={p.symbol}
              style={[styles.presetChip, isSelected && styles.presetChipActive]}
              onPress={() => handleSelectPreset(p)}
            >
              <Text style={[styles.presetChipText, isSelected && styles.presetChipTextActive]}>
                {p.symbol}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Expiry Selector Chips */}
      {chainData?.expiryList && chainData.expiryList.length > 0 && (
        <View style={styles.expiryContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.expiryBar}
          >
            {chainData.expiryList.slice(0, 10).map((exp) => {
              const isSelected = exp === (selectedExpiry || chainData.expiry);
              return (
                <TouchableOpacity
                  key={exp}
                  style={[styles.expiryChip, isSelected && styles.expiryChipActive]}
                  onPress={() => handleSelectExpiry(exp)}
                >
                  <Text style={[styles.expiryChipText, isSelected && styles.expiryChipTextActive]}>
                    📅 {formatExpiryDate(exp)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Spot Price & Telemetry Summary Header */}
      <View style={styles.spotHeader}>
        <View>
          <Text style={styles.scripName}>{selectedPreset.name}</Text>
          <View style={styles.spotRow}>
            <Text style={styles.spotPrefix}>SPOT:</Text>
            <FinancialValue
              value={activeSpot}
              format="currency"
              size="lg"
              weight="bold"
              colorize={false}
              style={styles.spotPriceText}
            />
            {chainData?.expiry ? (
              <Text style={styles.expiryTag}>📅 {formatExpiryDate(chainData.expiry)}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.headerRightGroup}>
          {pcr !== null && (
            <View style={styles.pcrGroup}>
              <Text style={styles.pcrLabel}>PCR: {pcr.toFixed(2)}</Text>
              <StatusBadge label={pcrTag} variant={pcrVariant} size="sm" />
            </View>
          )}

          {/* Mode & Strike Range Switch */}
          <View style={styles.controlsRow}>
            {/* Strike Range Selector */}
            <View style={styles.rangeToggleGroup}>
              {(['6', '10', 'ALL'] as const).map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.rangeBtn, strikeRange === r && styles.rangeBtnActive]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setStrikeRange(r);
                  }}
                >
                  <Text style={[styles.rangeBtnText, strikeRange === r && styles.rangeBtnTextActive]}>
                    {r === '6' ? '±6 (13)' : r === 'ALL' ? 'ALL' : `±${r}`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Mode Switch (Quotes vs Greeks) */}
            <View style={styles.modeToggleGroup}>
              <TouchableOpacity
                style={[styles.modeBtn, viewMode === 'QUOTES_OI' && styles.modeBtnActive]}
                onPress={() => handleToggleViewMode('QUOTES_OI')}
              >
                <Text style={[styles.modeBtnText, viewMode === 'QUOTES_OI' && styles.modeBtnTextActive]}>
                  OI & LTP
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeBtn, viewMode === 'GREEKS' && styles.modeBtnActive]}
                onPress={() => handleToggleViewMode('GREEKS')}
              >
                <Text style={[styles.modeBtnText, viewMode === 'GREEKS' && styles.modeBtnTextActive]}>
                  Greeks
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      {/* Table Column Headers */}
      <View style={styles.columnHeaderRow}>
        <View style={[styles.columnHeaderCell, styles.callHeader]}>
          <Text style={styles.columnHeaderText}>
            {viewMode === 'QUOTES_OI' ? 'CALLS (LTP / OI)' : 'CALLS (DELTA / THETA)'}
          </Text>
        </View>
        <View style={styles.strikeHeaderCell}>
          <Text style={styles.strikeHeaderText}>STRIKE</Text>
        </View>
        <View style={[styles.columnHeaderCell, styles.putHeader]}>
          <Text style={styles.columnHeaderText}>
            {viewMode === 'QUOTES_OI' ? 'PUTS (LTP / OI)' : 'PUTS (DELTA / THETA)'}
          </Text>
        </View>
      </View>

      {/* Option Strikes Stream */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <SkeletonLoader lines={12} height={42} spacing={4} />
        </View>
      ) : chainData && displayedStrikes.length > 0 ? (
        <FlatList
          style={styles.flatList}
          data={displayedStrikes}
          keyExtractor={(item) => `strike-${item.strikePrice}`}
          renderItem={renderStrikeRow}
          contentContainerStyle={styles.listContent}
          getItemLayout={(_data, index) => ({
            length: 54,
            offset: 54 * index,
            index,
          })}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={5}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => loadOptionChain(true)}
              tintColor={theme.colors.bullish}
              colors={[theme.colors.bullish]}
            />
          }
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => loadOptionChain(true)}
              tintColor={theme.colors.bullish}
            />
          }
        >
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyTitle}>
            {feedStatus === 'ONLINE' ? 'Connecting to Option Chain' : 'Live Option Chain Ready'}
          </Text>
          <Text style={styles.emptySubtitle}>
            {feedStatus === 'ONLINE'
              ? 'Retrieving live DhanHQ v2 institutional strike data & Greeks...'
              : 'Configure your Dhan Client ID & Token in Settings to stream institutional DhanHQ v2 Option Chain & Greeks.'}
          </Text>
          <StatusBadge
            label={feedStatus === 'ONLINE' ? 'FEED CONNECTED' : 'AWAITING DHAN CREDENTIALS'}
            variant={feedStatus === 'ONLINE' ? 'bullish' : 'neutral'}
            showDot={true}
            style={{ marginTop: 12 }}
          />
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => loadOptionChain(true)}
          >
            <Text style={styles.retryBtnText}>🔄 Tap to Reload</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const useThemedStyles = createThemedStyles((colors, theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.obsidian,
  },
  presetBar: {
    flexDirection: 'row',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing.sm,
  },
  presetChip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  presetChipActive: {
    backgroundColor: theme.colors.borderActive,
    borderColor: theme.colors.borderActive,
  },
  presetChipText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.sm,
    fontWeight: theme.typography.weights.semibold,
  },
  presetChipTextActive: {
    color: theme.colors.textPrimary,
    fontWeight: theme.typography.weights.bold,
  },
  expiryContainer: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  expiryBar: {
    flexDirection: 'row',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    gap: 6,
  },
  expiryChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.xs,
    backgroundColor: theme.colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  expiryChipActive: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    borderColor: theme.colors.cyan,
  },
  expiryChipText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.xs,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.semibold,
  },
  expiryChipTextActive: {
    color: theme.colors.cyan,
    fontWeight: theme.typography.weights.bold,
  },
  spotHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceElevated,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  scripName: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.xs,
    fontWeight: theme.typography.weights.semibold,
    letterSpacing: 0.5,
  },
  spotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  spotPrefix: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.sm,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.bold,
  },
  spotPriceText: {
    color: theme.colors.textPrimary,
  },
  expiryTag: {
    color: theme.colors.cyan,
    fontSize: theme.typography.sizes.micro,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.bold,
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 6,
  },
  headerRightGroup: {
    alignItems: 'flex-end',
    gap: 6,
  },
  pcrGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pcrLabel: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.sizes.xs,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.bold,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rangeToggleGroup: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceSubtle,
    borderRadius: theme.borderRadius.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  rangeBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  rangeBtnActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.3)',
  },
  rangeBtnText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.micro,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.semibold,
  },
  rangeBtnTextActive: {
    color: '#60A5FA',
    fontWeight: theme.typography.weights.bold,
  },
  modeToggleGroup: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceSubtle,
    borderRadius: theme.borderRadius.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  modeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  modeBtnActive: {
    backgroundColor: theme.colors.borderActive,
  },
  modeBtnText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.micro,
    fontWeight: theme.typography.weights.semibold,
  },
  modeBtnTextActive: {
    color: theme.colors.textPrimary,
    fontWeight: theme.typography.weights.bold,
  },
  columnHeaderRow: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingVertical: 8,
  },
  columnHeaderCell: {
    flex: 1,
    justifyContent: 'center',
  },
  callHeader: {
    alignItems: 'flex-start',
    paddingLeft: 12,
  },
  putHeader: {
    alignItems: 'flex-end',
    paddingRight: 12,
  },
  strikeHeaderCell: {
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
  },
  columnHeaderText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.micro,
    fontWeight: theme.typography.weights.bold,
    letterSpacing: 0.3,
  },
  strikeHeaderText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.sizes.micro,
    fontWeight: theme.typography.weights.extrabold,
    letterSpacing: 0.5,
  },
  flatList: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 24,
  },
  strikeRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    height: 54,
    alignItems: 'stretch',
  },
  strikeRowATM: {
    backgroundColor: 'rgba(59, 130, 246, 0.08)',
    borderTopWidth: 1.5,
    borderTopColor: '#3B82F6',
    borderBottomWidth: 1.5,
    borderBottomColor: '#3B82F6',
  },
  legCell: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  callCell: {
    alignItems: 'flex-start',
  },
  putCell: {
    alignItems: 'flex-end',
  },
  cellITM: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
  },
  cellContentLeft: {
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  cellContentRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  cellTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  cellTopRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    justifyContent: 'flex-end',
  },
  cellLtp: {
    fontWeight: theme.typography.weights.bold,
  },
  cellSubText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.micro,
    fontFamily: theme.typography.fontMono,
    marginTop: 2,
  },
  itmTag: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 0.5,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
  itmTagText: {
    color: '#F59E0B',
    fontSize: 8,
    fontWeight: theme.typography.weights.extrabold,
    letterSpacing: 0.5,
  },
  greekDeltaText: {
    color: theme.colors.cyan,
    fontSize: theme.typography.sizes.sm,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.bold,
  },
  greekSubText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.sizes.micro,
    fontFamily: theme.typography.fontMono,
    marginTop: 2,
  },
  strikeCenter: {
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceSubtle,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: theme.colors.border,
  },
  strikeCenterATM: {
    backgroundColor: 'rgba(59, 130, 246, 0.18)',
    borderColor: '#3B82F6',
  },
  strikeText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.sizes.sm,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.bold,
  },
  strikeTextATM: {
    color: '#60A5FA',
    fontWeight: theme.typography.weights.extrabold,
  },
  atmBadge: {
    backgroundColor: '#2563EB',
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginTop: 2,
  },
  atmBadgeText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: theme.typography.weights.extrabold,
    letterSpacing: 0.5,
  },
  moneynessText: {
    color: theme.colors.textMuted,
    fontSize: 8,
    fontFamily: theme.typography.fontMono,
    fontWeight: theme.typography.weights.semibold,
    marginTop: 2,
    opacity: 0.7,
  },
  loadingContainer: {
    padding: theme.spacing.md,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
    minHeight: 350,
  },
  emptyIcon: {
    fontSize: 44,
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
  retryBtn: {
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 8,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.borderActive,
  },
  retryBtnText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.sizes.sm,
    fontWeight: theme.typography.weights.semibold,
  },
}));

