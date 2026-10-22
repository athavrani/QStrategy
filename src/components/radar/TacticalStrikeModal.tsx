import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
} from 'react-native';
import { useTheme, createThemedStyles } from '../../theme';
import { StockRadarItem, TacticalStrikeSuggestion } from '../../types/mobile';
import * as Haptics from 'expo-haptics';

import { dhanDirectService } from '../../services/dhanDirectService';

interface Props {
  visible: boolean;
  stock: StockRadarItem | null;
  tactical: TacticalStrikeSuggestion | null;
  onClose: () => void;
  onViewOptionChain?: (stock: StockRadarItem) => void;
}

export function TacticalStrikeModal({ visible, stock, tactical, onClose, onViewOptionChain }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  if (!stock || !tactical) return null;

  const handleOpenBroker = (action: 'CE' | 'PE', broker: 'kite' | 'dhan' = 'dhan') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const strike = action === 'CE' ? tactical.recommendedCeStrike : tactical.recommendedPeStrike;
    const symbol = `${stock.ticker} ${strike} ${action}`;

    if (broker === 'dhan') {
      dhanDirectService.launchDhanApp(symbol);
    } else {
      const kiteUrl = `kite://search?q=${encodeURIComponent(symbol)}`;
      Linking.canOpenURL(kiteUrl).then((supported) => {
        if (supported) {
          Linking.openURL(kiteUrl);
        } else {
          Linking.openURL(`https://kite.zerodha.com`);
        }
      });
    }
  };

  const priceChangePct = stock.percentChange;
  const isPositive = priceChangePct > 0;
  const isNegative = priceChangePct < 0;
  const isCrossed = stock.hasCrossed20D;
  const isBullish = stock.crossoverDirection === 'BULLISH';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* Full-screen Backdrop dismissal */}
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
        />

        <View style={styles.modalContent}>
          {/* Top Drag Indicator */}
          <View style={styles.dragHandleContainer}>
            <View style={styles.dragHandle} />
          </View>

          {/* Header */}
          <View style={styles.modalHeader}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => {
                Haptics.selectionAsync();
                onClose();
              }}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Text style={styles.backButtonText}>← Back</Text>
            </TouchableOpacity>

            <View style={{ flex: 1, marginHorizontal: 8 }}>
              <View style={styles.tickerRow}>
                <Text style={styles.ticker}>{stock.ticker}</Text>
                <View style={[styles.statusBadge, { backgroundColor: isCrossed ? colors.bullishGlow : colors.warningGlow }]}>
                  <Text style={[styles.statusText, { color: isCrossed ? colors.bullish : colors.warning }]}>
                    {isCrossed ? '🔥 20D CROSSED' : '⚡ SCANNING'}
                  </Text>
                </View>
              </View>
              <Text style={styles.stockName} numberOfLines={1}>{stock.name}</Text>
            </View>

            <TouchableOpacity
              style={styles.closeBtn}
              onPress={() => {
                Haptics.selectionAsync();
                onClose();
              }}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {/* Spot Price & Volume Metrics */}
            <View style={styles.spotBox}>
              <View style={styles.spotRow}>
                <Text style={styles.spotLtp}>₹{stock.spotPrice.toFixed(2)}</Text>
                <Text
                  style={[
                    styles.spotPercent,
                    {
                      color:
                        isPositive
                          ? colors.bullish
                          : isNegative
                          ? colors.bearish
                          : colors.textMuted,
                    },
                  ]}
                >
                  {isPositive
                    ? `+${priceChangePct.toFixed(2)}%`
                    : `${priceChangePct.toFixed(2)}%`}
                </Text>
              </View>
              <Text style={styles.openText}>Day Open: ₹{stock.dayOpen.toFixed(2)} • Direction: {isBullish ? '▲ Bullish' : '▼ Bearish'}</Text>
            </View>

            {/* Exact Volume Shares Comparison */}
            <View style={styles.volumeBox}>
              <Text style={styles.boxTitle}>20-DAY VOLUME RATIO</Text>
              <View style={styles.sharesRow}>
                <Text style={styles.sharesLabel}>Today Traded:</Text>
                <Text style={styles.sharesVal}>{stock.todayTradedShares.toLocaleString()} shares</Text>
              </View>
              <View style={styles.sharesRow}>
                <Text style={styles.sharesLabel}>20D Avg Baseline:</Text>
                <Text style={styles.sharesVal}>{stock.avg20DTradedShares.toLocaleString()} shares</Text>
              </View>
              <View style={styles.sharesRow}>
                <Text style={styles.sharesLabel}>Ratio Progress:</Text>
                <Text style={[styles.sharesVal, { color: isCrossed ? colors.bullish : colors.warning, fontWeight: '700' }]}>
                  {(stock.volumeRatio * 100).toFixed(1)}% of Benchmark
                </Text>
              </View>
            </View>

            {/* Live Option Chain Quick Inspection Button */}
            {onViewOptionChain && (
              <TouchableOpacity
                style={styles.viewChainBtn}
                onPress={() => {
                  Haptics.selectionAsync();
                  onClose();
                  onViewOptionChain(stock);
                }}
              >
                <Text style={styles.viewChainBtnText}>📊 View Live Option Chain Matrix ({stock.ticker}) ↗</Text>
              </TouchableOpacity>
            )}

            {/* Tactical Strike Recommendation */}
            <Text style={styles.sectionHeader}>TACTICAL ATM OPTION REFERENCE</Text>

            {/* Recommended Call Option CE */}
            <View style={styles.strikeCard}>
              <View style={styles.strikeHeader}>
                <Text style={styles.strikeType}>BULLISH ATM CALL (CE)</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity style={[styles.kiteBtn, { backgroundColor: '#10B981' }]} onPress={() => handleOpenBroker('CE', 'dhan')}>
                    <Text style={styles.kiteBtnText}>⚡ Dhan</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.kiteBtn} onPress={() => handleOpenBroker('CE', 'kite')}>
                    <Text style={styles.kiteBtnText}>Kite ↗</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={styles.strikeNumber}>{tactical.recommendedCeStrike} CE</Text>
              <Text style={styles.estPrem}>
                {tactical.estimatedCePremium > 0
                  ? `Live Premium: ₹${tactical.estimatedCePremium.toFixed(2)}`
                  : 'Live Premium: Awaiting 09:15 Market Open'}
              </Text>

              {tactical.estimatedCePremium > 0 && (
                <View style={styles.levelsRow}>
                  <View style={styles.levelItem}>
                    <Text style={styles.levelLabel}>INITIAL SL (-20%)</Text>
                    <Text style={[styles.levelVal, { color: colors.bearish }]}>₹{tactical.ceStopLoss.toFixed(2)}</Text>
                  </View>
                  <View style={styles.levelItem}>
                    <Text style={styles.levelLabel}>TARGET (+40%)</Text>
                    <Text style={[styles.levelVal, { color: colors.bullish }]}>₹{tactical.ceTarget1.toFixed(2)}</Text>
                  </View>
                  <View style={styles.levelItem}>
                    <Text style={styles.levelLabel}>π% MILESTONE</Text>
                    <Text style={[styles.levelVal, { color: colors.cyan }]}>₹{tactical.cePiTarget1.toFixed(2)}</Text>
                  </View>
                </View>
              )}
            </View>

            {/* Recommended Put Option PE */}
            <View style={styles.strikeCard}>
              <View style={styles.strikeHeader}>
                <Text style={styles.strikeType}>BEARISH ATM PUT (PE)</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity style={[styles.kiteBtn, { backgroundColor: '#10B981' }]} onPress={() => handleOpenBroker('PE', 'dhan')}>
                    <Text style={styles.kiteBtnText}>⚡ Dhan</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.kiteBtn} onPress={() => handleOpenBroker('PE', 'kite')}>
                    <Text style={styles.kiteBtnText}>Kite ↗</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={styles.strikeNumber}>{tactical.recommendedPeStrike} PE</Text>
              <Text style={styles.estPrem}>
                {tactical.estimatedPePremium > 0
                  ? `Live Premium: ₹${tactical.estimatedPePremium.toFixed(2)}`
                  : 'Live Premium: Awaiting 09:15 Market Open'}
              </Text>

              {tactical.estimatedPePremium > 0 && (
                <View style={styles.levelsRow}>
                  <View style={styles.levelItem}>
                    <Text style={styles.levelLabel}>INITIAL SL (-20%)</Text>
                    <Text style={[styles.levelVal, { color: colors.bearish }]}>₹{tactical.peStopLoss.toFixed(2)}</Text>
                  </View>
                  <View style={styles.levelItem}>
                    <Text style={styles.levelLabel}>TARGET (+40%)</Text>
                    <Text style={[styles.levelVal, { color: colors.bullish }]}>₹{tactical.peTarget1.toFixed(2)}</Text>
                  </View>
                </View>
              )}
            </View>

            <View style={{ height: 20 }} />
          </ScrollView>

          {/* Sticky Bottom Close Button */}
          <View style={styles.bottomBar}>
            <TouchableOpacity
              style={styles.bottomCloseBtn}
              onPress={() => {
                Haptics.selectionAsync();
                onClose();
              }}
            >
              <Text style={styles.bottomCloseBtnText}>← Close & Return to Radar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    maxHeight: '90%',
  },
  dragHandleContainer: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.cardBorder,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  backButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
  },
  backButtonText: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '700',
  },
  tickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ticker: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
  },
  stockName: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: '700',
  },
  bottomBar: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    backgroundColor: colors.surface,
  },
  bottomCloseBtn: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  bottomCloseBtnText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  body: {
    padding: 16,
  },
  spotBox: {
    backgroundColor: colors.card,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 12,
  },
  spotRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  spotLtp: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  spotPercent: {
    fontSize: 15,
    fontWeight: '700',
  },
  openText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  volumeBox: {
    backgroundColor: colors.surfaceSubtle,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 16,
  },
  boxTitle: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  sharesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  sharesLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  sharesVal: {
    color: colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  sectionHeader: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  strikeCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  strikeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  strikeType: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  kiteBtn: {
    backgroundColor: colors.surfaceHover,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  kiteBtnText: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
  strikeNumber: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  estPrem: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 8,
  },
  levelsRow: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.surface,
    padding: 8,
    borderRadius: 6,
  },
  levelItem: {
    flex: 1,
    alignItems: 'center',
  },
  levelLabel: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '600',
    marginBottom: 2,
  },
  levelVal: {
    fontSize: 11,
    fontWeight: '700',
  },
  viewChainBtn: {
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 16,
  },
  viewChainBtnText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
  },
}));

