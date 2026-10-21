import React from 'react';
import { useRadarStore } from '../../store/useRadarStore';
import { HeaderBar } from './HeaderBar';

// Owns the per-second clock subscription so ticking re-renders only the header, not the navigator or tab content.
export function ConnectedHeaderBar(): React.JSX.Element {
  const istTime = useRadarStore((s) => s.istTime);
  const marketStatus = useRadarStore((s) => s.marketStatus);
  return <HeaderBar istTime={istTime} marketStatus={marketStatus} />;
}
