import React from 'react';
import renderer, { act } from 'react-test-renderer';
import {
  normalCdf,
  normalPdf,
  blackScholesPrice,
  calculateImpliedVolatility,
  calculateGreeks,
} from '../services/quant/BlackScholes';
import { OptionChainScreen, UNDERLYING_PRESETS } from '../screens/OptionChainScreen';
import { JournalScreen } from '../screens/JournalScreen';
import { AppNavigator } from '../navigation/AppNavigator';
import { useRadarStore } from '../store/useRadarStore';

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
    } catch {
      // Ignore
    }
  });
  activeTrees = [];
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

function createTestRenderer(element: React.ReactElement): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(element);
  });
  activeTrees.push(tree);
  return tree;
}

describe('Phase 10: On-Device Black-Scholes Greeks Engine Math', () => {
  test('normalPdf and normalCdf conform to standard normal distribution properties', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
    expect(normalCdf(10)).toBe(1);
    expect(normalCdf(-10)).toBe(0);

    expect(normalPdf(0)).toBeCloseTo(0.3989, 3);
  });

  test('blackScholesPrice computes accurate call and put premiums', () => {
    const spot = 25000;
    const strike = 25000;
    const T = 7 / 365; // 7 days to expiry
    const r = 0.07;
    const sigma = 0.14; // 14% IV

    const callPrice = blackScholesPrice(spot, strike, T, r, sigma, true);
    const putPrice = blackScholesPrice(spot, strike, T, r, sigma, false);

    expect(callPrice).toBeGreaterThan(50);
    expect(callPrice).toBeLessThan(500);
    expect(putPrice).toBeGreaterThan(50);
    expect(putPrice).toBeLessThan(500);

    // Put-Call Parity: C - P = S - K * exp(-rT)
    const parityDiff = callPrice - putPrice - (spot - strike * Math.exp(-r * T));
    expect(Math.abs(parityDiff)).toBeLessThan(0.01);
  });

  test('calculateImpliedVolatility solves for volatility within tolerance', () => {
    const spot = 25000;
    const strike = 25000;
    const T = 14 / 365;
    const r = 0.07;
    const knownVol = 0.16; // 16%

    const marketPrice = blackScholesPrice(spot, strike, T, r, knownVol, true);
    const solvedIv = calculateImpliedVolatility(spot, strike, T, r, marketPrice, true);

    expect(solvedIv).toBeCloseTo(16.0, 1);
  });

  test('calculateGreeks yields institutional Greeks (Delta, Gamma, Theta, Vega, IV)', () => {
    const spot = 25000;
    const strike = 25000;
    const T = 7 / 365;
    const r = 0.07;
    const callPrice = 175;

    const greeksCall = calculateGreeks(spot, strike, T, r, callPrice, true);
    expect(greeksCall.iv).toBeGreaterThan(5);
    expect(greeksCall.iv).toBeLessThan(50);
    expect(greeksCall.delta).toBeGreaterThan(0.4);
    expect(greeksCall.delta).toBeLessThan(0.65);
    expect(greeksCall.gamma).toBeGreaterThan(0);
    expect(greeksCall.theta).toBeLessThan(0); // Time decay is negative
    expect(greeksCall.vega).toBeGreaterThan(0);

    const putPrice = 160;
    const greeksPut = calculateGreeks(spot, strike, T, r, putPrice, false);
    expect(greeksPut.delta).toBeLessThan(-0.35);
    expect(greeksPut.delta).toBeGreaterThan(-0.65);
    expect(greeksPut.gamma).toBeGreaterThan(0);
  });

  test('calculateGreeks handles zero/negative inputs safely with clean fallbacks', () => {
    const zeroGreeks = calculateGreeks(0, 0, 0, 0.07, 0, true);
    expect(zeroGreeks.iv).toBe(0);
    expect(zeroGreeks.delta).toBe(0);
    expect(zeroGreeks.gamma).toBe(0);
    expect(zeroGreeks.theta).toBe(0);
    expect(zeroGreeks.vega).toBe(0);
  });
});

describe('Phase 10: OptionChainScreen Component', () => {
  test('renders underlying presets: NIFTY, BANKNIFTY, FINNIFTY, SENSEX', async () => {
    expect(UNDERLYING_PRESETS.length).toBe(4);
    expect(UNDERLYING_PRESETS[0].symbol).toBe('NIFTY');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<OptionChainScreen />);
    });
    activeTrees.push(tree);

    const texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });

    expect(texts.some((txt) => txt.includes('NIFTY'))).toBe(true);
    expect(texts.some((txt) => txt.includes('BANKNIFTY'))).toBe(true);
    expect(texts.some((txt) => txt.includes('FINNIFTY'))).toBe(true);
    expect(texts.some((txt) => txt.includes('SENSEX'))).toBe(true);
    expect(texts.some((txt) => txt.includes('OI & LTP'))).toBe(true);
    expect(texts.some((txt) => txt.includes('Greeks'))).toBe(true);
  });
});

describe('Phase 10: JournalScreen Dynamic Real Win Rate', () => {
  test('renders zero fabrication indicator when no closed trades exist', () => {
    useRadarStore.setState({ journal: [] });
    const tree = createTestRenderer(<JournalScreen />);
    const texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    expect(texts.some((txt) => txt.includes('WIN RATE (REAL)'))).toBe(true);
    expect(texts.some((txt) => txt.includes('—'))).toBe(true);
  });

  test('dynamically calculates real win rate from completed trade records', () => {
    useRadarStore.setState({
      journal: [
        {
          id: 'trade-1',
          strategyId: '20D_CROSSOVER',
          strategyName: '20D_CROSSOVER',
          symbol: 'RELIANCE',
          signalType: 'BUY',
          entryPrice: 2850,
          timestamp: '09:25:00',
          outcome: 'WIN',
          pnlPoints: 25.5,
        },
        {
          id: 'trade-2',
          strategyId: 'NIFTY_OVERNIGHT',
          strategyName: 'NIFTY_OVERNIGHT',
          symbol: 'NIFTY24800CE',
          signalType: 'BUY',
          entryPrice: 62.5,
          timestamp: '09:20:00',
          outcome: 'LOSS',
          pnlPoints: -15.5,
        },
      ],
    });

    const tree = createTestRenderer(<JournalScreen />);
    const texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    // 1 win out of 2 completed trades = 50.00%
    expect(texts.some((txt) => txt.includes('50.00%'))).toBe(true);
  });
});

describe('Phase 10: AppNavigator 5-Tab Navigation', () => {
  test('renders all 5 core terminal tabs including Options', () => {
    const tree = createTestRenderer(<AppNavigator />);
    const texts = tree.root.findAllByType(require('react-native').Text).map((t) => {
      const c = t.props.children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
    expect(texts.some((txt) => txt.includes('Signals'))).toBe(true);
    expect(texts.some((txt) => txt.includes('Radar'))).toBe(true);
    expect(texts.some((txt) => txt.includes('Options'))).toBe(true);
    expect(texts.some((txt) => txt.includes('Journal'))).toBe(true);
    expect(texts.some((txt) => txt.includes('Settings'))).toBe(true);
  });
});
