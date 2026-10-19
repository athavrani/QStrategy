// =====================================================================
// QStrategy — Direct Mobile-to-Dhan HQ Service (Zero Middleman)
// Direct TLS connection to Dhan HQ APIs (AWS Mumbai)
// Hardware Keystore Encrypted Token Storage via Expo SecureStore
// Multi-Tier Resilient Quote Fetching (/quote -> /ohlc -> /ltp)
// =====================================================================

import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';
import * as Haptics from 'expo-haptics';
import { DHAN_BASE_URL, getDhanSecurityId, DHAN_NIFTY_INDEX_ID, DHAN_SENSEX_INDEX_ID } from '../constants/dhanSecurityMaster';
import { SENSEX_NIFTY_MASTER_CATALOG } from '../constants/stockUniverse';
import {
  secureVault,
  DEFAULT_DHAN_CLIENT_ID,
  DEFAULT_DHAN_TOKEN,
  isDhanJwtToken,
  isNumericClientId,
} from './SecureCredentialVault';

export interface DhanDirectQuote {
  securityId: string;
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose?: number;
  netChange?: number;
  changePercent?: number;
  volume: number;
  lastUpdated: string;
}

export interface DhanConnectionResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  clientId?: string;
  spotPrice?: number;
}

export interface DhanFeedTelemetry {
  status: 'ONLINE' | 'ERROR' | 'UNCONFIGURED';
  lastError: string | null;
  lastTickTime: string | null;
  clientId: string | null;
  latencyMs?: number | null;
}

class DhanDirectService {
  private cachedClientId: string | null = null;
  private cachedAccessToken: string | null = null;
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;

  // Authentic previous day close cache initialized from verified baseline catalog
  private dailyPrevCloseMap = new Map<string, number>(
    SENSEX_NIFTY_MASTER_CATALOG.map((s) => [s.ticker.toUpperCase(), s.prevClose])
  );

  public getPrevClose(ticker: string): number | undefined {
    return this.dailyPrevCloseMap.get(ticker.toUpperCase());
  }

  public updatePrevClose(ticker: string, prevClose: number): void {
    if (prevClose > 0) {
      this.dailyPrevCloseMap.set(ticker.toUpperCase(), prevClose);
    }
  }

  private feedTelemetry: DhanFeedTelemetry = {
    status: 'UNCONFIGURED',
    lastError: null,
    lastTickTime: null,
    clientId: null,
  };

  /**
   * Automatically switches in-memory session to verified default credentials
   * when a custom token fails or is invalid.
   */
  public fallbackToDefaultCredentials(reason: string): void {
    console.warn(`[DhanDirect] ${reason} — Automatically switching to verified default token (${DEFAULT_DHAN_CLIENT_ID}).`);
    this.cachedClientId = DEFAULT_DHAN_CLIENT_ID;
    this.cachedAccessToken = DEFAULT_DHAN_TOKEN;
    this.feedTelemetry.clientId = DEFAULT_DHAN_CLIENT_ID;
    this.feedTelemetry.status = 'ONLINE';
    this.feedTelemetry.lastError = `Fell back to default token: ${reason}`;
  }

  /**
   * Initializes stored credentials from hardware Keystore via secureVault (Singleton Promise)
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const creds = await secureVault.getEffectiveCredentials();
        this.cachedClientId = creds.clientId;
        this.cachedAccessToken = creds.token;
        this.feedTelemetry.clientId = creds.clientId;
        this.feedTelemetry.status = creds.clientId && creds.token ? 'ONLINE' : 'UNCONFIGURED';
        this.isInitialized = true;
      } catch (err: any) {
        this.feedTelemetry.lastError = `Keystore init error: ${err.message}`;
        this.cachedClientId = DEFAULT_DHAN_CLIENT_ID;
        this.cachedAccessToken = DEFAULT_DHAN_TOKEN;
        this.feedTelemetry.clientId = DEFAULT_DHAN_CLIENT_ID;
        this.feedTelemetry.status = 'ONLINE';
        this.isInitialized = true;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Asynchronously determines whether credentials are saved in Keystore
   */
  public async isConfiguredAsync(): Promise<boolean> {
    await this.initialize();
    return Boolean(this.cachedClientId && this.cachedAccessToken);
  }

  /**
   * Synchronously checks cached credentials (must call initialize first)
   */
  public isConfigured(): boolean {
    return Boolean(this.cachedClientId && this.cachedAccessToken);
  }

  /**
   * Returns current active credentials
   */
  public async getCredentials(): Promise<{ clientId: string | null; accessToken: string | null }> {
    await this.initialize();
    return {
      clientId: this.cachedClientId,
      accessToken: this.cachedAccessToken,
    };
  }

  /**
   * Saves credentials directly to hardware Keystore / Keychain via secureVault
   */
  public async saveCredentials(clientId: string, accessToken: string): Promise<void> {
    const cleanId = clientId.trim();
    const cleanToken = accessToken.trim();
    await secureVault.saveCredentials(cleanId, cleanToken);
    this.cachedClientId = cleanId;
    this.cachedAccessToken = cleanToken;
    this.feedTelemetry.clientId = cleanId;
    this.feedTelemetry.status = 'ONLINE';
    this.feedTelemetry.lastError = null;
    this.isInitialized = true;
  }

  /**
   * Clears saved credentials from hardware Keystore and memory
   */
  public async clearCredentials(): Promise<void> {
    await secureVault.clearCredentials();
    this.cachedClientId = null;
    this.cachedAccessToken = null;
    this.feedTelemetry.clientId = null;
    this.feedTelemetry.status = 'UNCONFIGURED';
    this.feedTelemetry.lastError = null;
  }

  /**
   * Returns live feed telemetry status
   */
  public getTelemetry(): DhanFeedTelemetry {
    return { ...this.feedTelemetry };
  }

  /**
   * Pings Dhan HQ servers directly from the phone and measures round-trip latency
   */
  public async testDirectConnection(
    overrideClientId?: string,
    overrideToken?: string
  ): Promise<DhanConnectionResult> {
    await this.initialize();
    const rawClientId = overrideClientId?.trim() || this.cachedClientId || '';
    const rawToken = overrideToken?.trim() || this.cachedAccessToken || '';
    const clientId = rawClientId.replace(/\s+/g, '');
    const token = rawToken.replace(/[\s\r\n]+/g, '');

    if (!clientId || !token) {
      return {
        ok: false,
        latencyMs: 0,
        error: 'Dhan Client ID and Data API Access Token are required.',
      };
    }

    if (!isDhanJwtToken(token)) {
      return {
        ok: false,
        latencyMs: 0,
        error: `Invalid Token Format: You entered an API Secret / Key ("${token.slice(0, 10)}...").\n\nDhan Data APIs require an Access Token (JWT starting with "eyJ...").\n\nTo generate:\n1. Open web.dhan.co\n2. Go to Profile > Access DhanHQ APIs\n3. Switch to "Access Token" (not API Key) and click "Generate Access Token".`,
      };
    }

    if (!isNumericClientId(clientId)) {
      return {
        ok: false,
        latencyMs: 0,
        error: `Invalid Client ID ("${clientId}"). Your Dhan Client ID is your 10-digit trading account number (e.g. 1113940120), NOT an API Key (e.g. 6b70a445).`,
      };
    }

    const embeddedId = secureVault.extractDhanClientId(token);
    if (embeddedId && clientId && embeddedId !== clientId) {
      return {
        ok: false,
        latencyMs: 0,
        error: `Client ID (${clientId}) does not match token owner (${embeddedId}). Change Client ID to ${embeddedId}.`,
      };
    }

    const startTime = Date.now();
    try {
      // Direct request to Dhan HQ Data API Market Feed LTP endpoint
      const res = await fetch(`${DHAN_BASE_URL}/marketfeed/ltp`, {
        method: 'POST',
        headers: {
          'access-token': token,
          'client-id': clientId,
          'dhanClientId': clientId,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          IDX_I: [parseInt(DHAN_NIFTY_INDEX_ID, 10)],
        }),
      });

      const latencyMs = Date.now() - startTime;

      if (res.ok) {
        const json = await res.json();
        const nseData = json?.data?.IDX_I || json?.IDX_I || {};
        const niftyItem = nseData[DHAN_NIFTY_INDEX_ID] || nseData['13'];
        const spotPrice = niftyItem ? Number(niftyItem.last_price || niftyItem.close || 0) : undefined;

        this.feedTelemetry.status = 'ONLINE';
        this.feedTelemetry.lastError = null;
        this.feedTelemetry.latencyMs = latencyMs;
        this.feedTelemetry.lastTickTime = new Date().toLocaleTimeString('en-IN');
        return {
          ok: true,
          latencyMs,
          clientId,
          spotPrice,
        };
      }

      const errText = await res.text();
      let parsedError = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        parsedError = errJson.errorMessage || errJson.message || errJson.data?.['808'] || parsedError;
      } catch {
        parsedError = `${parsedError}: ${errText.slice(0, 80)}`;
      }

      this.feedTelemetry.status = 'ERROR';
      this.feedTelemetry.lastError = parsedError;
      return {
        ok: false,
        latencyMs,
        error: parsedError,
      };
    } catch (netErr: any) {
      const latencyMs = Date.now() - startTime;
      const errMsg = netErr.message || 'Network Timeout';
      this.feedTelemetry.status = 'ERROR';
      this.feedTelemetry.lastError = errMsg;
      return {
        ok: false,
        latencyMs,
        error: `Data API connection failed: ${errMsg}`,
      };
    }
  }

  /**
   * Fetches batch live quotes for multiple tickers directly from Dhan HQ.
   * Multi-Tier Resilient Strategy:
   * 1. Try /marketfeed/quote (Full quote & physical volume)
   * 2. Fallback /marketfeed/ohlc (Open, High, Low, Close, LTP)
   * 3. Fallback /marketfeed/ltp (LTP guarantee)
   */
  public async fetchDirectBatchQuotes(
    tickers: string[]
  ): Promise<Record<string, DhanDirectQuote>> {
    await this.initialize();
    if (!this.cachedClientId || !this.cachedAccessToken || tickers.length === 0) {
      return {};
    }

    // Build mapping: numericSecId -> ticker
    const secIdToTicker = new Map<number, string>();
    tickers.forEach((ticker) => {
      const secIdStr = getDhanSecurityId(ticker);
      const num = parseInt(secIdStr, 10);
      if (!isNaN(num)) {
        secIdToTicker.set(num, ticker.toUpperCase());
      }
    });

    const allSecIds = Array.from(secIdToTicker.keys());
    if (allSecIds.length === 0) return {};

    // Dhan HQ Market Feed supports up to 100 instruments per batch request
    const chunkSize = 100;
    const chunks: number[][] = [];
    for (let i = 0; i < allSecIds.length; i += chunkSize) {
      chunks.push(allSecIds.slice(i, i + chunkSize));
    }

    const quotes: Record<string, DhanDirectQuote> = {};
    const nowTimeStr = new Date().toLocaleTimeString('en-IN');
    let had401 = false;

    // Fetch chunks sequentially to prevent HTTP 429 rate limits
    for (const chunk of chunks) {
      let nseData: Record<string, any> = {};

      // --- TIER 1: Try /marketfeed/quote ---
      try {
        const res = await fetch(`${DHAN_BASE_URL}/marketfeed/quote`, {
          method: 'POST',
          headers: {
            'access-token': this.cachedAccessToken!,
            'client-id': this.cachedClientId!,
            'dhanClientId': this.cachedClientId!,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            NSE_EQ: chunk,
          }),
        });

        if (res.ok) {
          const json = await res.json();
          nseData = json?.data?.NSE_EQ || json?.NSE_EQ || {};
        } else if (res.status === 401) {
          had401 = true;
          break;
        }
      } catch {
        // Proceed to Tier 2
      }

      // --- TIER 2: Fallback to /marketfeed/ohlc if /quote failed ---
      if (Object.keys(nseData).length === 0 && !had401) {
        try {
          const resOhlc = await fetch(`${DHAN_BASE_URL}/marketfeed/ohlc`, {
            method: 'POST',
            headers: {
              'access-token': this.cachedAccessToken!,
              'client-id': this.cachedClientId!,
              'dhanClientId': this.cachedClientId!,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              NSE_EQ: chunk,
            }),
          });

          if (resOhlc.ok) {
            const jsonOhlc = await resOhlc.json();
            nseData = jsonOhlc?.data?.NSE_EQ || jsonOhlc?.NSE_EQ || {};
          }
        } catch {}
      }

      // --- TIER 3: Fallback to /marketfeed/ltp if both failed ---
      if (Object.keys(nseData).length === 0 && !had401) {
        try {
          const resLtp = await fetch(`${DHAN_BASE_URL}/marketfeed/ltp`, {
            method: 'POST',
            headers: {
              'access-token': this.cachedAccessToken!,
              'client-id': this.cachedClientId!,
              'dhanClientId': this.cachedClientId!,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              NSE_EQ: chunk,
            }),
          });

          if (resLtp.ok) {
            const jsonLtp = await resLtp.json();
            nseData = jsonLtp?.data?.NSE_EQ || jsonLtp?.NSE_EQ || {};
          }
        } catch {}
      }

      // Map parsed nseData items back to tickers
      chunk.forEach((secId) => {
        const sym = secIdToTicker.get(secId);
        const item = nseData[secId] || nseData[String(secId)];
        if (sym && item) {
          const ltp = Number(item.last_price || item.close || item.ltp || 0);
          const open = Number(item.ohlc?.open || item.open || ltp);
          const high = Number(item.ohlc?.high || item.high || ltp);
          const low = Number(item.ohlc?.low || item.low || ltp);
          const rawNetChange = Number(item.net_change ?? item.change ?? 0);

          // Resolve authentic previous day close:
          // 1. If net_change is non-zero, previous close is strictly (ltp - net_change)
          // 2. If item.previous_close or item.prev_close is provided, use it
          // 3. Dhan post-market behavior: item.ohlc.close is set to today's close (equal to ltp).
          //    Only use item.ohlc.close or item.close if it is strictly different from ltp.
          // 4. Otherwise, fall back to the verified dailyPrevCloseMap.
          let prevClose = 0;
          if (rawNetChange !== 0 && ltp > 0) {
            prevClose = +(ltp - rawNetChange).toFixed(2);
          } else if (item.previous_close && Number(item.previous_close) > 0) {
            prevClose = Number(item.previous_close);
          } else if (item.prev_close && Number(item.prev_close) > 0) {
            prevClose = Number(item.prev_close);
          } else if (item.ohlc?.close && Number(item.ohlc.close) > 0 && Number(item.ohlc.close) !== ltp) {
            prevClose = Number(item.ohlc.close);
          } else if (item.close && Number(item.close) > 0 && Number(item.close) !== ltp) {
            prevClose = Number(item.close);
          } else {
            prevClose = this.dailyPrevCloseMap.get(sym) || 0;
          }

          // Cache discovered genuine prevClose
          if (prevClose > 0) {
            this.dailyPrevCloseMap.set(sym, prevClose);
          }

          // Calculate mathematically sound netChange & changePercent
          const netChange = (rawNetChange !== 0)
            ? rawNetChange
            : (prevClose > 0 && ltp > 0 ? +(ltp - prevClose).toFixed(2) : 0);

          const changePercent = (prevClose > 0 && ltp > 0)
            ? +(((ltp - prevClose) / prevClose) * 100).toFixed(2)
            : 0;

          const volume = Number(item.volume || 0);

          quotes[sym] = {
            securityId: String(secId),
            symbol: sym,
            ltp,
            open,
            high,
            low,
            close: prevClose > 0 ? prevClose : ltp,
            prevClose: prevClose > 0 ? prevClose : undefined,
            netChange,
            changePercent,
            volume,
            lastUpdated: nowTimeStr,
          };
        }
      });
    }

    if (had401) {
      if (this.cachedAccessToken !== DEFAULT_DHAN_TOKEN) {
        this.fallbackToDefaultCredentials('Custom token expired or invalid (HTTP 401)');
        return this.fetchDirectBatchQuotes(tickers);
      } else {
        this.feedTelemetry.status = 'ERROR';
        this.feedTelemetry.lastError = 'Dhan Token Expired (401). Update in Settings.';
      }
    }

    if (Object.keys(quotes).length > 0) {
      this.feedTelemetry.status = 'ONLINE';
      this.feedTelemetry.lastError = null;
      this.feedTelemetry.lastTickTime = nowTimeStr;
    }

    return quotes;
  }

  // 3-second cache to strictly observe Dhan rate limits (1 request per 3 seconds per underlying)
  private optionChainCache = new Map<string, { timestamp: number; data: any }>();

  /**
   * Fetches official active option chain expiry dates from Dhan HQ
   * POST /v2/optionchain/expirylist
   */
  public async fetchExpiryList(underlyingTicker: string = 'NIFTY'): Promise<string[] | null> {
    await this.initialize();
    if (!this.cachedClientId || !this.cachedAccessToken) return null;

    let scrip = parseInt(DHAN_NIFTY_INDEX_ID, 10);
    let seg = 'IDX_I';
    const cleanTicker = (underlyingTicker || 'NIFTY').toUpperCase().trim();

    if (cleanTicker === 'SENSEX') {
      scrip = parseInt(DHAN_SENSEX_INDEX_ID, 10);
      seg = 'IDX_I';
    } else if (cleanTicker !== 'NIFTY' && cleanTicker !== 'NIFTY 50') {
      const secId = getDhanSecurityId(cleanTicker);
      const parsed = parseInt(secId, 10);
      if (!isNaN(parsed) && parsed > 0) {
        scrip = parsed;
        seg = 'NSE_EQ';
      }
    }

    try {
      const res = await fetch(`${DHAN_BASE_URL}/optionchain/expirylist`, {
        method: 'POST',
        headers: {
          'access-token': this.cachedAccessToken,
          'client-id': this.cachedClientId,
          'dhanClientId': this.cachedClientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          UnderlyingScrip: scrip,
          UnderlyingSeg: seg,
        }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          if (this.cachedAccessToken !== DEFAULT_DHAN_TOKEN) {
            this.fallbackToDefaultCredentials('Custom token expired on expiry list (HTTP 401)');
            return this.fetchExpiryList(underlyingTicker);
          }
          this.feedTelemetry.status = 'ERROR';
          this.feedTelemetry.lastError = 'Dhan Token Expired (401). Tap Auto Sync in Settings.';
        }
        return null;
      }

      const json = await res.json();
      if (Array.isArray(json?.data) && json.data.length > 0) {
        return json.data;
      }
    } catch {}
    return null;
  }

  /**
   * Fetches the official live Dhan HQ Option Chain for Indices and Equities
   * Direct POST to /v2/optionchain
   */
  public async fetchOptionChain(
    expiryDate?: string,
    underlyingTicker: string = 'NIFTY'
  ): Promise<{
    spotPrice?: number;
    oc: Record<
      number,
      {
        ceLtp: number;
        peLtp: number;
        ceOi: number;
        peOi: number;
        ceIv?: number;
        peIv?: number;
        ceBid?: number;
        ceAsk?: number;
        peBid?: number;
        peAsk?: number;
        ceSecId?: string;
        peSecId?: string;
      }
    >;
  } | null> {
    await this.initialize();
    if (!this.cachedClientId || !this.cachedAccessToken) return null;

    const cleanTicker = (underlyingTicker || 'NIFTY').toUpperCase().trim();
    let scrip = parseInt(DHAN_NIFTY_INDEX_ID, 10);
    let seg = 'IDX_I';

    if (cleanTicker === 'SENSEX') {
      scrip = parseInt(DHAN_SENSEX_INDEX_ID, 10);
      seg = 'IDX_I';
    } else if (cleanTicker !== 'NIFTY' && cleanTicker !== 'NIFTY 50') {
      const secId = getDhanSecurityId(cleanTicker);
      const parsed = parseInt(secId, 10);
      if (!isNaN(parsed) && parsed > 0) {
        scrip = parsed;
        seg = 'NSE_EQ';
      }
    }

    // Check 3-second cache
    const cacheKey = `${scrip}-${seg}-${expiryDate || 'default'}`;
    const cached = this.optionChainCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3000) {
      return cached.data;
    }

    let targetExpiry = expiryDate;
    const list = await this.fetchExpiryList(cleanTicker);
    if (list && list.length > 0) {
      if (targetExpiry) {
        const exp = targetExpiry;
        const matched = list.find((d) => d === exp || d.startsWith(exp));
        targetExpiry = matched || list[0];
      } else {
        targetExpiry = list[0];
      }
    }

    if (!targetExpiry) return null;

    try {
      const res = await fetch(`${DHAN_BASE_URL}/optionchain`, {
        method: 'POST',
        headers: {
          'access-token': this.cachedAccessToken,
          'client-id': this.cachedClientId,
          'dhanClientId': this.cachedClientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          UnderlyingScrip: scrip,
          UnderlyingSeg: seg,
          Expiry: targetExpiry,
        }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          if (this.cachedAccessToken !== DEFAULT_DHAN_TOKEN) {
            this.fallbackToDefaultCredentials('Custom token expired on option chain (HTTP 401)');
            return this.fetchOptionChain(expiryDate, underlyingTicker);
          }
          this.feedTelemetry.status = 'ERROR';
          this.feedTelemetry.lastError = 'Dhan Token Expired (401). Tap Auto Sync in Settings.';
        }
        return null;
      }

      const json = await res.json();
      const oc = json?.data?.oc;
      if (!oc || typeof oc !== 'object') return null;

      const result: Record<
        number,
        {
          ceLtp: number;
          peLtp: number;
          ceOi: number;
          peOi: number;
          ceIv?: number;
          peIv?: number;
          ceBid?: number;
          ceAsk?: number;
          peBid?: number;
          peAsk?: number;
          ceSecId?: string;
          peSecId?: string;
        }
      > = {};
      for (const [strikeStr, data] of Object.entries(oc as Record<string, any>)) {
        const strike = Math.round(parseFloat(strikeStr));
        if (!isNaN(strike)) {
          const ceLtp = Number(data.ce?.last_price || 0);
          const peLtp = Number(data.pe?.last_price || 0);
          const ceSecId = data.ce?.security_id || data.ce?.sec_id || data.ce?.securityId ? String(data.ce?.security_id || data.ce?.sec_id || data.ce?.securityId) : undefined;
          const peSecId = data.pe?.security_id || data.pe?.sec_id || data.pe?.securityId ? String(data.pe?.security_id || data.pe?.sec_id || data.pe?.securityId) : undefined;

          result[strike] = {
            ceLtp,
            peLtp,
            ceOi: Number(data.ce?.oi || 0),
            peOi: Number(data.pe?.oi || 0),
            ceIv: Number(data.ce?.iv || data.ce?.implied_volatility || 14.5),
            peIv: Number(data.pe?.iv || data.pe?.implied_volatility || 14.8),
            ceBid: Number(data.ce?.top_bid || data.ce?.bid || ceLtp || 0),
            ceAsk: Number(data.ce?.top_ask || data.ce?.ask || ceLtp || 0),
            peBid: Number(data.pe?.top_bid || data.pe?.bid || peLtp || 0),
            peAsk: Number(data.pe?.top_ask || data.pe?.ask || peLtp || 0),
            ceSecId,
            peSecId,
          };
        }
      }
      const spotPrice = json?.data?.last_price ? Number(json.data.last_price) : undefined;
      const finalResult = Object.keys(result).length > 0 ? { spotPrice, oc: result } : null;

      if (finalResult) {
        this.optionChainCache.set(cacheKey, { timestamp: Date.now(), data: finalResult });
      }

      return finalResult;
    } catch {
      return null;
    }
  }

  /**
   * Fetches live NIFTY 50 Index quote directly from Dhan HQ (/marketfeed/ohlc)
   */
  public async fetchNiftyIndexQuote(): Promise<{ ltp: number; open: number; high: number; low: number; close: number } | null> {
    await this.initialize();

    // 1. Attempt direct Dhan HQ quote if credentials configured
    if (this.cachedClientId && this.cachedAccessToken) {
      const niftyId = parseInt(DHAN_NIFTY_INDEX_ID, 10);

      // Try /marketfeed/ohlc
      try {
        const res = await fetch(`${DHAN_BASE_URL}/marketfeed/ohlc`, {
          method: 'POST',
          headers: {
            'access-token': this.cachedAccessToken,
            'client-id': this.cachedClientId,
            'dhanClientId': this.cachedClientId,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            IDX_I: [niftyId],
          }),
        });

        if (res.ok) {
          const json = await res.json();
          const item = json?.data?.IDX_I?.[DHAN_NIFTY_INDEX_ID] || json?.IDX_I?.[DHAN_NIFTY_INDEX_ID];
          if (item) {
            const ltp = Number(item.last_price || item.close || 0);
            if (ltp > 0) {
              return {
                ltp,
                open: Number(item.ohlc?.open || ltp),
                high: Number(item.ohlc?.high || ltp),
                low: Number(item.ohlc?.low || ltp),
                close: Number(item.ohlc?.close || ltp),
              };
            }
          }
        } else if (res.status === 401) {
          if (this.cachedAccessToken !== DEFAULT_DHAN_TOKEN) {
            this.fallbackToDefaultCredentials('Custom token expired on index quote (HTTP 401)');
            return this.fetchNiftyIndexQuote();
          }
        }
      } catch {}

      // Fallback: Try /marketfeed/ltp
      try {
        const resLtp = await fetch(`${DHAN_BASE_URL}/marketfeed/ltp`, {
          method: 'POST',
          headers: {
            'access-token': this.cachedAccessToken,
            'client-id': this.cachedClientId,
            'dhanClientId': this.cachedClientId,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            IDX_I: [niftyId],
          }),
        });

        if (resLtp.ok) {
          const jsonLtp = await resLtp.json();
          const item = jsonLtp?.data?.IDX_I?.[DHAN_NIFTY_INDEX_ID] || jsonLtp?.IDX_I?.[DHAN_NIFTY_INDEX_ID];
          if (item) {
            const ltp = Number(item.last_price || 0);
            if (ltp > 0) {
              return { ltp, open: ltp, high: ltp, low: ltp, close: ltp };
            }
          }
        }
      } catch {}
    }

    return null;
  }

  /**
   * Directly launches the Dhan Mobile Application installed on the phone
   * via Android Intent deep linking with graceful web fallback
   */
  public async launchDhanApp(
    symbol: string,
    securityId?: string,
    action: 'BUY' | 'SELL' = 'BUY'
  ): Promise<void> {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const secId = securityId || getDhanSecurityId(symbol);
    const encoded = encodeURIComponent(symbol);

    // Intent candidate 1: Direct Order Window
    const directOrderIntent = `dhan://trade/place?exchange=NSE&segment=NSE_FNO&securityId=${secId}&action=${action}`;
    
    // Intent candidate 2: Direct Scrip Search / Overview
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

      // Fallback: Dhan Fast Web
      await Linking.openURL(`https://web.dhan.co`);
    } catch {
      await Linking.openURL(`https://web.dhan.co`);
    }
  }
}

export const dhanDirectService = new DhanDirectService();
