import React, { useEffect, useState } from 'react';
import { useRadarStore } from './src/store/useRadarStore';
import { useTheme } from './src/theme';
import { notificationService } from './src/services/notificationService';
import { AppNavigator } from './src/navigation/AppNavigator';
import { dhanDirectService } from './src/services/dhanDirectService';
import { AppUpdateModal } from './src/components/common';
import { appUpdateService, UpdateCheckResult } from './src/services/appUpdateService';
import { formatDateKeyIST } from './src/constants/nseHolidays';
import { syncBackgroundMonitor } from './src/services/backgroundMonitorService';

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
    const clockTimer = setInterval(() => {
      const now = new Date();
      // Calculate Indian Standard Time (UTC + 5:30)
      const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
      const istMinutes = (now.getUTCMinutes() + 30) % 60;
      const istSeconds = now.getUTCSeconds();
      const timeStr = `${String(istHours).padStart(2, '0')}:${String(istMinutes).padStart(2, '0')}:${String(istSeconds).padStart(2, '0')} IST`;
      setIstTime(timeStr);
      runClockEvaluation();

      // Instant day change detection: triggers refreshAll the moment midnight IST strikes
      const currentSession = useRadarStore.getState().sessionDate;
      const todayDateKey = formatDateKeyIST();
      if (currentSession && currentSession !== todayDateKey) {
        refreshAll(false);
      }
    }, 1000);

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

