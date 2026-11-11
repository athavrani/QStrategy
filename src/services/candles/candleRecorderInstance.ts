import AsyncStorage from '@react-native-async-storage/async-storage';
import { CandleRecorder } from './CandleRecorder';
import { candleRepository } from './CandleRepository';
import { marketData } from '../marketdata/MarketDataService';
import { dhanDirectService } from '../dhanDirectService';
import { niftyOptionFeedService } from '../niftyOptionFeedService';
import { sensexOptionFeedService } from '../sensexOptionFeedService';

/** The app's recorder, wired to the live feed, Dhan and the on-device database. */
export const candleRecorder = new CandleRecorder({
  repo: candleRepository,
  market: marketData,
  fetchExpiryList: (underlying) => dhanDirectService.fetchExpiryList(underlying),
  fetchChain: (expiry, underlying) => dhanDirectService.fetchOptionChain(expiry, underlying),
  fetchCandles: (secId, segment, instrument, fromDate, toDate, withOi) =>
    dhanDirectService.fetchHistoricalIntraday(secId, fromDate, toDate, segment, instrument, '1', withOi),
  getLockedContracts: () => [
    ...niftyOptionFeedService
      .getLockedContracts()
      .map((c) => ({ ...c, underlying: 'NIFTY', segment: 'NSE_FNO' as const })),
    ...sensexOptionFeedService
      .getLockedContracts()
      .map((c) => ({ ...c, underlying: 'SENSEX', segment: 'BSE_FNO' as const })),
  ],
  storage: AsyncStorage,
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});
