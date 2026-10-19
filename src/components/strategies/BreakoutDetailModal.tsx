// =====================================================================
// QStrategy — NIFTY 09:25 ₹180 Breakout Strategy 3-Step Detail Modal
// Full-screen interactive drilldown matching OOBTST UI layout & theme
// Step 1: 09:25 Candle Open Selection (< ₹180 Rule)
// Step 2: Activation Status (> ₹180 Breakout Trigger)
// Step 3: Outcome & Target Booking (Target Booked / SL Hit / Time Exit)
// =====================================================================

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
import { NiftyBreakout180State } from '../../types/mobile';
import { dhanDirectService } from '../../services/dhanDirectService';
import * as Haptics from 'expo-haptics';

interface BreakoutDetailModalProps {
  visible: boolean;
  onClose: () => void;
  istTime: string;
  data: NiftyBreakout180State | null;
  niftySpot?: number;
}

export function BreakoutDetailModal({
  visible,
  onClose,
  istTime,
  data,
  niftySpot = 0,
}: BreakoutDetailModalProps) {
  const currentStep = data?.currentStep ?? 1;
  const status = data?.status ?? 'MONITORING_BREAKOUT';

  const ce = data?.ceCandidate ?? {
    type: 'CE',
    strike: 23150,
    expiry: '22-OCT-2026',
    price0925: 176.40,
    distanceTo180: 3.60,
    currentLtp: 176.40,
    isTriggered: false,
    isDisabled: false,
  };

  const pe = data?.peCandidate ?? {
    type: 'PE',
    strike: 23100,
    expiry: '22-OCT-2026',
    price0925: 172.10,
    distanceTo180: 7.90,
    currentLtp: 172.10,
    isTriggered: false,
    isDisabled: false,
  };

  const isActive = status === 'IN_TRADE' || status === 'TARGET_HIT' || status === 'SL_HIT' || status === 'TIME_EXIT';
  const isTargetHit = status === 'TARGET_HIT';
  const isSlHit = status === 'SL_HIT';
  const isTimeExit = status === 'TIME_EXIT';

  const activeContractType = data?.activeContract;
  const activeCandidate = activeContractType === 'CE' ? ce : activeContractType === 'PE' ? pe : null;
  const activeSymbol = activeCandidate ? `NIFTY ${activeCandidate.strike} ${activeContractType}` : 'NONE';
  const activeLtp = activeCandidate?.currentLtp ?? 0;
  const entryPrice = data?.entryPrice ?? 180.00;
  const targetPrice = data?.fixedTarget ?? 220.00;
  const slPrice = data?.fixedStopLoss ?? 160.00;

  const pnlPerShare = data?.pnlPoints ?? (isActive ? +(activeLtp - entryPrice).toFixed(2) : 0);
  const pnlPerLot = +(pnlPerShare * 25).toFixed(2); // NIFTY lot size = 25

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
            <Text style={styles.headerTitle}>🚀 NIFTY 09:25 BREAKOUT</Text>
            <Text style={styles.headerSubtitle}>09:25 Open &lt; ₹180 • 3 Steps</Text>
          </View>

          <View style={[styles.stagePill, { backgroundColor: isActive ? colors.cyanGlow : colors.surface }]}>
            <Text style={[styles.stagePillText, { color: isActive ? colors.cyan : colors.textMuted }]}>
              STEP {currentStep}/3
            </Text>
          </View>
        </View>

        {/* Scrollable Body */}
        <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
          {/* Strategy Lifecycle Meta Banner */}
          <View style={styles.metaBanner}>
            <View>
              <Text style={styles.metaLabel}>ENGINE LIFECYCLE</Text>
              <Text style={styles.metaValue}>
                {isTargetHit
                  ? '🎯 TARGET BOOKED (+40 PTS)'
                  : isSlHit
                  ? '🛑 STOP LOSS HIT (-20 PTS)'
                  : isTimeExit
                  ? '⏱️ SQUARED OFF @ 09:45 AM'
                  : isActive
                  ? '⚡ ACTIVATED > ₹180 (IN TRADE)'
                  : '🕒 STEP 1: CANDIDATES LOCKED (< ₹180)'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.metaLabel}>NIFTY SPOT</Text>
              <Text style={styles.metaSpot}>{niftySpot > 0 ? `₹${niftySpot.toLocaleString('en-IN')}` : '--'}</Text>
            </View>
          </View>

          {/* ========================================================== */}
          {/* STEP 1 CARD: 09:25 CANDLE OPEN SELECTION (< ₹180 RULE)    */}
          {/* ========================================================== */}
          <View style={[styles.stepCard, currentStep >= 1 && styles.stepCardActive]}>
            <View style={styles.stepHeader}>
              <View style={styles.stepNumberBadge}>
                <Text style={styles.stepNumberText}>STEP 1</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>09:25 Candle Open Selection (&lt; ₹180 Rule)</Text>
                <Text style={styles.stepSub}>Locked precisely at 09:25:00 IST candle open tick</Text>
              </View>
              <View style={styles.stepLockBadge}>
                <Text style={styles.stepLockText}>🔒 LOCKED</Text>
              </View>
            </View>

            <View style={styles.selectionGrid}>
              {/* CE Strike Box */}
              <View style={[styles.selectionBox, ce.isTriggered && styles.selectionBoxActive]}>
                <View style={styles.boxTag}>
                  <Text style={styles.boxTagText}>CALL (CE)</Text>
                </View>
                <Text style={styles.boxSymbol}>NIFTY {ce.strike} CE</Text>
                <Text style={styles.boxOpenPrice}>09:25 Open: ₹{ce.price0925.toFixed(2)}</Text>
                <View style={styles.ruleVerifiedRow}>
                  <Text style={styles.ruleVerifiedText}>Rule: &lt; 180 ✅</Text>
                  <Text style={styles.boxDelta}>Distance: {ce.distanceTo180.toFixed(2)} pts</Text>
                </View>
                <Text style={[styles.boxLiveLtp, { color: ce.currentLtp >= 180 ? colors.bullish : colors.cyan }]}>
                  Live LTP: ₹{ce.currentLtp.toFixed(2)}
                </Text>
              </View>

              {/* PE Strike Box */}
              <View style={[styles.selectionBox, pe.isTriggered && styles.selectionBoxActive, pe.isDisabled && styles.selectionBoxDisabled]}>
                <View style={[styles.boxTag, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}>
                  <Text style={[styles.boxTagText, { color: colors.bearish }]}>PUT (PE)</Text>
                </View>
                <Text style={[styles.boxSymbol, pe.isDisabled && styles.strikeThrough]}>
                  NIFTY {pe.strike} PE
                </Text>
                <Text style={styles.boxOpenPrice}>09:25 Open: ₹{pe.price0925.toFixed(2)}</Text>
                <View style={styles.ruleVerifiedRow}>
                  <Text style={styles.ruleVerifiedText}>Rule: &lt; 180 ✅</Text>
                  <Text style={styles.boxDelta}>Distance: {pe.distanceTo180.toFixed(2)} pts</Text>
                </View>
                <Text style={[styles.boxLiveLtp, { color: pe.currentLtp >= 180 ? colors.bullish : colors.cyan }]}>
                  Live LTP: ₹{pe.currentLtp.toFixed(2)}
                </Text>
              </View>
            </View>

            <View style={styles.quantExplainer}>
              <Text style={styles.quantExplainerText}>
                💡 <Text style={{ fontWeight: '700' }}>Quant Invariant:</Text> Both CE and PE candidate contracts must have an opening price strictly under ₹180 at 09:25 AM. Contracts already $\ge 180$ are eliminated to ensure we enter on true momentum breakouts without chasing extended prices.
              </Text>
            </View>
          </View>

          {/* Stepper Connector Line */}
          <View style={styles.stepperConnector}>
            <View style={styles.stepperLine} />
            <Text style={styles.stepperArrow}>▼</Text>
          </View>

          {/* ========================================================== */}
          {/* STEP 2 CARD: ACTIVATION STATUS (> ₹180 BREAKOUT TRIGGER)   */}
          {/* ========================================================== */}
          <View style={[styles.stepCard, currentStep >= 2 && styles.stepCardActive]}>
            <View style={styles.stepHeader}>
              <View style={[styles.stepNumberBadge, { backgroundColor: isActive ? colors.cyanGlow : colors.cardBorder }]}>
                <Text style={[styles.stepNumberText, { color: isActive ? colors.cyan : colors.textMuted }]}>
                  STEP 2
                </Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>Activation Status (&gt; ₹180 Breakout)</Text>
                <Text style={styles.stepSub}>Operating Window: 09:25:00 – 09:45:00 IST (1-min candles)</Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: isActive ? colors.cyanGlow : colors.surface }]}>
                <Text style={[styles.statusBadgeText, { color: isActive ? colors.cyan : colors.warning }]}>
                  {isActive ? '🚀 ACTIVATED' : '⏳ NOT ACTIVE'}
                </Text>
              </View>
            </View>

            {!isActive ? (
              <View style={styles.notActiveCard}>
                <Text style={styles.notActiveHeadline}>⏳ NOT ACTIVE — Neither leg has crossed ₹180 yet</Text>
                <Text style={styles.notActiveDescription}>
                  Scanning 1-min candles starting from 09:25:00 AM IST. Whichever contract crosses above ₹180 first will be automatically designated as ACTIVE.
                </Text>

                <View style={styles.pendingBarsContainer}>
                  <View style={styles.pendingLegRow}>
                    <Text style={styles.pendingLegSymbol}>NIFTY {ce.strike} CE</Text>
                    <Text style={styles.pendingLegPrice}>LTP: ₹{ce.currentLtp.toFixed(2)} / ₹180.00</Text>
                  </View>
                  <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${Math.min(100, Math.round((ce.currentLtp / 180) * 100))}%` }]} />
                  </View>

                  <View style={[styles.pendingLegRow, { marginTop: 8 }]}>
                    <Text style={styles.pendingLegSymbol}>NIFTY {pe.strike} PE</Text>
                    <Text style={styles.pendingLegPrice}>LTP: ₹{pe.currentLtp.toFixed(2)} / ₹180.00</Text>
                  </View>
                  <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${Math.min(100, Math.round((pe.currentLtp / 180) * 100))}%` }]} />
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.activatedCard}>
                <View style={styles.activeContractRow}>
                  <View>
                    <Text style={styles.activeContractLabel}>ACTIVATED CONTRACT</Text>
                    <Text style={styles.activeContractSymbol}>{activeSymbol}</Text>
                    <Text style={styles.activeContractEntry}>Broke ₹180 @ ₹{entryPrice.toFixed(2)} ({data?.entryTime || '09:28:15 AM'})</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.tradeNowBtn}
                    onPress={() => handleOpenBroker('dhan', activeSymbol)}
                  >
                    <Text style={styles.tradeNowBtnText}>Trade in Dhan ↗</Text>
                  </TouchableOpacity>
                </View>

                {/* Target & Stop Loss Grid */}
                <View style={styles.targetSlGrid}>
                  <View style={styles.targetCard}>
                    <Text style={styles.targetLabel}>TARGET (1:2 REWARD)</Text>
                    <Text style={[styles.targetValue, { color: colors.bullish }]}>₹{targetPrice.toFixed(2)}</Text>
                    <Text style={styles.targetSub}>+40.00 pts (+22.2%)</Text>
                  </View>

                  <View style={styles.slCard}>
                    <Text style={styles.slLabel}>STOP LOSS (RISK)</Text>
                    <Text style={[styles.slValue, { color: colors.bearish }]}>₹{slPrice.toFixed(2)}</Text>
                    <Text style={styles.slSub}>-20.00 pts (-11.1%)</Text>
                  </View>
                </View>

                <View style={styles.oppositeCanceledBanner}>
                  <Text style={styles.oppositeCanceledText}>
                    ⛔ Opposite Leg ({activeContractType === 'CE' ? `${pe.strike} PE` : `${ce.strike} CE`}) is PERMANENTLY CANCELED / DISABLED for today (strictly 1 trade/day).
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* Stepper Connector Line */}
          <View style={styles.stepperConnector}>
            <View style={styles.stepperLine} />
            <Text style={styles.stepperArrow}>▼</Text>
          </View>

          {/* ========================================================== */}
          {/* STEP 3 CARD: OUTCOME & TARGET BOOKING                      */}
          {/* ========================================================== */}
          <View style={[styles.stepCard, currentStep >= 3 && styles.stepCardActive]}>
            <View style={styles.stepHeader}>
              <View style={[styles.stepNumberBadge, { backgroundColor: isTargetHit ? colors.bullishGlow : isSlHit ? colors.bearishGlow : colors.cardBorder }]}>
                <Text style={[styles.stepNumberText, { color: isTargetHit ? colors.bullish : isSlHit ? colors.bearish : colors.textMuted }]}>
                  STEP 3
                </Text>
              </View>
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.stepTitle}>Outcome &amp; Target Booking</Text>
                <Text style={styles.stepSub}>Monitors ₹220 Target vs ₹160 SL with hard 09:45 AM square-off</Text>
              </View>
            </View>

            {isTargetHit ? (
              <View style={[styles.outcomeResultCard, { backgroundColor: colors.bullishGlow, borderColor: colors.bullish }]}>
                <Text style={[styles.outcomeResultTitle, { color: colors.bullish }]}>🎯 TARGET BOOKED (+40.00 pts)</Text>
                <Text style={styles.outcomeResultDesc}>
                  Contract crossed ₹220.00 Target price! Full 1:2 Risk-to-Reward ratio achieved.
                </Text>
                <View style={styles.pnlSummaryRow}>
                  <Text style={styles.pnlSummaryLabel}>PROFIT PER SHARE: <Text style={{ color: colors.bullish, fontWeight: '800' }}>+₹40.00</Text></Text>
                  <Text style={styles.pnlSummaryLabel}>PROFIT PER LOT (25x): <Text style={{ color: colors.bullish, fontWeight: '800' }}>+₹1,000.00</Text></Text>
                </View>
              </View>
            ) : isSlHit ? (
              <View style={[styles.outcomeResultCard, { backgroundColor: colors.bearishGlow, borderColor: colors.bearish }]}>
                <Text style={[styles.outcomeResultTitle, { color: colors.bearish }]}>🛑 STOP LOSS HIT (-20.00 pts)</Text>
                <Text style={styles.outcomeResultDesc}>
                  Contract breached ₹160.00 Stop Loss. Trade liquidated immediately to preserve capital.
                </Text>
                <View style={styles.pnlSummaryRow}>
                  <Text style={styles.pnlSummaryLabel}>LOSS PER SHARE: <Text style={{ color: colors.bearish, fontWeight: '800' }}>-₹20.00</Text></Text>
                  <Text style={styles.pnlSummaryLabel}>LOSS PER LOT (25x): <Text style={{ color: colors.bearish, fontWeight: '800' }}>-₹500.00</Text></Text>
                </View>
              </View>
            ) : isTimeExit ? (
              <View style={[styles.outcomeResultCard, { backgroundColor: colors.surfaceSubtle, borderColor: colors.warning }]}>
                <Text style={[styles.outcomeResultTitle, { color: colors.warning }]}>⏱️ SQUARED OFF @ 09:45:00 AM IST</Text>
                <Text style={styles.outcomeResultDesc}>
                  09:45 AM hard cutoff reached. Position exited at executable market price per strategy rules.
                </Text>
                <View style={styles.pnlSummaryRow}>
                  <Text style={styles.pnlSummaryLabel}>FINAL P&amp;L PER SHARE: <Text style={{ color: pnlPerShare >= 0 ? colors.bullish : colors.bearish, fontWeight: '800' }}>{pnlPerShare >= 0 ? `+₹${pnlPerShare}` : `-₹${Math.abs(pnlPerShare)}`}</Text></Text>
                  <Text style={styles.pnlSummaryLabel}>FINAL P&amp;L PER LOT: <Text style={{ color: pnlPerLot >= 0 ? colors.bullish : colors.bearish, fontWeight: '800' }}>{pnlPerLot >= 0 ? `+₹${pnlPerLot}` : `-₹${Math.abs(pnlPerLot)}`}</Text></Text>
                </View>
              </View>
            ) : isActive ? (
              <View style={[styles.outcomeResultCard, { backgroundColor: 'rgba(6, 182, 212, 0.1)', borderColor: colors.cyan }]}>
                <View style={styles.inTradeHeaderRow}>
                  <Text style={[styles.outcomeResultTitle, { color: colors.cyan }]}>⚡ IN TRADE — Running Position</Text>
                  <Text style={[styles.inTradePnlVal, { color: pnlPerShare >= 0 ? colors.bullish : colors.bearish }]}>
                    {pnlPerShare >= 0 ? `+${pnlPerShare} pts` : `${pnlPerShare} pts`}
                  </Text>
                </View>
                <Text style={styles.outcomeResultDesc}>
                  Current LTP: ₹{activeLtp.toFixed(2)} | Target: ₹220.00 | SL: ₹160.00
                </Text>

                <View style={styles.pnlSummaryRow}>
                  <Text style={styles.pnlSummaryLabel}>RUNNING P&amp;L / SHARE: <Text style={{ color: pnlPerShare >= 0 ? colors.bullish : colors.bearish, fontWeight: '800' }}>{pnlPerShare >= 0 ? `+₹${pnlPerShare}` : `-₹${Math.abs(pnlPerShare)}`}</Text></Text>
                  <Text style={styles.pnlSummaryLabel}>RUNNING P&amp;L / LOT (25x): <Text style={{ color: pnlPerLot >= 0 ? colors.bullish : colors.bearish, fontWeight: '800' }}>{pnlPerLot >= 0 ? `+₹${pnlPerLot}` : `-₹${Math.abs(pnlPerLot)}`}</Text></Text>
                </View>

                <View style={styles.timeExitCountdownBox}>
                  <Text style={styles.timeExitCountdownText}>
                    ⏳ Forced Time Exit in: {Math.floor((data?.timeRemainingSec ?? 480) / 60)}m {((data?.timeRemainingSec ?? 480) % 60)}s (@ 09:45:00 AM IST)
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.pendingOutcomeBox}>
                <Text style={styles.pendingOutcomeText}>⏳ Awaiting Activation in Step 2 before Outcome monitoring begins.</Text>
              </View>
            )}

            <View style={styles.ruleReminderBox}>
              <Text style={styles.ruleReminderText}>
                🛑 <Text style={{ fontWeight: '700' }}>Time Exit Rule:</Text> No positions under the 09:25 Breakout strategy are ever held past 09:45:00 AM IST under any circumstance.
              </Text>
            </View>
          </View>

          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Sticky Broker Bottom Bar */}
        {isActive && activeCandidate && (
          <View style={styles.bottomBar}>
            <TouchableOpacity
              style={[styles.brokerBtn, styles.kiteBtn]}
              onPress={() => handleOpenBroker('kite', activeSymbol)}
            >
              <Text style={styles.brokerBtnText}>Zerodha Kite ↗</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.brokerBtn, styles.dhanBtn]}
              onPress={() => handleOpenBroker('dhan', activeSymbol)}
            >
              <Text style={styles.brokerBtnText}>Dhan App ↗</Text>
            </TouchableOpacity>
          </View>
        )}
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    backgroundColor: colors.obsidian,
  },
  backBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  backBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  headerTitleContainer: {
    alignItems: 'center',
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  stagePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  stagePillText: {
    fontSize: 11,
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
    marginBottom: 12,
  },
  metaLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 2,
  },
  metaValue: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '800',
  },
  metaSpot: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  stepCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 12,
  },
  stepCardActive: {
    borderColor: 'rgba(6, 182, 212, 0.4)',
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  stepNumberBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  stepNumberText: {
    color: colors.bullish,
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
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '800',
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
  selectionBoxActive: {
    borderColor: colors.cyan,
  },
  selectionBoxDisabled: {
    opacity: 0.5,
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
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 2,
  },
  boxOpenPrice: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '700',
  },
  ruleVerifiedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 2,
  },
  ruleVerifiedText: {
    color: colors.bullish,
    fontSize: 10,
    fontWeight: '700',
  },
  boxDelta: {
    color: colors.textMuted,
    fontSize: 9,
  },
  boxLiveLtp: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  strikeThrough: {
    textDecorationLine: 'line-through',
  },
  quantExplainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    padding: 8,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.cyan,
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
  notActiveCard: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  notActiveHeadline: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 2,
  },
  notActiveDescription: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    marginBottom: 10,
  },
  pendingBarsContainer: {
    backgroundColor: colors.surfaceSubtle,
    padding: 8,
    borderRadius: 6,
  },
  pendingLegRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  pendingLegSymbol: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  pendingLegPrice: {
    color: colors.textSecondary,
    fontSize: 10,
  },
  progressBarBg: {
    height: 4,
    backgroundColor: colors.cardBorder,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.warning,
  },
  activatedCard: {
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cyan,
  },
  activeContractRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  activeContractLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
  },
  activeContractSymbol: {
    color: colors.cyan,
    fontSize: 15,
    fontWeight: '800',
  },
  activeContractEntry: {
    color: colors.textSecondary,
    fontSize: 10,
    marginTop: 2,
  },
  tradeNowBtn: {
    backgroundColor: colors.cyanGlow,
    borderWidth: 1,
    borderColor: colors.cyan,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  tradeNowBtnText: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '700',
  },
  targetSlGrid: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  targetCard: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
    padding: 8,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.bullish,
  },
  targetLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
  },
  targetValue: {
    fontSize: 14,
    fontWeight: '800',
    marginTop: 2,
  },
  targetSub: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '600',
    marginTop: 1,
  },
  slCard: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
    padding: 8,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: colors.bearish,
  },
  slLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
  },
  slValue: {
    fontSize: 14,
    fontWeight: '800',
    marginTop: 2,
  },
  slSub: {
    color: colors.bearish,
    fontSize: 9,
    fontWeight: '600',
    marginTop: 1,
  },
  oppositeCanceledBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 4,
    padding: 6,
  },
  oppositeCanceledText: {
    color: colors.bearish,
    fontSize: 10,
    fontWeight: '600',
  },
  outcomeResultCard: {
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 8,
  },
  outcomeResultTitle: {
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 2,
  },
  outcomeResultDesc: {
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    marginBottom: 8,
  },
  pnlSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  pnlSummaryLabel: {
    color: colors.textSecondary,
    fontSize: 10,
  },
  inTradeHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  inTradePnlVal: {
    fontSize: 14,
    fontWeight: '800',
  },
  timeExitCountdownBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    padding: 6,
    borderRadius: 4,
    marginTop: 8,
    alignItems: 'center',
  },
  timeExitCountdownText: {
    color: colors.warning,
    fontSize: 10,
    fontWeight: '700',
  },
  pendingOutcomeBox: {
    padding: 12,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 6,
    marginBottom: 8,
  },
  pendingOutcomeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
  },
  ruleReminderBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    padding: 6,
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: colors.bearish,
  },
  ruleReminderText: {
    color: colors.bearish,
    fontSize: 9,
    lineHeight: 13,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    padding: 12,
    gap: 10,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  brokerBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  kiteBtn: {
    backgroundColor: '#FF5722',
  },
  dhanBtn: {
    backgroundColor: '#00D09C',
  },
  brokerBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
});
