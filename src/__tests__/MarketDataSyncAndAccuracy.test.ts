import { SENSEX_NIFTY_MASTER_CATALOG } from '../constants/stockUniverse';
import { dhanDirectService } from '../services/dhanDirectService';
import { apiService } from '../services/apiService';
import { useRadarStore } from '../store/useRadarStore';

describe('Market Data Synchronization & Mathematical Accuracy', () => {
  describe('1. Static Universe Baselines', () => {
    it('should have authentic baseline prices and prevClose for all 51 constituents', () => {
      expect(SENSEX_NIFTY_MASTER_CATALOG.length).toBeGreaterThanOrEqual(50);

      SENSEX_NIFTY_MASTER_CATALOG.forEach((stock) => {
        expect(stock.approxLtp).toBeGreaterThan(0);
        expect(stock.prevClose).toBeGreaterThan(0);
        expect(typeof stock.ticker).toBe('string');
      });
    });

    it('should contain verified baseline for ADANIENT with -1.28% return', () => {
      const adani = SENSEX_NIFTY_MASTER_CATALOG.find((s) => s.ticker === 'ADANIENT');
      expect(adani).toBeDefined();
      expect(adani!.approxLtp).toBe(2657.50);
      expect(adani!.prevClose).toBe(2692.00);

      // Verify mathematical formula
      const pct = +(((adani!.approxLtp - adani!.prevClose) / adani!.prevClose) * 100).toFixed(2);
      expect(pct).toBe(-1.28);
    });

    it('should NOT contain the obsolete 3050.00 placeholder for ADANIENT', () => {
      const adani = SENSEX_NIFTY_MASTER_CATALOG.find((s) => s.ticker === 'ADANIENT');
      expect(adani!.approxLtp).not.toBe(3050.00);
    });
  });

  describe('2. DhanDirectService PrevClose Resolution', () => {
    it('should initialize dailyPrevCloseMap from verified catalog baseline', () => {
      expect(dhanDirectService.getPrevClose('ADANIENT')).toBe(2692.00);
      expect(dhanDirectService.getPrevClose('RELIANCE')).toBe(1211.20);
      expect(dhanDirectService.getPrevClose('TCS')).toBe(2465.00);
    });

    it('should resolve prevClose correctly when market is closed (net_change is 0 and ohlc.close equals ltp)', async () => {
      // Mock Dhan post-market quote response where ohlc.close === ltp and net_change === 0
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            NSE_EQ: {
              '25': {
                last_price: 2657.50,
                ohlc: {
                  open: 2715.00,
                  high: 2724.80,
                  low: 2650.00,
                  close: 2657.50, // Post-market settlement close equals ltp!
                },
                net_change: 0,
                volume: 2489000,
              },
            },
          },
        }),
      });
      (global as any).fetch = mockFetch;

      const quotes = await dhanDirectService.fetchDirectBatchQuotes(['ADANIENT']);
      const adaniQuote = quotes['ADANIENT'];

      expect(adaniQuote).toBeDefined();
      expect(adaniQuote.ltp).toBe(2657.50);
      // Crucial: Must NOT fall into the trap of using 2657.50 as prevClose
      expect(adaniQuote.prevClose).toBe(2692.00);
      expect(adaniQuote.changePercent).toBe(-1.28);
      expect(adaniQuote.netChange).toBe(-34.50);
    });

    it('should resolve prevClose correctly during live market when net_change is non-zero', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            NSE_EQ: {
              '25': {
                last_price: 2700.00,
                ohlc: {
                  open: 2695.00,
                  high: 2710.00,
                  low: 2680.00,
                  close: 2692.00,
                },
                net_change: 8.00, // +8 points above prevClose 2692
                volume: 500000,
              },
            },
          },
        }),
      });
      (global as any).fetch = mockFetch;

      const quotes = await dhanDirectService.fetchDirectBatchQuotes(['ADANIENT']);
      const adaniQuote = quotes['ADANIENT'];

      expect(adaniQuote).toBeDefined();
      expect(adaniQuote.ltp).toBe(2700.00);
      expect(adaniQuote.prevClose).toBe(2692.00);
      expect(adaniQuote.changePercent).toBe(0.30);
    });
  });

  describe('3. ApiService Stock Radar List', () => {
    it('should generate accurate spotPrice and pctChange for ADANIENT even if offline or before live quote', async () => {
      // Mock fetch rejection (offline scenario)
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const stocks = await apiService.fetchStockRadarList();
      const adani = stocks.find((s) => s.ticker === 'ADANIENT');

      expect(adani).toBeDefined();
      expect(adani!.spotPrice).toBe(2657.50);
      expect(adani!.prevClose).toBe(2692.00);
      expect(adani!.percentChange).toBe(-1.28);
      expect(adani!.percentChange).not.toBe(14.77);
      expect(adani!.percentChange).not.toBe(0.00);
    });
  });

  describe('4. Store Merging & Ticks PrevClose Preservation', () => {
    it('should preserve authentic prevClose and not collapse to 0.00% on live tick', () => {
      const store = useRadarStore.getState();

      // Simulate store having ADANIENT
      useRadarStore.setState({
        stocks: [
          {
            ticker: 'ADANIENT',
            name: 'Adani Enterprises Limited',
            exchange: 'NSE',
            sector: 'Metals & Mining',
            indices: ['NIFTY 50'],
            spotPrice: 2657.50,
            prevClose: 2692.00,
            dayOpen: 2715.00,
            dayHigh: 2724.80,
            dayLow: 2650.00,
            percentChange: -1.28,
            todayTradedShares: 2489000,
            avg20DTradedShares: 2600000,
            volumeRatio: 0.957,
            hasCrossed20D: false,
            crossoverDirection: 'BEARISH',
            circleIndicator: 'AMBER',
          },
        ],
      });

      const current = useRadarStore.getState().stocks[0];
      expect(current.spotPrice).toBe(2657.50);
      expect(current.prevClose).toBe(2692.00);
      expect(current.percentChange).toBe(-1.28);
    });
  });
});
