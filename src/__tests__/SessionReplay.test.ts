import { DhanHqFeedSocket } from '../services/dhan/DhanHqFeedSocket';
import { encodeDhanTickerPacket } from '../services/dhan/DhanBinaryCodec';
import { MarketDataService } from '../services/marketdata/MarketDataService';
import { OptionChainFeed } from '../services/marketdata/OptionChainFeed';
import { SignalPipeline, LatchPort } from '../engine/SignalPipeline';
import { StrategyEngine } from '../engine/StrategyEngine';
import { createNiftyOobtstStrategy } from '../engine/strategies';
import { instrumentKey } from '../services/marketdata/types';

const fixture = require('./fixtures/session-replay.json');

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => store.get(key) || null),
    setItemAsync: jest.fn(async (key: string, val: string) => {
      store.set(key, val);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'mock-when-unlocked',
  };
});
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(true),
  isEnrolledAsync: jest.fn().mockResolvedValue(true),
  authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Medium: 'medium', Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

interface Tick {
  t: number;
  seg: number;
  id: number;
  ltp: number;
}

// Concatenates one frame per timestamp, so the replay also exercises multi-packet frames.
function frameFor(ticks: Tick[]): ArrayBuffer {
  const parts = ticks.map((k) =>
    new Uint8Array(encodeDhanTickerPacket({ securityId: k.id, exchangeSegment: k.seg, ltp: k.ltp, ltt: 1729321200 }))
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  parts.forEach((p) => {
    out.set(p, off);
    off += p.length;
  });
  return out.buffer;
}

describe('Session replay regression (frames -> hub -> option feed -> engine -> journal)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('a recorded NIFTY session produces exactly the expected signals and final quotes', async () => {
    const { ce, pe } = fixture.legs;
    const socket = new DhanHqFeedSocket();
    const hub = new MarketDataService(socket);
    hub.start();

    const feed = new OptionChainFeed(
      {
        owner: 'replay',
        underlying: 'NIFTY',
        optionSegment: 'NSE_FNO',
        fallbackSpot: 24850,
        resolveExpiryYmd: () => '2026-10-27',
        selectCandidates: () => ({
          ceCandidates: [{ securityId: String(ce.securityId) }],
          peCandidates: [{ securityId: String(pe.securityId) }],
        }),
      },
      {
        fetchChain: async () => ({
          spotPrice: 24850,
          oc: {
            [ce.strike]: { ceLtp: ce.open, peLtp: 0, ceOi: 1, peOi: 0, ceSecId: String(ce.securityId) },
            [pe.strike]: { ceLtp: 0, peLtp: pe.open, ceOi: 0, peOi: 1, peSecId: String(pe.securityId) },
          },
        }),
        market: hub,
      }
    );
    await feed.sync();

    hub.onBatch((batch) => {
      Object.values(batch).forEach((p: any) => {
        if (p.exchangeSegment === 2 && typeof p.ltp === 'number') feed.updateFromTick(String(p.securityId), p.ltp);
      });
    });

    const taken = new Set<string>();
    const latch: LatchPort = {
      isAlertLatched: (k, s) => taken.has(`${k}|${s}`),
      acquireAlertLatch: async (k, s) => {
        taken.add(`${k}|${s}`);
        return true;
      },
    };
    const persisted: string[] = [];
    const engine = new StrategyEngine(
      new SignalPipeline(latch, () => 1, async (entry) => {
        persisted.push(entry.id);
      })
    );
    engine.register(
      createNiftyOobtstStrategy({
        notifier: { notify20DCrossover: jest.fn(), notify180BreakoutTriggered: jest.fn(), notify0920StrangleEntry: jest.fn() },
        tacticalStrike: () => ({ recommendedCeStrike: 0 }),
      })
    );

    const fired: Array<{ firedAtT: number; entry: any }> = [];
    let triggered = false;
    const times = [...new Set<number>(fixture.ticks.map((k: Tick) => k.t))].sort((a, b) => a - b);

    for (const t of times) {
      socket['handleIncomingFrame'](frameFor(fixture.ticks.filter((k: Tick) => k.t === t)));
      jest.advanceTimersByTime(300);

      const ceLtp = feed.getLiveOptionPrice(ce.strike, 'CE');
      if (ceLtp >= ce.open * 1.5) triggered = true;
      const state: any = {
        status: triggered ? 'ACTIVE' : 'ARMED',
        activeLeg: triggered ? 'CE' : null,
        lastUpdated: `t+${t}`,
        ceLeg: { symbol: `NIFTY ${ce.strike} CE`, strike: ce.strike, openPrice: ce.open, currentLtp: ceLtp },
        peLeg: { symbol: `NIFTY ${pe.strike} PE`, strike: pe.strike, openPrice: pe.open, currentLtp: pe.open },
      };

      const entries = await engine.evaluate({ istTime: `t+${t}`, niftyOobtst: state });
      entries.forEach((entry) => fired.push({ firedAtT: t, entry }));
    }

    expect(fired).toHaveLength(fixture.expected.signals.length);
    fixture.expected.signals.forEach((exp: any, i: number) => {
      expect(fired[i].firedAtT).toBe(exp.firedAtT);
      expect(fired[i].entry).toMatchObject({
        strategyId: exp.strategyId,
        symbol: exp.symbol,
        signalType: exp.signalType,
        entryPrice: exp.entryPrice,
        stopLoss: exp.stopLoss,
        outcome: 'OPEN',
      });
    });
    expect(persisted).toHaveLength(fixture.expected.signals.length);

    for (const [key, ltp] of Object.entries<number>(fixture.expected.finalLtp)) {
      expect(hub.getQuoteByKey(key)?.ltp).toBeCloseTo(ltp, 2);
    }
    expect(hub.getQuote('NSE_FNO', ce.securityId)?.ltp).toBeCloseTo(101, 2);
    expect(instrumentKey('NSE_FNO', ce.securityId)).toBe('2:5001');
  });
});
