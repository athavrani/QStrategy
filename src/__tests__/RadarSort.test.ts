import { StockRadarItem } from '../types/mobile';
import { DEFAULT_RADAR_SORT, nextSignalAt, sortRadarStocks } from '../utils/radarSort';

const stock = (ticker: string, over: Partial<StockRadarItem> = {}): StockRadarItem => ({
  ticker,
  name: ticker,
  exchange: 'NSE',
  indices: ['NIFTY 50'],
  spotPrice: 100,
  dayOpen: 100,
  dayHigh: 100,
  dayLow: 100,
  percentChange: 0,
  todayTradedShares: 0,
  avg20DTradedShares: 1,
  volumeRatio: 0,
  hasCrossed20D: false,
  circleIndicator: 'GREY',
  ...over,
});

const tickers = (list: StockRadarItem[]) => list.map((s) => s.ticker);

describe('radar sort', () => {
  const list = [
    stock('AAA', { circleIndicator: 'GREEN', signalAt: 1000, volumeRatio: 1.2, percentChange: 1 }),
    stock('BBB', { circleIndicator: 'RED', signalAt: 3000, volumeRatio: 2.5, percentChange: -2 }),
    stock('CCC'),
    stock('DDD', { circleIndicator: 'AMBER', signalAt: 2000, volumeRatio: 0.9, percentChange: 3 }),
    stock('EEE'),
  ];

  test('defaults to newest first, with undated stocks last in their original order', () => {
    expect(DEFAULT_RADAR_SORT).toBe('NEWEST');
    expect(tickers(sortRadarStocks(list, 'NEWEST'))).toEqual(['BBB', 'DDD', 'AAA', 'CCC', 'EEE']);
  });

  test('oldest first reverses the dated stocks only', () => {
    expect(tickers(sortRadarStocks(list, 'OLDEST'))).toEqual(['AAA', 'DDD', 'BBB', 'CCC', 'EEE']);
  });

  test('volume, price change and name orders', () => {
    expect(tickers(sortRadarStocks(list, 'RATIO'))).toEqual(['BBB', 'AAA', 'DDD', 'CCC', 'EEE']);
    expect(tickers(sortRadarStocks(list, 'CHANGE'))).toEqual(['DDD', 'AAA', 'CCC', 'EEE', 'BBB']);
    expect(tickers(sortRadarStocks([list[1], list[0], list[3]], 'NAME'))).toEqual(['AAA', 'BBB', 'DDD']);
  });

  test('equal signal times keep the original order and the input is not mutated', () => {
    const tied = [stock('X', { signalAt: 5 }), stock('Y', { signalAt: 5 })];
    const copy = [...tied];
    expect(tickers(sortRadarStocks(tied, 'NEWEST'))).toEqual(['X', 'Y']);
    expect(tied).toEqual(copy);
  });

  test('sorts the Buy, Sell and Near filter results newest first', () => {
    const buys = list.filter((s) => s.circleIndicator === 'GREEN' || s.circleIndicator === 'RED');
    expect(tickers(sortRadarStocks(buys, 'NEWEST'))).toEqual(['BBB', 'AAA']);
  });
});

describe('nextSignalAt', () => {
  test('stamps a new signal, keeps it while the state holds, restarts on a change, clears on scanning', () => {
    expect(nextSignalAt(undefined, 'AMBER', 500)).toBe(500);
    expect(nextSignalAt({ circleIndicator: 'AMBER', signalAt: 500 }, 'AMBER', 900)).toBe(500);
    expect(nextSignalAt({ circleIndicator: 'AMBER', signalAt: 500 }, 'GREEN', 900)).toBe(900);
    expect(nextSignalAt({ circleIndicator: 'GREEN', signalAt: 500 }, 'GREY', 900)).toBeUndefined();
    expect(nextSignalAt({ circleIndicator: 'GREEN' }, 'GREEN', 900)).toBe(900);
  });
});
