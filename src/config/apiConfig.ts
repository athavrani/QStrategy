// API and Backend Gateway Configuration for QStrategy Mobile Terminal

export const API_CONFIG = {
  // Update this to your local computer's IP when testing on physical phone via Expo Go
  BASE_URL: (process.env as Record<string, string | undefined>)?.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:3000',

  ENDPOINTS: {
    // Strategy Telemetry
    NIFTY_OVERNIGHT: '/api/strategy/nifty-overnight',
    NIFTY_BREAKOUT_180: '/api/strategy/nifty-breakout-180',
    
    // Screener & Market Feeds
    MARKET_SESSION: '/api/pipeline/market-session',
    CENTRAL_FEED_TICK: '/api/pipeline/central-feed-tick',
    SYNC_BASELINES: '/api/pipeline/sync-baselines',
    OPTION_CHAIN: '/api/broker/dhan/option-chain',
    STOCK_QUOTE: '/api/broker/dhan/quote',
    
    // Alerts
    ALERT_SETTINGS: '/api/alerts/settings',
    TELEGRAM_ALERT: '/api/alerts/telegram',
  },

  TIMEOUT_MS: 8000,
  POLL_INTERVAL_ACTIVE_MS: 2000,  // Fast polling during 09:15 - 09:45
  POLL_INTERVAL_IDLE_MS: 5000,    // Normal polling throughout the day
};
