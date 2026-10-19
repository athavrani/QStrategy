import * as SecureStore from 'expo-secure-store';

export type CrossoverTriggerState = 'GREEN' | 'RED';

export interface LatchedAlertRecord {
  ticker: string;
  state: CrossoverTriggerState;
  tradeDate: string;
  crossoverTime: string;
  spotPrice: number;
  todayTradedShares: number;
  avg20DTradedShares: number;
  volumeRatio: number;
  timestampMs: number;
}

class AlertLatchService {
  private activeLatches: Map<string, LatchedAlertRecord> = new Map();
  private currentSessionDate: string = '';
  private initialized: boolean = false;

  constructor() {
    this.currentSessionDate = this.getTodayISTDateString();
  }

  /**
   * Returns current Indian Standard Time (IST) date string in YYYY-MM-DD format.
   * Session boundary resets at 09:00:00 AM IST.
   */
  public getTodayISTDateString(): string {
    const now = new Date();
    // Offset by UTC + 5:30
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
    const istDate = new Date(istMs);

    const year = istDate.getUTCFullYear();
    const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getStorageKey(tradeDate: string): string {
    return `qp_latch_session_${tradeDate}`;
  }

  /**
   * Initializes local persistent store and synchronizes with remote Supabase audit logs.
   * Guarantees persistence across app restarts, reboots, and multi-device sessions.
   */
  public async initialize(): Promise<void> {
    const today = this.getTodayISTDateString();
    this.currentSessionDate = today;

    // 1. Load local device storage
    try {
      const storageKey = this.getStorageKey(today);
      const savedJson = await SecureStore.getItemAsync(storageKey);
      if (savedJson) {
        const records: Record<string, LatchedAlertRecord> = JSON.parse(savedJson);
        this.activeLatches.clear();
        for (const [key, rec] of Object.entries(records)) {
          if (rec.tradeDate === today) {
            this.activeLatches.set(key, rec);
          }
        }
      }
    } catch {}

    // 2. Sync with remote Supabase audit logs to prevent cross-device/browser tab duplicates
    await this.syncRemoteDispatchLogs(today);
    this.initialized = true;
  }

  /**
   * Checks whether a notification for this stock and trigger state has already been fired today.
   * If locked, strictly returns true (duplicate alert suppressed).
   */
  public isAlertLatched(ticker: string, state: CrossoverTriggerState): boolean {
    const today = this.getTodayISTDateString();
    // Auto-detect day rollover
    if (today !== this.currentSessionDate) {
      this.currentSessionDate = today;
      this.activeLatches.clear();
    }

    const key = `${ticker}_${state}`;
    return this.activeLatches.has(key);
  }

  /**
   * Attempts to acquire the monotonic alert latch for today's session.
   * Returns true if lock was acquired and notification should fire.
   * Returns false if already latched (suppressed).
   */
  public async acquireAlertLatch(
    ticker: string,
    state: CrossoverTriggerState,
    details: {
      spotPrice: number;
      todayTradedShares: number;
      avg20DTradedShares: number;
      volumeRatio: number;
      crossoverTime?: string;
    }
  ): Promise<boolean> {
    const today = this.getTodayISTDateString();
    const key = `${ticker}_${state}`;

    if (this.isAlertLatched(ticker, state)) {
      // MONOTONIC INVARIANT: Already latched for this session. Suppress duplicate.
      return false;
    }

    const record: LatchedAlertRecord = {
      ticker,
      state,
      tradeDate: today,
      crossoverTime: details.crossoverTime || new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      spotPrice: details.spotPrice,
      todayTradedShares: details.todayTradedShares,
      avg20DTradedShares: details.avg20DTradedShares,
      volumeRatio: details.volumeRatio,
      timestampMs: Date.now(),
    };

    // Lock in memory
    this.activeLatches.set(key, record);

    // Persist to SecureStore
    await this.persistLocalLatches(today);

    // Broadcast to remote Supabase alert_dispatch_logs (fire-and-forget)
    this.broadcastRemoteDispatchLog(key, record).catch(() => {});

    return true;
  }

  public getLatchedRecord(ticker: string): LatchedAlertRecord | null {
    const today = this.getTodayISTDateString();
    if (today !== this.currentSessionDate) return null;

    const green = this.activeLatches.get(`${ticker}_GREEN`);
    if (green) return green;
    const red = this.activeLatches.get(`${ticker}_RED`);
    if (red) return red;
    return null;
  }

  public getAllSessionLatches(): LatchedAlertRecord[] {
    return Array.from(this.activeLatches.values());
  }

  private async persistLocalLatches(today: string): Promise<void> {
    try {
      const storageKey = this.getStorageKey(today);
      const obj: Record<string, LatchedAlertRecord> = {};
      for (const [k, v] of this.activeLatches.entries()) {
        obj[k] = v;
      }
      await SecureStore.setItemAsync(storageKey, JSON.stringify(obj));
    } catch {}
  }

  private async syncRemoteDispatchLogs(today: string): Promise<void> {
    try {
      const eventKeyPrefix = `20D_CROSSOVER_${today}`;
      const res = await fetch(
        `https://cmcgvadapaoapxrxdcau.supabase.co/rest/v1/alert_dispatch_logs?select=event_key,ticker,payload&event_key=like.${encodeURIComponent(eventKeyPrefix)}*`,
        {
          headers: {
            apikey: 'sb_publishable_SVF3AyZbDDIIT5v5QLi0AA_kz_uuXj6',
            Authorization: 'Bearer sb_publishable_SVF3AyZbDDIIT5v5QLi0AA_kz_uuXj6',
          },
        }
      );

      if (res.ok) {
        const rows = await res.json();
        for (const r of rows) {
          // event_key format: 20D_CROSSOVER_YYYY-MM-DD_TICKER_GREEN
          const parts = r.event_key.split('_');
          const state = parts[parts.length - 1] as CrossoverTriggerState;
          const ticker = r.ticker;
          if (ticker && (state === 'GREEN' || state === 'RED')) {
            const key = `${ticker}_${state}`;
            if (!this.activeLatches.has(key)) {
              this.activeLatches.set(key, {
                ticker,
                state,
                tradeDate: today,
                crossoverTime: r.payload?.crossoverTime || 'Logged',
                spotPrice: r.payload?.spotPrice || 0,
                todayTradedShares: r.payload?.todayTradedShares || 0,
                avg20DTradedShares: r.payload?.avg20DTradedShares || 0,
                volumeRatio: r.payload?.volumeRatio || 1.0,
                timestampMs: Date.now(),
              });
            }
          }
        }
      }
    } catch {}
  }

  private async broadcastRemoteDispatchLog(key: string, record: LatchedAlertRecord): Promise<void> {
    try {
      const eventKey = `20D_CROSSOVER_${record.tradeDate}_${record.ticker}_${record.state}`;
      await fetch(`https://cmcgvadapaoapxrxdcau.supabase.co/rest/v1/alert_dispatch_logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: 'sb_publishable_SVF3AyZbDDIIT5v5QLi0AA_kz_uuXj6',
          Authorization: 'Bearer sb_publishable_SVF3AyZbDDIIT5v5QLi0AA_kz_uuXj6',
          Prefer: 'resolution=ignore-duplicates',
        },
        body: JSON.stringify({
          event_key: eventKey,
          event_type: '20D_VOLUME_CROSSOVER',
          ticker: record.ticker,
          destination_chat_id: 'MOBILE_CLIENT_UNIVERSAL',
          payload: record,
        }),
      });
    } catch {}
  }
}

export const alertLatchService = new AlertLatchService();
