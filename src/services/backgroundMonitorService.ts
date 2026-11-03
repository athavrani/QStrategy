import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundService from 'react-native-background-actions';
import { backgroundTickDelayMs } from './marketdata/lockSchedule';

const PREF_KEY = '@qstrategy_background_monitor';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let tickHandler: (() => void) | null = null;

/** Registers the clock evaluation that the background task runs, so time triggers do not rely on the screen's timers. */
export function setBackgroundTickHandler(handler: (() => void) | null): void {
  tickHandler = handler;
}

// Keeps the foreground service alive and drives the clock evaluation from its own loop, which keeps running while
// the app is minimised and the UI timers are paused.
const keepAliveTask = async (): Promise<void> => {
  while (BackgroundService.isRunning()) {
    try {
      tickHandler?.();
    } catch {
      // A failed evaluation must not stop the service
    }
    await sleep(backgroundTickDelayMs());
  }
};

const SERVICE_OPTIONS = {
  taskName: 'QStrategyMonitor',
  taskTitle: 'QStrategy is monitoring',
  taskDesc: 'Watching strikes, locks and exits so alerts fire with the app closed',
  taskIcon: { name: 'notification_icon', type: 'drawable' },
  color: '#10B981',
  linkingURI: 'qstrategy://',
};

/** On by default; only an explicit opt-out disables it. */
export async function isBackgroundMonitorEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PREF_KEY)) !== 'off';
  } catch {
    return true;
  }
}

export async function startBackgroundMonitor(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (BackgroundService.isRunning()) return true;
  try {
    await BackgroundService.start(keepAliveTask, SERVICE_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

export async function stopBackgroundMonitor(): Promise<void> {
  try {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
  } catch {
    // Already stopped
  }
}

export async function setBackgroundMonitorEnabled(enabled: boolean): Promise<boolean> {
  try {
    await AsyncStorage.setItem(PREF_KEY, enabled ? 'on' : 'off');
  } catch {
    // Preference is best-effort; the service state below still applies
  }
  if (!enabled) {
    await stopBackgroundMonitor();
    return false;
  }
  return startBackgroundMonitor();
}

/** Starts the service at launch when the user has not opted out. */
export async function syncBackgroundMonitor(): Promise<boolean> {
  if (!(await isBackgroundMonitorEnabled())) return false;
  return startBackgroundMonitor();
}

/** Opens Android's battery optimisation list so QStrategy can be set to "Unrestricted". */
export function openBatterySettings(): void {
  if (Platform.OS !== 'android') return;
  Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => {
    Linking.openSettings().catch(() => {});
  });
}
