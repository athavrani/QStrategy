/**
 * QStrategy — Official DhanHQ v2 REST Client
 * Directly interacts with DhanHQ Data API v2 (AWS Mumbai)
 * Features strict nullability, hardware Keystore auth, timeout management,
 * and 401 token expiry handling.
 */

import { secureVault } from '../SecureCredentialVault';
import { dhanRestGateway } from './DhanRestGateway';

export const DHAN_HQ_REST_BASE_URL = 'https://api.dhan.co/v2';

export interface DhanLtpItem {
  last_price: number;
}

export interface DhanQuoteItem {
  last_price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  prev_close?: number;
  average_price?: number;
  volume: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  oi?: number;
  last_trade_time?: string;
  depth?: any;
}

export interface DhanOptionContractRaw {
  last_price: number;
  oi: number;
  change_in_oi?: number;
  volume?: number;
  implied_volatility?: number;
  iv?: number;
  top_bid?: number;
  bid?: number;
  top_ask?: number;
  ask?: number;
  security_id?: number | string;
  sec_id?: number | string;
  strike_price?: number;
}

export interface DhanOptionChainStrikeItem {
  ce?: DhanOptionContractRaw;
  pe?: DhanOptionContractRaw;
}

export interface DhanOptionChainRawResponse {
  status?: string;
  remarks?: string;
  data?: {
    last_price?: number;
    oc?: Record<string, DhanOptionChainStrikeItem>;
  };
}

export class DhanHqRestClient {
  private timeoutMs: number;

  constructor(timeoutMs = 8000) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Internal request wrapper with 401 detection; transport, pacing and caching live in the gateway
   */
  public async post<T>(endpoint: string, body: any): Promise<T | null> {
    const creds = await secureVault.getEffectiveCredentials();
    if (!creds.clientId || !creds.token) {
      return null;
    }

    try {
      const response = await dhanRestGateway.post(
        endpoint,
        body,
        { clientId: creds.clientId, token: creds.token },
        { timeoutMs: this.timeoutMs }
      );

      if (response.status === 401) {
        secureVault.updateTelemetry({
          status: 'TOKEN_EXPIRED',
          lastError: 'Access token expired or unauthorized (HTTP 401).',
        });
        return null;
      }

      if (!response.ok) {
        secureVault.updateTelemetry({
          lastError: `DhanHQ REST error: HTTP ${response.status}`,
        });
        return null;
      }

      return response.data as T;
    } catch (err: any) {
      const isAbort = err.name === 'AbortError';
      secureVault.updateTelemetry({
        lastError: isAbort ? 'Request timed out' : err.message,
      });
      return null;
    }
  }
  /**
   * Fetches Last Traded Price for instruments across exchange segments
   * POST /v2/marketfeed/ltp
   */
  public async fetchLtp(
    instruments: Record<string, number[]>
  ): Promise<Record<string, Record<string, DhanLtpItem>> | null> {
    const res = await this.post<{ data?: Record<string, Record<string, DhanLtpItem>> }>(
      '/marketfeed/ltp',
      instruments
    );
    return res?.data ?? null;
  }

  /**
   * Fetches full quote for instruments
   * POST /v2/marketfeed/quote
   */
  public async fetchQuotes(
    instruments: Record<string, number[]>
  ): Promise<Record<string, Record<string, DhanQuoteItem>> | null> {
    const res = await this.post<{ data?: Record<string, Record<string, DhanQuoteItem>> }>(
      '/marketfeed/quote',
      instruments
    );
    return res?.data ?? null;
  }

  /**
   * Fetches live option chain from DhanHQ
   * POST /v2/optionchain
   */
  public async fetchOptionChain(
    underlyingScrip: number,
    underlyingSeg: string,
    expiry: string
  ): Promise<DhanOptionChainRawResponse | null> {
    return this.post<DhanOptionChainRawResponse>('/optionchain', {
      UnderlyingScrip: underlyingScrip,
      UnderlyingSeg: underlyingSeg,
      Expiry: expiry,
    });
  }

  /**
   * Fetches active expiry date list for underlying contract
   * POST /v2/optionchain/expirylist
   */
  public async fetchExpiryList(
    underlyingScrip: number,
    underlyingSeg: string
  ): Promise<string[]> {
    const res = await this.post<{ data?: string[] }>('/optionchain/expirylist', {
      UnderlyingScrip: underlyingScrip,
      UnderlyingSeg: underlyingSeg,
    });
    return Array.isArray(res?.data) ? res.data : [];
  }

  /**
   * Fetches intraday 1-minute OHLC candle data
   * POST /v2/charts/intraday
   */
  public async fetchHistoricalIntraday(
    securityId: string | number,
    exchangeSegment: string,
    instrument: string,
    fromDate: string,
    toDate: string,
    interval = '1'
  ): Promise<{
    open?: number[];
    high?: number[];
    low?: number[];
    close?: number[];
    volume?: number[];
    start_Time?: number[];
  } | null> {
    const res = await this.post<any>('/charts/intraday', {
      securityId: String(securityId),
      exchangeSegment,
      instrument,
      interval,
      fromDate,
      toDate,
    });
    // Dhan API returns arrays directly at root or inside .data
    const payload = res?.data ?? res;
    if (payload && (Array.isArray(payload.volume) || Array.isArray(payload.close))) {
      return payload;
    }
    return null;
  }

  /**
   * Fetches daily historical OHLC candle data (1 candle per trading day)
   * POST /v2/charts/historical
   */
  public async fetchHistoricalDaily(
    securityId: string | number,
    exchangeSegment: string,
    instrument: string,
    fromDate: string,
    toDate: string
  ): Promise<{
    open?: number[];
    high?: number[];
    low?: number[];
    close?: number[];
    volume?: number[];
    timestamp?: number[];
  } | null> {
    const res = await this.post<any>('/charts/historical', {
      securityId: String(securityId),
      exchangeSegment,
      instrument,
      expiryCode: 0,
      oi: false,
      fromDate,
      toDate,
    });
    // Dhan API returns arrays directly at root or inside .data
    const payload = res?.data ?? res;
    if (payload && (Array.isArray(payload.volume) || Array.isArray(payload.close))) {
      return payload;
    }
    return null;
  }
}

export const dhanHqRestClient = new DhanHqRestClient();

