import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { useTheme, createThemedStyles } from '../../theme';
import { useRadarStore } from '../../store/useRadarStore';
import { useSharedTick } from '../../hooks/useSharedTicker';
import { StrategySignalOutput } from '../../strategies/types';
import { dailyStrategyLockService } from '../../services/DailyStrategyLockService';
import { DailyStrategyLockRecord } from '../../db/schema';
import * as Haptics from 'expo-haptics';
import { SENSEX_LOT_SIZE } from '../../constants/lotSizes';
import { triggerProgressPct } from '../../utils/triggerProgress';

interface SensexOobtstDetailModalProps {
  visible: boolean;
  onClose: () => void;
  istTime: string;
  stepDetails?: StrategySignalOutput['stepDetails'];
}

export function SensexOobtstDetailModal({
  visible,
  onClose,
  istTime,
  stepDetails,
}: SensexOobtstDetailModalProps) {
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles();

  // 300ms UI Refresh Loop per Requirement 3
  const [isEditingCustomTarget, setIsEditingCustomTarget] = React.useState(false);
  const [customTargetText, setCustomTargetText] = React.useState('');
  const [targetError, setTargetError] = React.useState<string | null>(null);

  // Date-wise Historical Inspection State
  const availableLockDates = useRadarStore((s) => s.availableLockDates);
  const fetchAvailableLockDates = useRadarStore((s) => s.fetchAvailableLockDates);
  const [selectedHistoryDate, setSelectedHistoryDate] = React.useState<string | null>(null);
  const [historyRecord, setHistoryRecord] = React.useState<DailyStrategyLockRecord | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    fetchAvailableLockDates();
  }, [visible, fetchAvailableLockDates]);

  const handleSelectHistoryDate = async (date: string | null) => {
    Haptics.selectionAsync();
    setSelectedHistoryDate(date);
    if (!date) {
      setHistoryRecord(null);
    } else {
      const rec = await dailyStrategyLockService.getLock(date, 'SENSEX_OOBTST');
      setHistoryRecord(rec);
    }
  };

  useSharedTick(visible, 300);

  const sensexOobtstLive = useRadarStore((s) => s.sensexOobtstState);
  const storeTarget = useRadarStore((s) => s.sensexOobtstTargetPremium);
  const setTargetPremium = useRadarStore((s) => s.setSensexOobtstTargetPremium);
  const feedStatus = useRadarStore((s) => s.feedStatus);

  const targetPremium = storeTarget || sensexOobtstLive?.targetPremium || stepDetails?.targetPremium || stepDetails?.step1?.targetPremium || 100.00;
  const currentStep = sensexOobtstLive?.currentStep ?? stepDetails?.currentStep ?? 1;

  const isMarketClosed = sensexOobtstLive?.isMarketClosed ?? stepDetails?.step1?.isMarketClosed ?? false;
  const isProvisional = sensexOobtstLive?.isProvisional ?? stepDetails?.step1?.isProvisional ?? false;
  const isLocked = sensexOobtstLive?.isLocked ?? stepDetails?.step1?.isLocked ?? false;
  const isLockFailed = sensexOobtstLive?.isLockFailed ?? stepDetails?.step1?.isLockFailed ?? false;
  const lockFailureReason = sensexOobtstLive?.lockFailureReason || stepDetails?.step1?.lockFailureReason;
  const previewAvailable = sensexOobtstLive?.previewAvailable ?? stepDetails?.step1?.previewAvailable ?? false;
  const quoteFreshness = sensexOobtstLive?.quoteFreshness || stepDetails?.quoteFreshness || stepDetails?.step1?.quoteFreshness || 'STALE';

  const ceCandidates = sensexOobtstLive?.ceCandidates || stepDetails?.ceCandidates || stepDetails?.step1?.ceCandidates || [];
  const peCandidates = sensexOobtstLive?.peCandidates || stepDetails?.peCandidates || stepDetails?.step1?.peCandidates || [];

  const step1 = {
    ceStrike: sensexOobtstLive?.ceLeg.symbol || stepDetails?.step1?.ceStrike || '--',
    ceOpen: sensexOobtstLive?.ceLeg.openPrice || stepDetails?.step1?.ceOpen || 0,
    peStrike: sensexOobtstLive?.peLeg.symbol || stepDetails?.step1?.peStrike || '--',
    peOpen: sensexOobtstLive?.peLeg.openPrice || stepDetails?.step1?.peOpen || 0,
    timestamp: sensexOobtstLive?.anchorTime || stepDetails?.step1?.timestamp || '09:20:00 IST',
    isLocked,
    isProvisional,
    isMarketClosed,
    isLockFailed,
    lockFailureReason,
    previewAvailable,
    targetPremium,
  };

  const step2 = {
    ceTrigger: sensexOobtstLive?.ceLeg.triggerPrice || stepDetails?.step2?.ceTrigger || 0,
    ceLtp: sensexOobtstLive?.ceLeg.currentLtp || stepDetails?.step2?.ceLtp || 0,
    peTrigger: sensexOobtstLive?.peLeg.triggerPrice || stepDetails?.step2?.peTrigger || 0,
    peLtp: sensexOobtstLive?.peLeg.currentLtp || stepDetails?.step2?.peLtp || 0,
    ceHigh: sensexOobtstLive?.ceLeg.armedHigh ?? stepDetails?.step2?.ceHigh ?? 0,
    peHigh: sensexOobtstLive?.peLeg.armedHigh ?? stepDetails?.step2?.peHigh ?? 0,
    ceDayHigh: sensexOobtstLive?.ceLeg.dayHigh ?? stepDetails?.step2?.ceDayHigh ?? 0,
    peDayHigh: sensexOobtstLive?.peLeg.dayHigh ?? stepDetails?.step2?.peDayHigh ?? 0,
    multiplier: 1.5,
  };

  const step3 = {
    executedSymbol: sensexOobtstLive?.executedSymbol || stepDetails?.step3?.executedSymbol || '--',
    executedPrice: sensexOobtstLive?.executedPrice || stepDetails?.step3?.executedPrice || 0,
    slPrice: sensexOobtstLive?.slPrice || stepDetails?.step3?.slPrice || 0,
    status: sensexOobtstLive?.status || stepDetails?.step3?.status || 'SCANNING',
    riskPerLot: sensexOobtstLive?.riskPerLot || stepDetails?.step3?.riskPerLot || 0,
  };

  let statusBadgeText = sensexOobtstLive?.statusBadgeText;
  if (!statusBadgeText) {
    if (isLockFailed) statusBadgeText = 'LOCK FAILED — DATA UNAVAILABLE';
    else if (isMarketClosed) statusBadgeText = previewAvailable ? 'PREVIEW — NOT CONFIRMED' : 'PREVIEW UNAVAILABLE';
    else if (isProvisional) statusBadgeText = 'PROVISIONAL_STRIKES';
    else if (isLocked) statusBadgeText = 'LOCKED / ARMED_1.5X';
    else statusBadgeText = 'SCANNING';
  }

  const handleSelectTarget = async (val: number) => {
    Haptics.selectionAsync();
    setTargetError(null);
    setIsEditingCustomTarget(false);
    if (setTargetPremium) {
      await setTargetPremium(val);
    }
  };

  const handleApplyCustomTarget = async () => {
    const num = parseFloat(customTargetText.trim());
    if (isNaN(num) || num <= 0) {
      setTargetError('Please enter a valid positive target premium (> 0)');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setTargetError(null);
    if (setTargetPremium) {
      await setTargetPremium(Number(num.toFixed(2)));
    }
    setIsEditingCustomTarget(false);
    setCustomTargetText('');
  };

  const isCeExecuted = currentStep === 3 && step3.executedSymbol.includes('CE');
  const isPeExecuted = currentStep === 3 && step3.executedSymbol.includes('PE');
  const isCeCancelled = currentStep === 3 && !isCeExecuted;
  const isPeCancelled = currentStep === 3 && !isPeExecuted;

  const activeLtp = isPeExecuted ? step2.peLtp : step2.ceLtp;
  const pnlPerShare = currentStep === 3 && step3.executedPrice > 0 ? (activeLtp - step3.executedPrice) : 0;
  const pnlPerLot = pnlPerShare * SENSEX_LOT_SIZE;

  const ceProgress = triggerProgressPct(step2.ceHigh || step2.ceLtp, step2.ceTrigger);
  const peProgress = triggerProgressPct(step2.peHigh || step2.peLtp, step2.peTrigger);

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.obsidian} />

        {/* Top Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => {
              Haptics.selectionAsync();
              onClose();
            }}
          >
            <Text style={styles.backBtnText}>✕ Close</Text>
          </TouchableOpacity>

          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerTitle}>⚡ SENSEX 09:20 OOBTST</Text>
            <Text style={styles.headerSubtitle}>Open Opportunity BTST • 3 Steps</Text>
          </View>

          <View style={styles.stagePill}>
            <Text style={styles.stagePillText}>STEP {currentStep}/3</Text>
          </View>
        </View>

        {/* Content ScrollView */}
        <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
          {/* Date-Wise Session Selector */}
          <View style={styles.dateSelectorContainer}>
            <Text style={styles.dateSelectorLabel}>SESSION DATE (SENSEX 09:20 STRIKE LOCK)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dateChipsRow}>
              <TouchableOpacity
                style={[styles.dateChip, !selectedHistoryDate && styles.dateChipActive]}
                onPress={() => handleSelectHistoryDate(null)}
              >
                <Text style={[styles.dateChipText, !selectedHistoryDate && styles.dateChipTextActive]}>
                  ⚡ Today (Live)
                </Text>
              </TouchableOpacity>
              {availableLockDates.map((d) => (
                <TouchableOpacity
                  key={d}
                  style={[styles.dateChip, selectedHistoryDate === d && styles.dateChipActive]}
                  onPress={() => handleSelectHistoryDate(d)}
                >
                  <Text style={[styles.dateChipText, selectedHistoryDate === d && styles.dateChipTextActive]}>
                    📅 {d}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Historical Record Banner (When past date is selected) */}
          {selectedHistoryDate && (
            <View style={styles.historyCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Text style={styles.historyTitle}>🗓️ ARCHIVED SENSEX 09:20 LOCK • {selectedHistoryDate}</Text>
                <TouchableOpacity onPress={() => handleSelectHistoryDate(null)}>
                  <Text style={{ fontSize: 10, color: colors.purple, fontWeight: '700' }}>↺ Back to Live</Text>
                </TouchableOpacity>
              </View>
              {historyRecord ? (
                <View>
                  <Text style={styles.historyText}>
                    Spot at Lock: <Text style={{ fontWeight: '800' }}>₹{historyRecord.underlying_spot}</Text> • Time: <Text style={{ fontWeight: '800' }}>{historyRecord.lock_time}</Text>
                  </Text>
                  <Text style={styles.historyText}>
                    CE: <Text style={{ fontWeight: '800', color: colors.bullish }}>{historyRecord.ce_symbol}</Text> @ ₹{historyRecord.ce_open_price} (Trigger: ₹{historyRecord.ce_trigger_price})
                  </Text>
                  <Text style={styles.historyText}>
                    PE: <Text style={{ fontWeight: '800', color: colors.bearish }}>{historyRecord.pe_symbol}</Text> @ ₹{historyRecord.pe_open_price} (Trigger: ₹{historyRecord.pe_trigger_price})
                  </Text>
                  <Text style={styles.historySubText}>
                    Session Status: <Text style={{ fontWeight: '800', color: colors.purple }}>{historyRecord.status}</Text>
                    {historyRecord.execution_side ? ` • Executed: ${historyRecord.execution_side} @ ₹${historyRecord.execution_price}` : ''}
                  </Text>
                </View>
              ) : (
                <Text style={styles.historySubText}>No locked strikes recorded for {selectedHistoryDate}.</Text>
              )}
            </View>
          )}

          {/* Strategy Meta Summary */}
          <View style={styles.metaBanner}>
            <View>
              <Text style={styles.metaLabel}>ENGINE LIFECYCLE</Text>
              <Text style={styles.metaValue}>
                {currentStep === 3
                  ? (step3.status === 'SL_HIT' ? '🛑 STOP LOSS HIT' : step3.status === 'BTST_HOLD' ? '🌙 BTST OVERNIGHT HOLD' : '🔥 OOBTST POSITION ACTIVE')
                  : currentStep === 2
                  ? '⚡ ARMED 1.5x BREAKOUT'
                  : isProvisional
                  ? '⚡ PROVISIONAL CANDIDATES (09:15 - 09:20)'
                  : '⚪ MARKET CLOSED (STRIKES UNLOCKED)'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.metaLabel}>TIME (IST)</Text>
              <Text style={styles.metaTime}>{istTime}</Text>
            </View>
          </View>

          {/* Data Quality & Connectivity Warning Banner */}
          {(feedStatus === 'ERROR' || quoteFreshness === 'DISCONNECTED' || quoteFreshness === 'STALE') && (
            <View
              style={[
                styles.warningBanner,
                {
                  backgroundColor:
                    quoteFreshness === 'STALE' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  borderColor:
                    quoteFreshness === 'STALE' ? 'rgba(234, 179, 8, 0.4)' : 'rgba(239, 68, 68, 0.4)',
                },
              ]}
            >
              <Text
                style={[
                  styles.warningBannerText,
                  { color: quoteFreshness === 'STALE' ? colors.warning : colors.bearish },
                ]}
              >
                {quoteFreshness === 'DISCONNECTED' || feedStatus === 'ERROR'
                  ? '⚠️ Dhan HQ Live Feed Disconnected • Showing cached/offline data. Reconnecting...'
                  : '⚠️ Option quotes are aging or stale (> 15s) • Verify Dhan HQ market data connection'}
              </Text>
            </View>
          )}

          {/* Configurable Target Premium Bar */}
          <View style={styles.targetConfigContainer}>
            <View style={styles.targetConfigHeader}>
              <Text style={styles.targetConfigTitle}>
                TARGET PREMIUM: <Text style={{ color: colors.cyan, fontWeight: '800' }}>₹{targetPremium.toFixed(2)}</Text>
              </Text>
              {isLocked && (
                <Text style={styles.lockedNoticeText}>🔒 LOCKED FOR TODAY'S SESSION</Text>
              )}
            </View>

            <View style={styles.targetChipsRow}>
              {[90.00, 95.00, 100.00, 105.00, 110.00, 120.00].map((val) => {
                const isActive = Math.abs(targetPremium - val) < 0.01;
                return (
                  <TouchableOpacity
                    key={val}
                    style={[styles.targetChip, isActive && styles.targetChipActive]}
                    onPress={() => handleSelectTarget(val)}
                  >
                    <Text style={[styles.targetChipText, isActive && styles.targetChipTextActive]}>
                      ₹{val.toFixed(2)}{val === 100.00 ? ' (Default)' : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.targetChip, isEditingCustomTarget && styles.targetChipActive]}
                onPress={() => {
                  Haptics.selectionAsync();
                  setIsEditingCustomTarget(!isEditingCustomTarget);
                }}
              >
                <Text style={[styles.targetChipText, isEditingCustomTarget && styles.targetChipTextActive]}>
                  Custom...
                </Text>
              </TouchableOpacity>
            </View>

            {isEditingCustomTarget && (
              <View style={styles.customInputContainer}>
                <TextInput
                  style={styles.customTextInput}
                  placeholder="e.g. 100.00"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                  value={customTargetText}
                  onChangeText={setCustomTargetText}
                />
                <TouchableOpacity style={styles.customApplyBtn} onPress={handleApplyCustomTarget}>
                  <Text style={styles.customApplyBtnText}>Apply</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.customCancelBtn}
                  onPress={() => {
                    setIsEditingCustomTarget(false);
                    setTargetError(null);
                  }}
                >
                  <Text style={styles.customCancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}

            {targetError && <Text style={styles.targetErrorText}>{targetError}</Text>}
          </View>

          {/* STEP 1 CARD */}
          <View style={[styles.stepCard, currentStep >= 1 && styles.stepCardActive]}>
            <View style={styles.stepHeader}>
              <View
                style={[
                  styles.stepNumberBadge,
                  isLockFailed
                    ? { backgroundColor: colors.bearish }
                    : isMarketClosed
                    ? { backgroundColor: colors.surfaceSubtle }
                    : isProvisional
                    ? { backgroundColor: colors.cyan }
                    : { backgroundColor: colors.bullish },
                ]}
              >
                <Text
                  style={[
                    styles.stepNumberText,
                    isProvisional || (!isMarketClosed && !isLockFailed) ? { color: colors.obsidian } : {},
                  ]}
                >
                  STEP 1
                </Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>
                  09:20 Candle Open Selection (~₹{targetPremium.toFixed(2)})
                </Text>
                <Text style={styles.stepSub}>
                  {isLockFailed
                    ? 'Lock Failed: Missing or invalid quote data at 09:20 candle start'
                    : isMarketClosed
                    ? previewAvailable
                      ? 'Market Closed: Prior-session preview candidates shown (Not Confirmed)'
                      : 'Market Closed: Preview unavailable (Awaiting 09:15 open)'
                    : isProvisional
                    ? 'Provisional Window (09:15–09:19:59): 300ms live monitoring from Dhan ticks'
                    : 'Locked precisely at 09:20:00 IST candle opening tick'}
                </Text>
              </View>
              <View
                style={[
                  styles.stepLockBadge,
                  isLockFailed
                    ? { backgroundColor: 'rgba(239, 68, 68, 0.15)' }
                    : isMarketClosed
                    ? { backgroundColor: 'rgba(234, 179, 8, 0.15)' }
                    : isProvisional
                    ? { backgroundColor: 'rgba(6, 182, 212, 0.15)' }
                    : isLocked
                    ? { backgroundColor: 'rgba(16, 185, 129, 0.15)' }
                    : { backgroundColor: 'rgba(255, 255, 255, 0.05)' },
                ]}
              >
                <Text
                  style={[
                    styles.stepLockText,
                    {
                      color: isLockFailed
                        ? colors.bearish
                        : isMarketClosed
                        ? colors.warning
                        : isProvisional
                        ? colors.cyan
                        : isLocked
                        ? colors.bullish
                        : colors.textMuted,
                    },
                  ]}
                >
                  {statusBadgeText}
                </Text>
              </View>
            </View>

            {/* Lock Failed Callout */}
            {isLockFailed && (
              <View style={[styles.calloutBox, { backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.3)' }]}>
                <Text style={[styles.calloutTitle, { color: colors.bearish }]}>
                  ❌ LOCK FAILED — DATA UNAVAILABLE
                </Text>
                <Text style={[styles.calloutDesc, { color: colors.textSecondary }]}>
                  {lockFailureReason || 'Exact opening price or valid quotes were unavailable at 09:20:00 IST.'}
                </Text>
                <Text style={[styles.calloutDesc, { color: colors.textMuted, marginTop: 4 }]}>
                  Strategy arming was prevented to protect capital. Stale or fabricated prices are never substituted silently.
                </Text>
              </View>
            )}

            {/* Market Closed Preview Callout */}
            {isMarketClosed && (
              <View style={[styles.calloutBox, { backgroundColor: 'rgba(234, 179, 8, 0.08)', borderColor: 'rgba(234, 179, 8, 0.25)' }]}>
                <Text style={[styles.calloutTitle, { color: colors.warning }]}>
                  {previewAvailable ? '👁 PREVIEW — NOT CONFIRMED' : '⚠️ PREVIEW UNAVAILABLE'}
                </Text>
                <Text style={[styles.calloutDesc, { color: colors.textSecondary }]}>
                  {previewAvailable
                    ? 'Market is currently closed. Showing top 2 CE and 2 PE strikes closest to target premium from latest available BSE option chain. These prices are NOT confirmed.'
                    : 'Option chain data is currently unavailable. Awaiting market open at 09:15 IST.'}
                </Text>
              </View>
            )}

            {/* Provisional Monitoring Callout */}
            {isProvisional && (
              <View style={[styles.calloutBox, { backgroundColor: 'rgba(6, 182, 212, 0.08)', borderColor: 'rgba(6, 182, 212, 0.25)' }]}>
                <Text style={[styles.calloutTitle, { color: colors.cyan }]}>
                  ⚡ LIVE PROVISIONAL MONITORING (09:15 - 09:19:59 IST)
                </Text>
                <Text style={[styles.calloutDesc, { color: colors.textSecondary }]}>
                  Recalculating top two candidates every 300ms from Dhan live ticks. At 09:20:00, the closest strike in ₹90–₹120 range locks permanently for the day.
                </Text>
              </View>
            )}

            {/* Locked Notice Callout */}
            {isLocked && !isLockFailed && (
              <View style={[styles.calloutBox, { backgroundColor: 'rgba(16, 185, 129, 0.08)', borderColor: 'rgba(16, 185, 129, 0.25)' }]}>
                <Text style={[styles.calloutTitle, { color: colors.bullish }]}>
                  🔒 LOCKED AT 09:20:00 CANDLE OPEN
                </Text>
                <Text style={[styles.calloutDesc, { color: colors.textSecondary }]}>
                  Selected CE ({step1.ceStrike} @ ₹{step1.ceOpen.toFixed(2)}) and PE ({step1.peStrike} @ ₹{step1.peOpen.toFixed(2)}) are permanently locked for today's session.
                </Text>
              </View>
            )}

            {/* 2 CE CANDIDATES */}
            <View style={styles.candidateSection}>
              <View style={styles.candidateSectionHeader}>
                <Text style={[styles.candidateSectionTitle, { color: colors.bullish }]}>
                  CALL (CE) CANDIDATES (Target ~₹{targetPremium.toFixed(2)})
                </Text>
              </View>
              <View style={styles.candidateRow}>
                {ceCandidates.length > 0 ? (
                  ceCandidates.map((c) => {
                    const isLockedItem = isLocked && step1.ceStrike.includes(String(c.strike));
                    const tagColor = colors.bullish;
                    const tagBg = 'rgba(16, 185, 129, 0.15)';
                    const rankLabel = c.rank === 1 ? '#1 PRIMARY' : '#2 RUNNER-UP';
                    const freshnessColor =
                      c.quoteAgeMs < 5000
                        ? colors.bullish
                        : c.quoteAgeMs < 15000
                        ? colors.warning
                        : colors.bearish;
                    const freshnessText =
                      c.quoteAgeMs < 5000 ? 'FRESH' : c.quoteAgeMs < 15000 ? 'AGING' : 'STALE';

                    return (
                      <View
                        key={`CE-${c.strike}-${c.rank}`}
                        style={[
                          styles.candidateCard,
                          c.rank === 1 && styles.primaryCandidateCard,
                          isLockedItem && styles.lockedCandidateCard,
                        ]}
                      >
                        <View style={styles.candidateHeader}>
                          <View style={[styles.rankTag, { backgroundColor: tagBg }]}>
                            <Text style={[styles.rankTagText, { color: tagColor }]}>{rankLabel}</Text>
                          </View>
                          <View style={[styles.freshnessTag, { borderColor: freshnessColor }]}>
                            <Text style={[styles.freshnessText, { color: freshnessColor }]}>
                              {c.isStale ? '⚠️ STALE' : freshnessText}
                            </Text>
                          </View>
                        </View>

                        <Text style={styles.candidateSymbol}>{c.symbol}</Text>

                        <View style={styles.candidatePriceRow}>
                          <Text style={styles.candidatePriceLabel}>LTP:</Text>
                          <Text style={styles.candidatePriceValue}>
                            {c.ltp > 0 ? `₹${c.ltp.toFixed(2)}` : '₹--'}
                          </Text>
                        </View>

                        <View style={styles.candidateDiffRow}>
                          <Text style={styles.candidateDiffLabel}>Δ Target:</Text>
                          <Text style={[styles.candidateDiffValue, { color: colors.cyan }]}>
                            {c.ltp > 0 ? `|${(c.ltp - targetPremium).toFixed(2)}| = ₹${c.diffFromTarget.toFixed(2)}` : '--'}
                          </Text>
                        </View>

                        <View style={styles.candidateTimeRow}>
                          <Text style={styles.candidateTimeText}>
                            {c.quoteTimestamp} ({c.quoteAgeMs < 1000 ? '<1s' : `${(c.quoteAgeMs / 1000).toFixed(1)}s`} ago)
                          </Text>
                        </View>
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.selectionBox}>
                    <Text style={styles.boxSymbol}>{step1.ceStrike}</Text>
                    <Text style={styles.boxOpenPrice}>
                      {step1.ceOpen > 0 ? `₹${step1.ceOpen.toFixed(2)}` : 'Awaiting option quotes...'}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* 2 PE CANDIDATES */}
            <View style={styles.candidateSection}>
              <View style={styles.candidateSectionHeader}>
                <Text style={[styles.candidateSectionTitle, { color: colors.bearish }]}>
                  PUT (PE) CANDIDATES (Target ~₹{targetPremium.toFixed(2)})
                </Text>
              </View>
              <View style={styles.candidateRow}>
                {peCandidates.length > 0 ? (
                  peCandidates.map((c) => {
                    const isLockedItem = isLocked && step1.peStrike.includes(String(c.strike));
                    const tagColor = colors.bearish;
                    const tagBg = 'rgba(239, 68, 68, 0.15)';
                    const rankLabel = c.rank === 1 ? '#1 PRIMARY' : '#2 RUNNER-UP';
                    const freshnessColor =
                      c.quoteAgeMs < 5000
                        ? colors.bullish
                        : c.quoteAgeMs < 15000
                        ? colors.warning
                        : colors.bearish;
                    const freshnessText =
                      c.quoteAgeMs < 5000 ? 'FRESH' : c.quoteAgeMs < 15000 ? 'AGING' : 'STALE';

                    return (
                      <View
                        key={`PE-${c.strike}-${c.rank}`}
                        style={[
                          styles.candidateCard,
                          c.rank === 1 && styles.primaryCandidateCard,
                          isLockedItem && styles.lockedCandidateCard,
                        ]}
                      >
                        <View style={styles.candidateHeader}>
                          <View style={[styles.rankTag, { backgroundColor: tagBg }]}>
                            <Text style={[styles.rankTagText, { color: tagColor }]}>{rankLabel}</Text>
                          </View>
                          <View style={[styles.freshnessTag, { borderColor: freshnessColor }]}>
                            <Text style={[styles.freshnessText, { color: freshnessColor }]}>
                              {c.isStale ? '⚠️ STALE' : freshnessText}
                            </Text>
                          </View>
                        </View>

                        <Text style={styles.candidateSymbol}>{c.symbol}</Text>

                        <View style={styles.candidatePriceRow}>
                          <Text style={styles.candidatePriceLabel}>LTP:</Text>
                          <Text style={styles.candidatePriceValue}>
                            {c.ltp > 0 ? `₹${c.ltp.toFixed(2)}` : '₹--'}
                          </Text>
                        </View>

                        <View style={styles.candidateDiffRow}>
                          <Text style={styles.candidateDiffLabel}>Δ Target:</Text>
                          <Text style={[styles.candidateDiffValue, { color: colors.cyan }]}>
                            {c.ltp > 0 ? `|${(c.ltp - targetPremium).toFixed(2)}| = ₹${c.diffFromTarget.toFixed(2)}` : '--'}
                          </Text>
                        </View>

                        <View style={styles.candidateTimeRow}>
                          <Text style={styles.candidateTimeText}>
                            {c.quoteTimestamp} ({c.quoteAgeMs < 1000 ? '<1s' : `${(c.quoteAgeMs / 1000).toFixed(1)}s`} ago)
                          </Text>
                        </View>
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.selectionBox}>
                    <Text style={styles.boxSymbol}>{step1.peStrike}</Text>
                    <Text style={styles.boxOpenPrice}>
                      {step1.peOpen > 0 ? `₹${step1.peOpen.toFixed(2)}` : 'Awaiting option quotes...'}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            <View style={styles.quantExplainer}>
              <Text style={styles.quantExplainerText}>
                💡 <Text style={{ fontWeight: '700' }}>Quant Rationale:</Text> ₹{targetPremium.toFixed(2)} target premium identifies BSE Sensex strikes (~0.20-0.25 Delta) in the ₹90–₹120 range with low entry premium (~₹{Math.round(targetPremium * SENSEX_LOT_SIZE).toLocaleString('en-IN')}/lot) and high gamma acceleration potential.
              </Text>
            </View>
          </View>

          {/* Stepper Connector Line */}
          <View style={styles.stepperConnector}>
            <View style={styles.stepperLine} />
            <Text style={styles.stepperArrow}>▼</Text>
            <View style={styles.stepperLine} />
          </View>

          {/* STEP 2 CARD */}
          <View style={[styles.stepCard, currentStep >= 2 && styles.stepCardActive]}>
            <View style={styles.stepHeader}>
              <View
                style={[
                  styles.stepNumberBadge,
                  currentStep >= 2
                    ? { backgroundColor: colors.cyan }
                    : { backgroundColor: colors.surfaceSubtle },
                ]}
              >
                <Text
                  style={[
                    styles.stepNumberText,
                    currentStep >= 2 ? { color: colors.obsidian } : {},
                  ]}
                >
                  STEP 2
                </Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>1.5x Dual Momentum Breakout Trigger</Text>
                <Text style={styles.stepSub}>Buy Trigger = 09:20 Open Price × 1.5</Text>
              </View>
              <View
                style={[
                  styles.stepLockBadge,
                  currentStep >= 2
                    ? { backgroundColor: 'rgba(6, 182, 212, 0.15)' }
                    : { backgroundColor: 'rgba(255, 255, 255, 0.05)' },
                ]}
              >
                <Text
                  style={[
                    styles.stepLockText,
                    { color: currentStep >= 2 ? colors.cyan : colors.textMuted },
                  ]}
                >
                  {currentStep >= 2 ? '⚡ ARMED' : '⏳ PENDING 09:20'}
                </Text>
              </View>
            </View>

            {/* CE Trigger Bar */}
            <View style={styles.triggerItem}>
              <View style={styles.triggerRow}>
                <Text style={styles.triggerSymbol}>{step1.ceStrike}</Text>
                <View
                  style={
                    isCeExecuted
                      ? styles.triggerBadgeActive
                      : isCeCancelled
                      ? styles.triggerBadgeCancelled
                      : currentStep >= 2
                      ? styles.triggerBadgeArmed
                      : styles.triggerBadgeCancelled
                  }
                >
                  <Text
                    style={
                      isCeExecuted
                        ? styles.triggerBadgeActiveText
                        : isCeCancelled
                        ? styles.triggerBadgeCancelledText
                        : currentStep >= 2
                        ? styles.triggerBadgeArmedText
                        : styles.triggerBadgeCancelledText
                    }
                  >
                    {isCeExecuted
                      ? '🟢 EXECUTED (CROSS 1.5x)'
                      : isCeCancelled
                      ? '❌ CANCELLED (OCO)'
                      : currentStep >= 2
                      ? '⚡ ARMED (WAITING 1.5x)'
                      : '⏳ PENDING'}
                  </Text>
                </View>
              </View>
              <View style={styles.triggerMetrics}>
                <Text style={styles.triggerMetricText}>
                  1.5x Trigger: <Text style={styles.boldWhite}>{step2.ceTrigger > 0 ? `₹${step2.ceTrigger.toFixed(2)}` : '--'}</Text>
                </Text>
                <Text style={styles.triggerMetricText}>
                  LTP: <Text style={[styles.boldWhite, { color: isCeExecuted ? colors.bullish : colors.textPrimary }]}>{step2.ceLtp > 0 ? `₹${step2.ceLtp.toFixed(2)}` : '--'}</Text>{step2.ceDayHigh > 0 ? ` • Day High ₹${step2.ceDayHigh.toFixed(2)}` : ''}{step2.ceTrigger > 0 ? ` (${ceProgress}%)` : ''}
                </Text>
              </View>
              <View style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${ceProgress}%`,
                      backgroundColor: isCeExecuted ? colors.bullish : isCeCancelled ? colors.textMuted : colors.cyan,
                    },
                  ]}
                />
              </View>
            </View>

            {/* PE Trigger Bar */}
            <View style={[styles.triggerItem, { marginTop: 10 }]}>
              <View style={styles.triggerRow}>
                <Text style={styles.triggerSymbol}>{step1.peStrike}</Text>
                <View
                  style={
                    isPeExecuted
                      ? styles.triggerBadgeActive
                      : isPeCancelled
                      ? styles.triggerBadgeCancelled
                      : currentStep >= 2
                      ? styles.triggerBadgeArmed
                      : styles.triggerBadgeCancelled
                  }
                >
                  <Text
                    style={
                      isPeExecuted
                        ? styles.triggerBadgeActiveText
                        : isPeCancelled
                        ? styles.triggerBadgeCancelledText
                        : currentStep >= 2
                        ? styles.triggerBadgeArmedText
                        : styles.triggerBadgeCancelledText
                    }
                  >
                    {isPeExecuted
                      ? '🟢 EXECUTED (CROSS 1.5x)'
                      : isPeCancelled
                      ? '❌ CANCELLED (OCO)'
                      : currentStep >= 2
                      ? '⚡ ARMED (WAITING 1.5x)'
                      : '⏳ PENDING'}
                  </Text>
                </View>
              </View>
              <View style={styles.triggerMetrics}>
                <Text style={styles.triggerMetricText}>
                  1.5x Trigger: <Text style={styles.boldWhite}>{step2.peTrigger > 0 ? `₹${step2.peTrigger.toFixed(2)}` : '--'}</Text>
                </Text>
                <Text style={styles.triggerMetricText}>
                  LTP: <Text style={[styles.boldWhite, { color: isPeExecuted ? colors.bullish : colors.textPrimary }]}>{step2.peLtp > 0 ? `₹${step2.peLtp.toFixed(2)}` : '--'}</Text>{step2.peDayHigh > 0 ? ` • Day High ₹${step2.peDayHigh.toFixed(2)}` : ''}{step2.peTrigger > 0 ? ` (${peProgress}%)` : ''}
                </Text>
              </View>
              <View style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${peProgress}%`,
                      backgroundColor: isPeExecuted ? colors.bullish : isPeCancelled ? colors.textMuted : colors.cyan,
                    },
                  ]}
                />
              </View>
            </View>

            <View style={styles.quantExplainer}>
              <Text style={styles.quantExplainerText}>
                🛡️ <Text style={{ fontWeight: '700' }}>False Breakout Shield:</Text> If market is sideways/chop, neither leg breaches 1.5x. Zero trades execute, protecting capital from decay.
              </Text>
            </View>
          </View>

          {/* Stepper Connector Line */}
          <View style={styles.stepperConnector}>
            <View style={styles.stepperLine} />
            <Text style={styles.stepperArrow}>▼</Text>
            <View style={styles.stepperLine} />
          </View>

          {/* STEP 3 CARD */}
          <View style={[styles.stepCard, currentStep === 3 && styles.stepCardActiveBorder]}>
            <View style={styles.stepHeader}>
              <View style={[styles.stepNumberBadge, { backgroundColor: colors.bullish }]}>
                <Text style={[styles.stepNumberText, { color: colors.obsidian }]}>STEP 3</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>Open Opportunity BTST (OOBTST)</Text>
                <Text style={styles.stepSub}>Triggered Leg Position & Strict 50% Stop Loss</Text>
              </View>
              <View style={[styles.stepLockBadge, { backgroundColor: currentStep === 3 ? colors.bullishGlow : 'rgba(255, 255, 255, 0.05)' }]}>
                <Text style={[styles.stepLockText, { color: currentStep === 3 ? colors.bullish : colors.textMuted }]}>
                  {currentStep === 3 ? (step3.status === 'SL_HIT' ? '🛑 SL HIT' : step3.status === 'BTST_HOLD' ? '🌙 BTST HOLD' : '🔥 OOBTST') : '⏳ AWAITING'}
                </Text>
              </View>
            </View>

            {/* Active Position Hero Card */}
            {currentStep === 3 ? (
              <View style={styles.oobtstHero}>
                <View style={styles.oobtstHeroTop}>
                  <View>
                    <Text style={styles.oobtstTag}>EXECUTED OPPORTUNITY</Text>
                    <Text style={styles.oobtstSymbol}>{step3.executedSymbol}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.oobtstTag}>POSITION TYPE</Text>
                    <Text style={styles.oobtstType}>{isPeExecuted ? 'LONG PE • BTST' : 'LONG CE • BTST'}</Text>
                  </View>
                </View>

                <View style={styles.oobtstGrid}>
                  <View style={styles.oobtstCell}>
                    <Text style={styles.cellLabel}>EXECUTED BUY PRICE</Text>
                    <Text style={styles.cellValue}>₹{step3.executedPrice.toFixed(2)}</Text>
                  </View>
                  <View style={styles.oobtstCell}>
                    <Text style={styles.cellLabel}>50% STOP LOSS (HALF)</Text>
                    <Text style={[styles.cellValue, { color: colors.bearish }]}>₹{step3.slPrice.toFixed(2)}</Text>
                  </View>
                  <View style={styles.oobtstCell}>
                    <Text style={styles.cellLabel}>MAX RISK / LOT ({SENSEX_LOT_SIZE})</Text>
                    <Text style={[styles.cellValue, { color: colors.bearish }]}>₹{step3.riskPerLot.toFixed(2)}</Text>
                  </View>
                  <View style={styles.oobtstCell}>
                    <Text style={styles.cellLabel}>LIVE UNREALIZED P&L</Text>
                    <Text style={[styles.cellValue, { color: pnlPerShare >= 0 ? colors.bullish : colors.bearish }]}>
                      {pnlPerShare >= 0 ? `+₹${pnlPerShare.toFixed(2)}` : `-₹${Math.abs(pnlPerShare).toFixed(2)}`}
                      <Text style={{ fontSize: 11 }}> ({pnlPerLot >= 0 ? `+₹${pnlPerLot.toFixed(0)}` : `-₹${Math.abs(pnlPerLot).toFixed(0)}`})</Text>
                    </Text>
                  </View>
                </View>
              </View>
            ) : currentStep === 2 ? (
              <View style={[styles.oobtstHero, { alignItems: 'center', paddingVertical: 18 }]}>
                <Text style={{ color: colors.cyan, fontSize: 13, fontWeight: '700', marginBottom: 6 }}>
                  ⚡ Awaiting 1.5x Breakout Breach
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 11, textAlign: 'center', lineHeight: 16 }}>
                  Both legs are actively armed. The instant CE reaches ₹{step2.ceTrigger.toFixed(2)} or PE reaches ₹{step2.peTrigger.toFixed(2)}, this card will execute with strict 50% SL locked.
                </Text>
              </View>
            ) : isProvisional ? (
              <View style={[styles.oobtstHero, { alignItems: 'center', paddingVertical: 18 }]}>
                <Text style={{ color: colors.cyan, fontSize: 13, fontWeight: '700', marginBottom: 6 }}>
                  ⚡ Step 1 Provisional Tracking (09:15 - 09:20 IST)
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 11, textAlign: 'center', lineHeight: 16 }}>
                  Scanning nearest BSE option strikes to ₹{targetPremium.toFixed(2)}. Target strikes lock permanently and 1.5x triggers activate at 09:20:00 IST.
                </Text>
              </View>
            ) : (
              <View style={[styles.oobtstHero, { alignItems: 'center', paddingVertical: 18 }]}>
                <Text style={{ color: colors.warning, fontSize: 13, fontWeight: '700', marginBottom: 6 }}>
                  ⚪ Market Closed (Strikes Unlocked)
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 11, textAlign: 'center', lineHeight: 16 }}>
                  Market opens at 09:15 IST. Candidate strikes will update provisionally from 09:15 to 09:20 AM and lock at 09:20 AM.
                </Text>
              </View>
            )}

            {/* Overnight Carry Banner */}
            <View style={styles.overnightBox}>
              <Text style={styles.overnightTitle}>🌙 BTST Overnight Holding Invariant</Text>
              <Text style={styles.overnightDesc}>
                If Stop Loss (₹{step3.slPrice.toFixed(2)}) is not hit before 15:30 IST, this position is held overnight into tomorrow morning (D+1). Target exit: 09:15–09:25 AM opening volatility gap.
              </Text>
            </View>

            {/* Note: Quick Action / Broker section completely removed per requirement */}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  safeArea: {
    flex: 1,
    backgroundColor: colors.obsidian,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  backBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  backBtnText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  headerTitleContainer: {
    alignItems: 'center',
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 1,
  },
  stagePill: {
    backgroundColor: colors.purpleGlow,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  stagePillText: {
    color: colors.purple,
    fontSize: 10,
    fontWeight: '800',
  },
  body: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  metaBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 14,
  },
  metaLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  metaValue: {
    color: colors.bullish,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  metaTime: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  stepCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 14,
  },
  stepCardActive: {
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  stepCardActiveBorder: {
    borderColor: colors.bullish,
    shadowColor: colors.bullish,
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  stepNumberBadge: {
    backgroundColor: colors.purple,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  stepNumberText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  stepTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  stepSub: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 1,
  },
  stepLockBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  stepLockText: {
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: '700',
  },
  selectionGrid: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  selectionBox: {
    flex: 1,
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  boxTag: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginBottom: 4,
  },
  boxTagText: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '800',
  },
  boxSymbol: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  boxOpenPrice: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
  boxDelta: {
    color: colors.textMuted,
    fontSize: 9,
    marginTop: 2,
  },
  quantExplainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    padding: 8,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.purple,
  },
  quantExplainerText: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  stepperConnector: {
    alignItems: 'center',
    marginVertical: 4,
  },
  stepperLine: {
    width: 2,
    height: 8,
    backgroundColor: colors.divider,
  },
  stepperArrow: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 14,
  },
  triggerItem: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  triggerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  triggerSymbol: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  triggerBadgeActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  triggerBadgeActiveText: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '800',
  },
  triggerBadgeCancelled: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  triggerBadgeCancelledText: {
    color: colors.bearish,
    fontSize: 9,
    fontWeight: '800',
  },
  triggerBadgeArmed: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  triggerBadgeArmedText: {
    color: colors.cyan,
    fontSize: 9,
    fontWeight: '800',
  },
  triggerMetrics: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  triggerMetricText: {
    color: colors.textMuted,
    fontSize: 10,
  },
  boldWhite: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  progressBarBg: {
    height: 6,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  oobtstHero: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
    padding: 12,
    marginBottom: 10,
  },
  oobtstHeroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    marginBottom: 8,
  },
  oobtstTag: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  oobtstSymbol: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    marginTop: 1,
  },
  oobtstType: {
    color: colors.bullish,
    fontSize: 11,
    fontWeight: '800',
    marginTop: 1,
  },
  oobtstGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 8,
  },
  oobtstCell: {
    width: '50%',
  },
  cellLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
  },
  cellValue: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
  overnightBox: {
    backgroundColor: 'rgba(168, 85, 247, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.25)',
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
  },
  overnightTitle: {
    color: colors.purple,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
  },
  overnightDesc: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  warningBanner: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
  },
  warningBannerText: {
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 16,
  },
  targetConfigContainer: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 14,
  },
  targetConfigHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  targetConfigTitle: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  lockedNoticeText: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '800',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  targetChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  targetChip: {
    backgroundColor: colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  targetChipActive: {
    backgroundColor: colors.purpleGlow,
    borderColor: colors.purple,
  },
  targetChipText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  targetChipTextActive: {
    color: colors.purple,
    fontWeight: '800',
  },
  customInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  customTextInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  customApplyBtn: {
    backgroundColor: colors.purple,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  customApplyBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  customCancelBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
  },
  customCancelBtnText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  targetErrorText: {
    color: colors.bearish,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 6,
  },
  calloutBox: {
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 10,
  },
  calloutTitle: {
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 2,
  },
  calloutDesc: {
    fontSize: 10,
    lineHeight: 14,
  },
  candidateSection: {
    marginBottom: 10,
  },
  candidateSectionHeader: {
    marginBottom: 6,
  },
  candidateSectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  candidateRow: {
    flexDirection: 'row',
    gap: 8,
  },
  candidateCard: {
    flex: 1,
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  primaryCandidateCard: {
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  lockedCandidateCard: {
    borderColor: colors.bullish,
    backgroundColor: 'rgba(16, 185, 129, 0.05)',
  },
  candidateHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  rankTag: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  rankTagText: {
    fontSize: 9,
    fontWeight: '800',
  },
  freshnessTag: {
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  freshnessText: {
    fontSize: 8,
    fontWeight: '700',
  },
  candidateSymbol: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  candidatePriceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  candidatePriceLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  candidatePriceValue: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  candidateDiffRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  candidateDiffLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  candidateDiffValue: {
    fontSize: 10,
    fontWeight: '700',
  },
  candidateTimeRow: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: 3,
  },
  candidateTimeText: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '500',
  },
  dateSelectorContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  dateSelectorLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  dateChipsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dateChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.card,
  },
  dateChipActive: {
    backgroundColor: colors.purpleGlow,
    borderColor: colors.purple,
  },
  dateChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  dateChipTextActive: {
    color: colors.purple,
    fontWeight: '800',
  },
  historyCard: {
    margin: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  historyTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.purple,
    marginBottom: 8,
  },
  historyText: {
    fontSize: 12,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  historySubText: {
    fontSize: 11,
    color: colors.textMuted,
  },
}));
