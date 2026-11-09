import React, { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useRadarStore } from './src/store/useRadarStore';
import { useTheme } from './src/theme';
import { notificationService } from './src/services/notificationService';
import { AppNavigator } from './src/navigation/AppNavigator';
import { dhanDirectService } from './src/services/dhanDirectService';
import { AppUpdateModal } from './src/components/common';
import { appUpdateService, UpdateCheckResult } from './src/services/appUpdateService';
import { formatDateKeyIST } from './src/constants/nseHolidays';
import { setBackgroundTickHandler, syncBackgroundMonitor } from './src/services/backgroundMonitorService';
import { isMarketHoursIst, istClockString } from './src/services/marketdata/lockSchedule';
import { dhanHqFeedSocket } from './src/services/dhan/DhanHqFeedSocket';
import { startPositionMonitor, stopPositionMonitor } from './src/execution/positionMonitor';

export default function App() {
  const refreshAll = useRadarStore((s) => s.refreshAll);
  const ensureLatchReady = useRadarStore((s) => s.ensureLatchReady);
  const setIstTime = useRadarStore((s) => s.setIstTime);
  const runClockEvaluation = useRadarStore((s) => s.runClockEvaluation);
  const initStreamer = useRadarStore((s) => s.initStreamer);
  const { initTheme } = useTheme();
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isUpdateModalVisible, setIsUpdateModalVisible] = useState(false);

  useEffect(() => {
    // 0. Initialize saved theme preference
    initTheme();

    // 1. Initialize notification channel permissions
    notificationService.registerForPushNotifications();

    // Foreground service keeps timers and the Dhan socket alive while the app is minimised
    syncBackgroundMonitor().catch(() => {});

    // Keeps stop-losses placed and exits tracked for positions opened by the app, even when the Orders tab is closed
    startPositionMonitor();

    // 2. Restore latches and today's journal first, then load data and launch the live streamer.
    // The streamer starts even if the first refresh fails, so ticks are never blocked by one bad REST call.
    ensureLatchReady().catch(() => {});
    refreshAll(false)
      .catch(() => {})
      .then(() => {
        initStreamer();
      });

    // 3. Background sync fallback (every 10 seconds, runs silently without hiccups)
    const backgroundSyncTimer = setInterval(() => {
      refreshAll(false);
    }, 10000);

    // 4. Live IST Clock Timer (1 second interval)
    // Reads the wall clock each time, so a late tick after the timers were paused still sees the real time.
    const evaluateClock = () => {
      setIstTime(istClockString());
      // A socket that stalled or closed while the app was in the background is reopened from here, not on the next foreground
      if (isMarketHoursIst()) dhanHqFeedSocket.ensureAlive();
      runClockEvaluation();
    };
    const clockTimer = setInterval(() => {
      evaluateClock();

      // Instant day change detection: triggers refreshAll the moment midnight IST strikes
      const currentSession = useRadarStore.getState().sessionDate;
      const todayDateKey = formatDateKeyIST();
      if (currentSession && currentSession !== todayDateKey) {
        refreshAll(false);
      }
    }, 1000);

    // The background task has its own loop, which keeps running while the screen timers are paused.
    setBackgroundTickHandler(evaluateClock);

    // Back in the foreground the paused timers missed the 09:20 lock; refresh the chain and catch up straight away.
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      evaluateClock();
      refreshAll(false)
        .catch(() => {})
        .then(evaluateClock);
    });

    // 5. Silent background app update check (runs after 2.5s to keep startup instantaneous)
    const updateCheckTimeout = setTimeout(async () => {
      try {
        const result = await appUpdateService.checkForUpdate();
        if (result.updateAvailable && !appUpdateService.isDismissed(result.latestVersion)) {
          setUpdateInfo(result);
          setIsUpdateModalVisible(true);
        }
      } catch {
        // Silent failure - do not interrupt trading loop
      }
    }, 2500);

    return () => {
      clearInterval(clockTimer);
      clearInterval(backgroundSyncTimer);
      clearTimeout(updateCheckTimeout);
      appStateSub.remove();
      setBackgroundTickHandler(null);
      stopPositionMonitor();
    };
  }, []);

  return (
    <>
      <AppNavigator />
      <AppUpdateModal
        visible={isUpdateModalVisible}
        updateInfo={updateInfo}
        onClose={() => setIsUpdateModalVisible(false)}
      />
    </>
  );
}

