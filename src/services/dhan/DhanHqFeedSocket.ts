/**
 * QStrategy — Official DhanHQ v2 Live Market Feed WebSocket Client
 * Official WebSocket endpoint: wss://api-feed.dhan.co?version=2
 * Features 250ms micro-batch buffer, Little-Endian binary packet decoding,
 * exponential backoff reconnection, and hardware Keystore integration.
 */

import {
  decodeDhanBinaryPacket,
  buildDhanSubscriptionMessage,
  buildDhanUnsubscriptionMessage,
  buildDhanDisconnectMessage,
  DhanFeedResponseCode,
  DhanParsedPacket,
  DhanQuotePacket,
  DhanTickerPacket,
  InstrumentSubscription,
  DhanFeedRequestCode,
} from './DhanBinaryCodec';
import { Linking, AppState, AppStateStatus } from 'react-native';
import * as Haptics from 'expo-haptics';
import { secureVault, StreamerTelemetry } from '../SecureCredentialVault';
import { getDhanSecurityId } from '../../constants/dhanSecurityMaster';

export const OFFICIAL_DHAN_FEED_URL = 'wss://api-feed.dhan.co';

export type FeedTickListener = (ticks: Record<string, DhanParsedPacket>) => void;
export type FeedTelemetryListener = (telemetry: StreamerTelemetry) => void;

export class DhanHqFeedSocket {
  private socket: WebSocket | null = null;
  private isExplicitlyStopped = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // 250ms Micro-Batch Buffer (Prevents UI Thread Starvation)
  private readonly THROTTLE_MS = 250;
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingTickBatch = new Map<string, DhanParsedPacket>();
  private packetsReceivedCount = 0;

  // Registered instrument catalog
  private registeredInstruments = new Map<string, InstrumentSubscription>();

  // Event Listeners
  private tickListeners = new Set<FeedTickListener>();
  private telemetryListeners = new Set<FeedTelemetryListener>();

  constructor() {
    AppState.addEventListener('change', this.handleAppStateChange);
  }

  private handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      if (!this.isExplicitlyStopped && (!this.socket || this.socket.readyState === WebSocket.CLOSED)) {
        this.start();
      }
    }
  };

  /**
   * Initializes and starts live WebSocket connection to official DhanHQ v2 feed
   */
  public async start(): Promise<void> {
    this.isExplicitlyStopped = false;
    const creds = await secureVault.getEffectiveCredentials();

    if (!creds.isStreamerEnabled || !creds.clientId || !creds.token) {
      this.updateStatus('DISCONNECTED', 'Missing Dhan credentials or streamer disabled');
      return;
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return; // Already active
    }

    this.clearTimers();
    this.updateStatus('CONNECTING');

    // Official DhanHQ v2 WebSocket URL
    const wsUrl = `${OFFICIAL_DHAN_FEED_URL}?version=2&token=${encodeURIComponent(
      creds.token
    )}&clientId=${encodeURIComponent(creds.clientId)}&authType=2`;

    try {
      this.socket = new WebSocket(wsUrl);
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.updateStatus('STREAMING', null);
        this.flushSubscriptions();
      };

      this.socket.onmessage = (event: any) => {
        this.handleIncomingFrame(event.data);
      };

      this.socket.onerror = (event: any) => {
        this.updateStatus('ERROR', 'WebSocket encountered connection error');
      };

      this.socket.onclose = (event: any) => {
        this.socket = null;
        if (!this.isExplicitlyStopped) {
          this.scheduleReconnect();
        } else {
          this.updateStatus('DISCONNECTED', 'Disconnected by user');
        }
      };
    } catch (err: any) {
      this.updateStatus('ERROR', `WebSocket connection exception: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Gracefully shuts down connection
   */
  public stop(): void {
    this.isExplicitlyStopped = true;
    this.clearTimers();

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(buildDhanDisconnectMessage());
        this.socket.close(1000, 'Normal Closure');
      } catch {}
    }
    this.socket = null;
    this.updateStatus('DISCONNECTED', 'Feed stopped');
  }

  /**
   * Subscribes to a single instrument (supports InstrumentSubscription or securityId + segment)
   */
  public subscribe(
    instrumentOrSecId: InstrumentSubscription | string,
    exchangeSegment: string = 'NSE_EQ',
    requestCode = DhanFeedRequestCode.SUBSCRIBE_QUOTE
  ): void {
    let instrument: InstrumentSubscription;
    if (typeof instrumentOrSecId === 'string') {
      let normalizedSegment = 'NSE_EQ';
      if (exchangeSegment === 'D' || exchangeSegment === 'NSE_FNO') {
        normalizedSegment = 'NSE_FNO';
      } else if (exchangeSegment === 'I' || exchangeSegment === 'IDX' || exchangeSegment === 'IDX_I') {
        normalizedSegment = 'IDX_I';
      } else if (exchangeSegment === 'BSE' || exchangeSegment === 'BSE_EQ') {
        normalizedSegment = 'BSE_EQ';
      }
      instrument = {
        exchangeSegment: normalizedSegment,
        securityId: instrumentOrSecId,
      };
    } else {
      instrument = instrumentOrSecId;
    }

    const key = `${instrument.exchangeSegment}:${instrument.securityId}`;
    this.registeredInstruments.set(key, instrument);

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const msg = buildDhanSubscriptionMessage([instrument], requestCode);
      this.socket.send(msg);
    }
  }

  /**
   * Subscribes to multiple instruments in batch
   */
  public subscribeBatch(
    instruments: InstrumentSubscription[],
    requestCode = DhanFeedRequestCode.SUBSCRIBE_QUOTE
  ): void {
    instruments.forEach((instr) => {
      const key = `${instr.exchangeSegment}:${instr.securityId}`;
      this.registeredInstruments.set(key, instr);
    });

    if (this.socket && this.socket.readyState === WebSocket.OPEN && instruments.length > 0) {
      const msg = buildDhanSubscriptionMessage(instruments, requestCode);
      this.socket.send(msg);
    }
  }

  /**
   * Unsubscribes from an instrument
   */
  public unsubscribe(instrument: InstrumentSubscription): void {
    const key = `${instrument.exchangeSegment}:${instrument.securityId}`;
    this.registeredInstruments.delete(key);

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const msg = buildDhanUnsubscriptionMessage([instrument]);
      this.socket.send(msg);
    }
  }

  /**
   * Subscribes to atomic batched ticks
   */
  public addTickListener(listener: FeedTickListener): () => void {
    this.tickListeners.add(listener);
    return () => {
      this.tickListeners.delete(listener);
    };
  }

  /**
   * Subscribes to telemetry status changes
   */
  public addTelemetryListener(listener: FeedTelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  public isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Decodes incoming WebSocket frames and buffers them
   */
  private handleIncomingFrame(data: any): void {
    let arrayBuffer: ArrayBuffer | null = null;

    if (data instanceof ArrayBuffer) {
      arrayBuffer = data;
    } else if (ArrayBuffer.isView(data)) {
      arrayBuffer = data.buffer;
    }

    if (!arrayBuffer) return;

    const parsed = decodeDhanBinaryPacket(arrayBuffer);
    if (!parsed) return;

    this.packetsReceivedCount++;

    if (parsed.responseCode === DhanFeedResponseCode.DISCONNECT) {
      this.updateStatus('DISCONNECTED', parsed.reason);
      if (parsed.disconnectCode === 805) {
        this.updateStatus('TOKEN_EXPIRED', parsed.reason);
      }
      return;
    }

    // Buffer Quote, Ticker, and OI by Security ID
    const key = String(parsed.securityId);
    this.pendingTickBatch.set(key, parsed);
    this.ensureFlushTimer();
  }

  /**
   * Flushes batched ticks every 250ms to UI listeners
   */
  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.pendingTickBatch.size > 0) {
        const batch: Record<string, DhanParsedPacket> = {};
        this.pendingTickBatch.forEach((val, key) => {
          batch[key] = val;
        });
        this.pendingTickBatch.clear();

        const nowStr = new Date().toLocaleTimeString('en-IN');
        secureVault.updateTelemetry({
          lastTickTime: nowStr,
          packetsReceived: this.packetsReceivedCount,
        });

        // Dispatch immutable batch
        this.tickListeners.forEach((listener) => {
          try {
            listener(batch);
          } catch {}
        });
      } else {
        if (this.flushTimer) {
          clearInterval(this.flushTimer);
          this.flushTimer = null;
        }
      }
    }, this.THROTTLE_MS);

    if (this.flushTimer && typeof (this.flushTimer as any).unref === 'function') {
      (this.flushTimer as any).unref();
    }
  }

  /**
   * Sends subscription packets for all registered instruments
   */
  private flushSubscriptions(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const instruments = Array.from(this.registeredInstruments.values());
    if (instruments.length === 0) return;

    // Send in chunks of 50 to respect packet boundaries
    const CHUNK_SIZE = 50;
    for (let i = 0; i < instruments.length; i += CHUNK_SIZE) {
      const chunk = instruments.slice(i, i + CHUNK_SIZE);
      const msg = buildDhanSubscriptionMessage(chunk, DhanFeedRequestCode.SUBSCRIBE_QUOTE);
      this.socket.send(msg);
    }
  }

  /**
   * Exponential backoff reconnection scheduler
   */
  private scheduleReconnect(): void {
    if (this.isExplicitlyStopped) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.updateStatus('ERROR', 'Max reconnect attempts reached. Tap to retry.');
      return;
    }

    this.reconnectAttempts++;
    this.updateStatus('CONNECTING', `Reconnecting (Attempt ${this.reconnectAttempts})...`);

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
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private updateStatus(
    status: 'STREAMING' | 'CONNECTING' | 'DISCONNECTED' | 'TOKEN_EXPIRED' | 'ERROR',
    lastError: string | null = null,
    latencyMs: number | null = null
  ): void {
    secureVault.updateTelemetry({
      status,
      lastError,
      latencyMs: latencyMs !== null ? latencyMs : undefined,
    });

    const telem = secureVault.getTelemetry();
    this.telemetryListeners.forEach((listener) => {
      try {
        listener(telem);
      } catch {}
    });
  }

  public getTelemetry(): StreamerTelemetry {
    return secureVault.getTelemetry();
  }

  /**
   * Launches native Dhan mobile app installed on device via Intent or web fallback
   */
  public async launchDhanApp(
    symbol: string,
    securityId?: string,
    action: 'BUY' | 'SELL' = 'BUY'
  ): Promise<void> {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}

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

export const dhanHqFeedSocket = new DhanHqFeedSocket();

/**
 * Diagnostic ping test for SettingsScreen to test DhanHQ WebSocket TLS handshake & Auth
 */
export async function testDhanFeedConnection(
  clientId: string,
  token: string
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const cleanId = (clientId || '').replace(/\s+/g, '');
    const cleanToken = (token || '').replace(/[\s\r\n]+/g, '');
    const startTime = Date.now();
    const wsUrl = `${OFFICIAL_DHAN_FEED_URL}?version=2&token=${encodeURIComponent(
      cleanToken
    )}&clientId=${encodeURIComponent(cleanId)}&authType=2`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve({ ok: false, latencyMs: 0, error: 'Connection timed out (5s)' });
      }, 5000);

      ws.onopen = () => {
        const latency = Date.now() - startTime;
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
      resolve({ ok: false, latencyMs: 0, error: e?.message || 'Exception during WebSocket handshake' });
    }
  });
}
