import {
  decodeDhanBinaryPacket,
  decodeDhanBinaryFrame,
  encodeDhanQuotePacket,
  encodeDhanTickerPacket,
  encodeDhanDisconnectPacket,
  buildDhanSubscriptionMessage,
  buildDhanUnsubscriptionMessage,
  buildDhanDisconnectMessage,
  DhanFeedResponseCode,
  DhanFeedRequestCode,
  DhanQuotePacket,
  DhanTickerPacket,
  DhanDisconnectPacket,
  getDhanDisconnectReason,
} from '../services/dhan/DhanBinaryCodec';

describe('DhanHQ v2 Binary Codec (Little-Endian Protocol)', () => {
  describe('Code 2: Ticker Packet Decoding', () => {
    it('decodes Code 2 Ticker binary packet accurately in Little-Endian order', () => {
      const sample = encodeDhanTickerPacket({
        securityId: 1333, // HDFCBANK
        exchangeSegment: 1, // NSE_EQ
        ltp: 1680.50,
        ltt: 1729320000,
      });

      const decoded = decodeDhanBinaryPacket(sample);

      expect(decoded).not.toBeNull();
      expect(decoded?.responseCode).toBe(DhanFeedResponseCode.TICKER);
      expect(decoded?.securityId).toBe(1333);
      expect(decoded?.exchangeSegment).toBe(1);

      const ticker = decoded as DhanTickerPacket;
      expect(ticker.ltp).toBeCloseTo(1680.50, 2);
      expect(ticker.ltt).toBe(1729320000);
    });
  });

  describe('Code 4: Full Quote Packet Decoding', () => {
    it('decodes 50-byte Code 4 Quote packet with all 11 fields intact', () => {
      const sample = encodeDhanQuotePacket({
        securityId: 2885, // RELIANCE
        exchangeSegment: 1, // NSE_EQ
        ltp: 2945.50,
        ltq: 125,
        ltt: 1729320600,
        atp: 2930.25,
        volume: 4821390,
        totalSellQty: 85400,
        totalBuyQty: 120500,
        dayOpen: 2920.00,
        dayClose: 0.00,
        dayHigh: 2960.00,
        dayLow: 2915.00,
      });

      expect(sample.byteLength).toBe(50);

      const decoded = decodeDhanBinaryPacket(sample);

      expect(decoded).not.toBeNull();
      expect(decoded?.responseCode).toBe(DhanFeedResponseCode.QUOTE);
      expect(decoded?.securityId).toBe(2885);
      expect(decoded?.messageLength).toBe(50);

      const quote = decoded as DhanQuotePacket;
      expect(quote.ltp).toBeCloseTo(2945.50, 2);
      expect(quote.ltq).toBe(125);
      expect(quote.ltt).toBe(1729320600);
      expect(quote.atp).toBeCloseTo(2930.25, 2);
      expect(quote.volume).toBe(4821390);
      expect(quote.totalSellQty).toBe(85400);
      expect(quote.totalBuyQty).toBe(120500);
      expect(quote.dayOpen).toBeCloseTo(2920.00, 2);
      expect(quote.dayHigh).toBeCloseTo(2960.00, 2);
      expect(quote.dayLow).toBeCloseTo(2915.00, 2);
    });
  });

  describe('Code 50: Disconnect Code Handling', () => {
    it('decodes Code 50 disconnect packets and formats exact reason strings', () => {
      const buffer805 = encodeDhanDisconnectPacket({
        securityId: 0,
        disconnectCode: 805,
      });

      const decoded = decodeDhanBinaryPacket(buffer805) as DhanDisconnectPacket;

      expect(decoded).not.toBeNull();
      expect(decoded.responseCode).toBe(DhanFeedResponseCode.DISCONNECT);
      expect(decoded.disconnectCode).toBe(805);
      expect(decoded.reason).toContain('Access Token expired');

      expect(getDhanDisconnectReason(806)).toContain('Data APIs');
      expect(getDhanDisconnectReason(807)).toContain('5 concurrent');
      expect(getDhanDisconnectReason(808)).toContain('rate limit');
    });
  });

  describe('Multi-packet frames', () => {
    const concat = (...bufs: ArrayBuffer[]): ArrayBuffer => {
      const out = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
      let off = 0;
      for (const b of bufs) {
        out.set(new Uint8Array(b), off);
        off += b.byteLength;
      }
      return out.buffer;
    };
    const quote = (securityId: number, ltp: number) =>
      encodeDhanQuotePacket({
        securityId, ltp, ltq: 1, ltt: 1729320600, atp: ltp, volume: 10,
        totalSellQty: 1, totalBuyQty: 1, dayOpen: ltp, dayClose: 0, dayHigh: ltp, dayLow: ltp,
      });

    it('decodes every packet in a concatenated frame', () => {
      const frame = concat(
        quote(1333, 1650.5),
        encodeDhanTickerPacket({ securityId: 2885, ltp: 2945.5, ltt: 1729320600 }),
        quote(25, 2650)
      );
      const packets = decodeDhanBinaryFrame(frame);
      expect(packets.map((p) => p.securityId)).toEqual([1333, 2885, 25]);
      expect(packets.map((p) => p.responseCode)).toEqual([4, 2, 4]);
    });

    it('keeps complete packets when the frame is truncated', () => {
      const full = concat(quote(1333, 1650.5), quote(2885, 2945.5));
      const packets = decodeDhanBinaryFrame(full.slice(0, 70));
      expect(packets).toHaveLength(1);
      expect(packets[0].securityId).toBe(1333);
    });

    it('decodes a single-packet frame and ignores empty input', () => {
      expect(decodeDhanBinaryFrame(quote(1333, 10))).toHaveLength(1);
      expect(decodeDhanBinaryFrame(new ArrayBuffer(0))).toEqual([]);
    });
  });

  describe('Malformed Packet Safety', () => {
    it('returns null safely on truncated buffers under 8 bytes', () => {
      const emptyBuffer = new ArrayBuffer(0);
      const shortBuffer = new ArrayBuffer(4);

      expect(decodeDhanBinaryPacket(emptyBuffer)).toBeNull();
      expect(decodeDhanBinaryPacket(shortBuffer)).toBeNull();
    });
  });

  describe('Outbound JSON Message Serialization', () => {
    it('builds compliant JSON subscription messages', () => {
      const instruments = [
        { exchangeSegment: 'NSE_EQ', securityId: '1333' },
        { exchangeSegment: 'NSE_FNO', securityId: '49512' },
      ];

      const jsonStr = buildDhanSubscriptionMessage(instruments, DhanFeedRequestCode.SUBSCRIBE_QUOTE);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.RequestCode).toBe(17);
      expect(parsed.InstrumentCount).toBe(2);
      expect(parsed.InstrumentList).toHaveLength(2);
      expect(parsed.InstrumentList[0]).toEqual({ ExchangeSegment: 'NSE_EQ', SecurityId: '1333' });
    });

    it('builds valid unsubscription and disconnect frames', () => {
      const unsubs = buildDhanUnsubscriptionMessage([{ exchangeSegment: 'NSE_EQ', securityId: '1333' }]);
      expect(JSON.parse(unsubs).RequestCode).toBe(16);

      const disconn = buildDhanDisconnectMessage();
      expect(JSON.parse(disconn).RequestCode).toBe(12);
    });
  });
});
