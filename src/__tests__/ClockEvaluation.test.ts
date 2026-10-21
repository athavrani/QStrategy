import { CLOCK_TRIGGERS, isNearTrigger, parseClockSeconds } from '../engine/clockTriggers';
import { useRadarStore } from '../store/useRadarStore';
import { niftyOptionFeedService } from '../services/niftyOptionFeedService';
import { sensexOptionFeedService } from '../services/sensexOptionFeedService';
import { strategyEngine, STRATEGY_IDS } from '../engine';

describe('clock triggers', () => {
  test('parses IST clock strings and rejects garbage', () => {
    expect(parseClockSeconds('09:20:00 IST')).toBe(9 * 3600 + 20 * 60);
    expect(parseClockSeconds('9:05:07')).toBe(9 * 3600 + 5 * 60 + 7);
    expect(parseClockSeconds('--:--:--')).toBeNull();
    expect(parseClockSeconds('25:00:00')).toBeNull();
  });

  test('is near a trigger from 2 s before to 8 s after, and only then', () => {
    expect(isNearTrigger('09:19:57 IST')).toBe(false);
    expect(isNearTrigger('09:19:58 IST')).toBe(true);
    expect(isNearTrigger('09:20:00 IST')).toBe(true);
    expect(isNearTrigger('09:20:08 IST')).toBe(true);
    expect(isNearTrigger('09:20:09 IST')).toBe(false);
    expect(isNearTrigger('09:45:03 IST')).toBe(true);
    expect(isNearTrigger('11:00:00 IST')).toBe(false);
    expect(isNearTrigger('--:--:--')).toBe(false);
    expect(CLOCK_TRIGGERS).toContain('09:25:00');
  });
});

describe('runClockEvaluation', () => {
  let evaluate: jest.SpyInstance;
  let nifty: jest.SpyInstance;
  let breakout: jest.SpyInstance;
  let sensex: jest.SpyInstance;

  beforeEach(() => {
    evaluate = jest.spyOn(strategyEngine, 'evaluate').mockResolvedValue([]);
    nifty = jest.spyOn(niftyOptionFeedService, 'evaluateOobtst').mockReturnValue({ status: 'ARMED' } as any);
    breakout = jest.spyOn(niftyOptionFeedService, 'evaluateBreakout180').mockReturnValue({ status: 'WAITING_0925' } as any);
    sensex = jest.spyOn(sensexOptionFeedService, 'evaluateSensexOobtst').mockReturnValue({ status: 'ARMED' } as any);
    useRadarStore.setState({ latchServiceInitialized: true, niftySpot: 24850, sensexSpot: 81000, istTime: '09:20:00 IST' });
  });
  afterEach(() => jest.restoreAllMocks());

  test('re-evaluates the option strategies at a trigger time without any tick', () => {
    useRadarStore.getState().runClockEvaluation();

    expect(nifty).toHaveBeenCalledWith(24850, '09:20:00 IST');
    expect(breakout).toHaveBeenCalledWith(24850, '09:20:00 IST');
    expect(sensex).toHaveBeenCalledWith(81000, '09:20:00 IST');
    expect(useRadarStore.getState().oobtstState).toEqual({ status: 'ARMED' });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][1]).toEqual([
      STRATEGY_IDS.BREAKOUT_180, STRATEGY_IDS.OOBTST_NIFTY, STRATEGY_IDS.OOBTST_SENSEX,
    ]);
  });

  test('does nothing away from trigger times, before the latch is ready, or without a spot', () => {
    useRadarStore.setState({ istTime: '11:00:00 IST' });
    useRadarStore.getState().runClockEvaluation();

    useRadarStore.setState({ istTime: '09:20:00 IST', latchServiceInitialized: false });
    useRadarStore.getState().runClockEvaluation();

    useRadarStore.setState({ latchServiceInitialized: true, niftySpot: 0, sensexSpot: 0 });
    useRadarStore.getState().runClockEvaluation();

    expect(nifty).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
