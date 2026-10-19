import { NiftyOvernightStrategy, TARGET_PREMIUM_ANCHOR } from '../strategies/NiftyOvernightStrategy';
import { TradingCalendarService } from '../services/TradingCalendarService';
import { OptionChainResult } from '../services/dhan/DhanOptionChainService';

describe('Strategy 2 Engine: NIFTY 09:20 Overnight Strangle Suite', () => {
  let strategy: NiftyOvernightStrategy;
  let calendar: TradingCalendarService;

  beforeEach(() => {
    strategy = new NiftyOvernightStrategy();
    calendar = new TradingCalendarService();
  });

  describe('Expiry Resolution & Expiry Day Skipping Invariant', () => {
    test('rolls to next weekly expiry (+7 days) when today is the scheduled expiry day', () => {
      // Simulate today being Tuesday 2026-10-13 (an expiry day)
      const expiryDayDate = new Date(2026, 9, 13, 10, 0, 0); // 13-OCT-2026 Tuesday

      const res = calendar.getActiveWeeklyExpiry(expiryDayDate, true);

      // Must roll to next week (+7 days) because OOBTST is a BTST overnight strategy
      expect(res.isExpiryDay).toBe(true);
      expect(res.rolledToNextExpiry).toBe(true);
    });

    test('prepones expiry date if scheduled Tuesday is an official NSE holiday', () => {
      // Dussehra: 2026-10-20 (Tuesday) is an official holiday per circular NSE/CMTR/71775
      const preDussehraDate = new Date(2026, 9, 15, 10, 0, 0); // Thursday Oct 15
      const res = calendar.getActiveWeeklyExpiry(preDussehraDate, false);

      // Should prepone Tuesday Oct 20 to Monday Oct 19
      expect(res.wasPreponed).toBe(true);
      expect(res.expiryDateYMD).toBe('2026-10-19');
    });
  });

  describe('Candidate Selection Math & Range Filter (₹50–₹75)', () => {
    const mockChain: OptionChainResult = {
      underlyingScrip: 13,
      underlyingSeg: 'IDX_I',
      expiry: '2026-10-27',
      spotPrice: 24800,
      atmStrike: 24800,
      pcr: 1.0,
      totalCallOi: 100000,
      totalPutOi: 100000,
      strikes: [
        {
          strikePrice: 24700,
          moneyness: 'ITM',
          ce: { ltp: 110.0, oi: 100, volume: 50, iv: 13, bid: 109, ask: 111 },
          pe: { ltp: 45.0, oi: 100, volume: 50, iv: 13, bid: 44, ask: 46 }, // Out of range (< 50)
        },
        {
          strikePrice: 24750,
          moneyness: 'ITM',
          ce: { ltp: 80.0, oi: 100, volume: 50, iv: 13, bid: 79, ask: 81 },
          pe: { ltp: 58.0, oi: 100, volume: 50, iv: 13, bid: 57, ask: 59 }, // Diff: |58 - 62.5| = 4.5
        },
        {
          strikePrice: 24800,
          moneyness: 'ATM',
          ce: { ltp: 64.0, oi: 100, volume: 50, iv: 13, bid: 63, ask: 65 }, // Diff: |64 - 62.5| = 1.5 (WINNER)
          pe: { ltp: 63.5, oi: 100, volume: 50, iv: 13, bid: 63, ask: 64 }, // Diff: |63.5 - 62.5| = 1.0 (WINNER)
        },
        {
          strikePrice: 24850,
          moneyness: 'OTM',
          ce: { ltp: 52.0, oi: 100, volume: 50, iv: 13, bid: 51, ask: 53 }, // Diff: |52 - 62.5| = 10.5
          pe: { ltp: 85.0, oi: 100, volume: 50, iv: 13, bid: 84, ask: 86 }, // Out of range (> 75)
        },
      ],
    };

    test('selects candidate closest to ₹62.50 within ₹50–₹75 range', () => {
      const { ceCandidate, peCandidate } = strategy.select0920Candidates(mockChain);

      expect(ceCandidate).not.toBeNull();
      expect(peCandidate).not.toBeNull();

      expect(ceCandidate?.strike).toBe(24800);
      expect(ceCandidate?.ltp).toBe(64.0);
      expect(ceCandidate?.distanceToAnchor).toBe(1.5);

      expect(peCandidate?.strike).toBe(24800);
      expect(peCandidate?.ltp).toBe(63.5);
      expect(peCandidate?.distanceToAnchor).toBe(1.0);
    });

    test('strictly enforces permanent 25% Stop Loss (refPrice * 0.75)', () => {
      const evalResult = strategy.evaluate(mockChain, '09:20:00');

      expect(evalResult.status).toBe('ENTRY_TRIGGERED');
      expect(evalResult.ceLeg).not.toBeNull();
      expect(evalResult.peLeg).not.toBeNull();

      // CE: 64.0 * 0.75 = 48.00
      expect(evalResult.ceLeg?.refPrice).toBe(64.0);
      expect(evalResult.ceLeg?.stopLossPrice).toBe(48.0);

      // PE: 63.5 * 0.75 = 47.63
      expect(evalResult.peLeg?.refPrice).toBe(63.5);
      expect(evalResult.peLeg?.stopLossPrice).toBe(47.63);
    });

    test('ENFORCES STRICTLY ZERO PROFIT TARGET INVARIANT', () => {
      const evalResult = strategy.evaluate(mockChain, '09:20:00');

      // MATHEMATICAL INVARIANT: Target MUST be strictly undefined
      expect(evalResult.target).toBeUndefined();
      expect(evalResult.ceLeg?.targetPrice).toBeUndefined();
      expect(evalResult.peLeg?.targetPrice).toBeUndefined();
    });
  });

  describe('Intraday Stop-Loss Breaches & Overnight Progression', () => {
    test('triggers SL_HIT on leg when price falls below 25% stop-loss', () => {
      const initialEval = strategy.evaluate(
        {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          expiry: '2026-10-27',
          spotPrice: 24800,
          atmStrike: 24800,
          pcr: 1.0,
          totalCallOi: 1000,
          totalPutOi: 1000,
          strikes: [
            {
              strikePrice: 24800,
              moneyness: 'ATM',
              ce: { ltp: 60.0, oi: 10, volume: 10, iv: 13, bid: 60, ask: 60 },
              pe: { ltp: 60.0, oi: 10, volume: 10, iv: 13, bid: 60, ask: 60 },
            },
          ],
        },
        '09:20:00'
      );

      const ceLeg = initialEval.ceLeg!;
      const peLeg = initialEval.peLeg!;

      // Ref: 60, SL: 45
      expect(ceLeg.stopLossPrice).toBe(45);

      // Simulate tick where CE crashes to 44.0 (SL breached) while PE rises to 72.0
      const tickChain: OptionChainResult = {
        underlyingScrip: 13,
        underlyingSeg: 'IDX_I',
        expiry: '2026-10-27',
        spotPrice: 24700,
        atmStrike: 24700,
        pcr: 1.0,
        totalCallOi: 1000,
        totalPutOi: 1000,
        strikes: [
          {
            strikePrice: 24800,
            moneyness: 'OTM',
            ce: { ltp: 44.0, oi: 10, volume: 10, iv: 13, bid: 44, ask: 44 },
            pe: { ltp: 72.0, oi: 10, volume: 10, iv: 13, bid: 72, ask: 72 },
          },
        ],
      };

      const monitored = strategy.evaluate(tickChain, '11:15:00', {
        ceLeg,
        peLeg,
        entryDate: '2026-10-20',
      });

      expect(monitored.ceLeg?.status).toBe('SL_HIT');
      expect(monitored.peLeg?.status).toBe('ACTIVE');
      expect(monitored.target).toBeUndefined();
    });

    test('tags open position as OVERNIGHT_HOLD after 15:30:00 IST', () => {
      const dummyLeg = {
        type: 'CE' as const,
        strike: 24800,
        symbol: 'NIFTY 24800 CE',
        refPrice: 62.0,
        stopLossPrice: 46.5,
        currentLtp: 65.0,
        status: 'ACTIVE' as const,
        pnlPts: 3.0,
        pnlPct: 4.8,
        targetPrice: undefined,
      };

      const eodEval = strategy.evaluate(
        {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          expiry: '2026-10-27',
          spotPrice: 24800,
          atmStrike: 24800,
          pcr: 1.0,
          totalCallOi: 1000,
          totalPutOi: 1000,
          strikes: [],
        },
        '15:31:00',
        {
          ceLeg: dummyLeg,
          peLeg: { ...dummyLeg, type: 'PE', symbol: 'NIFTY 24800 PE' },
          entryDate: '2026-10-20',
        }
      );

      expect(eodEval.status).toBe('OVERNIGHT_HOLD');
      expect(eodEval.isOvernightCarry).toBe(true);
    });

    test('mandates exit (COMPLETED) at exactly 09:25:00 AM IST on next trading day', () => {
      const dummyLeg = {
        type: 'CE' as const,
        strike: 24800,
        symbol: 'NIFTY 24800 CE',
        refPrice: 62.0,
        stopLossPrice: 46.5,
        currentLtp: 75.0,
        status: 'ACTIVE' as const,
        pnlPts: 13.0,
        pnlPct: 20.9,
        targetPrice: undefined,
      };

      const exitEval = strategy.evaluate(
        {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          expiry: '2026-10-27',
          spotPrice: 24850,
          atmStrike: 24850,
          pcr: 1.0,
          totalCallOi: 1000,
          totalPutOi: 1000,
          strikes: [],
        },
        '09:25:00',
        {
          ceLeg: dummyLeg,
          peLeg: { ...dummyLeg, type: 'PE', symbol: 'NIFTY 24800 PE' },
          entryDate: '2026-10-20',
          isNextDay: true,
        }
      );

      expect(exitEval.status).toBe('COMPLETED');
      expect(exitEval.ceLeg?.status).toBe('SQUARED_OFF');
      expect(exitEval.peLeg?.status).toBe('SQUARED_OFF');
    });
  });
});
