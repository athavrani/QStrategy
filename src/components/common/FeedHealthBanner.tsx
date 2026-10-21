import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { createThemedStyles } from '../../theme';
import { useRadarStore } from '../../store/useRadarStore';
import { dhanHqFeedSocket } from '../../services/dhan/DhanHqFeedSocket';
import type { MarketSessionStatus } from '../../types/mobile';

export type FeedStatus = 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR' | 'UNCONFIGURED';

export interface FeedHealth {
  level: 'warning' | 'error';
  message: string;
  action: 'RETRY' | 'SETTINGS';
}

export const CONNECTING_GRACE_MS = 6000;

const ACTIVE_SESSIONS: MarketSessionStatus[] = ['PRE_MARKET', 'STABILIZING', 'REGULAR_HOURS'];

/** Returns the banner to show, or null when the feed is healthy or its absence is expected (market closed). */
export function getFeedHealth(
  feedStatus: FeedStatus,
  marketStatus: MarketSessionStatus,
  feedError: string | null,
  connectingLongerThanGrace: boolean
): FeedHealth | null {
  if (feedStatus === 'UNCONFIGURED') {
    return { level: 'warning', message: 'Dhan credentials are not set. Add them in Settings to start the live feed.', action: 'SETTINGS' };
  }
  if (feedStatus === 'OFFLINE') {
    return { level: 'error', message: 'Dhan token is expired or invalid. Update it in Settings.', action: 'SETTINGS' };
  }
  if (!ACTIVE_SESSIONS.includes(marketStatus)) return null;

  if (feedStatus === 'ERROR' || feedStatus === 'DISCONNECTED') {
    return { level: 'error', message: `Live feed disconnected${feedError ? `: ${feedError}` : ''}`, action: 'RETRY' };
  }
  if (feedStatus === 'CONNECTING' && connectingLongerThanGrace) {
    return { level: 'warning', message: 'Still connecting to the Dhan live feed...', action: 'RETRY' };
  }
  return null;
}

interface Props {
  onOpenSettings?: () => void;
}

export function FeedHealthBanner({ onOpenSettings }: Props): React.JSX.Element | null {
  const styles = useThemedStyles();
  const feedStatus = useRadarStore((s) => s.feedStatus);
  const marketStatus = useRadarStore((s) => s.marketStatus);
  const feedError = useRadarStore((s) => s.feedError);

  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    if (feedStatus !== 'CONNECTING') {
      setGraceElapsed(false);
      return;
    }
    const timer = setTimeout(() => setGraceElapsed(true), CONNECTING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [feedStatus]);

  const health = getFeedHealth(feedStatus, marketStatus, feedError, graceElapsed);
  if (!health) return null;

  const showAction = health.action === 'RETRY' || Boolean(onOpenSettings);
  return (
    <View style={[styles.banner, health.level === 'error' ? styles.error : styles.warning]} accessibilityRole="alert">
      <Text style={styles.message} numberOfLines={2}>
        {health.message}
      </Text>
      {showAction && (
        <TouchableOpacity
          style={styles.action}
          onPress={() => (health.action === 'RETRY' ? dhanHqFeedSocket.start() : onOpenSettings?.())}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.actionText}>{health.action === 'RETRY' ? 'Retry' : 'Settings'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 12,
    borderBottomWidth: 1,
  },
  error: { backgroundColor: colors.bearishSubtle, borderBottomColor: colors.bearish },
  warning: { backgroundColor: colors.warningSubtle, borderBottomColor: colors.warning },
  message: { flex: 1, color: colors.textPrimary, fontSize: 12, fontWeight: '600' },
  action: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surfaceHover,
  },
  actionText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
}));
