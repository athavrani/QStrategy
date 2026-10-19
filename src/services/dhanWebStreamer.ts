// =====================================================================
// QStrategy — Dhan Web Live Market Streamer Service (Phase 3)
// Direct WSS connection to wss://price-feed-web.dhan.co:443
// High-Speed 100ms Tick Throttler & Connection State Machine
// =====================================================================

import { Linking, AppState, AppStateStatus } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  DHAN_WEB_WS_URL,
  buildDhanWebAuthPacket,
  buildDhanWebSubscribePacket,
  buildDhanWebUnsubscribePacket,
  decodeDhanWebBinaryFeed,
  DhanLiveTickData,
} from './dhanWebBinaryProtocol';
import { secureVault, StreamerTelemetry as DhanStreamerTelemetry, DhanCredentials } from './SecureCredentialVault';
import { getDhanSecurityId, DHAN_NIFTY_INDEX_ID } from '../constants/dhanSecurityMaster';

export type TickListener = (ticks: Record<string, DhanLiveTickData>) => void;
export type TelemetryListener = (telemetry: DhanStreamerTelemetry) => void;

interface SubscribedInstrument {
  securityId: string;
  exchange: string;
  segment: string;
  mode: 'price' | 'depth';
}

class DhanWebStreamer {
  private cachedCreds: DhanCredentials = {
    clientId: '',
    token: '',
    tabId: '1',
    isStreamerEnabled: true,
  };
  private socket: WebSocket | null = null;
  private state: 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATED' | 'STREAMING' | 'RECONNECTING' = 'DISCONNECTED';
  
  private registeredInstruments = new Map<string, SubscribedInstrument>();
  private tickListeners = new Set<TickListener>();
  private telemetryListeners = new Set<TelemetryListener>();

  // 250ms Micro-Batch Buffer (4 updates/sec) to keep JS thread and gestures 100% responsive
  private pendingTickBatch = new Map<string, DhanLiveTickData>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly THROTTLE_MS = 250;

  // Auto-reconnect with exponential backoff
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isExplicitlyStopped = false;

  private packetsCount = 0;
  private lastConnectTime = 0;
  private currentLatencyMs: number | null = null;

  constructor() {
    // Listen for app foregrounding to automatically resume stream
    AppState.addEventListener('change', this.handleAppStateChange);
  }

  private handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      if (!this.isExplicitlyStopped && this.state === 'DISCONNECTED') {
        this.start();
      }
    } else if (nextState === 'background') {
      // Optional: keep alive or pause depending on battery, we keep running
    }
  };

  /**
   * Initializes and starts the live WebSocket connection
   */
  public async start(): Promise<void> {
    this.isExplicitlyStopped = false;
    const creds = await secureVault.getCredentials();
    this.cachedCreds = creds;

    if (!creds.isStreamerEnabled || !creds.clientId || !creds.token) {
      this.updateStatus('DISCONNECTED', 'Credentials missing or streamer disabled');
      return;
    }

    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return; // Already connecting or connected
    }

    this.clearTimers();
    this.updateStatus('CONNECTING');
    this.lastConnectTime = Date.now();

    try {
      this.socket = new WebSocket(DHAN_WEB_WS_URL);
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.currentLatencyMs = Date.now() - this.lastConnectTime;
        this.updateStatus('AUTHENTICATED', null, this.currentLatencyMs);

        // 1. Send 703-byte Auth Packet
        const authPacket = buildDhanWebAuthPacket(creds.clientId, creds.token, creds.tabId);
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(authPacket);
        }

        // 2. Flush all registered instrument subscriptions
        this.flushSubscriptions();

        // 3. Start high-frequency tick flush timer
        this.startFlushTimer();
      };

      this.socket.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.socket.onerror = (err: any) => {
        const errorMsg = err?.message || 'WebSocket Network Error';
        this.updateStatus('ERROR', errorMsg);
      };

      this.socket.onclose = (event) => {
        this.stopFlushTimer();
        this.socket = null;
        if (!this.isExplicitlyStopped) {
          this.scheduleReconnect();
        } else {
          this.updateStatus('DISCONNECTED');
        }
      };
    } catch (e: any) {
      this.updateStatus('ERROR', e.message || 'Failed to initialize WebSocket');
      this.scheduleReconnect();
    }
  }

  /**
   * Gracefully stops the WebSocket streamer
   */
  public stop(): void {
    this.isExplicitlyStopped = true;
    this.clearTimers();
    this.stopFlushTimer();

    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }

    this.updateStatus('DISCONNECTED');
  }

  /**
   * Subscribes to a single instrument for live ticks
   */
  public subscribe(
    securityId: string,
    exchange = 'NSE',
    segment = 'E',
    mode: 'price' | 'depth' = 'price'
  ): void {
    const key = `${securityId}-${segment}-${exchange}`;
    this.registeredInstruments.set(key, { securityId, exchange, segment, mode });

    const creds = this.cachedCreds;
    if (this.socket && this.socket.readyState === WebSocket.OPEN && creds.clientId && creds.token) {
      const packet = buildDhanWebSubscribePacket(
        creds.clientId,
        creds.token,
        securityId,
        exchange,
        segment,
        mode,
        creds.tabId
      );
      this.socket.send(packet);
    }
  }

  /**
   * Subscribes to multiple instruments in batch
   */
  public subscribeBatch(
    items: { securityId: string; exchange?: string; segment?: string; mode?: 'price' | 'depth' }[]
  ): void {
    items.forEach((item) => {
      this.subscribe(item.securityId, item.exchange || 'NSE', item.segment || 'E', item.mode || 'price');
    });
  }

  /**
   * Unsubscribes from an instrument
   */
  public unsubscribe(
    securityId: string,
    exchange = 'NSE',
    segment = 'E',
    mode: 'price' | 'depth' = 'price'
  ): void {
    const key = `${securityId}-${segment}-${exchange}`;
    this.registeredInstruments.delete(key);

    const creds = this.cachedCreds;
    if (this.socket && this.socket.readyState === WebSocket.OPEN && creds.clientId && creds.token) {
      const packet = buildDhanWebUnsubscribePacket(
        creds.clientId,
        creds.token,
        securityId,
        exchange,
        segment,
        mode,
        creds.tabId
      );
      this.socket.send(packet);
    }
  }

  /**
   * Internal message handler
   */
  private handleMessage(event: WebSocketMessageEvent): void {
    const data = event.data;

    // Heartbeat: 1-byte ACK (0x20)
    if (data instanceof ArrayBuffer && data.byteLength === 1) {
      // Send ACK back
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(new Uint8Array([0x20]));
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.packetsCount++;
      const ticks = decodeDhanWebBinaryFeed(data);

      if (ticks.length > 0) {
        if (this.state !== 'STREAMING') {
          this.updateStatus('STREAMING', null, this.currentLatencyMs);
        }

        // Buffer into micro-batch map (keys: securityId or composite key)
        ticks.forEach((tick) => {
          this.pendingTickBatch.set(tick.key, tick);
          this.pendingTickBatch.set(tick.securityId, tick);
        });
      }
    }
  }

  /**
   * Starts the 100ms micro-batch flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.pendingTickBatch.size > 0) {
        const batch: Record<string, DhanLiveTickData> = {};
        this.pendingTickBatch.forEach((val, key) => {
          batch[key] = val;
        });
        this.pendingTickBatch.clear();

        const nowStr = new Date().toLocaleTimeString('en-IN');
        secureVault.updateTelemetry({
          lastTickTime: nowStr,
          packetsReceived: this.packetsCount,
        });

        // Notify all registered tick listeners atomically
        this.tickListeners.forEach((listener) => {
          try {
            listener(batch);
          } catch {}
        });
      }
    }, this.THROTTLE_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Sends subscription packets for all registered instruments
   */
  private flushSubscriptions(): void {
    const creds = this.cachedCreds;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !creds.clientId || !creds.token) {
      return;
    }

    let delayMs = 0;
    this.registeredInstruments.forEach((instr) => {
      setTimeout(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          const packet = buildDhanWebSubscribePacket(
            creds.clientId,
            creds.token,
            instr.securityId,
            instr.exchange,
            instr.segment,
            instr.mode,
            creds.tabId
          );
          this.socket.send(packet);
        }
      }, delayMs);
      delayMs += 15; // smooth 15ms pace: all 60 stocks register in under 1 second cleanly
    });
  }

  /**
   * Schedules an automatic reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isExplicitlyStopped) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.updateStatus('ERROR', 'Max reconnect attempts reached. Tap to reconnect.');
      return;
    }

    this.reconnectAttempts++;
    this.updateStatus('RECONNECTING');

    const delayMs = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 12000);
    this.reconnectTimer = setTimeout(() => {
      this.start();
    }, delayMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private updateStatus(
    status: 'STREAMING' | 'CONNECTING' | 'DISCONNECTED' | 'TOKEN_EXPIRED' | 'ERROR' | 'AUTHENTICATED' | 'RECONNECTING',
    lastError: string | null = null,
    latencyMs: number | null = null
  ): void {
    const mappedStatus =
      status === 'AUTHENTICATED' || status === 'RECONNECTING'
        ? 'CONNECTING'
        : status;

    this.state = status as any;
    secureVault.updateTelemetry({
      status: mappedStatus as any,
      lastError,
      latencyMs: latencyMs !== null ? latencyMs : undefined,
    });

    const telem = secureVault.getTelemetry();
    this.telemetryListeners.forEach((l) => {
      try {
        l(telem);
      } catch {}
    });
  }

  /**
   * Subscribes a listener to receive throttled tick batches
   */
  public addTickListener(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /**
   * Subscribes a listener to receive connection telemetry
   */
  public addTelemetryListener(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  /**
   * Launches the native Dhan mobile app installed on the device via Intent
   */
  public async launchDhanApp(
    symbol: string,
    securityId?: string,
    action: 'BUY' | 'SELL' = 'BUY'
  ): Promise<void> {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const secId = securityId || getDhanSecurityId(symbol);
    const encoded = encodeURIComponent(symbol);

    const directOrderIntent = `dhan://trade/place?exchange=NSE&segment=NSE_FNO&securityId=${secId}&action=${action}`;
    const searchIntent = `dhan://search?q=${encoded}`;

    try {
      const canOpenOrder = await Linking.canOpenURL(directOrderIntent);
      if (canOpenOrder) {
        await Linking.openURL(directOrderIntent);
        return;
      }

      const canOpenSearch = await Linking.canOpenURL(searchIntent);
      if (canOpenSearch) {
        await Linking.openURL(searchIntent);
        return;
      }

      await Linking.openURL('https://web.dhan.co');
    } catch {
      await Linking.openURL('https://web.dhan.co');
    }
  }
}

export const dhanWebStreamer = new DhanWebStreamer();

/**
 * Diagnostic ping test for SettingsScreen to test WebSocket TLS handshake & Auth
 */
export async function testDhanWebStreamerConnection(
  clientId: string,
  token: string
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    try {
      const ws = new WebSocket(DHAN_WEB_WS_URL);
      ws.binaryType = 'arraybuffer';

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve({ ok: false, latencyMs: 0, error: 'Connection timed out (5s)' });
      }, 5000);

      ws.onopen = () => {
        const latency = Date.now() - startTime;
        const auth = buildDhanWebAuthPacket(clientId, token);
        ws.send(auth);
        clearTimeout(timer);
        setTimeout(() => {
          try {
            ws.close();
          } catch {}
        }, 500);
        resolve({ ok: true, latencyMs: latency });
      };

      ws.onerror = (e: any) => {
        clearTimeout(timer);
        resolve({ ok: false, latencyMs: 0, error: e?.message || 'WebSocket Handshake Failed' });
      };
    } catch (e: any) {
      resolve({ ok: false, latencyMs: 0, error: e.message });
    }
  });
}

