import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { colors } from '../../theme/colors';
import { NiftyOvernightState } from '../../types/mobile';
import * as Haptics from 'expo-haptics';

interface Props {
  data: NiftyOvernightState | null;
}

export function NiftyOvernightCard({ data }: Props) {
  const handleOpenBroker = (symbol: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Deep link intent to broker apps (fallback to web search if not installed)
    const kiteUrl = `kite://search?q=${encodeURIComponent(symbol)}`;
    Linking.canOpenURL(kiteUrl).then((supported) => {
      if (supported) {
        Linking.openURL(kiteUrl);
      } else {
        Linking.openURL(`https://kite.zerodha.com`);
      }
    });
  };

  const isHold = data?.status === 'OVERNIGHT_HOLD';

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleGroup}>
          <Text style={styles.icon}>🌙</Text>
          <View>
            <Text style={styles.title}>NIFTY 09:20 Overnight (62.5)</Text>
            <Text style={styles.expiry}>Expiry: {data?.selectedExpiry || '19-OCT-2026'}</Text>
          </View>
        </View>

        <View style={[styles.badge, { backgroundColor: isHold ? colors.purpleGlow : colors.bullishGlow }]}>
          <Text style={[styles.badgeText, { color: isHold ? colors.purple : colors.bullish }]}>
            {data?.status || 'ACTIVE_HOLD'}
          </Text>
        </View>
      </View>

      {/* Critical Invariant Banner */}
      <View style={styles.invariantBanner}>
        <Text style={styles.invariantText}>
          🛑 ZERO PROFIT TARGET • EXITS ONLY ON 25% SL OR 09:25 AM D+1
        </Text>
      </View>

      {/* Legs Side-by-Side */}
      <View style={styles.legsContainer}>
        {/* CE Leg */}
        <View style={styles.legCard}>
          <View style={styles.legHeader}>
            <Text style={styles.legType}>CALL (CE)</Text>
            <TouchableOpacity onPress={() => handleOpenBroker(`NIFTY ${data?.ceLeg?.strike || 23300} CE`)}>
              <Text style={styles.linkText}>Kite ↗</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.legStrike}>{data?.ceLeg?.strike || 23300} CE</Text>
          <Text style={styles.legSub}>Ref: ₹{data?.ceLeg?.referencePrice.toFixed(2) || '61.50'}</Text>
          <Text style={[styles.legLtp, { color: colors.bullish }]}>
            LTP: ₹{data?.ceLeg?.currentPrice.toFixed(2) || '61.50'}
          </Text>
          <Text style={styles.legSl}>25% SL: ₹{data?.ceLeg?.stopLoss.toFixed(2) || '46.10'}</Text>
        </View>

        {/* PE Leg */}
        <View style={styles.legCard}>
          <View style={styles.legHeader}>
            <Text style={styles.legType}>PUT (PE)</Text>
            <TouchableOpacity onPress={() => handleOpenBroker(`NIFTY ${data?.peLeg?.strike || 23050} PE`)}>
              <Text style={styles.linkText}>Kite ↗</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.legStrike}>{data?.peLeg?.strike || 23050} PE</Text>
          <Text style={styles.legSub}>Ref: ₹{data?.peLeg?.referencePrice.toFixed(2) || '62.00'}</Text>
          <Text style={[styles.legLtp, { color: data?.peLeg?.status === 'SL_HIT' ? colors.bearish : colors.textPrimary }]}>
            {data?.peLeg?.status === 'SL_HIT' ? 'SL HIT ❌' : `LTP: ₹${data?.peLeg?.currentPrice.toFixed(2) || '62.00'}`}
          </Text>
          <Text style={styles.legSl}>25% SL: ₹{data?.peLeg?.stopLoss.toFixed(2) || '46.50'}</Text>
        </View>
      </View>

      {/* Footer Info */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Next Scheduled Exit: <Text style={styles.highlight}>Tomorrow 09:25:00 AM IST</Text>
        </Text>
        <Text style={[styles.netPoints, { color: (data?.netPointsPnl || 0) >= 0 ? colors.bullish : colors.bearish }]}>
          Net: {(data?.netPointsPnl || 0) >= 0 ? `+${data?.netPointsPnl} pts` : `${data?.netPointsPnl} pts`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  titleGroup: {
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
  expiry: {
    color: colors.textMuted,
    fontSize: 11,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  invariantBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.25)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
    marginBottom: 12,
  },
  invariantText: {
    color: colors.bearish,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  legsContainer: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  legCard: {
    flex: 1,
    backgroundColor: colors.surface,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  legHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  legType: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  linkText: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
  legStrike: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  legSub: {
    color: colors.textSecondary,
    fontSize: 11,
    marginBottom: 2,
  },
  legLtp: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  legSl: {
    color: colors.textMuted,
    fontSize: 11,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  footerText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  highlight: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  netPoints: {
    fontSize: 12,
    fontWeight: '700',
  },
});
