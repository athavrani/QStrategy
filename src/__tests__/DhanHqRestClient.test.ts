import { DhanHqRestClient } from '../services/dhan/DhanHqRestClient';
import { DhanOptionChainService } from '../services/dhan/DhanOptionChainService';
import { secureVault } from '../services/SecureCredentialVault';

const VALID_MOCK_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTAwMzQ1Njc4IiwiZXhwIjoxNzkyNDkxMDI1LCJkaGFuQ2xpZW50SWQiOiIxMTAwMzQ1Njc4In0.mock_signature_hash_bytes_for_valid_token_testing_50chars';

// Mock expo-secure-store
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => store.get(key) || null),
    setItemAsync: jest.fn(async (key: string, val: string) => {
      store.set(key, val);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'mock-when-unlocked',
  };
});

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn().mockResolvedValue(true),
  isEnrolledAsync: jest.fn().mockResolvedValue(true),
  authenticateAsync: jest.fn().mockResolvedValue({ success: true }),
}));

describe('DhanHqRestClient & OptionChainService Suite', () => {
  let restClient: DhanHqRestClient;
  let optionChainService: DhanOptionChainService;

  beforeEach(async () => {
    jest.clearAllMocks();
    restClient = new DhanHqRestClient(1000);
    optionChainService = new DhanOptionChainService();
    // Configure valid mock credentials
    await secureVault.saveCredentials('1100345678', VALID_MOCK_JWT);
  });

  afterEach(async () => {
    await secureVault.clearCredentials();
  });

  describe('DhanHqRestClient', () => {
    test('makes no request and returns null when no credentials are configured (no built-in fallback account)', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      await secureVault.clearCredentials();
      const res = await restClient.fetchLtp({ NSE_EQ: [1333] });

      expect(res).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('does not retry with another account after HTTP 401', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
      global.fetch = mockFetch as any;

      const res = await restClient.fetchLtp({ NSE_EQ: [1333] });

      expect(res).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('fetches LTP data successfully and injects correct auth headers', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            NSE_EQ: {
              '1333': { last_price: 1650.5 },
            },
          },
        }),
      });
      global.fetch = mockFetch as any;

      const res = await restClient.fetchLtp({ NSE_EQ: [1333] });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.dhan.co/v2/marketfeed/ltp');
      expect(options.headers['access-token']).toBe(VALID_MOCK_JWT);
      expect(options.headers['client-id']).toBe('1100345678');
      expect(res).toEqual({
        NSE_EQ: {
          '1333': { last_price: 1650.5 },
        },
      });
    });

    test('handles HTTP 401 and updates telemetry status to TOKEN_EXPIRED', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      global.fetch = mockFetch as any;

      const res = await restClient.fetchQuotes({ NSE_EQ: [1333] });
      expect(res).toBeNull();

      const telem = secureVault.getTelemetry();
      expect(telem.status).toBe('TOKEN_EXPIRED');
    });

    test('handles network failure gracefully without throwing uncaught exceptions', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error('Connection reset by peer'));
      global.fetch = mockFetch as any;

      const res = await restClient.fetchOptionChain(13, 'IDX_I', '2026-10-20');
      expect(res).toBeNull();

      const telem = secureVault.getTelemetry();
      expect(telem.lastError).toContain('Connection reset by peer');
    });
  });

  describe('DhanOptionChainService', () => {
    test('transforms option chain response, computes ATM, PCR, and strictly preserves nulls', async () => {
      const mockRawResponse = {
        status: 'success',
        data: {
          last_price: 24823.5,
          oc: {
            '24800.00': {
              ce: {
                last_price: 65.0,
                oi: 100000,
                implied_volatility: 13.5,
                volume: 50000,
                security_id: 25100,
              },
              pe: {
                last_price: 45.0,
                oi: 80000,
                volume: 40000,
                // implied_volatility is omitted to test strict nullability
              },
            },
            '24850.00': {
              ce: {
                last_price: 35.0,
                oi: 50000,
                implied_volatility: 13.8,
              },
              pe: {
                last_price: 75.0,
                oi: 120000,
                implied_volatility: 14.1,
              },
            },
          },
        },
      };

      jest.spyOn(restClient, 'fetchOptionChain').mockResolvedValue(mockRawResponse);
      (optionChainService as any).restClient = restClient;

      // Temporarily replace singleton restClient
      const originalPost = (optionChainService as any).getOptionChain;
      const chain = await optionChainService.getOptionChain(13, 'IDX_I', '2026-10-20', 50);

      // Verify spot and ATM strike (24823.5 rounds to 24800 ATM with step 50)
      expect(chain).not.toBeNull();
      if (!chain) return;

      expect(chain.spotPrice).toBe(24823.5);
      expect(chain.atmStrike).toBe(24800);

      // Total Call OI: 100000 + 50000 = 150000
      // Total Put OI: 80000 + 120000 = 200000
      expect(chain.totalCallOi).toBe(150000);
      expect(chain.totalPutOi).toBe(200000);
      expect(chain.pcr).toBe(1.33); // 200000 / 150000 = 1.3333 -> 1.33

      // Verify strict nullability: PE on 24800 had no IV, MUST be null, not 14.8!
      const strike24800 = chain.strikes.find((s) => s.strikePrice === 24800);
      expect(strike24800).toBeDefined();
      expect(strike24800?.pe.iv).toBeNull();
      expect(strike24800?.ce.iv).toBe(13.5);
    });

    test('selects anchor strikes closest to target premium (₹62.50)', () => {
      const mockChain = {
        underlyingScrip: 13,
        underlyingSeg: 'IDX_I',
        expiry: '2026-10-20',
        spotPrice: 24810,
        atmStrike: 24800,
        pcr: 1.0,
        totalCallOi: 10000,
        totalPutOi: 10000,
        strikes: [
          {
            strikePrice: 24750,
            moneyness: 'ITM' as const,
            ce: { ltp: 110, oi: 100, volume: 50, iv: null, bid: null, ask: null },
            pe: { ltp: 61.5, oi: 100, volume: 50, iv: null, bid: null, ask: null }, // Diff |61.5 - 62.5| = 1.0
          },
          {
            strikePrice: 24800,
            moneyness: 'ATM' as const,
            ce: { ltp: 63.0, oi: 100, volume: 50, iv: null, bid: null, ask: null }, // Diff |63 - 62.5| = 0.5
            pe: { ltp: 85.0, oi: 100, volume: 50, iv: null, bid: null, ask: null },
          },
          {
            strikePrice: 24850,
            moneyness: 'OTM' as const,
            ce: { ltp: 32.0, oi: 100, volume: 50, iv: null, bid: null, ask: null },
            pe: { ltp: 120.0, oi: 100, volume: 50, iv: null, bid: null, ask: null },
          },
        ],
      };

      const anchor = optionChainService.selectAnchorStrikes(mockChain, 62.5);
      expect(anchor).toEqual({
        ceStrike: 24800,
        cePrice: 63.0,
        peStrike: 24750,
        pePrice: 61.5,
      });
    });

    test('returns null when chain has no spotPrice or empty strikes', () => {
      const emptyChain = {
        underlyingScrip: 13,
        underlyingSeg: 'IDX_I',
        expiry: '2026-10-20',
        spotPrice: null,
        atmStrike: null,
        pcr: null,
        totalCallOi: 0,
        totalPutOi: 0,
        strikes: [],
      };

      const anchor = optionChainService.selectAnchorStrikes(emptyChain);
      expect(anchor).toBeNull();
    });
  });
});
