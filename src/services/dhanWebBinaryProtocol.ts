// =====================================================================
// QStrategy — Dhan Web Live Market Streamer Binary Protocol (Option 1)
// Reverse-engineered from Dhan Web Web Worker (957.87e9ccb3c70cb520.js)
// Wire format: 703-byte Auth Packet (SHA-512) & 129-byte Subscriptions
// =====================================================================

import { sha512 } from 'js-sha512';

export const DHAN_WEB_WS_URL = 'wss://price-feed-web.dhan.co:443';
export const DHAN_BROKER_CODE = 'DHN1804';
export const DHAN_WEB_SOURCE = 'W';
export const DHAN_DEFAULT_TAB_ID = '1';

export interface DhanWebClientInfo {
  clientId: string; // e.g. "11139401201" (${entity_id}${tabId})
  token: string;    // e.g. "${token_id}${tabId}"
  contactNo: string;// "${clientId}-W-DHN1804"
  tabId: string;    // "1"
}

export interface DhanLiveTickData {
  key: string;             // e.g. "1333-E-NSE"
  securityId: string;      // e.g. "1333"
  exchange: string;        // "NSE" | "BSE" | "IDX"
  segment: string;         // "E" | "D" | "I"
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose?: number;
  volume: number;
  change: number;
  changePercent: number;
  openInterest?: number;
  lastUpdated: string;
}

/**
 * Calculates Julian Day seconds since Dhan's 1980 base epoch
 */
export function getDhanJulianEpochSeconds(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const date = String(now.getUTCDate()).padStart(2, '0');
  const utcDateStr = `${year}-${month}-${date}`;
  
  const todayMs = new Date(utcDateStr).getTime();
  const base1980Ms = new Date('1980-01-01T00:00:00Z').getTime();
  return Math.floor((todayMs - base1980Ms) / 1000);
}

/**
 * Generates the SHA-512 authentication signature string
 * Formula: btoa(sha512(`${brokerCode}-${clientId}-${source}-C-${julianDate}`))
 */
export function generateDhanWebSignature(clientId: string): string {
  const julianSec = getDhanJulianEpochSeconds();
  const rawString = `${DHAN_BROKER_CODE}-${clientId}-${DHAN_WEB_SOURCE}-C-${julianSec}`;
  const hashBytes = sha512.array(rawString);
  
  let binaryStr = '';
  for (let i = 0; i < hashBytes.length; i++) {
    binaryStr += String.fromCharCode(hashBytes[i]);
  }
  
  // Base64 encode the binary hash
  if (typeof btoa !== 'undefined') {
    return btoa(binaryStr);
  }
  return Buffer.from(binaryStr, 'binary').toString('base64');
}

/**
 * Helper to write string into DataView, padding with null bytes (0x00)
 */
function writePaddedString(
  view: DataView,
  offset: number,
  length: number,
  str: string
): void {
  for (let i = 0; i < length; i++) {
    const code = i < str.length ? str.charCodeAt(i) : 0;
    view.setInt8(offset + i, code);
  }
}

/**
 * Constructs the 703-byte Authentication Packet required by wss://price-feed-web.dhan.co
 */
export function buildDhanWebAuthPacket(
  rawClientId: string,
  rawToken: string,
  tabId = DHAN_DEFAULT_TAB_ID
): ArrayBuffer {
  const cleanId = rawClientId.trim();
  const cleanToken = rawToken.trim();
  const fullClientId = `${cleanId}${tabId}`;
  const fullToken = `${cleanToken}${tabId}`;

  const buffer = new ArrayBuffer(703);
  const view = new DataView(buffer);

  // Byte 0: Packet Request Code 41 (Int8)
  view.setInt8(0, 41);
  // Bytes 1..2: Message length 703 (Uint16 Little Endian)
  view.setUint16(1, 703, true);

  // Bytes 3..32: Client ID (30 bytes)
  writePaddedString(view, 3, 30, fullClientId);

  // Bytes 33..82: Token (50 bytes)
  writePaddedString(view, 33, 50, fullToken);

  // Bytes 83..582: SHA-512 Signature String (500 bytes)
  const signature = generateDhanWebSignature(fullClientId);
  writePaddedString(view, 83, 500, signature);

  // Bytes 583..632: Broker Code "DHN1804" (50 bytes)
  writePaddedString(view, 583, 50, DHAN_BROKER_CODE);

  // Bytes 633..682: Full Client ID (50 bytes)
  writePaddedString(view, 633, 50, fullClientId);

  // Bytes 683..692: Source "W" (10 bytes)
  writePaddedString(view, 683, 10, DHAN_WEB_SOURCE);

  // Bytes 693..702: Segment "C" (10 bytes)
  writePaddedString(view, 693, 10, 'C');

  return buffer;
}

/**
 * Maps exchange and segment to Dhan Web wire enum:
 * NSE_EQ -> 1, NSE_FNO -> 2, IDX -> 0, BSE_EQ -> 4
 */
export function mapExchangeSegmentToDhanWeb(exchange: string, segment: string): number {
  const ex = exchange.toUpperCase();
  const seg = segment.toUpperCase();

  if (seg === 'I' || ex === 'IDX') return 0;
  if (ex === 'NSE') {
    if (seg === 'E' || seg === 'EQ' || seg === 'NSE_EQ') return 1;
    if (seg === 'D' || seg === 'FNO' || seg === 'NSE_FNO') return 2;
  }
  if (ex === 'BSE') {
    if (seg === 'E' || seg === 'EQ' || seg === 'BSE_EQ') return 4;
    if (seg === 'D' || seg === 'FNO' || seg === 'BSE_FNO') return 8;
  }
  return 1; // Default to NSE Equity
}

/**
 * Constructs the 129-byte Instrument Subscription Packet
 * Code 12 = Equity / F&O Quotes, Code 24 = Index, Code 23 = Depth
 */
export function buildDhanWebSubscribePacket(
  rawClientId: string,
  rawToken: string,
  securityId: string,
  exchange = 'NSE',
  segment = 'E',
  mode: 'price' | 'depth' = 'price',
  tabId = DHAN_DEFAULT_TAB_ID
): ArrayBuffer {
  const fullClientId = `${rawClientId.trim()}${tabId}`;
  const fullToken = `${rawToken.trim()}${tabId}`;
  const segCode = mapExchangeSegmentToDhanWeb(exchange, segment);

  const buffer = new ArrayBuffer(129);
  const view = new DataView(buffer);

  // Byte 0: Mode code (12 for stocks, 24 for index, 23 for depth)
  const reqCode = mode === 'depth' ? 23 : (segCode === 0 ? 24 : 12);
  view.setInt8(0, reqCode);

  // Bytes 1..2: Packet length 129 (Uint16 LE)
  view.setUint16(1, 129, true);

  // Bytes 3..32: Client ID (30 bytes)
  writePaddedString(view, 3, 30, fullClientId);

  // Bytes 33..82: Token (50 bytes)
  writePaddedString(view, 33, 50, fullToken);

  // Byte 83: Exchange/Segment enum
  view.setInt8(83, segCode);

  // Bytes 84..87: Flags = -1 (Int32 LE)
  view.setInt32(84, -1, true);

  // Byte 88: Feed Type = 1 (Int8)
  view.setInt8(88, 1);

  // Bytes 89..108: Prefix tag "abc" (20 bytes)
  writePaddedString(view, 89, 20, 'abc');

  // Bytes 109..128: Security ID (20 bytes)
  writePaddedString(view, 109, 20, securityId.toString());

  return buffer;
}

/**
 * Constructs the 129-byte Instrument Unsubscribe Packet
 * Code 13 = Unsubscribe Quote, Code 25 = Unsubscribe Depth
 */
export function buildDhanWebUnsubscribePacket(
  rawClientId: string,
  rawToken: string,
  securityId: string,
  exchange = 'NSE',
  segment = 'E',
  mode: 'price' | 'depth' = 'price',
  tabId = DHAN_DEFAULT_TAB_ID
): ArrayBuffer {
  const buffer = buildDhanWebSubscribePacket(rawClientId, rawToken, securityId, exchange, segment, mode, tabId);
  const view = new DataView(buffer);
  const unsubsCode = mode === 'depth' ? 25 : 13;
  view.setInt8(0, unsubsCode);
  return buffer;
}

/**
 * Decodes incoming binary feed buffer from wss://price-feed-web.dhan.co
 * Supports Type 1 (LTP), Type 3 (OHLC), Type 5 (Index Spot)
 */
export function decodeDhanWebBinaryFeed(buffer: ArrayBuffer): DhanLiveTickData[] {
  const ticks: DhanLiveTickData[] = [];
  const totalLen = buffer.byteLength;
  if (totalLen <= 1) return ticks;

  let offset = 0;
  while (offset < totalLen) {
    const remaining = buffer.slice(offset);
    if (remaining.byteLength < 11) break;

    const packetLen = new Uint8Array(remaining.slice(9, 10))[0];
    const packetType = new Uint8Array(remaining.slice(10, 11))[0];

    if (packetLen < 11) break;
    offset += packetLen;

    const nowStr = new Date().toLocaleTimeString('en-IN');

    // TYPE 1: Regular Equity / F&O LTP Tick (37+ bytes)
    if (packetType === 1 && remaining.byteLength >= 37) {
      const segId = new Uint8Array(remaining.slice(0, 1))[0].toString();
      const secId = new Uint32Array(remaining.slice(1, 5))[0].toString();
      const ltp = Number(new Float32Array(remaining.slice(11, 15))[0].toFixed(2));
      const volume = new Uint32Array(remaining.slice(17, 21))[0];
      const avgPrice = Number(new Float32Array(remaining.slice(21, 25))[0].toFixed(2));
      const oi = new Uint32Array(remaining.slice(25, 29))[0];

      const exch = segId === '4' ? 'BSE' : 'NSE';
      const seg = segId === '2' ? 'D' : 'E';
      const key = `${secId}-${seg}-${exch}`;

      ticks.push({
        key,
        securityId: secId,
        exchange: exch,
        segment: seg,
        ltp,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume,
        change: 0,
        changePercent: 0,
        openInterest: oi !== 4294967295 ? oi : undefined,
        lastUpdated: nowStr,
      });
    }

    // TYPE 3: Day OHLC & Baseline Packet (27 bytes)
    else if (packetType === 3 && remaining.byteLength >= 27) {
      const segId = new Uint8Array(remaining.slice(0, 1))[0].toString();
      const secId = new Uint32Array(remaining.slice(1, 5))[0].toString();
      const open = Number(new Float32Array(remaining.slice(11, 15))[0].toFixed(2));
      const prevClose = Number(new Float32Array(remaining.slice(15, 19))[0].toFixed(2));
      const high = Number(new Float32Array(remaining.slice(19, 23))[0].toFixed(2));
      const low = Number(new Float32Array(remaining.slice(23, 27))[0].toFixed(2));

      const exch = segId === '4' ? 'BSE' : 'NSE';
      const seg = segId === '2' ? 'D' : 'E';
      const key = `${secId}-${seg}-${exch}`;

      ticks.push({
        key,
        securityId: secId,
        exchange: exch,
        segment: seg,
        ltp: 0, // Baseline packet; do not overwrite live LTP
        open: open > 0 ? open : 0,
        high: high > 0 ? high : 0,
        low: low > 0 ? low : 0,
        close: prevClose > 0 ? prevClose : 0,
        prevClose: prevClose > 0 ? prevClose : undefined,
        volume: 0,
        change: 0,
        changePercent: 0,
        lastUpdated: nowStr,
      });
    }

    // TYPE 32: Official Previous Day Close Packet (19 bytes)
    else if (packetType === 32 && remaining.byteLength >= 19) {
      const segId = new Uint8Array(remaining.slice(0, 1))[0].toString();
      const secId = new Uint32Array(remaining.slice(1, 5))[0].toString();
      const prevClose = Number(new Float32Array(remaining.slice(11, 15))[0].toFixed(2));

      const exch = segId === '4' ? 'BSE' : 'NSE';
      const seg = segId === '2' ? 'D' : 'E';
      const key = `${secId}-${seg}-${exch}`;

      if (prevClose > 0) {
        ticks.push({
          key,
          securityId: secId,
          exchange: exch,
          segment: seg,
          ltp: 0, // Baseline-only packet; do not overwrite live LTP
          open: 0,
          high: 0,
          low: 0,
          close: prevClose,
          prevClose,
          volume: 0,
          change: 0,
          changePercent: 0,
          lastUpdated: nowStr,
        });
      }
    }

    // TYPE 5: Spot Index Tick (31+ bytes) e.g. NIFTY 50
    else if (packetType === 5 && remaining.byteLength >= 31) {
      const secId = new Uint32Array(remaining.slice(1, 5))[0].toString();
      const ltp = Number(new Float32Array(remaining.slice(11, 15))[0].toFixed(2));
      const open = Number(new Float32Array(remaining.slice(15, 19))[0].toFixed(2));
      const high = Number(new Float32Array(remaining.slice(19, 23))[0].toFixed(2));
      const low = Number(new Float32Array(remaining.slice(23, 27))[0].toFixed(2));
      const prevClose = Number(new Float32Array(remaining.slice(27, 31))[0].toFixed(2));

      const change = prevClose > 0 ? +(ltp - prevClose).toFixed(2) : 0;
      const changePercent = prevClose > 0 ? +((change / prevClose) * 100).toFixed(2) : 0;

      ticks.push({
        key: `${secId}-I-IDX`,
        securityId: secId,
        exchange: 'IDX',
        segment: 'I',
        ltp,
        open,
        high,
        low,
        close: prevClose > 0 ? prevClose : ltp,
        prevClose: prevClose > 0 ? prevClose : undefined,
        volume: 0,
        change,
        changePercent,
        lastUpdated: nowStr,
      });
    }
  }

  return ticks;
}
