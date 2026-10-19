import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configure notification behavior when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export const notificationService = {
  async registerForPushNotifications(): Promise<boolean> {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        return false;
      }

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('qstrategy_signals', {
          name: 'QStrategy Signals',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#10B981',
        });
      }

      return true;
    } catch {
      return false;
    }
  },

  // 1. Alert: 20D Volume Crossover (100% Confirmed)
  async notify20DCrossover(ticker: string, volumeRatio: number, spotPrice: number, atmStrike: number) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `🔥 20D VOLUME BUY: ${ticker}`,
          body: `Breakout! Traded ${(volumeRatio * 100).toFixed(0)}% of 20D Avg @ ₹${spotPrice.toFixed(2)} | Rec Strike: ${atmStrike} CE`,
          data: { strategy: '20D_CROSSOVER', ticker },
          sound: true,
        },
        trigger: null, // Send immediately
      });
    } catch {}
  },

  // 1B. Alert: 20D Volume Early Warning (80% Proximity Heads-Up)
  async notify20DEarlyWarning(ticker: string, volumeRatio: number, spotPrice: number, atmStrike: number) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `⚡ 20D PROXIMITY ALERT (80%): ${ticker}`,
          body: `Fast accumulation! Traded ${(volumeRatio * 100).toFixed(0)}% of 20D Avg @ ₹${spotPrice.toFixed(2)} | Prepare ${atmStrike} CE`,
          data: { strategy: '20D_CROSSOVER', ticker, alertType: 'EARLY_WARNING' },
          sound: true,
        },
        trigger: null,
      });
    } catch {}
  },

  // 2. Alert: 09:20 Overnight Strangle Entry
  async notify0920StrangleEntry(ceStrike: number, peStrike: number, cePrice: number, pePrice: number) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '🟢 09:20 STRANGLE BUY SIGNAL (NIFTY)',
          body: `CE: ${ceStrike} @ ₹${cePrice.toFixed(2)} | PE: ${peStrike} @ ₹${pePrice.toFixed(2)} | ZERO TARGET | Hold Overnight`,
          data: { strategy: 'NIFTY_OVERNIGHT' },
          sound: true,
        },
        trigger: null,
      });
    } catch {}
  },

  // 3. Alert: 09:20 Strangle Stop Loss Hit
  async notify0920StopLossHit(legType: 'CE' | 'PE', strike: number, price: number) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `🛑 25% SL HIT: NIFTY ${strike} ${legType}`,
          body: `Price hit ₹${price.toFixed(2)}. EXIT ${legType} LEG IMMEDIATELY. Remaining leg stays in hold.`,
          data: { strategy: 'NIFTY_OVERNIGHT' },
          sound: true,
        },
        trigger: null,
      });
    } catch {}
  },

  // 4. Alert: 09:25 Breakout Triggered
  async notify180BreakoutTriggered(type: 'CE' | 'PE', strike: number, price: number, target: number, sl: number) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `🚀 09:25 BREAKOUT BUY: NIFTY ${strike} ${type}`,
          body: `Broke ₹180 (Price: ₹${price.toFixed(2)}, Open < 180) | Target: ₹${target} | SL: ₹${sl} | Opposite Disabled | Exit: 09:45 AM`,
          data: { strategy: 'NIFTY_BREAKOUT_180' },
          sound: true,
        },
        trigger: null,
      });
    } catch {}
  },

  // 5. Alert: 09:45 Time Exit
  async notify180TimeExit(strike: number, type: 'CE' | 'PE') {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `⏱️ 09:45 TIME EXIT: NIFTY ${strike} ${type}`,
          body: '09:45 AM hard time limit reached. Close breakout position at current market price.',
          data: { strategy: 'NIFTY_BREAKOUT_180' },
          sound: true,
        },
        trigger: null,
      });
    } catch {}
  },
};
