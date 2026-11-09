import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { OptionChainScreen, formatOi, UNDERLYING_PRESETS } from '../screens/OptionChainScreen';
import { dhanDirectService } from '../services/dhanDirectService';
import { mergeLiveHigh } from '../utils/indexDayStats';
import { DhanOptionChainService, OptionChainResult, OptionStrikeData } from '../services/dhan/DhanOptionChainService';

jest.setTimeout(25000);

let activeTrees: renderer.ReactTestRenderer[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  activeTrees = [];
});

afterEach(() => {
  activeTrees.forEach((t) => {
    try {
      t.unmount();
    } catch {}
  });
  activeTrees = [];
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('Option Chain: formatOi Indian Notation', () => {
  test('handles null, undefined, 0, or negative OI gracefully', () => {
    expect(formatOi(undefined)).toBe('—');
    expect(formatOi(null)).toBe('—');
    expect(formatOi(0)).toBe('—');
    expect(formatOi(-100)).toBe('—');
  });

  test('formats numbers into k, Lakhs (L), and Crores (Cr)', () => {
    expect(formatOi(500)).toBe('500');
    expect(formatOi(45000)).toBe('45k');
    expect(formatOi(1250000)).toBe('12.5L');
    expect(formatOi(15000000)).toBe('1.50Cr');
  });
});

describe('Option Chain: 13-Strike Range and Moneyness', () => {
  function generateMockStrikes(atmStrike: number, step: number, countEachSide: number): OptionStrikeData[] {
    const list: OptionStrikeData[] = [];
    for (let i = -countEachSide; i <= countEachSide; i++) {
      const strikePrice = atmStrike + i * step;
      list.push({
        strikePrice,
        moneyness: i === 0 ? 'ATM' : i < 0 ? 'ITM' : 'OTM',
        ce: {
          ltp: Math.max(1, 200 - i * 15),
          oi: 50000 + i * 1000,
          volume: 10000,
          iv: 14.5,
          bid: null,
          ask: null,
        },
        pe: {
          ltp: Math.max(1, 200 + i * 15),
          oi: 60000 - i * 1000,
          volume: 8000,
          iv: 15.2,
          bid: null,
          ask: null,
        },
      });
    }
    return list;
  }

  test('default strike slicing selects exactly 13 strikes (6 ITM + 1 ATM + 6 OTM)', async () => {
    const mockStrikes = generateMockStrikes(25000, 50, 15); // 31 strikes total
    const mockChain: OptionChainResult = {
      underlyingScrip: 13,
      underlyingSeg: 'IDX_I',
      spotPrice: 25010,
      atmStrike: 25000,
      strikes: mockStrikes,
      pcr: 1.15,
      totalCallOi: 1000000,
      totalPutOi: 1150000,
      expiry: '2026-10-22',
      expiryList: ['2026-10-22', '2026-10-29'],
    };

    jest.spyOn(DhanOptionChainService.prototype, 'getOptionChain').mockResolvedValue(mockChain);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);

    // Let the effect resolve
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const flatList = tree.root.findByType(require('react-native').FlatList);
    const displayedData = flatList.props.data as OptionStrikeData[];

    // Expect exactly 13 strikes: 6 below ATM, 1 ATM, 6 above ATM
    expect(displayedData.length).toBe(13);

    // 6 strikes below ATM
    const belowAtm = displayedData.filter((s) => s.strikePrice < 25000);
    expect(belowAtm.length).toBe(6);
    expect(belowAtm.map((s) => s.strikePrice)).toEqual([
      24700, 24750, 24800, 24850, 24900, 24950,
    ]);

    // 1 ATM strike
    const atm = displayedData.filter((s) => s.strikePrice === 25000);
    expect(atm.length).toBe(1);
    expect(atm[0].strikePrice).toBe(25000);

    // 6 strikes above ATM
    const aboveAtm = displayedData.filter((s) => s.strikePrice > 25000);
    expect(aboveAtm.length).toBe(6);
    expect(aboveAtm.map((s) => s.strikePrice)).toEqual([
      25050, 25100, 25150, 25200, 25250, 25300,
    ]);
  });

  test('FlatList uses getItemLayout with 54px row height for smooth 60fps rendering', async () => {
    const mockStrikes = generateMockStrikes(25000, 50, 10);
    const mockChain: OptionChainResult = {
      underlyingScrip: 13,
      underlyingSeg: 'IDX_I',
      spotPrice: 25000,
      atmStrike: 25000,
      strikes: mockStrikes,
      pcr: 1.0,
      totalCallOi: 500000,
      totalPutOi: 500000,
      expiry: '2026-10-22',
      expiryList: ['2026-10-22'],
    };

    jest.spyOn(DhanOptionChainService.prototype, 'getOptionChain').mockResolvedValue(mockChain);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const flatList = tree.root.findByType(require('react-native').FlatList);
    const layout = flatList.props.getItemLayout(null, 5);
    expect(layout).toEqual({
      length: 54,
      offset: 54 * 5,
      index: 5,
    });
  });

  test('renders strike range toggle showing ±6 (13) by default', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);

    const texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });

    expect(texts.some((txt) => txt.includes('±6 (13)'))).toBe(true);
    expect(texts.some((txt) => txt.includes('STRIKE'))).toBe(true);
  });

  test('switches spot price correctly when changing tab from NIFTY to BANKNIFTY and SENSEX', async () => {
    const niftyStrikes = generateMockStrikes(25000, 50, 5);
    const bankNiftyStrikes = generateMockStrikes(51200, 100, 5);
    const sensexStrikes = generateMockStrikes(81400, 100, 5);

    const getOptionChainSpy = jest.spyOn(DhanOptionChainService.prototype, 'getOptionChain').mockImplementation(
      async (scripId: number) => {
        if (scripId === 25) {
          return {
            underlyingScrip: 25,
            underlyingSeg: 'IDX_I',
            spotPrice: 51250,
            atmStrike: 51200,
            strikes: bankNiftyStrikes,
            pcr: 0.95,
            totalCallOi: 400000,
            totalPutOi: 380000,
            expiry: '2026-10-22',
            expiryList: ['2026-10-22'],
          };
        }
        if (scripId === 51) {
          return {
            underlyingScrip: 51,
            underlyingSeg: 'IDX_I',
            spotPrice: 81400,
            atmStrike: 81400,
            strikes: sensexStrikes,
            pcr: 1.05,
            totalCallOi: 300000,
            totalPutOi: 315000,
            expiry: '2026-10-23',
            expiryList: ['2026-10-23'],
          };
        }
        return {
          underlyingScrip: 13,
          underlyingSeg: 'IDX_I',
          spotPrice: 25010,
          atmStrike: 25000,
          strikes: niftyStrikes,
          pcr: 1.15,
          totalCallOi: 1000000,
          totalPutOi: 1150000,
          expiry: '2026-10-22',
          expiryList: ['2026-10-22'],
        };
      }
    );

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    // 1. Initial NIFTY check
    let texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    expect(texts.some((txt) => txt.includes('25,010'))).toBe(true);

    // 2. Tap BANKNIFTY chip
    const touchables = tree.root.findAllByType(require('react-native').TouchableOpacity);
    const bankNiftyChip = touchables.find((op) => {
      const childTexts = op.findAllByType(require('react-native').Text).map((t) => t.props.children);
      return childTexts.includes('BANKNIFTY');
    });
    expect(bankNiftyChip).toBeDefined();

    await act(async () => {
      bankNiftyChip?.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    // 3. Verify BANKNIFTY spot price is shown and NIFTY spot is NOT shown
    texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    expect(texts.some((txt) => txt.includes('51,250'))).toBe(true);
    expect(texts.some((txt) => txt.includes('25,010'))).toBe(false);

    // 4. Tap SENSEX chip
    const sensexChip = touchables.find((op) => {
      const childTexts = op.findAllByType(require('react-native').Text).map((t) => t.props.children);
      return childTexts.includes('SENSEX');
    });
    expect(sensexChip).toBeDefined();

    await act(async () => {
      sensexChip?.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    // 5. Verify SENSEX spot price is shown and NIFTY / BANKNIFTY spots are NOT shown
    texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    expect(texts.some((txt) => txt.includes('81,400'))).toBe(true);
    expect(texts.some((txt) => txt.includes('25,010'))).toBe(false);
    expect(texts.some((txt) => txt.includes('51,250'))).toBe(false);

    getOptionChainSpy.mockRestore();
  });
});

describe('Option Chain: index day stats strip', () => {
  const textsOf = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });

  test('shows previous close, open and high of the selected index and refetches when the index changes', async () => {
    jest.spyOn(DhanOptionChainService.prototype, 'getOptionChain').mockResolvedValue(null as any);
    const stats = jest.spyOn(dhanDirectService, 'fetchIndexDayStats').mockImplementation(async (scripId) =>
      Number(scripId) === 25
        ? { prevClose: 51000, open: 51100, high: 51400 }
        : { prevClose: 24900, open: 24950, high: 25080 }
    );

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);
    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(stats).toHaveBeenCalledWith(13, 'IDX_I');
    let texts = textsOf(tree);
    expect(texts).toEqual(expect.arrayContaining(['PREV CLOSE', 'OPEN', 'HIGH']));
    expect(texts.some((t) => t.includes('24,900'))).toBe(true);
    expect(texts.some((t) => t.includes('24,950'))).toBe(true);
    expect(texts.some((t) => t.includes('25,080'))).toBe(true);

    const chip = tree.root
      .findAllByType(require('react-native').TouchableOpacity)
      .find((op) => op.findAllByType(require('react-native').Text).some((t) => t.props.children === 'BANKNIFTY'));
    await act(async () => {
      chip?.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(stats).toHaveBeenCalledWith(25, 'IDX_I');
    texts = textsOf(tree);
    expect(texts.some((t) => t.includes('51,400'))).toBe(true);
    expect(texts.some((t) => t.includes('25,080'))).toBe(false);
  });

  test('shows dashes when the snapshot has no values', async () => {
    jest.spyOn(DhanOptionChainService.prototype, 'getOptionChain').mockResolvedValue(null as any);
    jest.spyOn(dhanDirectService, 'fetchIndexDayStats').mockResolvedValue(null);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);
    const strip = tree.root.findByProps({ testID: 'index-day-stats' });
    const values = strip.findAllByType(require('react-native').Text).map((t) => String(t.props.children));
    expect(values.filter((v) => v.includes('—')).length).toBe(3);
  });

  test('mergeLiveHigh lifts the high only when the live spot exceeds it', () => {
    const stats = { prevClose: 100, open: 101, high: 105 };
    expect(mergeLiveHigh(stats, 104)).toBe(stats);
    expect(mergeLiveHigh(stats, 106)).toEqual({ prevClose: 100, open: 101, high: 106 });
    expect(mergeLiveHigh(stats, null)).toBe(stats);
    expect(mergeLiveHigh(null, 106)).toBeNull();
    expect(mergeLiveHigh({ ...stats, high: 0 }, 106)?.high).toBe(0);
  });
});
