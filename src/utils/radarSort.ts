import { StockRadarItem } from '../types/mobile';

export type RadarSort = 'NEWEST' | 'OLDEST' | 'RATIO' | 'CHANGE' | 'NAME';

export const DEFAULT_RADAR_SORT: RadarSort = 'NEWEST';

/**
 * Orders radar rows. NEWEST is LIFO: the stock that most recently entered its current Buy/Sell/Near state is first.
 * Rows without a signal time (plain scanning stocks) follow the dated ones in their original order, and every
 * comparison falls back to the original order so the list never reshuffles between ticks.
 */
export function sortRadarStocks(stocks: readonly StockRadarItem[], sort: RadarSort): StockRadarItem[] {
  const indexed = stocks.map((stock, index) => ({ stock, index }));
  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;

  const compare = (a: { stock: StockRadarItem; index: number }, b: { stock: StockRadarItem; index: number }): number => {
    switch (sort) {
      case 'NEWEST':
      case 'OLDEST': {
        const ta = a.stock.signalAt;
        const tb = b.stock.signalAt;
        if (ta === undefined && tb === undefined) return byIndex(a, b);
        if (ta === undefined) return 1;
        if (tb === undefined) return -1;
        if (ta === tb) return byIndex(a, b);
        return sort === 'NEWEST' ? tb - ta : ta - tb;
      }
      case 'RATIO':
        return b.stock.volumeRatio - a.stock.volumeRatio || byIndex(a, b);
      case 'CHANGE':
        return b.stock.percentChange - a.stock.percentChange || byIndex(a, b);
      case 'NAME':
        return a.stock.ticker.localeCompare(b.stock.ticker) || byIndex(a, b);
    }
  };

  return indexed.sort(compare).map((entry) => entry.stock);
}

/**
 * The time a stock entered its current indicator state. It is kept while the state is unchanged,
 * restarted when the state changes, and cleared when the stock drops back to scanning.
 */
export function nextSignalAt(
  previous: Pick<StockRadarItem, 'circleIndicator' | 'signalAt'> | undefined,
  circleIndicator: StockRadarItem['circleIndicator'],
  now: number = Date.now()
): number | undefined {
  if (circleIndicator === 'GREY') return undefined;
  if (previous && previous.circleIndicator === circleIndicator && previous.signalAt !== undefined) {
    return previous.signalAt;
  }
  return now;
}
