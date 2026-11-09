export interface IndexDayStats {
  prevClose: number;
  open: number;
  high: number;
}

/**
 * Today's high can only be at or above the live price, so a spot above the last snapshot's high is the new high.
 * Values the snapshot did not supply stay 0, which the screen shows as a dash.
 */
export function mergeLiveHigh(stats: IndexDayStats | null, spot: number | null): IndexDayStats | null {
  if (!stats) return null;
  if (spot && spot > 0 && stats.high > 0 && spot > stats.high) return { ...stats, high: spot };
  return stats;
}
