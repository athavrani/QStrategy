import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import BackgroundService from 'react-native-background-actions';
import {
  isBackgroundMonitorEnabled,
  setBackgroundMonitorEnabled,
  setBackgroundTickHandler,
  startBackgroundMonitor,
  syncBackgroundMonitor,
  stopBackgroundMonitor,
} from '../services/backgroundMonitorService';

describe('backgroundMonitorService', () => {
  beforeEach(async () => {
    Platform.OS = 'android';
    await AsyncStorage.clear();
    await stopBackgroundMonitor();
    (BackgroundService.start as jest.Mock).mockClear();
  });

  it('is enabled by default and starts the service on launch', async () => {
    expect(await isBackgroundMonitorEnabled()).toBe(true);
    expect(await syncBackgroundMonitor()).toBe(true);
    expect(BackgroundService.isRunning()).toBe(true);
  });

  it('does not start a second service when one is already running', async () => {
    await syncBackgroundMonitor();
    await syncBackgroundMonitor();
    expect(BackgroundService.start).toHaveBeenCalledTimes(1);
  });

  it('stays off after the user opts out, including on the next launch', async () => {
    await syncBackgroundMonitor();
    expect(await setBackgroundMonitorEnabled(false)).toBe(false);
    expect(BackgroundService.isRunning()).toBe(false);
    expect(await isBackgroundMonitorEnabled()).toBe(false);
    expect(await syncBackgroundMonitor()).toBe(false);
    expect(BackgroundService.isRunning()).toBe(false);
  });

  it('reports failure when the native service cannot start', async () => {
    (BackgroundService.start as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    expect(await setBackgroundMonitorEnabled(true)).toBe(false);
  });

  it('runs the registered clock evaluation from the background task and survives a failing one', async () => {
    jest.useFakeTimers();
    try {
      const tick = jest.fn(() => {
        throw new Error('boom');
      });
      setBackgroundTickHandler(tick);
      await startBackgroundMonitor();
      const task = (BackgroundService.start as jest.Mock).mock.calls[0][0] as () => Promise<void>;
      const finished = task();
      expect(tick).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5000);
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);

      await stopBackgroundMonitor();
      await jest.advanceTimersByTimeAsync(5000);
      await finished;
    } finally {
      setBackgroundTickHandler(null);
      jest.useRealTimers();
    }
  });
});
