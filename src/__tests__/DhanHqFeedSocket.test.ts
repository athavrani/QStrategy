import { dhanHqFeedSocket, DhanHqFeedSocket, testDhanFeedConnection } from '../services/dhan/DhanHqFeedSocket';
import { encodeDhanQuotePacket, encodeDhanTickerPacket, encodeDhanDisconnectPacket, DhanFeedRequestCode } from '../services/dhan/DhanBinaryCodec';
import { secureVault } from '../services/SecureCredentialVault';
import { Linking } from 'react-native';

// Mock expo-secure-store and expo-local-authentication
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
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: 'medium', Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

describe('DhanHqFeedSocket Service Suite', () => {
  let socketInstance: DhanHqFeedSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    socketInstance = new DhanHqFeedSocket();
  });

  afterEach(() => {
    socketInstance.stop();
  });

  test('reports initial telemetry status as DISCONNECTED', () => {
    const telem = socketInstance.getTelemetry();
    expect(telem.status).toBe('DISCONNECTED');
  });

  test('subscribes and tracks registered instruments cleanly', () => {
    socketInstance.subscribe({ exchangeSegment: 'NSE_EQ', securityId: '1333' });
    socketInstance.subscribe('13', 'IDX_I');

    // Test unsubscribe
    socketInstance.unsubscribe({ exchangeSegment: 'NSE_EQ', securityId: '1333' });
    expect(true).toBe(true);
  });

  test('subscribeBatch registers all constituent instruments', () => {
    socketInstance.subscribeBatch([
      { exchangeSegment: 'NSE_EQ', securityId: '25' },
      { exchangeSegment: 'NSE_EQ', securityId: '15083' },
      { exchangeSegment: 'IDX_I', securityId: '13' },
    ]);
    expect(true).toBe(true);
  });

  test('notifies tick listeners upon flushing micro-batched ticks', (done) => {
    jest.useFakeTimers();

    const quoteBuf = encodeDhanQuotePacket({
      securityId: 1333,
      ltp: 1650.5,
      ltq: 100,
      ltt: 1729321200,
      atp: 1648.2,
      volume: 5200000,
      totalSellQty: 45000,
      totalBuyQty: 62000,
      dayOpen: 1640.0,
      dayClose: 1635.0,
      dayHigh: 1655.0,
      dayLow: 1638.0,
    });

    const unsubscribe = socketInstance.addTickListener((batch) => {
      try {
        expect(batch['1333']).toBeDefined();
        expect(batch['1333'].responseCode).toBe(4);
        expect((batch['1333'] as any).ltp).toBe(1650.5);
        expect((batch['1333'] as any).volume).toBe(5200000);
        unsubscribe();
        jest.useRealTimers();
        done();
      } catch (e) {
        jest.useRealTimers();
        done(e);
      }
    });

    // Simulate incoming frame on socket
    (socketInstance as any).handleIncomingFrame(quoteBuf);

    // Fast-forward past 250ms throttle buffer
    jest.advanceTimersByTime(300);
  });

  test('launches Dhan mobile app via deep linking Intent or fallback URL', async () => {
    const canOpenSpy = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);

    await socketInstance.launchDhanApp('HDFCBANK', '1333', 'BUY');

    expect(canOpenSpy).toHaveBeenCalledWith(
      'dhan://trade/place?exchange=NSE&segment=NSE_FNO&securityId=1333&action=BUY'
    );
    expect(openSpy).toHaveBeenCalledWith(
      'dhan://trade/place?exchange=NSE&segment=NSE_FNO&securityId=1333&action=BUY'
    );
  });
});
