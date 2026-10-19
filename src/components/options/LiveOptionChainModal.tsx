import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useTheme, createThemedStyles } from '../../theme';
import { liveMarketService, LiveOptionChainSummary } from '../../services/liveMarketService';
import { dhanDirectService } from '../../services/dhanDirectService';
import * as Haptics from 'expo-haptics';

interface Props {
  visible: boolean;
  ticker?: string;
  spotPrice?: number;
  strikeStep?: number;
  onClose: () => void;
}

export function LiveOptionChainModal({
  visible,
  ticker = 'NIFTY',
  spotPrice = 0,
  strikeStep = 50,
  onClose,
}: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles();
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chain, setChain] = useState<LiveOptionChainSummary | null>(null);

  useEffect(() => {
    if (visible) {
      loadOptionChain();
    }
  }, [visible, ticker, spotPrice]);

  const loadOptionChain = async (isManual = false) => {
    if (isManual) {
      setIsRefreshing(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const data = await liveMarketService.fetchLiveOptionChain(ticker, spotPrice, strikeStep, true);
    setChain(data);
    if (isManual) {
      setIsRefreshing(false);
    }
    setLoading(false);
  };

  const handleOpenBroker = (symbol: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dhanDirectService.launchDhanApp(symbol);
  };

  if (!visible) return null;

  const displaySpot = chain?.spotPrice || spotPrice;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* Full-screen Backdrop dismissal on touch outside */}
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
        />

        <View style={styles.content}>
          {/* Top Drag Handle */}
          <View style={styles.dragHandleContainer}>
            <View style={styles.dragHandle} />
          </View>

          {/* Header */}
          <View style={styles.header}>
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
              <View style={styles.titleRow}>
                <Text style={styles.title}>{ticker} Option Chain</Text>
                {chain?.isLiveMarketData ? (
                  <View style={[styles.badge, styles.liveBadge]}>
                    <Text style={styles.liveBadgeText}>🟢 LIVE DHAN</Text>
                  </View>
                ) : (
                  <View style={[styles.badge, styles.estimatedBadge]}>
                    <Text style={styles.estimatedBadgeText}>⚡ AWAITING FEED</Text>
                  </View>
                )}
                {chain?.rolledToNextExpiry && (
                  <View style={[styles.badge, styles.expiryRolloverBadge]}>
                    <Text style={styles.expiryRolloverBadgeText}>NEXT EXPIRY (BTST)</Text>
                  </View>
                )}
                {chain?.wasPreponed && (
                  <View style={[styles.badge, styles.holidayPreponedBadge]}>
                    <Text style={styles.holidayPreponedBadgeText}>PREPONED</Text>
                  </View>
                )}
              </View>
              <Text style={styles.sub}>
                Spot: {displaySpot > 0 ? `₹${displaySpot.toFixed(2)}` : '--'} • Expiry: {chain?.expiryDate || '--'} {chain?.daysToExpiry ? `(${chain.daysToExpiry}d)` : ''}
              </Text>
            </View>

            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.refreshBtn}
                onPress={() => loadOptionChain(true)}
                disabled={isRefreshing}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                {isRefreshing ? (
                  <ActivityIndicator size="small" color={colors.cyan} />
                ) : (
                  <Text style={styles.refreshIcon}>🔄</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={() => {
                  Haptics.selectionAsync();
                  onClose();
                }}
                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
              >
                <Text style={styles.closeText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Expiry Day Notice Banner */}
          {chain?.rolledToNextExpiry && (
            <View style={styles.expiryNoticeBanner}>
              <Text style={styles.expiryNoticeText}>
                ⚡ <Text style={{ fontWeight: '800' }}>EXPIRY DAY:</Text> Auto-rolled to Next Expiry ({chain.expiryDate}) so 09:20 OOBTST can safely carry overnight (BTST).
              </Text>
            </View>
          )}

          {/* Holiday Preponement Notice Banner */}
          {chain?.wasPreponed && (
            <View style={[styles.expiryNoticeBanner, styles.holidayNoticeBanner]}>
              <Text style={styles.holidayNoticeText}>
                📅 <Text style={{ fontWeight: '800' }}>NSE HOLIDAY PREPONEMENT:</Text> Expiry preponed to {chain.expiryDate} because scheduled Tuesday was {chain.holidayReason || 'Exchange Holiday'}.
              </Text>
            </View>
          )}

          {/* Pre-Market / Live Market Notice Banner */}
          {chain && !chain.isLiveMarketData && (
            <View style={styles.offlineNoticeBanner}>
              <Text style={styles.offlineNoticeText}>
                ⚡ <Text style={{ fontWeight: '800' }}>LIVE EXCHANGE DATA ONLY:</Text> F&O contracts trade from 09:15 to 15:30 IST. Showing real exchange quotes only (never mathematical or index-derived synthetic estimates).
              </Text>
            </View>
          )}

          {/* 09:20 OOBTST Strike Tracker Strip */}
          {chain?.oobtstCeStrike && chain?.oobtstPeStrike && (
            <View style={styles.oobtstTrackerStrip}>
              <Text style={styles.oobtstTrackerTitle}>🌙 09:20 OOBTST TARGETS (~₹62.50):</Text>
              <View style={styles.oobtstTrackerItems}>
                <View style={styles.oobtstPillCe}>
                  <Text style={styles.oobtstPillTextCe}>
                    CE: {chain.oobtstCeStrike} (₹{chain.oobtstCeOpen?.toFixed(1) ?? '62.5'})
                  </Text>
                </View>
                <View style={styles.oobtstPillPe}>
                  <Text style={styles.oobtstPillTextPe}>
                    PE: {chain.oobtstPeStrike} (₹{chain.oobtstPeOpen?.toFixed(1) ?? '62.5'})
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* KPI Bar */}
          <View style={styles.kpiBar}>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>PCR RATIO</Text>
              <Text style={[styles.kpiVal, { color: (chain?.pcrRatio || 1) >= 1 ? colors.bullish : colors.bearish }]}>
                {chain?.pcrRatio.toFixed(2) || '1.15'}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>ATM STRIKE</Text>
              <Text style={[styles.kpiVal, { color: colors.cyan }]}>
                {chain?.atmStrike || 23150}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiLabel}>TOTAL PUT/CALL OI</Text>
              <Text style={styles.kpiVal}>
                {(chain?.totalPutOi || 0) > 100000 ? `${((chain?.totalPutOi || 0) / 100000).toFixed(1)}L` : '0'} / {((chain?.totalCallOi || 0) / 100000).toFixed(1)}L
              </Text>
            </View>
          </View>

          {/* Table Column Headers */}
          <View style={styles.tableHeader}>
            <Text style={[styles.colHeader, { flex: 1.3, textAlign: 'left' }]}>CALL LTP (OI)</Text>
            <Text style={[styles.colHeader, { flex: 1, textAlign: 'center' }]}>STRIKE</Text>
            <Text style={[styles.colHeader, { flex: 1.3, textAlign: 'right' }]}>PUT LTP (OI)</Text>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.cyan} />
              <Text style={styles.loadingText}>Streaming live options chain...</Text>
            </View>
          ) : (
            <ScrollView
              style={styles.list}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl
                  refreshing={isRefreshing}
                  onRefresh={() => loadOptionChain(true)}
                  tintColor={colors.cyan}
                  colors={[colors.cyan]}
                />
              }
            >
              {chain?.strikes.map((s) => {
                const isAtm = s.moneyness === 'ATM';
                const isOobtstCe = !!s.isOobtstCe;
                const isOobtstPe = !!s.isOobtstPe;
                const isOobtstRow = isOobtstCe || isOobtstPe;

                return (
                  <View
                    key={s.strikePrice}
                    style={[
                      styles.row,
                      isAtm && styles.atmRow,
                      isOobtstRow && styles.oobtstRow,
                    ]}
                  >
                    {/* Call Side */}
                    <TouchableOpacity
                      style={[
                        styles.callCell,
                        { flex: 1.3 },
                        isOobtstCe && styles.oobtstCellHighlightCe,
                      ]}
                      onPress={() => handleOpenBroker(s.callSymbol)}
                    >
                      {isOobtstCe && (
                        <View style={styles.oobtstBadgeCe}>
                          <Text style={styles.oobtstBadgeTextCe}>⭐ 09:20 OOBTST CE</Text>
                        </View>
                      )}
                      <Text style={[styles.callPrice, { color: s.callLtp > 0 ? colors.bullish : colors.textMuted }, isOobtstCe && styles.boldOobtstPrice]}>
                        {s.callLtp > 0 ? `₹${s.callLtp.toFixed(2)}` : '₹--'}
                      </Text>
                      <Text style={styles.oiText}>{s.callOi > 0 ? `${(s.callOi / 1000).toFixed(0)}k oi` : '-- oi'}</Text>
                    </TouchableOpacity>

                    {/* Strike Center */}
                    <View style={[styles.strikeCell, { flex: 1 }]}>
                      <Text style={[styles.strikeText, isAtm && styles.atmStrikeText, isOobtstRow && styles.oobtstStrikeText]}>
                        {s.strikePrice}
                      </Text>
                      <Text style={[styles.moneynessText, isAtm && { color: colors.cyan, fontWeight: '700' }]}>
                        {s.moneyness}
                      </Text>
                    </View>

                    {/* Put Side */}
                    <TouchableOpacity
                      style={[
                        styles.putCell,
                        { flex: 1.3 },
                        isOobtstPe && styles.oobtstCellHighlightPe,
                      ]}
                      onPress={() => handleOpenBroker(s.putSymbol)}
                    >
                      {isOobtstPe && (
                        <View style={styles.oobtstBadgePe}>
                          <Text style={styles.oobtstBadgeTextPe}>⭐ 09:20 OOBTST PE</Text>
                        </View>
                      )}
                      <Text style={[styles.putPrice, { color: s.putLtp > 0 ? colors.bearish : colors.textMuted }, isOobtstPe && styles.boldOobtstPrice]}>
                        {s.putLtp > 0 ? `₹${s.putLtp.toFixed(2)}` : '₹--'}
                      </Text>
                      <Text style={styles.oiText}>{s.putOi > 0 ? `${(s.putOi / 1000).toFixed(0)}k oi` : '-- oi'}</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
              <View style={{ height: 20 }} />
            </ScrollView>
          )}

          {/* Sticky Bottom Close Button */}
          <View style={styles.bottomBar}>
            <TouchableOpacity
              style={styles.bottomCloseBtn}
              onPress={() => {
                Haptics.selectionAsync();
                onClose();
              }}
            >
              <Text style={styles.bottomCloseBtnText}>← Close Option Chain & Return</Text>
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
  content: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '90%',
    borderWidth: 1,
    borderColor: colors.cardBorder,
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
  header: {
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  badge: {
    backgroundColor: colors.cyanGlow,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    color: colors.cyan,
    fontSize: 9,
    fontWeight: '800',
  },
  liveBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.4)',
  },
  liveBadgeText: {
    color: '#22c55e',
    fontSize: 9,
    fontWeight: '800',
  },
  estimatedBadge: {
    backgroundColor: 'rgba(234, 179, 8, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(234, 179, 8, 0.4)',
  },
  estimatedBadgeText: {
    color: '#fbbf24',
    fontSize: 8,
    fontWeight: '800',
  },
  expiryRolloverBadge: {
    backgroundColor: colors.warningGlow,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  expiryRolloverBadgeText: {
    color: colors.warning,
    fontSize: 8,
    fontWeight: '800',
  },
  holidayPreponedBadge: {
    backgroundColor: 'rgba(234, 179, 8, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(234, 179, 8, 0.4)',
  },
  holidayPreponedBadgeText: {
    color: '#fbbf24',
    fontSize: 8,
    fontWeight: '800',
  },
  holidayNoticeBanner: {
    backgroundColor: 'rgba(234, 179, 8, 0.12)',
    borderBottomColor: 'rgba(234, 179, 8, 0.35)',
  },
  holidayNoticeText: {
    color: '#fbbf24',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
  },
  sub: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  refreshBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshIcon: {
    fontSize: 14,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
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
  offlineNoticeBanner: {
    backgroundColor: 'rgba(234, 179, 8, 0.12)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(234, 179, 8, 0.3)',
  },
  offlineNoticeText: {
    color: '#fbbf24',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
  },
  expiryNoticeBanner: {
    backgroundColor: colors.warningGlow,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(245, 158, 11, 0.25)',
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  expiryNoticeText: {
    color: colors.warning,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
  },
  oobtstTrackerStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  oobtstTrackerTitle: {
    color: colors.purple,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  oobtstTrackerItems: {
    flexDirection: 'row',
    gap: 6,
  },
  oobtstPillCe: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  oobtstPillTextCe: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '700',
  },
  oobtstPillPe: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  oobtstPillTextPe: {
    color: colors.bearish,
    fontSize: 9,
    fontWeight: '700',
  },
  kpiBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  kpiItem: {
    flex: 1,
    alignItems: 'center',
  },
  kpiLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
  },
  kpiVal: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  colHeader: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 10,
  },
  list: {
    paddingHorizontal: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  atmRow: {
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderLeftWidth: 3,
    borderLeftColor: colors.cyan,
  },
  oobtstRow: {
    backgroundColor: 'rgba(168, 85, 247, 0.08)',
  },
  callCell: {
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  callPrice: {
    fontSize: 13,
    fontWeight: '700',
  },
  boldOobtstPrice: {
    fontSize: 14,
    fontWeight: '900',
  },
  strikeCell: {
    alignItems: 'center',
  },
  strikeText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  atmStrikeText: {
    color: colors.cyan,
  },
  oobtstStrikeText: {
    color: colors.purple,
    fontWeight: '900',
  },
  moneynessText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
  },
  putCell: {
    alignItems: 'flex-end',
    paddingRight: 4,
  },
  putPrice: {
    fontSize: 13,
    fontWeight: '700',
  },
  oiText: {
    color: colors.textMuted,
    fontSize: 9,
    marginTop: 1,
  },
  oobtstCellHighlightCe: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderRadius: 6,
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  oobtstCellHighlightPe: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderRadius: 6,
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  oobtstBadgeCe: {
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    marginBottom: 2,
  },
  oobtstBadgeTextCe: {
    color: colors.bullish,
    fontSize: 7.5,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  oobtstBadgePe: {
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    marginBottom: 2,
  },
  oobtstBadgeTextPe: {
    color: colors.bearish,
    fontSize: 7.5,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
}));

