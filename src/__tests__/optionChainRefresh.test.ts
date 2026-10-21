import { chainSubscriptions, diffSubscriptions, mergeRefreshedChain, LIVE_TICK_PRIORITY_MS } from '../utils/optionChainRefresh';
import type { OptionChainResult } from '../services/dhan/DhanOptionChainService';

function chain(ceLtp: number, peLtp: number, scrip = 13): OptionChainResult {
  return {
    underlyingScrip: scrip,
    strikes: [
      {
        strikePrice: 24000,
        ce: { ltp: ceLtp, oi: 10, securityId: '101' },
        pe: { ltp: peLtp, oi: 20, securityId: '102' },
      },
    ],
  } as unknown as OptionChainResult;
}

describe('optionChainRefresh', () => {
  const now = 1_000_000;

  it('keeps a recently ticked live price over the REST snapshot', () => {
    const ticks = new Map([['101', now - 1000]]);
    const merged = mergeRefreshedChain(chain(120, 80), chain(100, 90), ticks, now);
    expect(merged.strikes[0].ce.ltp).toBe(120);
    expect(merged.strikes[0].pe.ltp).toBe(90);
  });

  it('takes the REST price once the last tick is old', () => {
    const ticks = new Map([['101', now - LIVE_TICK_PRIORITY_MS - 1]]);
    const merged = mergeRefreshedChain(chain(120, 80), chain(100, 90), ticks, now);
    expect(merged.strikes[0].ce.ltp).toBe(100);
  });

  it('uses the new chain when the underlying changed or nothing was loaded', () => {
    const next = chain(100, 90, 25);
    expect(mergeRefreshedChain(chain(1, 1, 13), next, new Map([['101', now]]), now)).toBe(next);
    expect(mergeRefreshedChain(null, next, new Map(), now)).toBe(next);
  });

  it('subscribes only contracts that changed', () => {
    const wanted = chainSubscriptions(chain(1, 1), 'NSE_FNO');
    expect(wanted).toHaveLength(2);

    const current = new Map([
      ['2:101', wanted[0]],
      ['2:999', { exchangeSegment: 'NSE_FNO', securityId: '999' }],
    ]);
    const { toAdd, toDrop } = diffSubscriptions(current, wanted);
    expect(toAdd.map((s) => s.securityId)).toEqual(['102']);
    expect(toDrop.map((s) => s.securityId)).toEqual(['999']);
  });
});
