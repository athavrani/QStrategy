import { OptionChainFeed, OptionChainRows } from '../services/marketdata/OptionChainFeed';

jest.mock('../services/dhanDirectService', () => ({ dhanDirectService: {} }));
jest.mock('../services/marketdata/MarketDataService', () => ({ marketData: {} }));

const rows = (): OptionChainRows => ({
  24800: { ceLtp: 60, peLtp: 40, ceOi: 1, peOi: 1, ceSecId: '101', peSecId: '102' },
  24850: { ceLtp: 35, peLtp: 70, ceOi: 1, peOi: 1, ceSecId: '103', peSecId: '104' },
});

function setup(selected: Array<{ ce: string[]; pe: string[] }>) {
  let clock = 1_000;
  let call = 0;
  const market = { acquire: jest.fn(), release: jest.fn(), isConnected: jest.fn(() => true) };
  const fetchChain = jest.fn(async (_expiry: string, _underlying: string) => ({ spotPrice: 24820, oc: rows() }));
  const feed = new OptionChainFeed(
    {
      owner: 'test-options',
      underlying: 'NIFTY',
      optionSegment: 'NSE_FNO',
      fallbackSpot: 24850,
      resolveExpiryYmd: () => '2026-10-27',
      selectCandidates: () => {
        const pick = selected[Math.min(call++, selected.length - 1)];
        return {
          ceCandidates: pick.ce.map((securityId) => ({ securityId })),
          peCandidates: pick.pe.map((securityId) => ({ securityId })),
        };
      },
    },
    { fetchChain, market, now: () => clock }
  );
  return { feed, market, fetchChain, advance: (ms: number) => (clock += ms) };
}

describe('OptionChainFeed', () => {
  test('stores the chain and spot, and streams candidates under its owner', async () => {
    const { feed, market, fetchChain } = setup([{ ce: ['101'], pe: ['102'] }]);
    expect(await feed.sync()).toBe(true);

    expect(fetchChain).toHaveBeenCalledWith('2026-10-27', 'NIFTY');
    expect(feed.lastSpot).toBe(24820);
    expect(feed.getLiveOptionPrice(24800, 'CE')).toBe(60);
    expect(market.acquire).toHaveBeenCalledWith('test-options', [
      { exchangeSegment: 'NSE_FNO', securityId: '101' },
      { exchangeSegment: 'NSE_FNO', securityId: '102' },
    ]);
  });

  test('streams only the delta between syncs and releases dropped contracts', async () => {
    const { feed, market } = setup([
      { ce: ['101'], pe: ['102'] },
      { ce: ['101'], pe: ['104'] },
    ]);
    await feed.sync();
    market.acquire.mockClear();
    await feed.sync();

    expect(market.acquire).toHaveBeenCalledWith('test-options', [{ exchangeSegment: 'NSE_FNO', securityId: '104' }]);
    expect(market.release).toHaveBeenCalledWith('test-options', [{ exchangeSegment: 'NSE_FNO', securityId: '102' }]);
  });

  test('concurrent syncs share one fetch', async () => {
    const { feed, fetchChain } = setup([{ ce: [], pe: [] }]);
    await Promise.all([feed.sync(), feed.sync(), feed.sync()]);
    expect(fetchChain).toHaveBeenCalledTimes(1);
  });

  test('other underlyings are fetched but never stored', async () => {
    const { feed, fetchChain } = setup([{ ce: [], pe: [] }]);
    expect(await feed.sync('BANKNIFTY')).toBe(true);
    expect(fetchChain).toHaveBeenCalledWith('2026-10-27', 'BANKNIFTY');
    expect(feed.chain).toBeNull();
  });

  test('failed or empty fetch returns false and keeps the previous chain', async () => {
    const { feed, fetchChain } = setup([{ ce: [], pe: [] }]);
    await feed.sync();
    fetchChain.mockResolvedValueOnce(null as any);
    expect(await feed.sync()).toBe(false);
    fetchChain.mockRejectedValueOnce(new Error('net'));
    expect(await feed.sync()).toBe(false);
    expect(feed.getLiveOptionPrice(24800, 'CE')).toBe(60);
  });

  test('tick updates LTP and bid/ask by security id and ignores non-positive prices', async () => {
    const { feed } = setup([{ ce: [], pe: [] }]);
    await feed.sync();
    feed.updateFromTick('103', 38.5, 38, 39);
    feed.updateFromTick('104', 0);
    expect(feed.getLiveOptionPrice(24850, 'CE')).toBe(38.5);
    expect(feed.chain?.[24850].ceBid).toBe(38);
    expect(feed.getLiveOptionPrice(24850, 'PE')).toBe(70);
  });

  test('freshness follows sync age and connection state', async () => {
    const { feed, market, advance } = setup([{ ce: [], pe: [] }]);
    expect(feed.getQuoteFreshness()).toBe('STALE');
    await feed.sync();
    expect(feed.getQuoteFreshness()).toBe('FRESH');
    advance(6000);
    expect(feed.getQuoteFreshness()).toBe('AGING');
    advance(10000);
    expect(feed.getQuoteFreshness()).toBe('STALE');
    market.isConnected.mockReturnValue(false);
    expect(feed.getQuoteFreshness()).toBe('DISCONNECTED');
  });

  test('reset clears state and releases every streamed contract', async () => {
    const { feed, market } = setup([{ ce: ['101'], pe: ['102'] }]);
    await feed.sync();
    feed.reset();
    expect(feed.chain).toBeNull();
    expect(feed.lastSyncTime).toBe(0);
    expect(market.release).toHaveBeenCalledWith('test-options', [
      { exchangeSegment: 'NSE_FNO', securityId: '101' },
      { exchangeSegment: 'NSE_FNO', securityId: '102' },
    ]);
  });
});
