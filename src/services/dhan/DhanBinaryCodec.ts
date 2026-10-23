/**
 * QStrategy — Official DhanHQ v2 WebSocket Binary Codec
 * Implements the Little-Endian binary protocol specification defined in official DhanHQ API docs.
 * Handles Code 2 (Ticker), Code 4 (Quote), Code 5 (OI), Code 6 (Prev Close), and Code 50 (Disconnect).
 */

export enum DhanFeedResponseCode {
  TICKER = 2,
  QUOTE = 4,
  OPEN_INTEREST = 5,
  PREV_CLOSE = 6,
  FULL_DEPTH = 8,
  DISCONNECT = 50,
}

export enum DhanFeedRequestCode {
  SUBSCRIBE_TICKER = 15,
  SUBSCRIBE_QUOTE = 17,
  SUBSCRIBE_DEPTH = 21,
  UNSUBSCRIBE = 16,
  DISCONNECT = 12,
}

export interface DhanHeader {
  responseCode: DhanFeedResponseCode | number;
  messageLength: number;
  exchangeSegment: number;
  securityId: number;
}

export interface DhanTickerPacket extends DhanHeader {
  responseCode: DhanFeedResponseCode.TICKER;
  ltp: number;
  ltt: number;
}

export interface DhanQuotePacket extends DhanHeader {
  responseCode: DhanFeedResponseCode.QUOTE;
  ltp: number;
  ltq: number;
  ltt: number;
  atp: number;
  volume: number;
  totalSellQty: number;
  totalBuyQty: number;
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
  open?: number;
  close?: number;
  high?: number;
  low?: number;
}

export interface DhanOIPacket extends DhanHeader {
  responseCode: DhanFeedResponseCode.OPEN_INTEREST;
  oi: number;
}

export interface DhanPrevClosePacket extends DhanHeader {
  responseCode: DhanFeedResponseCode.PREV_CLOSE;
  prevClose: number;
  prevOI: number;
  close?: number;
}

export interface DhanDisconnectPacket extends DhanHeader {
  responseCode: DhanFeedResponseCode.DISCONNECT;
  disconnectCode: number;
  reason: string;
}

export type DhanParsedPacket =
  | DhanTickerPacket
  | DhanQuotePacket
  | DhanOIPacket
  | DhanPrevClosePacket
  | DhanDisconnectPacket;

export interface InstrumentSubscription {
  exchangeSegment: 'NSE_EQ' | 'NSE_FNO' | 'BSE_EQ' | 'IDX_I' | string;
  securityId: string;
}

/**
 * Returns human-readable error description for Dhan disconnect codes
 */
export function getDhanDisconnectReason(code: number): string {
  switch (code) {
    case 805:
      return 'Access Token expired or invalid, or maximum concurrent connections exceeded (first connection severed).';
    case 806:
      return 'User is not subscribed to DhanHQ Data APIs. Please activate Data API subscription.';
    case 807:
      return 'Maximum active WebSocket connection limit exceeded (maximum 5 concurrent sockets allowed).';
    case 808:
      return 'API rate limit exceeded (maximum 25 requests per second).';
    default:
      return `Server disconnected with code: ${code}`;
  }
}

/**
 * Decodes an official DhanHQ binary WebSocket frame into typed packets.
 * Uses Little-Endian byte order per official specification.
 */
export function decodeDhanBinaryPacket(buffer: ArrayBuffer): DhanParsedPacket | null {
  if (!buffer || buffer.byteLength < 8) {
    return null; // Header requires at least 8 bytes
  }

  const view = new DataView(buffer);
  const responseCode = view.getUint8(0);
  const messageLength = view.getInt16(1, true); // Little-Endian
  const exchangeSegment = view.getUint8(3);
  const securityId = view.getInt32(4, true); // Little-Endian

  const header: DhanHeader = {
    responseCode,
    messageLength,
    exchangeSegment,
    securityId,
  };

  switch (responseCode) {
    case DhanFeedResponseCode.TICKER: {
      if (buffer.byteLength < 16) return null;
      const ltp = Number(view.getFloat32(8, true).toFixed(2));
      const ltt = view.getInt32(12, true);
      return {
        ...header,
        responseCode: DhanFeedResponseCode.TICKER,
        ltp,
        ltt,
      };
    }

    case DhanFeedResponseCode.QUOTE: {
      if (buffer.byteLength < 50) return null;
      const ltp = Number(view.getFloat32(8, true).toFixed(2));
      const ltq = view.getInt16(12, true);
      const ltt = view.getInt32(14, true);
      const atp = Number(view.getFloat32(18, true).toFixed(2));
      const volume = view.getInt32(22, true);
      const totalSellQty = view.getInt32(26, true);
      const totalBuyQty = view.getInt32(30, true);
      const dayOpen = Number(view.getFloat32(34, true).toFixed(2));
      const dayClose = Number(view.getFloat32(38, true).toFixed(2));
      const dayHigh = Number(view.getFloat32(42, true).toFixed(2));
      const dayLow = Number(view.getFloat32(46, true).toFixed(2));

      return {
        ...header,
        responseCode: DhanFeedResponseCode.QUOTE,
        ltp,
        ltq,
        ltt,
        atp,
        volume,
        totalSellQty,
        totalBuyQty,
        dayOpen,
        dayClose,
        dayHigh,
        dayLow,
        open: dayOpen,
        close: dayClose,
        high: dayHigh,
        low: dayLow,
      };
    }

    case DhanFeedResponseCode.OPEN_INTEREST: {
      if (buffer.byteLength < 12) return null;
      const oi = view.getInt32(8, true);
      return {
        ...header,
        responseCode: DhanFeedResponseCode.OPEN_INTEREST,
        oi,
      };
    }

    case DhanFeedResponseCode.PREV_CLOSE: {
      if (buffer.byteLength < 16) return null;
      const prevClose = Number(view.getFloat32(8, true).toFixed(2));
      const prevOI = view.getInt32(12, true);
      return {
        ...header,
        responseCode: DhanFeedResponseCode.PREV_CLOSE,
        prevClose,
        prevOI,
        close: prevClose,
      };
    }

    case DhanFeedResponseCode.DISCONNECT: {
      if (buffer.byteLength < 10) return null;
      const disconnectCode = view.getInt16(8, true);
      return {
        ...header,
        responseCode: DhanFeedResponseCode.DISCONNECT,
        disconnectCode,
        reason: getDhanDisconnectReason(disconnectCode),
      };
    }

    default:
      // Unknown response code
      return null;
  }
}

/**
 * Decodes every packet in a frame. Packets are walked by their header length field;
 * a missing/invalid length falls back to decoding the remainder as one packet.
 */
export function decodeDhanBinaryFrame(buffer: ArrayBuffer): DhanParsedPacket[] {
  const packets: DhanParsedPacket[] = [];
  if (!buffer || buffer.byteLength < 8) return packets;

  const view = new DataView(buffer);
  let offset = 0;
  while (offset + 8 <= buffer.byteLength) {
    const remaining = buffer.byteLength - offset;
    const length = view.getInt16(offset + 1, true);
    if (length < 8 || length > remaining) {
      const parsed = decodeDhanBinaryPacket(offset === 0 ? buffer : buffer.slice(offset));
      if (parsed) packets.push(parsed);
      break;
    }
    const parsed = decodeDhanBinaryPacket(
      offset === 0 && length === buffer.byteLength ? buffer : buffer.slice(offset, offset + length)
    );
    if (parsed) packets.push(parsed);
    offset += length;
  }
  return packets;
}

/**
 * Builds outbound JSON subscription string for DhanHQ WebSocket
 */
export function buildDhanSubscriptionMessage(
  instruments: InstrumentSubscription[],
  requestCode = DhanFeedRequestCode.SUBSCRIBE_QUOTE
): string {
  return JSON.stringify({
    RequestCode: requestCode,
    InstrumentCount: instruments.length,
    InstrumentList: instruments.map((i) => ({
      ExchangeSegment: i.exchangeSegment,
      SecurityId: String(i.securityId),
    })),
  });
}

/**
 * Builds outbound JSON unsubscription message
 */
export function buildDhanUnsubscriptionMessage(instruments: InstrumentSubscription[]): string {
  return JSON.stringify({
    RequestCode: DhanFeedRequestCode.UNSUBSCRIBE,
    InstrumentCount: instruments.length,
    InstrumentList: instruments.map((i) => ({
      ExchangeSegment: i.exchangeSegment,
      SecurityId: String(i.securityId),
    })),
  });
}

/**
 * Builds outbound disconnect request
 */
export function buildDhanDisconnectMessage(): string {
  return JSON.stringify({
    RequestCode: DhanFeedRequestCode.DISCONNECT,
  });
}

/**
 * Utility to encode packets to ArrayBuffer (for deterministic unit tests and offline replay)
 */
export function encodeDhanQuotePacket(packet: {
  securityId: number;
  exchangeSegment?: number;
  ltp: number;
  ltq: number;
  ltt: number;
  atp: number;
  volume: number;
  totalSellQty: number;
  totalBuyQty: number;
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
}): ArrayBuffer {
  const buffer = new ArrayBuffer(50);
  const view = new DataView(buffer);

  // Header (8 bytes)
  view.setUint8(0, DhanFeedResponseCode.QUOTE);
  view.setInt16(1, 50, true);
  view.setUint8(3, packet.exchangeSegment ?? 1); // 1 = NSE_EQ
  view.setInt32(4, packet.securityId, true);

  // Payload (42 bytes)
  view.setFloat32(8, packet.ltp, true);
  view.setInt16(12, packet.ltq, true);
  view.setInt32(14, packet.ltt, true);
  view.setFloat32(18, packet.atp, true);
  view.setInt32(22, packet.volume, true);
  view.setInt32(26, packet.totalSellQty, true);
  view.setInt32(30, packet.totalBuyQty, true);
  view.setFloat32(34, packet.dayOpen, true);
  view.setFloat32(38, packet.dayClose, true);
  view.setFloat32(42, packet.dayHigh, true);
  view.setFloat32(46, packet.dayLow, true);

  return buffer;
}

export function encodeDhanTickerPacket(packet: {
  securityId: number;
  exchangeSegment?: number;
  ltp: number;
  ltt: number;
}): ArrayBuffer {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);

  view.setUint8(0, DhanFeedResponseCode.TICKER);
  view.setInt16(1, 16, true);
  view.setUint8(3, packet.exchangeSegment ?? 1);
  view.setInt32(4, packet.securityId, true);

  view.setFloat32(8, packet.ltp, true);
  view.setInt32(12, packet.ltt, true);

  return buffer;
}

export function encodeDhanDisconnectPacket(packet: {
  securityId: number;
  disconnectCode: number;
}): ArrayBuffer {
  const buffer = new ArrayBuffer(10);
  const view = new DataView(buffer);

  view.setUint8(0, DhanFeedResponseCode.DISCONNECT);
  view.setInt16(1, 10, true);
  view.setUint8(3, 0);
  view.setInt32(4, packet.securityId, true);

  view.setInt16(8, packet.disconnectCode, true);

  return buffer;
}
