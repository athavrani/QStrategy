import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BaseStrategyPlugin, StrategyContext, StrategySignalOutput } from '../types';
import { useTheme, createThemedStyles } from '../../theme';
import { sensexOptionFeedService } from '../../services/sensexOptionFeedService';
import * as Haptics from 'expo-haptics';
import { SENSEX_LOT_SIZE } from '../../constants/lotSizes';

export const SensexOobtstPlugin: BaseStrategyPlugin = {
  id: 'SENSEX_OOBTST',
  name: 'SENSEX 09:20 OOBTST (100)',
  tagline: 'Open Opportunity BTST • 1.5x Breakout & 50% SL',
  icon: '⚡',
  category: 'INDEX_OPTIONS',
  executionStyle: 'TIME_TRIGGERED',
  operatingWindow: {
    startIST: '09:20:00',
    endIST: '09:25:00', // D+1 exit
    isOvernightAllowed: true,
  },
  hasZeroTargetInvariant: true,

  evaluate: (ctx: StrategyContext): StrategySignalOutput => {
    const live = ctx.sensexOobtstLiveState || sensexOptionFeedService.evaluateSensexOobtst(ctx.sensexSpot || 0, ctx.istTime);

    const isStep3 = live.currentStep === 3;
    const isStep2 = live.currentStep === 2;

    const ceSymbol = live.ceLeg.symbol;
    const peSymbol = live.peLeg.symbol;
    const ceOpen = live.ceLeg.openPrice;
    const peOpen = live.peLeg.openPrice;
    const ceTrigger = live.ceLeg.triggerPrice;
    const peTrigger = live.peLeg.triggerPrice;
    const ceLtp = live.ceLeg.currentLtp;
    const peLtp = live.peLeg.currentLtp;

    const executedSymbol = live.executedSymbol || (live.activeLeg === 'PE' ? peSymbol : ceSymbol);
    const executedPrice = live.executedPrice || (live.activeLeg === 'PE' ? peTrigger : ceTrigger);
    const slPrice = live.slPrice || (executedPrice > 0 ? +(executedPrice / 2).toFixed(2) : 0);
    const riskPerLot = live.riskPerLot || (executedPrice > 0 ? +((executedPrice - slPrice) * SENSEX_LOT_SIZE).toFixed(2) : 0);
    const pnlLot = live.pnlPerLot ?? 0;

    let badgeTone: 'purple' | 'bullish' | 'bearish' | 'warning' | 'cyan' = 'cyan';
    if (live.status === 'LOCK_FAILED' || live.isLockFailed) badgeTone = 'bearish';
    else if (live.isMarketClosed) badgeTone = 'warning';
    else if (live.isProvisional) badgeTone = 'cyan';
    else if (live.status === 'ACTIVE') badgeTone = 'purple';
    else if (live.status === 'BTST_HOLD') badgeTone = 'bullish';
    else if (live.status === 'SL_HIT') badgeTone = 'bearish';
    else if (live.status === 'ARMED') badgeTone = 'cyan';

    const targetLabel = live.targetPremium ? `₹${live.targetPremium.toFixed(2)}` : '₹100.00';
    let headline = `Step 2: 1.5x Breakout Armed (CE: ₹${ceTrigger} • PE: ₹${peTrigger})`;
    let primaryMetricLabel = '1.5x BREAKOUT TARGET';
    let primaryMetricValue = `CE ₹${ceTrigger} / PE ₹${peTrigger}`;

    if (live.status === 'LOCK_FAILED' || live.isLockFailed) {
      headline = 'Step 1: Lock Failed • Data Unavailable at 09:20 Lock Point';
      primaryMetricLabel = 'LOCK STATUS';
      primaryMetricValue = 'DATA UNAVAILABLE';
    } else if (live.isMarketClosed) {
      headline = live.previewAvailable
        ? `Step 1: Market Closed • Preview Available (~${targetLabel})`
        : 'Step 1: Market Closed • Opens at 09:15 IST (Strikes Unlocked)';
      primaryMetricLabel = 'MARKET STATUS';
      primaryMetricValue = live.previewAvailable ? 'PREVIEW MODE' : 'OPENS 09:15 IST';
    } else if (live.isProvisional) {
      headline = `Step 1: Provisional Strikes (~${targetLabel}) • Locks at 09:20:00`;
      primaryMetricLabel = 'PROVISIONAL CANDIDATE';
      primaryMetricValue = ceOpen > 0 ? `CE ₹${ceOpen.toFixed(1)} / PE ₹${peOpen.toFixed(1)}` : 'UPDATING LIVE';
    } else if (isStep3) {
      headline = `Step 3: Open Opportunity BTST (${executedSymbol} ${live.status}) • SL: ₹${slPrice}`;
      primaryMetricLabel = 'NET SENSEX P&L';
      primaryMetricValue = `${pnlLot >= 0 ? `+₹${pnlLot.toFixed(0)}` : `-₹${Math.abs(pnlLot).toFixed(0)}`} / lot`;
    }

    let statusValue: 'IDLE' | 'PREPARING' | 'ARMED' | 'ACTIVE' | 'SL_HIT' = 'ARMED';
    if (live.status === 'LOCK_FAILED' || live.isLockFailed || live.isMarketClosed) statusValue = 'IDLE';
    else if (live.isProvisional) statusValue = 'PREPARING';
    else if (live.status === 'SL_HIT') statusValue = 'SL_HIT';
    else if (live.status === 'ACTIVE' || live.status === 'BTST_HOLD') statusValue = 'ACTIVE';

    return {
      status: statusValue,
      statusBadgeText: live.statusBadgeText,
      badgeTone,
      headline,
      primaryMetricLabel,
      primaryMetricValue,
      invariantNotice: '🛑 SENSEX OOBTST INVARIANT: STOP LOSS LOCKED AT 50% OF BUY PRICE • OCO OPPOSITE LEG CANCELLED',
      lastUpdated: live.lastUpdated || ctx.istTime,
      stepDetails: {
        currentStep: live.currentStep,
        targetPremium: live.targetPremium,
        ceCandidates: live.ceCandidates,
        peCandidates: live.peCandidates,
        quoteFreshness: live.quoteFreshness,
        step1: {
          ceStrike: ceSymbol,
          ceOpen,
          peStrike: peSymbol,
          peOpen,
          timestamp: live.anchorTime || '09:20:00 IST',
          isLocked: live.isLocked,
          isProvisional: live.isProvisional,
          isMarketClosed: live.isMarketClosed,
          isLockFailed: live.isLockFailed,
          lockFailureReason: live.lockFailureReason,
          previewAvailable: live.previewAvailable,
          targetPremium: live.targetPremium,
          ceCandidates: live.ceCandidates,
          peCandidates: live.peCandidates,
          quoteFreshness: live.quoteFreshness,
        },
        step2: {
          ceTrigger,
          ceLtp,
          peTrigger,
          peLtp,
          ceHigh: live.ceLeg.armedHigh,
          peHigh: live.peLeg.armedHigh,
          ceDayHigh: live.ceLeg.dayHigh,
          peDayHigh: live.peLeg.dayHigh,
          multiplier: 1.5,
        },
        step3: {
          executedSymbol,
          executedPrice,
          slPrice,
          status: live.status,
          riskPerLot,
        },
      },
      legs: [
        {
          type: 'CE',
          symbol: ceSymbol,
          strike: live.ceLeg.strike,
          refPrice: ceOpen,
          currentLtp: ceLtp,
          slPrice: live.activeLeg === 'CE' ? slPrice : undefined,
          targetPrice: undefined,
          status: live.ceLeg.status === 'EXECUTED' ? 'ACTIVE' : live.ceLeg.status === 'SL_HIT' ? 'SL_HIT' : live.ceLeg.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        },
        {
          type: 'PE',
          symbol: peSymbol,
          strike: live.peLeg.strike,
          refPrice: peOpen,
          currentLtp: peLtp,
          slPrice: live.activeLeg === 'PE' ? slPrice : undefined,
          targetPrice: undefined,
          status: live.peLeg.status === 'EXECUTED' ? 'ACTIVE' : live.peLeg.status === 'SL_HIT' ? 'SL_HIT' : live.peLeg.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        },
      ],
    };
  },

  renderCard: (props) => <SensexOobtstPluginCard {...props} />,
};

function SensexOobtstPluginCard({
  state,
  onViewDetails,
}: {
  state: StrategySignalOutput;
  onOpenBroker?: (symbol: string) => void;
  onViewDetails?: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles();

  const handleCardPress = () => {
    Haptics.selectionAsync();
    if (onViewDetails) {
      onViewDetails('SENSEX_OOBTST');
    }
  };

  const currentStep = state.stepDetails?.currentStep ?? 1;
  const step3 = state.stepDetails?.step3;
  const step1 = state.stepDetails?.step1;
  const step2 = state.stepDetails?.step2;
  const isMarketClosed = step1?.isMarketClosed ?? (state.statusBadgeText === 'MARKET_CLOSED');
  const isProvisional = step1?.isProvisional ?? (state.statusBadgeText === 'PROVISIONAL_STRIKES');
  const isStep3 = currentStep === 3;
  const isStep2 = currentStep === 2;

  return (
    <TouchableOpacity
      activeOpacity={0.92}
      style={styles.card}
      onPress={handleCardPress}
    >
      {/* Top Header */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.icon}>⚡</Text>
          <View>
            <Text style={styles.title}>SENSEX 09:20 OOBTST</Text>
            <Text style={styles.sub}>Open Opportunity BTST (3-Step Engine)</Text>
          </View>
        </View>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: isMarketClosed
                ? 'rgba(234, 179, 8, 0.15)'
                : isStep3
                ? colors.purpleGlow
                : 'rgba(6, 182, 212, 0.15)',
            },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              {
                color: isMarketClosed
                  ? colors.warning
                  : isStep3
                  ? colors.purple
                  : colors.cyan,
              },
            ]}
          >
            {state.statusBadgeText}
          </Text>
        </View>
      </View>

      {/* Invariant Alert */}
      {state.invariantNotice && (
        <View style={styles.invariantBox}>
          <Text style={styles.invariantText}>{state.invariantNotice}</Text>
        </View>
      )}

      {/* 3-Step Micro Stepper Pill Bar */}
      <View style={styles.stepperPillBar}>
        <View
          style={[
            styles.stepPill,
            step1?.isLockFailed
              ? { backgroundColor: 'rgba(239, 68, 68, 0.15)', borderColor: 'rgba(239, 68, 68, 0.4)' }
              : step1?.isLocked
              ? styles.stepPillDone
              : isProvisional
              ? styles.stepPillActive
              : styles.stepPillInactive,
          ]}
        >
          <Text
            style={
              step1?.isLockFailed
                ? { color: colors.bearish, fontWeight: '700' }
                : step1?.isLocked
                ? styles.stepPillDoneText
                : isProvisional
                ? styles.stepPillActiveText
                : styles.stepPillInactiveText
            }
          >
            {step1?.isLockFailed
              ? '❌ 1. Lock Failed'
              : step1?.isLocked
              ? `✓ 1. Open ~${(step1?.targetPremium || 100.0).toFixed(1)}`
              : isProvisional
              ? `⚡ 1. Prov. ~${(step1?.targetPremium || 100.0).toFixed(1)}`
              : step1?.previewAvailable
              ? `👁 1. Preview ~${(step1?.targetPremium || 100.0).toFixed(1)}`
              : '🕒 1. Market Closed'}
          </Text>
        </View>
        <Text style={styles.pillArrow}>➔</Text>
        <View
          style={[
            styles.stepPill,
            currentStep >= 2
              ? isStep3
                ? styles.stepPillDone
                : styles.stepPillActive
              : styles.stepPillInactive,
          ]}
        >
          <Text
            style={
              currentStep >= 2
                ? isStep3
                  ? styles.stepPillDoneText
                  : styles.stepPillActiveText
                : styles.stepPillInactiveText
            }
          >
            {isStep3 ? '✓ 2. 1.5x Armed' : currentStep === 2 ? '⚡ 2. 1.5x Armed' : '2. 1.5x Armed'}
          </Text>
        </View>
        <Text style={styles.pillArrow}>➔</Text>
        <View style={[styles.stepPill, isStep3 ? styles.stepPillActive : styles.stepPillInactive]}>
          <Text style={isStep3 ? styles.stepPillActiveText : styles.stepPillInactiveText}>
            {isStep3 ? '🔥 3. OOBTST Active' : '3. OOBTST Active'}
          </Text>
        </View>
      </View>

      {/* Trade Information Card */}
      {isStep3 ? (
        <View style={styles.activeTradeContainer}>
          <View style={styles.tradeTop}>
            <View>
              <Text style={styles.tradeTag}>OOBTST EXECUTED LEG</Text>
              <Text style={styles.tradeSymbol}>{step3?.executedSymbol}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.tradeTag}>HALF-PRICE SL (50%)</Text>
              <Text style={[styles.tradeSymbol, { color: colors.bearish }]}>
                ₹{step3?.slPrice.toFixed(2)}
              </Text>
            </View>
          </View>

          <View style={styles.metricsRow}>
            <Text style={styles.metricText}>
              Buy Level: <Text style={styles.boldText}>₹{step3?.executedPrice.toFixed(2)}</Text>
            </Text>
            <Text style={styles.metricText}>
              Max Risk: <Text style={[styles.boldText, { color: colors.bearish }]}>₹{step3?.riskPerLot.toFixed(0)}</Text>
            </Text>
            <Text style={styles.metricText}>
              P&L: <Text style={[styles.boldText, { color: colors.bullish }]}>{state.primaryMetricValue}</Text>
            </Text>
          </View>
        </View>
      ) : isStep2 ? (
        <View style={styles.activeTradeContainer}>
          <View style={styles.tradeTop}>
            <View>
              <Text style={styles.tradeTag}>DUAL 1.5x ARMED LEGS (LOCKED 09:20)</Text>
              <Text style={styles.tradeSymbol}>{step1?.ceStrike}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.tradeTag}>OPPOSITE ARMED LEG</Text>
              <Text style={styles.tradeSymbol}>{step1?.peStrike}</Text>
            </View>
          </View>

          <View style={styles.metricsRow}>
            <Text style={styles.metricText}>
              CE: <Text style={styles.boldText}>₹{step2?.ceLtp.toFixed(1)}</Text> / ₹{step2?.ceTrigger.toFixed(1)}
            </Text>
            <Text style={styles.metricText}>
              PE: <Text style={styles.boldText}>₹{step2?.peLtp.toFixed(1)}</Text> / ₹{step2?.peTrigger.toFixed(1)}
            </Text>
            <Text style={styles.metricText}>
              Status: <Text style={[styles.boldText, { color: colors.cyan }]}>ARMED</Text>
            </Text>
          </View>
        </View>
      ) : isProvisional ? (
        <View style={styles.activeTradeContainer}>
          <View style={styles.tradeTop}>
            <View>
              <Text style={[styles.tradeTag, { color: colors.cyan }]}>⚡ PROVISIONAL CE CANDIDATE</Text>
              <Text style={styles.tradeSymbol}>{step1?.ceStrike || '--'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.tradeTag, { color: colors.cyan }]}>⚡ PROVISIONAL PE CANDIDATE</Text>
              <Text style={styles.tradeSymbol}>{step1?.peStrike || '--'}</Text>
            </View>
          </View>

          <View style={styles.metricsRow}>
            <Text style={styles.metricText}>
              CE: <Text style={styles.boldText}>{step2?.ceLtp && step2.ceLtp > 0 ? `₹${step2.ceLtp.toFixed(1)}` : '--'}</Text>
            </Text>
            <Text style={styles.metricText}>
              PE: <Text style={styles.boldText}>{step2?.peLtp && step2.peLtp > 0 ? `₹${step2.peLtp.toFixed(1)}` : '--'}</Text>
            </Text>
            <Text style={styles.metricText}>
              Window: <Text style={[styles.boldText, { color: colors.cyan }]}>LOCKS 09:20</Text>
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.activeTradeContainer}>
          <View style={styles.tradeTop}>
            <View>
              <Text style={styles.tradeTag}>NEAREST VALID CANDIDATE CE</Text>
              <Text style={styles.tradeSymbol}>{step1?.ceStrike || '--'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.tradeTag}>NEAREST VALID CANDIDATE PE</Text>
              <Text style={styles.tradeSymbol}>{step1?.peStrike || '--'}</Text>
            </View>
          </View>

          <View style={styles.metricsRow}>
            <Text style={styles.metricText}>
              Market: <Text style={[styles.boldText, { color: colors.warning }]}>CLOSED</Text>
            </Text>
            <Text style={styles.metricText}>
              Strikes: <Text style={styles.boldText}>UNLOCKED</Text>
            </Text>
            <Text style={styles.metricText}>
              Opens: <Text style={[styles.boldText, { color: colors.textPrimary }]}>09:15 IST</Text>
            </Text>
          </View>
        </View>
      )}

      {/* Deep Dive Action Button (Matching NIFTY OOBTST) */}
      <TouchableOpacity
        style={styles.detailBtn}
        onPress={handleCardPress}
      >
        <Text style={styles.detailBtnText}>🔍 View 3-Step Strategy Details ➔</Text>
      </TouchableOpacity>

      {/* Footer: Strictly no Dhan Quick Order or companion broker link */}
      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          {isStep3
            ? 'Hold Overnight • Exit 09:25 D+1'
            : isStep2
            ? 'Awaiting 1.5x Trigger'
            : isProvisional
            ? 'Provisional • Locks @ 09:20'
            : 'Market Closed • Opens @ 09:15'}
        </Text>
        <Text
          style={[
            styles.footerMetric,
            {
              color: isMarketClosed
                ? colors.warning
                : isStep3
                ? colors.bullish
                : colors.cyan,
            },
          ]}
        >
          {state.primaryMetricValue}
        </Text>
      </View>
    </TouchableOpacity>
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
    fontSize: 10,
    fontWeight: '800',
  },
  invariantBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.25)',
    borderRadius: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 10,
  },
  invariantText: {
    color: colors.bearish,
    fontSize: 9,
    fontWeight: '700',
    textAlign: 'center',
  },
  stepperPillBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceSubtle,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    marginBottom: 10,
  },
  stepPill: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  stepPillDone: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  stepPillDoneText: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '700',
  },
  pillArrow: {
    color: colors.textMuted,
    fontSize: 9,
  },
  stepPillActive: {
    backgroundColor: colors.purpleGlow,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  stepPillActiveText: {
    color: colors.purple,
    fontSize: 9,
    fontWeight: '800',
  },
  stepPillInactive: {
    backgroundColor: 'transparent',
  },
  stepPillInactiveText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
  },
  activeTradeContainer: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: 10,
  },
  tradeTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  tradeTag: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  tradeSymbol: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 1,
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metricText: {
    color: colors.textMuted,
    fontSize: 10,
  },
  boldText: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  detailBtn: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.purple,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    marginBottom: 10,
  },
  detailBtnText: {
    color: colors.purple,
    fontSize: 11,
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
    fontSize: 10,
  },
  footerMetric: {
    fontSize: 11,
    fontWeight: '800',
  },
}));
