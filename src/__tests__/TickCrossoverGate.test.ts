import { useRadarStore } from '../store/useRadarStore';
import { strategyEngine, STRATEGY_IDS } from '../engine';
import { dhanHqFeedSocket } from '../services/dhan/DhanHqFeedSocket';
import { encodeDhanQuotePacket } from '../services/dhan/DhanBinaryCodec';
import { secureVault } from '../services/SecureCredentialVault';
import { getDhanSecurityId } from '../constants/dhanSecurityMaster';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'mock-when-unlocked',
}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(true),
  isEnrolledAsync: jest.fn().mockResolvedValue(true),
  authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
}));

const stock = () =>
  ({
    ticker: 'RELIANCE', name: 'Reliance', indices: ['NIFTY 50'], sector: 'Energy',
    spotPrice: 2640, prevClose: 2600, percentChange: 1.5, dayOpen: 2630, dayHigh: 2645, dayLow: 2625,
    todayTradedShares: 100, avg20DTradedShares: 1000, volumeRatio: 0.1, hasCrossed20D: false,
    circleIndicator: 'GREY', crossoverDirection: 'BULLISH', lastUpdated: '', isLiveQuote: true,
  }) as any;

function tick(volume: number): ArrayBuffer {
  return encodeDhanQuotePacket({
    securityId: Number(getDhanSecurityId('RELIANCE')), exchangeSegment: 1, ltp: 2650, ltq: 1, ltt: 1729321200,
    atp: 2648, volume, totalSellQty: 1, totalBuyQty: 1, dayOpen: 2630, dayClose: 0, dayHigh: 2655, dayLow: 2625,
  });
}

describe('20D crossover on ticks (gated on loaded averages)', () => {
  let evaluate: jest.SpyInstance;

  beforeAll(() => {
    jest.useFakeTimers();
    jest.spyOn(secureVault, 'getEffectiveCredentials').mockResolvedValue({
      clientId: '', token: '', tabId: '1', isStreamerEnabled: false,
    });
    evaluate = jest.spyOn(strategyEngine, 'evaluate').mockResolvedValue([]);
    useRadarStore.setState({ isStreamerInitialized: false });
    useRadarStore.getState().initStreamer();
  });

  afterAll(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    evaluate.mockClear();
  });

  const pushTick = (volume: number) => {
    (dhanHqFeedSocket as any).handleIncomingFrame(tick(volume));
    jest.advanceTimersByTime(300);
  };

  test('does not evaluate the crossover while averages are not loaded', () => {
    useRadarStore.setState({ stocks: [stock()], latchServiceInitialized: true, avgLoaded: false });
    pushTick(5000);
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('evaluates the crossover only after averages are loaded, passing the updated stocks', () => {
    useRadarStore.setState({ stocks: [stock()], latchServiceInitialized: true, avgLoaded: true });
    pushTick(5000);

    expect(evaluate).toHaveBeenCalledTimes(1);
    const [ctx, only] = evaluate.mock.calls[0];
    expect(only).toEqual([STRATEGY_IDS.VOLUME_CROSSOVER]);
    expect(ctx.stocks[0]).toMatchObject({ ticker: 'RELIANCE', todayTradedShares: 5000, hasCrossed20D: true });
  });

  test('waits for the latch to be ready', () => {
    useRadarStore.setState({ stocks: [stock()], latchServiceInitialized: false, avgLoaded: true });
    pushTick(6000);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
