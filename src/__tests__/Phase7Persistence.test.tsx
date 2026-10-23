import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import { JournalRepository } from '../services/JournalRepository';
import { SignalPipeline, LatchPort } from '../engine/SignalPipeline';
import { StrategyEngine } from '../engine/StrategyEngine';
import { createNiftyOobtstStrategy } from '../engine/strategies';
import { getFeedHealth, FeedHealthBanner, CONNECTING_GRACE_MS } from '../components/common/FeedHealthBanner';
import { useRadarStore } from '../store/useRadarStore';
import { dhanHqFeedSocket } from '../services/dhan/DhanHqFeedSocket';
import type { SignalJournalItem } from '../types/mobile';

const entry = (id: string, over: Partial<SignalJournalItem> = {}): SignalJournalItem => ({
  id,
  timestamp: '09:31:00',
  strategyId: 'OOBTST_NIFTY',
  strategyName: '09:20 OOBTST NIFTY',
  symbol: 'NIFTY 24850 CE',
  signalType: 'BUY',
  entryPrice: 90,
  outcome: 'OPEN',
  ...over,
});

describe('JournalRepository', () => {
  const day = '2099-01-02';

  test('round-trips entries newest first and survives a new repository instance (restart)', async () => {
    const repo = new JournalRepository();
    await repo.save(entry('a-1', { stopLoss: 60, target: 120, notes: 'first' }), day);
    await repo.save(entry('b-2', { symbol: 'NIFTY 24800 PE' }), day);

    const restored = await new JournalRepository().loadForDate(day);
    expect(restored.map((e) => e.id)).toEqual(['b-2', 'a-1']);
    expect(restored[1]).toMatchObject({ stopLoss: 60, target: 120, notes: 'first', outcome: 'OPEN' });
    expect(restored[0]).not.toHaveProperty('stopLoss');
  });

  test('ignores duplicate ids and scopes by trade date', async () => {
    const repo = new JournalRepository();
    await repo.save(entry('dup-1', { notes: 'original' }), '2099-02-01');
    await repo.save(entry('dup-1', { notes: 'changed' }), '2099-02-01');
    await repo.save(entry('other-1'), '2099-02-02');

    const feb1 = await repo.loadForDate('2099-02-01');
    expect(feb1).toHaveLength(1);
    expect(feb1[0].notes).toBe('original');
    expect(await repo.loadForDate('2099-02-02')).toHaveLength(1);
  });

  test('pruneBefore removes only older sessions', async () => {
    const repo = new JournalRepository();
    await repo.save(entry('old-1'), '2098-01-01');
    await repo.save(entry('new-1'), '2098-06-01');
    await repo.pruneBefore('2098-03-01');
    expect(await repo.loadForDate('2098-01-01')).toEqual([]);
    expect(await repo.loadForDate('2098-06-01')).toHaveLength(1);
  });

  test('lists session dates newest first and the store selects a past day', async () => {
    const repo = new JournalRepository();
    await repo.save(entry('d-1'), '2097-05-01');
    await repo.save(entry('d-2'), '2097-05-03');
    await repo.save(entry('d-3'), '2097-05-03');

    const dates = await repo.getAvailableDates();
    expect(dates.indexOf('2097-05-03')).toBeLessThan(dates.indexOf('2097-05-01'));
    expect(new Set(dates).size).toBe(dates.length);

    await useRadarStore.getState().selectJournalDate('2097-05-03');
    expect(useRadarStore.getState().historicalJournal).toHaveLength(2);
    await useRadarStore.getState().selectJournalDate(null);
    expect(useRadarStore.getState().selectedJournalDate).toBeNull();
    expect(useRadarStore.getState().historicalJournal).toEqual([]);
  });
});

describe('SignalPipeline journal sink', () => {
  const latch = (): LatchPort => {
    const taken = new Set<string>();
    return {
      isAlertLatched: (k, s) => taken.has(`${k}|${s}`),
      acquireAlertLatch: async (k, s) => {
        taken.add(`${k}|${s}`);
        return true;
      },
    };
  };
  const state = {
    status: 'ACTIVE', activeLeg: 'CE', lastUpdated: '09:31:00',
    ceLeg: { symbol: 'NIFTY 24850 CE', strike: 24850, openPrice: 60, currentLtp: 92 },
    peLeg: { symbol: 'NIFTY 24800 PE', strike: 24800, openPrice: 64, currentLtp: 40 },
  } as any;
  const deps = {
    notifier: { notify20DCrossover: jest.fn(), notify180BreakoutTriggered: jest.fn(), notify0920StrangleEntry: jest.fn() },
    tacticalStrike: () => ({ recommendedCeStrike: 1 }),
  };

  test('each fired signal is persisted once, after the latch is taken', async () => {
    const sink = jest.fn(async () => {});
    const engine = new StrategyEngine(new SignalPipeline(latch(), () => 5, sink));
    engine.register(createNiftyOobtstStrategy(deps));

    await engine.evaluate({ istTime: 't', niftyOobtst: state });
    await engine.evaluate({ istTime: 't', niftyOobtst: state });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ id: 'sig-oobtst-nifty-5', outcome: 'OPEN' }));
  });

  test('a failing sink does not drop the live journal entry', async () => {
    const sink = jest.fn(async () => {
      throw new Error('disk full');
    });
    const engine = new StrategyEngine(new SignalPipeline(latch(), () => 5, sink));
    engine.register(createNiftyOobtstStrategy(deps));
    expect(await engine.evaluate({ istTime: 't', niftyOobtst: state })).toHaveLength(1);
  });
});

describe('getFeedHealth', () => {
  test('stays quiet when healthy or when the market is closed', () => {
    expect(getFeedHealth('ONLINE', 'REGULAR_HOURS', null, false)).toBeNull();
    expect(getFeedHealth('DISCONNECTED', 'CLOSED', null, false)).toBeNull();
    expect(getFeedHealth('ERROR', 'POST_MARKET', 'x', false)).toBeNull();
  });

  test('credential problems always show and point to Settings', () => {
    expect(getFeedHealth('OFFLINE', 'CLOSED', null, false)).toMatchObject({ level: 'error', action: 'SETTINGS' });
    expect(getFeedHealth('UNCONFIGURED', 'CLOSED', null, false)).toMatchObject({ level: 'warning', action: 'SETTINGS' });
  });

  test('disconnects during market hours offer a retry with the error text', () => {
    const h = getFeedHealth('DISCONNECTED', 'REGULAR_HOURS', 'Connection stalled (No ticks for 20s)', false);
    expect(h).toMatchObject({ level: 'error', action: 'RETRY' });
    expect(h?.message).toContain('Connection stalled');
  });

  test('connecting only warns after the grace period', () => {
    expect(getFeedHealth('CONNECTING', 'REGULAR_HOURS', null, false)).toBeNull();
    expect(getFeedHealth('CONNECTING', 'REGULAR_HOURS', null, true)).toMatchObject({ level: 'warning', action: 'RETRY' });
  });
});

describe('FeedHealthBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useRadarStore.setState({ feedStatus: 'ONLINE', marketStatus: 'REGULAR_HOURS', feedError: null });
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const texts = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAllByType(Text).map((t) => String(t.props.children));

  test('renders nothing while online and shows a retry that restarts the feed when disconnected', () => {
    const startSpy = jest.spyOn(dhanHqFeedSocket, 'start').mockResolvedValue();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<FeedHealthBanner />);
    });
    expect(tree.toJSON()).toBeNull();

    act(() => useRadarStore.setState({ feedStatus: 'DISCONNECTED', feedError: 'Disconnected by user' }));
    expect(texts(tree).some((t) => t.includes('Live feed disconnected: Disconnected by user'))).toBe(true);

    act(() => {
      tree.root.findByType(TouchableOpacity).props.onPress();
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
    act(() => tree.unmount());
  });

  test('connecting banner appears only after the grace period', () => {
    useRadarStore.setState({ feedStatus: 'CONNECTING' });
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<FeedHealthBanner />);
    });
    expect(tree.toJSON()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(CONNECTING_GRACE_MS + 10);
    });
    expect(tree.toJSON()).not.toBeNull();
    act(() => tree.unmount());
  });
});
