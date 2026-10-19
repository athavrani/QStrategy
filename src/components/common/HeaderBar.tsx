import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme, createThemedStyles } from '../../theme';
import { MarketSessionStatus } from '../../types/mobile';
import { useRadarStore } from '../../store/useRadarStore';

interface HeaderBarProps {
  istTime?: string;
  marketStatus?: MarketSessionStatus;
}

export function HeaderBar({ istTime = '09:15:00 IST', marketStatus = 'REGULAR_HOURS' }: HeaderBarProps) {
  const isMarketOpen = marketStatus === 'REGULAR_HOURS';
  const feedStatus = useRadarStore((s) => s.feedStatus);
  const isDhanActive = feedStatus === 'ONLINE';
  const { colors, isDark, toggleTheme } = useTheme();
  const styles = useThemedStyles();

  return (
    <View style={styles.header}>
      <View style={styles.brandRow}>
        <Text style={styles.brandIcon}>⚡</Text>
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.brandTitle}>QStrategy Radar</Text>
            {isDhanActive && (
              <View style={styles.dhanPill}>
                <Text style={styles.dhanPillText}>⚡ DHAN STREAM</Text>
              </View>
            )}
          </View>
          <Text style={styles.brandSubtitle}>Signal & Breakout Station</Text>
        </View>
      </View>

      <View style={styles.headerRight}>
        <View style={styles.topControlRow}>
          {/* Quick 1-Tap Theme Toggle Button */}
          <TouchableOpacity
            style={styles.themeToggleBtn}
            onPress={toggleTheme}
            activeOpacity={0.7}
            accessibilityLabel={`Switch to ${isDark ? 'Light' : 'Dark'} Theme`}
          >
            <Text style={styles.themeToggleIcon}>{isDark ? '🌙' : '☀️'}</Text>
          </TouchableOpacity>

          <View style={styles.clockBadge}>
            <View
              style={[
                styles.liveDot,
                { backgroundColor: isMarketOpen ? colors.bullish : colors.warning },
              ]}
            />
            <Text style={styles.clockText}>{istTime}</Text>
          </View>
        </View>

        <View
          style={[
            styles.statusBadge,
            isMarketOpen ? styles.statusBadgeActive : styles.statusBadgeClosed,
          ]}
        >
          <Text
            style={[
              styles.statusText,
              { color: isMarketOpen ? colors.bullish : colors.warning },
            ]}
          >
            {marketStatus}
          </Text>
        </View>
      </View>
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandIcon: {
    fontSize: 22,
    marginRight: 8,
  },
  brandTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  brandSubtitle: {
    color: colors.textMuted,
    fontSize: 11,
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  topControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  themeToggleBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  themeToggleIcon: {
    fontSize: 12,
  },
  clockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  clockText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusBadgeActive: {
    backgroundColor: colors.bullishGlow,
  },
  statusBadgeClosed: {
    backgroundColor: colors.warningGlow,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
  },
  dhanPill: {
    backgroundColor: colors.bullishGlow,
    borderWidth: 1,
    borderColor: colors.bullish,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  dhanPillText: {
    color: colors.bullish,
    fontSize: 9,
    fontWeight: '800',
  },
}));
