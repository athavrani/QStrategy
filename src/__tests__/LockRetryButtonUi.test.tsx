import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { LockRetryButton } from '../components/strategies/LockRetryButton';
import { NiftyOvernightPlugin } from '../strategies/plugins/NiftyOvernightPlugin';
import { SensexOobtstPlugin } from '../strategies/plugins/SensexOobtstPlugin';
import { NiftyBreakout180Plugin } from '../strategies/plugins/NiftyBreakout180Plugin';
import { useRadarStore } from '../store/useRadarStore';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { dhanDirectService } from '../services/dhanDirectService';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const textOf = (tree: renderer.ReactTestRenderer) => JSON.stringify(tree.toJSON());
const original = useRadarStore.getState().retryStrategyLock;

afterEach(() => {
  useRadarStore.setState({ retryStrategyLock: original });
  jest.restoreAllMocks();
});

describe('LockRetryButton', () => {
  test('asks the store to retry the given strategy and shows nothing more when it locks', async () => {
    const retry = jest.fn().mockResolvedValue({ ok: true, message: 'Locked at 11:02:10 IST on live prices.' });
    useRadarStore.setState({ retryStrategyLock: retry });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<LockRetryButton strategy="NIFTY" />);
    });

    await act(async () => tree.root.findByProps({ testID: 'lock-retry-nifty' }).props.onPress());
    await flush();

    expect(retry).toHaveBeenCalledWith('NIFTY');
    expect(tree.root.findAllByProps({ testID: 'lock-retry-nifty-message' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('shows why the retry failed and can be tapped again', async () => {
    const retry = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'Retry found no fresh CE priced ₹90–₹120 right now.' })
      .mockResolvedValueOnce({ ok: true, message: 'ok' });
    useRadarStore.setState({ retryStrategyLock: retry });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<LockRetryButton strategy="SENSEX" />);
    });

    await act(async () => tree.root.findByProps({ testID: 'lock-retry-sensex' }).props.onPress());
    await flush();
    expect(textOf(tree)).toContain('Retry found no fresh CE');

    await act(async () => tree.root.findByProps({ testID: 'lock-retry-sensex' }).props.onPress());
    await flush();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(textOf(tree)).not.toContain('Retry found no fresh CE');
    act(() => tree.unmount());
  });

  test('ignores a second tap while the retry is running', async () => {
    let finish!: (v: { ok: boolean; message: string }) => void;
    const retry = jest.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    useRadarStore.setState({ retryStrategyLock: retry });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<LockRetryButton strategy="NIFTY" />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'lock-retry-nifty' }).props.onPress();
    });
    await act(async () => tree.root.findByProps({ testID: 'lock-retry-nifty' }).props.onPress());
    expect(retry).toHaveBeenCalledTimes(1);

    await act(async () => finish({ ok: false, message: 'x' }));
    act(() => tree.unmount());
  });

  test('the store action returns the service result and republishes the strategy state', async () => {
    const spy = jest.spyOn(niftyOptionFeedService, 'retryLock').mockResolvedValue({ ok: false, message: 'nope' });
    useRadarStore.setState({ istTime: '11:02:10 AM', niftySpot: 24850, oobtstState: null });

    const result = await useRadarStore.getState().retryStrategyLock('NIFTY');

    expect(spy).toHaveBeenCalledWith(24850, '11:02:10 AM');
    expect(result).toEqual({ ok: false, message: 'nope' });
    expect(useRadarStore.getState().oobtstState).not.toBeNull();
    useRadarStore.setState({ istTime: '--:--:--' });
  });

  test('the store action runs the breakout retry and republishes the breakout state', async () => {
    const spy = jest.spyOn(niftyOptionFeedService, 'retryBreakoutLock').mockResolvedValue({ ok: false, message: 'nope' });
    useRadarStore.setState({ istTime: '09:27:30 AM', niftySpot: 24850, niftyBreakout180: null });

    const result = await useRadarStore.getState().retryStrategyLock('BREAKOUT');

    expect(spy).toHaveBeenCalledWith(24850, '09:27:30 AM');
    expect(result).toEqual({ ok: false, message: 'nope' });
    expect(useRadarStore.getState().niftyBreakout180).not.toBeNull();
    useRadarStore.setState({ istTime: '--:--:--' });
  });
});

describe('Re-lock button', () => {
  test('asks the store to re-lock and confirms what it locked', async () => {
    const retry = jest.fn().mockResolvedValue({ ok: true, message: 'Re-locked at 11:05:00 IST on live prices.' });
    useRadarStore.setState({ retryStrategyLock: retry });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<LockRetryButton strategy="NIFTY" relock />);
    });
    expect(tree.root.findAllByProps({ testID: 'lock-retry-nifty' })).toHaveLength(0);

    await act(async () => tree.root.findByProps({ testID: 'lock-relock-nifty' }).props.onPress());
    await flush();

    expect(retry).toHaveBeenCalledWith('NIFTY', true);
    expect(textOf(tree)).toContain('Re-locked at 11:05:00 IST on live prices.');
    act(() => tree.unmount());
  });

  test('shows why the re-lock failed', async () => {
    const retry = jest.fn().mockResolvedValue({ ok: false, message: 'Re-lock is unavailable once a leg has triggered.' });
    useRadarStore.setState({ retryStrategyLock: retry });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<LockRetryButton strategy="BREAKOUT" relock />);
    });

    await act(async () => tree.root.findByProps({ testID: 'lock-relock-breakout' }).props.onPress());
    await flush();
    expect(textOf(tree)).toContain('Re-lock is unavailable once a leg has triggered.');
    act(() => tree.unmount());
  });

  test('the store action routes a re-lock to each service', async () => {
    const nifty = jest.spyOn(niftyOptionFeedService, 'relock').mockResolvedValue({ ok: false, message: 'n' });
    const sensex = jest.spyOn(sensexOptionFeedService, 'relock').mockResolvedValue({ ok: false, message: 's' });
    const breakout = jest.spyOn(niftyOptionFeedService, 'relockBreakout').mockResolvedValue({ ok: false, message: 'b' });
    const retry = jest.spyOn(niftyOptionFeedService, 'retryLock');
    useRadarStore.setState({ istTime: '11:05:00 AM', niftySpot: 24850, sensexSpot: 81000 });

    expect(await useRadarStore.getState().retryStrategyLock('NIFTY', true)).toEqual({ ok: false, message: 'n' });
    expect(await useRadarStore.getState().retryStrategyLock('SENSEX', true)).toEqual({ ok: false, message: 's' });
    expect(await useRadarStore.getState().retryStrategyLock('BREAKOUT', true)).toEqual({ ok: false, message: 'b' });

    expect(nifty).toHaveBeenCalledWith(24850, '11:05:00 AM');
    expect(sensex).toHaveBeenCalledWith(81000, '11:05:00 AM');
    expect(breakout).toHaveBeenCalledWith(24850, '11:05:00 AM');
    expect(retry).not.toHaveBeenCalled();
    useRadarStore.setState({ istTime: '--:--:--' });
  });
});

describe('Re-lock on the strategy cards', () => {
  const ctx = (extra: object) => ({ istTime: '11:05:00 AM', marketStatus: 'REGULAR_HOURS', stocks: [], ...extra }) as any;

  const lockedLive = (activeLeg: 'CE' | null) =>
    ({
      currentStep: activeLeg ? 3 : 2,
      status: activeLeg ? 'ACTIVE' : 'ARMED',
      statusBadgeText: 'LOCKED / ARMED_1.5X',
      expiryDate: '',
      daysToExpiry: 1,
      niftySpot: 24850,
      anchorTime: '09:20:00 IST',
      isLocked: true,
      isProvisional: false,
      isMarketClosed: false,
      isLockFailed: false,
      targetPremium: 62.5,
      ceCandidates: [],
      peCandidates: [],
      ceLeg: { type: 'CE', strike: 24850, symbol: 'NIFTY 24850 CE', openPrice: 60, triggerPrice: 90, currentLtp: 65, progressPct: 10, armedHigh: 65, status: 'ARMED' },
      peLeg: { type: 'PE', strike: 24800, symbol: 'NIFTY 24800 PE', openPrice: 62, triggerPrice: 93, currentLtp: 61, progressPct: 0, armedHigh: 62, status: 'ARMED' },
      activeLeg,
      lastUpdated: '',
    }) as any;

  const render = async (element: React.ReactElement) => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(element);
    });
    return tree;
  };

  test('the NIFTY card shows Re-lock while locked and hides it once a leg has triggered', async () => {
    const armed = NiftyOvernightPlugin.evaluate(ctx({ oobtstLiveState: lockedLive(null) }));
    let tree = await render(<>{NiftyOvernightPlugin.renderCard!({ state: armed, onOpenBroker: jest.fn() } as any)}</>);
    expect(tree.root.findAllByProps({ testID: 'lock-relock-nifty' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'lock-retry-nifty' })).toHaveLength(0);
    act(() => tree.unmount());

    const triggered = NiftyOvernightPlugin.evaluate(ctx({ oobtstLiveState: lockedLive('CE') }));
    tree = await render(<>{NiftyOvernightPlugin.renderCard!({ state: triggered, onOpenBroker: jest.fn() } as any)}</>);
    expect(tree.root.findAllByProps({ testID: 'lock-relock-nifty' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('the SENSEX card shows Re-lock while locked and hides it once a leg has triggered', async () => {
    const armed = SensexOobtstPlugin.evaluate(ctx({ sensexOobtstLiveState: lockedLive(null) }));
    let tree = await render(<>{SensexOobtstPlugin.renderCard!({ state: armed, onOpenBroker: jest.fn() } as any)}</>);
    expect(tree.root.findAllByProps({ testID: 'lock-relock-sensex' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());

    const triggered = SensexOobtstPlugin.evaluate(ctx({ sensexOobtstLiveState: lockedLive('CE') }));
    tree = await render(<>{SensexOobtstPlugin.renderCard!({ state: triggered, onOpenBroker: jest.fn() } as any)}</>);
    expect(tree.root.findAllByProps({ testID: 'lock-relock-sensex' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('the breakout card shows Re-lock while locked and no trade is taken', async () => {
    await niftyOptionFeedService.resetAnchor(true);
    await niftyOptionFeedService.resetBreakout180(true);
    const base = niftyOptionFeedService.evaluateBreakout180(24850, '09:25:05 AM');

    const locked = NiftyBreakout180Plugin.evaluate(ctx({ breakout180LiveState: { ...base, status: 'MONITORING_BREAKOUT', isLockFailed: false } }));
    expect(locked.canRelock).toBe(true);
    let tree = await render(<>{NiftyBreakout180Plugin.renderCard!({ state: locked, onOpenBroker: jest.fn() } as any)}</>);
    expect(tree.root.findAllByProps({ testID: 'lock-relock-breakout' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());

    const inTrade = NiftyBreakout180Plugin.evaluate(ctx({ breakout180LiveState: { ...base, status: 'IN_TRADE', isLockFailed: false } }));
    expect(inTrade.canRelock).toBe(false);
    tree = await render(<>{NiftyBreakout180Plugin.renderCard!({ state: inTrade, onOpenBroker: jest.fn() } as any)}</>);
    expect(tree.root.findAllByProps({ testID: 'lock-relock-breakout' })).toHaveLength(0);
    act(() => tree.unmount());
  });
});

describe('Retry on the strategy cards', () => {
  const ctx = (extra: object) => ({ istTime: '09:21:10 AM', marketStatus: 'REGULAR_HOURS', stocks: [], ...extra }) as any;

  test('the NIFTY card shows Retry only while the lock is failed', async () => {
    await niftyOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    (niftyOptionFeedService as any).lastCandleFetchAt = Date.now();
    const failed = niftyOptionFeedService.evaluateOobtst(24850, '09:21:10 AM');
    expect(failed.isLockFailed).toBe(true);

    const state = NiftyOvernightPlugin.evaluate(ctx({ oobtstLiveState: failed }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<>{NiftyOvernightPlugin.renderCard!({ state, onOpenBroker: jest.fn() } as any)}</>);
    });
    expect(tree.root.findAllByProps({ testID: 'lock-retry-nifty' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());

    const provisional = NiftyOvernightPlugin.evaluate(ctx({ oobtstLiveState: { ...failed, isLockFailed: false, status: 'SCANNING', isProvisional: true } }));
    await act(async () => {
      tree = renderer.create(<>{NiftyOvernightPlugin.renderCard!({ state: provisional, onOpenBroker: jest.fn() } as any)}</>);
    });
    expect(tree.root.findAllByProps({ testID: 'lock-retry-nifty' })).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('the SENSEX card shows Retry only while the lock is failed', async () => {
    await sensexOptionFeedService.resetAnchor(true);
    jest.spyOn(dhanDirectService, 'fetchHistoricalIntraday').mockResolvedValue(null as any);
    (sensexOptionFeedService as any).lastCandleFetchAt = Date.now();
    const failed = sensexOptionFeedService.evaluateSensexOobtst(81000, '09:21:10 AM');
    expect(failed.isLockFailed).toBe(true);

    const state = SensexOobtstPlugin.evaluate(ctx({ sensexOobtstLiveState: failed }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<>{SensexOobtstPlugin.renderCard!({ state, onOpenBroker: jest.fn() } as any)}</>);
    });
    expect(tree.root.findAllByProps({ testID: 'lock-retry-sensex' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  test('the breakout card shows Retry only while the lock is failed', async () => {
    await niftyOptionFeedService.resetAnchor(true);
    await niftyOptionFeedService.resetBreakout180(true);
    const failed = niftyOptionFeedService.evaluateBreakout180(24850, '09:25:05 AM');
    expect(failed.status).toBe('LOCK_FAILED');

    const state = NiftyBreakout180Plugin.evaluate(ctx({ breakout180LiveState: failed }));
    expect(state.isLockFailed).toBe(true);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<>{NiftyBreakout180Plugin.renderCard!({ state, onOpenBroker: jest.fn() } as any)}</>);
    });
    expect(tree.root.findAllByProps({ testID: 'lock-retry-breakout' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());

    const monitoring = NiftyBreakout180Plugin.evaluate(ctx({ breakout180LiveState: { ...failed, status: 'MONITORING_BREAKOUT', isLockFailed: false } }));
    expect(monitoring.isLockFailed).toBe(false);
    await act(async () => {
      tree = renderer.create(<>{NiftyBreakout180Plugin.renderCard!({ state: monitoring, onOpenBroker: jest.fn() } as any)}</>);
    });
    expect(tree.root.findAllByProps({ testID: 'lock-retry-breakout' })).toHaveLength(0);
    act(() => tree.unmount());
  });
});
