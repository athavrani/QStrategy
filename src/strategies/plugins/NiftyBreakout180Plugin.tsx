import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BaseStrategyPlugin, StrategyContext, StrategySignalOutput } from '../types';
import { useTheme, createThemedStyles } from '../../theme';
import * as Haptics from 'expo-haptics';
import { LockRetryButton } from '../../components/strategies/LockRetryButton';

export const NiftyBreakout180Plugin: BaseStrategyPlugin = {
  id: 'NIFTY_BREAKOUT_180',
  name: 'NIFTY 09:25 ₹180 Breakout',
  tagline: '09:25 Candle Open < ₹180 • 3-Step Directional Option Buying',
  icon: '🚀',
  category: 'MOMENTUM_BREAKOUT',
  executionStyle: 'CANDLE_BREAKOUT',
  operatingWindow: {
    startIST: '09:25:00',
    endIST: '09:45:00',
    isOvernightAllowed: false,
  },

  evaluate: (ctx: StrategyContext): StrategySignalOutput => {
    const live = ctx.breakout180LiveState;
    const threshold = live?.lockedThreshold ?? live?.threshold ?? 180.0;
    const ce = live?.ceCandidate;
    const pe = live?.peCandidate;
    const activeContract = live?.activeContract;
    const activeStrike = activeContract === 'CE' ? ce?.strike : pe?.strike;
    const activeSymbol = activeStrike ? `NIFTY ${activeStrike} ${activeContract}` : 'NONE';
    const status = live?.status || 'IN_TRADE';
    const targetLevel = live?.fixedTarget ?? threshold + 40;
    const stopLevel = live?.fixedStopLoss ?? threshold - 20;
    const exitPnl = live?.pnlPoints ?? 0;
    const exitPnlText = `${exitPnl >= 0 ? '+' : ''}${exitPnl.toFixed(2)} pts`;
    const currentStep = live?.currentStep || (status === 'IN_TRADE' ? 2 : status === 'TARGET_HIT' || status === 'SL_HIT' || status === 'TIME_EXIT' ? 3 : 1);

    let badgeTone: StrategySignalOutput['badgeTone'] = 'cyan';
    let statusBadgeText = `STEP ${currentStep}/3`;
    let headline = `${activeSymbol} Crossed ₹${threshold.toFixed(2)} • Opposite Leg Disabled`;

    if (status === 'WAITING_0925') {
      badgeTone = 'purple';
      statusBadgeText = 'STEP 1: WAITING 09:25';
      headline = `Selecting CE & PE contracts with 09:25 Open < ₹${threshold.toFixed(2)}`;
    } else if (status === 'PROVISIONAL_MONITORING') {
      badgeTone = 'purple';
      statusBadgeText = 'PROVISIONAL — NOT LOCKED';
      headline = `Provisional Candidates (< ₹${threshold.toFixed(2)}) • No Orders Triggered`;
    } else if (status === 'LOCK_FAILED') {
      badgeTone = 'bearish';
      statusBadgeText = 'LOCK FAILED';
      headline = 'LOCK FAILED — DATA UNAVAILABLE';
    } else if (status === 'NO_ELIGIBLE_STRIKE') {
      badgeTone = 'bearish';
      statusBadgeText = 'NO ELIGIBLE STRIKE';
      headline = `No eligible strike with 09:25 Open < ₹${threshold.toFixed(2)}`;
    } else if (status === 'MONITORING_BREAKOUT' || status === 'CANDIDATES_LOCKED') {
      badgeTone = 'warning';
      statusBadgeText = 'STEP 1: LOCKED (< ' + Math.round(threshold) + ')';
      headline = `Watching ${ce?.strike} CE (₹${ce?.price0925.toFixed(1)}) & ${pe?.strike} PE (₹${pe?.price0925.toFixed(1)}) [< ₹${threshold.toFixed(2)}]`;
      if (/^\d/.test(ctx.istTime ?? '') && ctx.istTime < '09:30:00') {
        headline = `Strikes locked ${ce?.strike} CE & ${pe?.strike} PE • Entry check at 09:30`;
      }
    } else if (status === 'IN_TRADE') {
      badgeTone = 'cyan';
      statusBadgeText = 'STEP 2: ACTIVE 🚀';
      headline = `${activeSymbol} Activated > ₹${threshold.toFixed(2)} • Opposite Leg Canceled`;
    } else if (status === 'TARGET_HIT') {
      badgeTone = 'bullish';
      statusBadgeText = 'STEP 3: TARGET BOOKED 🎯';
      headline = `🎯 ${activeSymbol} hit Target ₹${targetLevel.toFixed(2)} (${exitPnlText} booked)`;
    } else if (status === 'SL_HIT') {
      badgeTone = 'bearish';
      statusBadgeText = 'STEP 3: SL HIT 🛑';
      headline = `🛑 ${activeSymbol} hit Stop Loss ₹${stopLevel.toFixed(2)} (${exitPnlText})`;
    } else if (status === 'TIME_EXIT') {
      badgeTone = 'warning';
      statusBadgeText = 'STEP 3: TIME EXIT ⏱️';
      headline = `⏱️ 09:45 AM hard exit reached. Position closed (${exitPnlText}).`;
    } else if (status === 'NO_TRADE_TODAY') {
      badgeTone = 'bearish';
      statusBadgeText = 'STEP 3: NO TRADE ⛔';
      headline = `Neither contract broke ₹${threshold.toFixed(2)} before 09:45 AM cutoff.`;
    }

    const ceLtp = ce?.currentLtp || 176.40;
    const peLtp = pe?.currentLtp || 145.80;

    return {
      status: status === 'IN_TRADE' ? 'TRIGGERED' : status === 'TARGET_HIT' ? 'TARGET_HIT' : status === 'SL_HIT' ? 'SL_HIT' : 'ACTIVE',
      statusBadgeText,
      badgeTone,
      headline,
      primaryMetricLabel: 'TARGET / SL',
      primaryMetricValue: `₹${targetLevel.toFixed(2)} / ₹${stopLevel.toFixed(2)}`,
      target: `₹${targetLevel.toFixed(2)} (+40 pts)`,
      stopLoss: `₹${stopLevel.toFixed(2)} (-20 pts)`,
      invariantNotice: `⛔ 09:25 Open < ₹${threshold.toFixed(2)} Rule. 1st break > ₹${threshold.toFixed(2)} (checked from 09:30) activates trade & disables opposite leg.`,
      isLockFailed: status === 'LOCK_FAILED' || Boolean(live?.isLockFailed),
      lastUpdated: ctx.istTime,
      legs: [
        {
          type: 'CE',
          symbol: `NIFTY ${ce?.strike || 23150} CE`,
          strike: ce?.strike || 23150,
          refPrice: ce?.price0925 || 176.40,
          currentLtp: ceLtp,
          slPrice: stopLevel,
          targetPrice: targetLevel,
          status: ce?.isTriggered ? 'ACTIVE' : ce?.isDisabled ? 'DISABLED' : 'ACTIVE',
        },
        {
          type: 'PE',
          symbol: `NIFTY ${pe?.strike || 23100} PE`,
          strike: pe?.strike || 23100,
          refPrice: pe?.price0925 || 172.10,
          currentLtp: peLtp,
          slPrice: stopLevel,
          targetPrice: targetLevel,
          status: pe?.isTriggered ? 'ACTIVE' : pe?.isDisabled ? 'DISABLED' : 'ACTIVE',
        },
      ],
    };
  },

  renderCard: (props) => <NiftyBreakout180PluginCard {...props} />,
};

function NiftyBreakout180PluginCard({
  state,
  onOpenBroker,
  onViewDetails,
}: {
  state: StrategySignalOutput;
  onOpenBroker: (symbol: string) => void;
  onViewDetails?: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles();

  const handleCardPress = () => {
    Haptics.selectionAsync();
    if (onViewDetails) {
      onViewDetails('NIFTY_BREAKOUT_180');
    }
  };

  const ceLeg = state.legs?.find((l) => l.type === 'CE');
    const peLeg = state.legs?.find((l) => l.type === 'PE');
    const isCeTriggered = ceLeg?.status === 'ACTIVE' && (ceLeg?.currentLtp ?? 0) >= 180;
    const isPeTriggered = peLeg?.status === 'ACTIVE' && (peLeg?.currentLtp ?? 0) >= 180;
    const isActive = isCeTriggered || isPeTriggered || state.status === 'TRIGGERED' || state.status === 'TARGET_HIT' || state.status === 'SL_HIT';
    const activeLeg = isCeTriggered ? ceLeg : isPeTriggered ? peLeg : ceLeg;

    const isTargetHit = state.status === 'TARGET_HIT';
    const isSlHit = state.status === 'SL_HIT';

    return (
      <TouchableOpacity
        activeOpacity={0.92}
        style={styles.card}
        onPress={handleCardPress}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Text style={styles.icon}>🚀</Text>
            <View>
              <Text style={styles.title}>NIFTY 09:25 ₹180 Breakout</Text>
              <Text style={styles.sub}>3-Step Execution • Lock 09:25 • Entry 09:30 – 09:45 IST</Text>
            </View>
          </View>
          <View style={[styles.badge, { backgroundColor: colors.cyanGlow }]}>
            <Text style={[styles.badgeText, { color: colors.cyan }]}>{state.statusBadgeText}</Text>
          </View>
        </View>

        {/* Invariant Rule Banner */}
        <View style={styles.invariantBox}>
          <Text style={styles.invariantText}>
            🔒 09:25 Candle Open &lt; ₹180 Rule • CE &amp; PE Locked at 09:25:00 IST
          </Text>
        </View>

        {/* ============================================================ */}
        {/* STEP 1: 09:25 CANDLE OPEN SELECTION (< ₹180 RULE & LOCKED)   */}
        {/* ============================================================ */}
        <View style={styles.stepSection}>
          <View style={styles.stepHeaderRow}>
            <View style={styles.stepNumberBadge}>
              <Text style={styles.stepNumberText}>STEP 1</Text>
            </View>
            <Text style={styles.stepTitle}>09:25 Candle Open Selection (&lt; ₹180 Rule)</Text>
            <Text style={styles.stepStatusTag}>🔒 LOCKED STRIKES</Text>
          </View>

          <View style={styles.step1Row}>
            {/* CE Contract Box */}
            <View style={[styles.contractBox, isCeTriggered && styles.contractBoxActive]}>
              <View style={styles.contractHeader}>
                <Text style={styles.contractType}>CALL (CE)</Text>
                <Text style={styles.rulePill}>Open &lt; 180 ✅</Text>
              </View>
              <Text style={styles.contractStrike}>{ceLeg?.symbol?.replace('NIFTY ', '') || '23150 CE'}</Text>
              <Text style={styles.contractPrice}>09:25 Open: ₹{ceLeg?.refPrice?.toFixed(2) || '176.40'}</Text>
              <Text style={[styles.contractLtp, { color: (ceLeg?.currentLtp || 0) >= 180 ? colors.bullish : colors.textPrimary }]}>
                Live LTP: ₹{ceLeg?.currentLtp.toFixed(2) || '176.40'}
              </Text>
            </View>

            {/* PE Contract Box */}
            <View style={[styles.contractBox, isPeTriggered && styles.contractBoxActive]}>
              <View style={styles.contractHeader}>
                <Text style={[styles.contractType, { color: colors.bearish }]}>PUT (PE)</Text>
                <Text style={styles.rulePill}>Open &lt; 180 ✅</Text>
              </View>
              <Text style={styles.contractStrike}>
                {peLeg?.symbol?.replace('NIFTY ', '') || '23100 PE'}
              </Text>
              <Text style={styles.contractPrice}>09:25 Open: ₹{peLeg?.refPrice?.toFixed(2) || '172.10'}</Text>
              <Text style={[styles.contractLtp, { color: (peLeg?.currentLtp || 0) >= 180 ? colors.bullish : colors.textPrimary }]}>
                Live LTP: ₹{peLeg?.currentLtp.toFixed(2) || '172.10'}
              </Text>
            </View>
          </View>
        </View>

        {/* 3-Step Sub-Page Drilldown Trigger */}
        {state.isLockFailed && <LockRetryButton strategy="BREAKOUT" />}
        <TouchableOpacity
          activeOpacity={0.8}
          style={styles.drilldownBar}
          onPress={handleCardPress}
        >
          <Text style={styles.drilldownText}>⚡ View Full 3-Step Strategy &amp; Order Details</Text>
          <Text style={styles.drilldownArrow}>➔</Text>
        </TouchableOpacity>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerNote}>Mandatory Exit: 09:45:00 AM IST (Never held past 09:45)</Text>
        </View>
      </TouchableOpacity>
    );
}

const useThemedStyles = createThemedStyles((colors) => ({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 14,
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    paddingBottom: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    fontSize: 22,
    marginRight: 8,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  sub: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  invariantBox: {
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  invariantText: {
    color: colors.cyan,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  stepSection: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 10,
  },
  stepHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  stepNumberBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6,
  },
  stepNumberText: {
    color: colors.bullish,
    fontSize: 10,
    fontWeight: '800',
  },
  stepTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  stepStatusTag: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.bullish,
  },
  step1Row: {
    flexDirection: 'row',
    gap: 8,
  },
  contractBox: {
    flex: 1,
    backgroundColor: colors.surface,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  contractBoxActive: {
    borderColor: colors.cyan,
  },
  contractBoxDisabled: {
    opacity: 0.5,
  },
  contractHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  contractType: {
    color: colors.bullish,
    fontSize: 10,
    fontWeight: '700',
  },
  rulePill: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '700',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  contractStrike: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  contractPrice: {
    color: colors.textSecondary,
    fontSize: 10,
    marginTop: 1,
  },
  contractLtp: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  strikeThrough: {
    textDecorationLine: 'line-through',
  },
  stepperArrowBox: {
    alignItems: 'center',
    paddingVertical: 3,
  },
  stepperArrow: {
    color: colors.textMuted,
    fontSize: 10,
  },
  notActiveBox: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  notActiveText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  notActiveSub: {
    color: colors.textMuted,
    fontSize: 10,
  },
  activatedBox: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cyan,
  },
  activeLegRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  activeLegLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginRight: 6,
  },
  activeLegSymbol: {
    color: colors.cyan,
    fontSize: 14,
    fontWeight: '800',
  },
  slTargetGrid: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  slTargetItem: {
    flex: 1,
    alignItems: 'center',
  },
  slTargetDivider: {
    width: 1,
    backgroundColor: colors.cardBorder,
  },
  slTargetLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  slTargetVal: {
    fontSize: 13,
    fontWeight: '800',
  },
  oppositeCanceledNotice: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 4,
    padding: 6,
  },
  oppositeCanceledText: {
    color: colors.bearish,
    fontSize: 10,
    fontWeight: '600',
  },
  outcomeBanner: {
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
  },
  outcomeTitle: {
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 2,
  },
  outcomeSub: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  inTradeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  livePnlText: {
    fontSize: 13,
    fontWeight: '800',
  },
  pendingOutcomeBox: {
    padding: 8,
    alignItems: 'center',
  },
  pendingOutcomeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
  },
  footer: {
    paddingTop: 8,
    alignItems: 'center',
  },
  footerNote: {
    color: colors.textMuted,
    fontSize: 11,
  },
  drilldownBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginTop: 10,
    marginBottom: 4,
  },
  drilldownText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
  },
  drilldownArrow: {
    color: colors.cyan,
    fontSize: 14,
    fontWeight: '800',
  },
}));
