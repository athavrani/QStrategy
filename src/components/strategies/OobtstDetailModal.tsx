import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  Linking,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { colors } from '../../theme/colors';
import { dhanDirectService } from '../../services/dhanDirectService';
import * as Haptics from 'expo-haptics';

interface OobtstDetailModalProps {
  visible: boolean;
  onClose: () => void;
  istTime: string;
  stepDetails?: {
    currentStep: 1 | 2 | 3;
    step1?: {
      ceStrike: string;
      ceOpen: number;
      peStrike: string;
      peOpen: number;
      timestamp: string;
      isLocked?: boolean;
      isProvisional?: boolean;
      isMarketClosed?: boolean;
    };
    step2?: {
      ceTrigger: number;
      ceLtp: number;
      peTrigger: number;
      peLtp: number;
      multiplier: number;
    };
    step3?: {
      executedSymbol: string;
      executedPrice: number;
      slPrice: number;
      status: string;
      riskPerLot: number;
    };
  };
}

export function OobtstDetailModal({
  visible,
  onClose,
  istTime,
  stepDetails,
}: OobtstDetailModalProps) {
  const currentStep = stepDetails?.currentStep ?? 1;

  const step1 = stepDetails?.step1 ?? {
    ceStrike: '--',
    ceOpen: 0,
    peStrike: '--',
    peOpen: 0,
    timestamp: '09:20:00 IST',
    isLocked: false,
    isProvisional: false,
    isMarketClosed: true,
  };

  const step2 = stepDetails?.step2 ?? {
    ceTrigger: 0,
    ceLtp: 0,
    peTrigger: 0,
    peLtp: 0,
    multiplier: 1.5,
  };

  const step3 = stepDetails?.step3 ?? {
    executedSymbol: '--',
    executedPrice: 0,
    slPrice: 0,
    status: 'SCANNING',
    riskPerLot: 0,
  };

  const isMarketClosed = step1.isMarketClosed ?? false;
  const isProvisional = step1.isProvisional ?? false;
  const isLocked = step1.isLocked ?? false;

  const isCeExecuted = currentStep === 3 && step3.executedSymbol.includes('CE');
  const isPeExecuted = currentStep === 3 && step3.executedSymbol.includes('PE');
  const isCeCancelled = currentStep === 3 && !isCeExecuted;
  const isPeCancelled = currentStep === 3 && !isPeExecuted;

  const activeLtp = isPeExecuted ? step2.peLtp : step2.ceLtp;
  const pnlPerShare = currentStep === 3 && step3.executedPrice > 0 ? (activeLtp - step3.executedPrice) : 0;
  const pnlPerLot = pnlPerShare * 25; // NIFTY lot size = 25

  const handleOpenBroker = (broker: 'kite' | 'dhan', symbol: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (broker === 'dhan') {
      dhanDirectService.launchDhanApp(symbol);
    } else {
      const encoded = encodeURIComponent(symbol);
      const url = `kite://search?q=${encoded}`;
      Linking.canOpenURL(url).then((supported) => {
        Linking.openURL(supported ? url : 'https://kite.zerodha.com');
      });
    }
  };

  const ceProgress = step2.ceTrigger > 0 ? Math.min(100, Math.round((step2.ceLtp / step2.ceTrigger) * 100)) : 0;
  const peProgress = step2.peTrigger > 0 ? Math.min(100, Math.round((step2.peLtp / step2.peTrigger) * 100)) : 0;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" backgroundColor={colors.obsidian} />

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
            <Text style={styles.headerTitle}>🌙 NIFTY 09:20 OOBTST</Text>
            <Text style={styles.headerSubtitle}>Open Opportunity BTST • 3 Steps</Text>
          </View>

          <View style={styles.stagePill}>
            <Text style={styles.stagePillText}>STEP {currentStep}/3</Text>
          </View>
        </View>

        {/* Content ScrollView */}
        <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
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

          {/* STEP 1 CARD */}
          <View style={[styles.stepCard, currentStep >= 1 && styles.stepCardActive]}>
            <View style={styles.stepHeader}>
              <View
                style={[
                  styles.stepNumberBadge,
                  isMarketClosed
                    ? { backgroundColor: colors.surfaceSubtle }
                    : isProvisional
                    ? { backgroundColor: colors.cyan }
                    : { backgroundColor: colors.bullish },
                ]}
              >
                <Text
                  style={[
                    styles.stepNumberText,
                    isProvisional || !isMarketClosed ? { color: colors.obsidian } : {},
                  ]}
                >
                  STEP 1
                </Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>09:20 Candle Open Selection (~₹62.50)</Text>
                <Text style={styles.stepSub}>
                  {isMarketClosed
                    ? 'Strikes unlocked. Nearest valid candidates tracked from live spot.'
                    : isProvisional
                    ? 'Provisional candidates: dynamically updating live until 09:20:00 tick'
                    : 'Locked precisely at 09:20:00 IST candle open tick'}
                </Text>
              </View>
              <View
                style={[
                  styles.stepLockBadge,
                  isMarketClosed
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
                      color: isMarketClosed
                        ? colors.warning
                        : isProvisional
                        ? colors.cyan
                        : isLocked
                        ? colors.bullish
                        : colors.textMuted,
                    },
                  ]}
                >
                  {isMarketClosed
                    ? '⚪ MARKET CLOSED'
                    : isProvisional
                    ? '⚡ PROVISIONAL'
                    : isLocked
                    ? '🔒 LOCKED AT 09:20'
                    : '⏳ SCANNING'}
                </Text>
              </View>
            </View>

            <View style={styles.selectionGrid}>
              {/* CE Strike */}
              <View style={styles.selectionBox}>
                <View style={styles.boxTag}>
                  <Text style={styles.boxTagText}>CALL (CE)</Text>
                </View>
                <Text style={styles.boxSymbol}>{step1.ceStrike}</Text>
                <Text style={styles.boxOpenPrice}>
                  {step1.ceOpen > 0
                    ? `${isLocked ? '09:20 Open' : isProvisional ? 'Live Candidate' : 'Reference'}: ₹${step1.ceOpen.toFixed(2)}`
                    : 'Price: ₹-- (Market Closed)'}
                </Text>
                <Text style={styles.boxDelta}>
                  {step1.ceOpen > 0
                    ? `Δ from ₹62.5: ${step1.ceOpen >= 62.5 ? `+₹${(step1.ceOpen - 62.5).toFixed(2)}` : `-₹${(62.5 - step1.ceOpen).toFixed(2)}`}`
                    : 'Awaiting 09:15 open candle'}
                </Text>
              </View>

              {/* PE Strike */}
              <View style={styles.selectionBox}>
                <View style={[styles.boxTag, { backgroundColor: 'rgba(239, 68, 68, 0.2)' }]}>
                  <Text style={[styles.boxTagText, { color: colors.bearish }]}>PUT (PE)</Text>
                </View>
                <Text style={styles.boxSymbol}>{step1.peStrike}</Text>
                <Text style={styles.boxOpenPrice}>
                  {step1.peOpen > 0
                    ? `${isLocked ? '09:20 Open' : isProvisional ? 'Live Candidate' : 'Reference'}: ₹${step1.peOpen.toFixed(2)}`
                    : 'Price: ₹-- (Market Closed)'}
                </Text>
                <Text style={styles.boxDelta}>
                  {step1.peOpen > 0
                    ? `Δ from ₹62.5: ${step1.peOpen >= 62.5 ? `+₹${(step1.peOpen - 62.5).toFixed(2)}` : `-₹${(62.5 - step1.peOpen).toFixed(2)}`}`
                    : 'Awaiting 09:15 open candle'}
                </Text>
              </View>
            </View>

            <View style={styles.quantExplainer}>
              <Text style={styles.quantExplainerText}>
                💡 <Text style={{ fontWeight: '700' }}>Quant Rationale:</Text> ₹62.50 open price identifies OTM strikes (~0.20-0.25 Delta) with low entry premium (~₹1,500/lot) and high gamma acceleration potential.
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
                  LTP: <Text style={[styles.boldWhite, { color: isCeExecuted ? colors.bullish : colors.textPrimary }]}>{step2.ceLtp > 0 ? `₹${step2.ceLtp.toFixed(2)}` : '--'}</Text>{step2.ceTrigger > 0 ? ` (${ceProgress}%)` : ''}
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
                  LTP: <Text style={[styles.boldWhite, { color: isPeExecuted ? colors.bullish : colors.textPrimary }]}>{step2.peLtp > 0 ? `₹${step2.peLtp.toFixed(2)}` : '--'}</Text>{step2.peTrigger > 0 ? ` (${peProgress}%)` : ''}
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
                    <Text style={styles.cellLabel}>MAX RISK / LOT (25)</Text>
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
                  Scanning nearest option strikes to ₹62.50. Target strikes lock permanently and 1.5x triggers activate at 09:20:00 IST.
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

            {/* Quick Action Deep Links */}
            <View style={styles.brokerSection}>
              <Text style={styles.brokerTitle}>QUICK ACTION • 1-TAP BROKER TERMINAL</Text>
              <View style={styles.brokerButtons}>
                <TouchableOpacity
                  style={[styles.brokerBtn, { backgroundColor: '#FF5722' }]}
                  onPress={() => handleOpenBroker('kite', currentStep === 3 ? step3.executedSymbol : step1.ceStrike)}
                >
                  <Text style={styles.brokerBtnText}>🚀 Open Kite ({currentStep === 3 ? step3.executedSymbol : step1.ceStrike})</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.brokerBtn, { backgroundColor: '#10B981' }]}
                  onPress={() => handleOpenBroker('dhan', currentStep === 3 ? step3.executedSymbol : step1.ceStrike)}
                >
                  <Text style={styles.brokerBtnText}>⚡ Open Dhan ({currentStep === 3 ? step3.executedSymbol : step1.ceStrike})</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  brokerSection: {
    marginTop: 4,
  },
  brokerTitle: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  brokerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  brokerBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brokerBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
});
