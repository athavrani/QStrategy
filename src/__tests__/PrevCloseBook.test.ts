import { PrevCloseBook } from '../services/marketdata/PrevCloseBook';

function makeBook(day = { value: '2026-10-22' }) {
  const book = new PrevCloseBook(
    () => day.value,
    () => [['TCS', 2465]]
  );
  return { book, day };
}

describe('PrevCloseBook', () => {
  it('starts from the catalog seed', () => {
    const { book } = makeBook();
    expect(book.get('tcs')).toEqual({ value: 2465, source: 'CATALOG' });
  });

  it('lets a higher-ranked source replace a lower one and never the reverse', () => {
    const { book } = makeBook();
    expect(book.set('TCS', 2500, 'HISTORY', 2510)).toBe(true);
    expect(book.set('TCS', 2490, 'REST', 2510)).toBe(true);
    // A stale catalog or history value arriving later cannot pull the baseline back
    expect(book.set('TCS', 2465, 'HISTORY', 2510)).toBe(false);
    expect(book.set('TCS', 2400, 'CATALOG', 2510)).toBe(false);
    expect(book.get('TCS')).toEqual({ value: 2490, source: 'REST' });
  });

  it('keeps the first value among equal-ranked sources and logs the conflict', () => {
    const { book } = makeBook();
    book.set('TCS', 2490, 'REST', 2510);
    expect(book.set('TCS', 2480, 'REST', 2510)).toBe(false);
    expect(book.get('TCS')?.value).toBe(2490);
    expect(book.conflictCount()).toBe(1);
    expect(book.formatLog()).toContain('CONFLICT TCS 2480 REST (held 2490 REST)');
  });

  it('lets the exchange packet override everything, including a different earlier exchange value', () => {
    const { book } = makeBook();
    book.set('TCS', 2490, 'REST', 2510);
    expect(book.set('TCS', 2488.5, 'EXCHANGE', 2510)).toBe(true);
    expect(book.get('TCS')).toEqual({ value: 2488.5, source: 'EXCHANGE' });
    expect(book.set('TCS', 2486, 'EXCHANGE', 2510)).toBe(true);
    expect(book.get('TCS')?.value).toBe(2486);
  });

  it('rejects an implausible non-exchange value but trusts the exchange', () => {
    const { book } = makeBook();
    expect(book.set('TCS', 1000, 'REST', 2510)).toBe(false);
    expect(book.get('TCS')?.source).toBe('CATALOG');
    expect(book.formatLog()).toContain('REJECT TCS 1000 REST');
    expect(book.set('TCS', 1000, 'EXCHANGE', 2510)).toBe(true);
  });

  it('computes the percentage from the held value and falls back without one', () => {
    const { book } = makeBook();
    book.set('TCS', 2000, 'EXCHANGE', 2400);
    // +20% is inside any circuit band and an exchange value skips the 25% gate
    expect(book.percent('TCS', 2400, 0)).toBe(20);
    expect(book.percent('UNKNOWN', 100, 1.5)).toBe(1.5);
    expect(book.percent('TCS', 0, 3)).toBe(3);
  });

  it('applies the sanity gate to non-authoritative baselines', () => {
    const { book } = makeBook();
    expect(book.percent('TCS', 4000, 7)).toBe(7); // catalog baseline 2465 -> +62% is not credible
  });

  it('keeps the percentage stable across alternating packet types', () => {
    const { book } = makeBook();
    book.set('TCS', 2490, 'EXCHANGE', 2500);
    const readings = [
      (book.set('TCS', 2465, 'HISTORY', 2500), book.percent('TCS', 2500, 0)),
      (book.set('TCS', 2470, 'QUOTE', 2500), book.percent('TCS', 2500, 0)),
      book.percent('TCS', 2500, 0),
    ];
    expect(new Set(readings).size).toBe(1);
    expect(readings[0]).toBeCloseTo(0.4, 1);
  });

  it('resets on a new trading day', () => {
    const { book, day } = makeBook();
    book.set('TCS', 2490, 'EXCHANGE', 2500);
    day.value = '2026-10-23';
    expect(book.get('TCS')).toEqual({ value: 2465, source: 'CATALOG' });
  });
});
