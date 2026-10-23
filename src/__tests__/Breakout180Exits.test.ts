import AsyncStorage from '@react-native-async-storage/async-storage';
import { niftyOptionFeedService as svc } from '../services/niftyOptionFeedService';
import { createBreakout180Strategy } from '../engine/strategies';

const setChain = (ce: number) => {
  (svc as any).cachedLiveOptionChain = {
    24800: { ceLtp: ce, peLtp: 140.0, ceSecId: '301', peSecId: '302' },
    24850: { ceLtp: 165.0, peLtp: 175.2, ceSecId: '303', peSecId: '304' },
  };
};
const setCe = (v: number) => {
  (svc as any).cachedLiveOptionChain[24800].ceLtp = v;
};

/** Locks at 09:25 and enters the CE at `entry`. */
const enter = (entry: number) => {
  setChain(178.5);
  svc.evaluateBreakout180(24800, '09:25:05 AM');
  setCe(entry);
  return svc.evaluateBreakout180(24800, '09:30:00 AM');
};

beforeEach(async () => {
  await AsyncStorage.clear();
  await svc.resetBreakout180(true);
});

describe('09:25 breakout stop-loss and target are relative to the actual entry', () => {
  test('a gap entry above 180 keeps a 20-point stop and 40-point target', () => {
    const s = enter(195);
    expect(s).toMatchObject({ status: 'IN_TRADE', entryPrice: 195, fixedStopLoss: 175, fixedTarget: 235 });
    setCe(176);
    expect(svc.evaluateBreakout180(24800, '09:30:00 AM').status).toBe('IN_TRADE');
  });

  test('stop-loss exits at the actual LTP, 20 points below entry', () => {
    enter(195);
    setCe(173.5);
    const s = svc.evaluateBreakout180(24800, '09:31:00 AM');
    expect(s).toMatchObject({ status: 'SL_HIT', exitPrice: 173.5, pnlPoints: -21.5 });
  });

  test('target exits at the actual LTP, 40 points above entry', () => {
    enter(182);
    setCe(223.5);
    expect(svc.evaluateBreakout180(24800, '09:35:00 AM')).toMatchObject({ status: 'TARGET_HIT', exitPrice: 223.5, pnlPoints: 41.5 });
  });

  test('a custom threshold moves the levels with the entry', async () => {
    await svc.setBreakoutThreshold(200);
    setChain(190);
    svc.evaluateBreakout180(24800, '09:25:05 AM');
    setCe(201);
    const s = svc.evaluateBreakout180(24800, '09:30:00 AM');
    expect(s).toMatchObject({ entryPrice: 201, fixedStopLoss: 181, fixedTarget: 241 });
    await svc.setBreakoutThreshold(180);
  });

  test('a missing quote is not read as a stop-loss', () => {
    enter(185);
    setCe(0);
    expect(svc.evaluateBreakout180(24800, '09:30:00 AM').status).toBe('IN_TRADE');
  });
});

describe('09:45 time exit and frozen exits', () => {
  test('time exit closes at the live LTP', () => {
    enter(182);
    setCe(190);
    expect(svc.evaluateBreakout180(24800, '09:44:59 IST').status).toBe('IN_TRADE');
    expect(svc.evaluateBreakout180(24800, '09:45:00 IST')).toMatchObject({ status: 'TIME_EXIT', exitPrice: 190, pnlPoints: 8 });
  });

  test('a stop-loss is not rewritten as a time exit or by a recovering price', () => {
    enter(182);
    setCe(150);
    expect(svc.evaluateBreakout180(24800, '09:30:00 AM').status).toBe('SL_HIT');
    setCe(185);
    expect(svc.evaluateBreakout180(24800, '09:31:00 AM')).toMatchObject({ status: 'SL_HIT', exitPrice: 150 });
    expect(svc.evaluateBreakout180(24800, '09:45:03 IST')).toMatchObject({ status: 'SL_HIT', exitPrice: 150 });
  });

  test('reloading persisted state does not roll back an in-memory exit', async () => {
    enter(182);
    setCe(150);
    svc.evaluateBreakout180(24800, '09:30:00 AM');
    await svc.loadPersistedBreakoutState();
    expect(svc.evaluateBreakout180(24800, '09:31:00 AM').status).toBe('SL_HIT');
  });

  test('engine records the exit at the frozen price', () => {
    enter(182);
    setCe(150);
    const state = svc.evaluateBreakout180(24800, '09:30:00 AM');
    const strategy = createBreakout180Strategy({
      notifier: {} as any,
      tacticalStrike: () => ({ recommendedCeStrike: 0 }),
    });
    const [exit] = strategy.detectExits!({ istTime: '09:30:00 IST', breakout: state });
    expect(exit).toMatchObject({ outcome: 'LOSS', exitPrice: 150, pnlPoints: -32 });
  });
});

describe('09:30 entry window', () => {
  const lock = () => {
    setChain(178.5);
    svc.evaluateBreakout180(24800, '09:25:05 AM');
  };

  test('no entry before 09:30 even if a leg is above 180', () => {
    lock();
    setCe(185);
    expect(svc.evaluateBreakout180(24800, '09:29:59 AM')).toMatchObject({ status: 'MONITORING_BREAKOUT', activeContract: null });
  });

  test('a leg above 180 at 09:30 is bought at the actual LTP', () => {
    lock();
    setCe(195);
    expect(svc.evaluateBreakout180(24800, '09:30:00 AM')).toMatchObject({ status: 'IN_TRADE', activeContract: 'CE', entryPrice: 195, fixedStopLoss: 175, fixedTarget: 235 });
  });

  test('a leg that crosses after 09:30 is bought on the first cross until 09:45', () => {
    lock();
    expect(svc.evaluateBreakout180(24800, '09:30:00 AM').status).toBe('MONITORING_BREAKOUT');
    setCe(181);
    expect(svc.evaluateBreakout180(24800, '09:38:10 AM')).toMatchObject({ status: 'IN_TRADE', entryPrice: 181 });
  });

  test('when both legs are at or above 180 the higher LTP wins', () => {
    lock();
    setCe(186);
    (svc as any).cachedLiveOptionChain[24800].peLtp = 192;
    expect(svc.evaluateBreakout180(24800, '09:30:00 AM')).toMatchObject({ status: 'IN_TRADE', activeContract: 'PE', entryPrice: 192 });
  });

  test('no entry when nothing crosses by 09:45', () => {
    lock();
    expect(svc.evaluateBreakout180(24800, '09:45:00 AM').status).toBe('NO_TRADE_TODAY');
  });
});
