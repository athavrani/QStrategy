import React, { useEffect } from 'react';
import { useRadarStore } from './src/store/useRadarStore';
import { useTheme } from './src/theme';
import { notificationService } from './src/services/notificationService';
import { AppNavigator } from './src/navigation/AppNavigator';
import { dhanDirectService } from './src/services/dhanDirectService';

export default function App() {
  const { refreshAll, setIstTime, initStreamer } = useRadarStore();
  const { initTheme } = useTheme();

  useEffect(() => {
    // 0. Initialize saved theme preference
    initTheme();

    // 1. Initialize notification channel permissions
    notificationService.registerForPushNotifications();

    // 2. Perform initial batch data load silently in background then launch live Dhan Web Streamer
    refreshAll(false).then(() => {
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
    }, 1000);

    return () => {
      clearInterval(clockTimer);
      clearInterval(backgroundSyncTimer);
    };
  }, []);

  return <AppNavigator />;
}
