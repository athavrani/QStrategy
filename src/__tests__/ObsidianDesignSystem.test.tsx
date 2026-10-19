import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { theme, colors, typography, spacing, borderRadius } from '../theme';
import {
  FinancialValue,
  formatIndianNumber,
  formatCompactIndian,
} from '../components/common/FinancialValue';
import { StatusBadge } from '../components/common/StatusBadge';
import { SkeletonLoader } from '../components/common/SkeletonLoader';

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

describe('Phase 9: Obsidian Design System Tokens', () => {
  test('theme has all primary colors and semantic glow tokens', () => {
    expect(colors.obsidian).toBe('#080A0F');
    expect(colors.surface).toBe('#0F131D');
    expect(colors.bullish).toBe('#10B981');
    expect(colors.bearish).toBe('#EF4444');
    expect(colors.warning).toBe('#F59E0B');
    expect(colors.cyan).toBe('#06B6D4');
    expect(colors.purple).toBe('#8B5CF6');
    expect(colors.bullishGlow).toContain('16, 185, 129');
    expect(colors.textPrimary).toBe('#F9FAFB');
  });

  test('typography has mono font, standard sizes, and weights', () => {
    expect(typography.fontMono).toBeDefined();
    expect(typography.sizes.micro).toBe(10);
    expect(typography.sizes.sm).toBe(12);
    expect(typography.sizes.md).toBe(14);
    expect(typography.sizes.lg).toBe(16);
    expect(typography.sizes.xl).toBe(20);
    expect(typography.sizes.hero).toBe(26);
    expect(typography.weights.bold).toBe('700');
  });

  test('spacing and borderRadius scale monotonically', () => {
    expect(spacing.xs).toBeLessThan(spacing.sm);
    expect(spacing.sm).toBeLessThan(spacing.md);
    expect(spacing.md).toBeLessThan(spacing.lg);
    expect(spacing.lg).toBeLessThan(spacing.xl);

    expect(borderRadius.xs).toBeLessThan(borderRadius.sm);
    expect(borderRadius.sm).toBeLessThan(borderRadius.md);
    expect(borderRadius.md).toBeLessThan(borderRadius.lg);
    expect(borderRadius.full).toBe(9999);
  });
});

describe('Phase 9: formatIndianNumber & formatCompactIndian Math', () => {
  test('formats numbers according to Indian numbering system (Lakhs & Crores)', () => {
    expect(formatIndianNumber(100, 2)).toBe('100.00');
    expect(formatIndianNumber(1000, 2)).toBe('1,000.00');
    expect(formatIndianNumber(100000, 2)).toBe('1,00,000.00');
    expect(formatIndianNumber(1234567.89, 2)).toBe('12,34,567.89');
    expect(formatIndianNumber(10000000, 2)).toBe('1,00,00,000.00');
    expect(formatIndianNumber(24850.5, 2)).toBe('24,850.50');
  });

  test('handles negative numbers and zero with precision', () => {
    expect(formatIndianNumber(-500.5, 2)).toBe('-500.50');
    expect(formatIndianNumber(-1234567.89, 2)).toBe('-12,34,567.89');
    expect(formatIndianNumber(0, 2)).toBe('0.00');
    expect(formatIndianNumber(1234.5678, 4)).toBe('1,234.5678');
  });

  test('formats compact Indian units (Cr, L, k)', () => {
    expect(formatCompactIndian(15000000, 2)).toBe('1.50 Cr');
    expect(formatCompactIndian(250000, 2)).toBe('2.50 L');
    expect(formatCompactIndian(5000, 2)).toBe('5.00 k');
    expect(formatCompactIndian(450, 2)).toBe('450.00');
    expect(formatCompactIndian(-35000000, 2)).toBe('-3.50 Cr');
    expect(formatCompactIndian(-750000, 1)).toBe('-7.5 L');
  });
});

describe('Phase 9: FinancialValue Component Render', () => {
  test('renders positive currency with bullish emerald color', () => {
    const tree = createTestRenderer(<FinancialValue value={24850.5} format="currency" testID="nifty-val" />);
    const json = tree.toJSON();
    expect(json).toBeDefined();
    // @ts-ignore
    expect(json.children).toContain('₹24,850.50');
    // @ts-ignore
    const flatStyle = json.props.style.flat ? json.props.style.flat(Infinity) : json.props.style;
    const styleObj = Array.isArray(flatStyle) ? Object.assign({}, ...flatStyle) : flatStyle;
    expect(styleObj.color).toBe(theme.colors.bullish);
  });

  test('renders negative currency with bearish crimson color and leading minus', () => {
    const tree = createTestRenderer(<FinancialValue value={-1250.75} format="currency" testID="loss-val" />);
    const json = tree.toJSON();
    // @ts-ignore
    expect(json.children).toContain('-₹1,250.75');
    // @ts-ignore
    const flatStyle = json.props.style.flat ? json.props.style.flat(Infinity) : json.props.style;
    const styleObj = Array.isArray(flatStyle) ? Object.assign({}, ...flatStyle) : flatStyle;
    expect(styleObj.color).toBe(theme.colors.bearish);
  });

  test('renders percent format with explicit sign', () => {
    const tree = createTestRenderer(<FinancialValue value={3.14} format="percent" />);
    const json = tree.toJSON();
    // @ts-ignore
    expect(json.children).toContain('+3.14%');

    const negTree = createTestRenderer(<FinancialValue value={-1.5} format="percent" />);
    const negJson = negTree.toJSON();
    // @ts-ignore
    expect(negJson.children).toContain('-1.50%');
  });

  test('renders points format with pts suffix', () => {
    const tree = createTestRenderer(<FinancialValue value={45.2} format="points" />);
    const json = tree.toJSON();
    // @ts-ignore
    expect(json.children).toContain('+45.20 pts');
  });

  test('renders compact format', () => {
    const tree = createTestRenderer(<FinancialValue value={25000000} format="compact" prefix="₹" />);
    const json = tree.toJSON();
    // @ts-ignore
    expect(json.children).toContain('₹2.50 Cr');
  });

  test('enforces strict nullability: renders fallback em-dash for null, undefined, or NaN', () => {
    const treeNull = createTestRenderer(<FinancialValue value={null} />);
    // @ts-ignore
    expect(treeNull.toJSON().children).toContain('—');

    const treeUndef = createTestRenderer(<FinancialValue value={undefined} fallback="N/A" />);
    // @ts-ignore
    expect(treeUndef.toJSON().children).toContain('N/A');

    const treeNaN = createTestRenderer(<FinancialValue value={NaN} />);
    // @ts-ignore
    expect(treeNaN.toJSON().children).toContain('—');
  });
});

describe('Phase 9: StatusBadge Component Render', () => {
  test('renders bullish badge with label and theme styling', () => {
    const tree = createTestRenderer(<StatusBadge label="BUY CONFIRMED" variant="bullish" testID="badge" />);
    const root = tree.root;
    expect(root.findByProps({ testID: 'badge' })).toBeDefined();
    // @ts-ignore
    expect(tree.toJSON().children.some((c: any) => c.children?.includes('BUY CONFIRMED'))).toBe(true);
  });

  test('renders warning badge with live indicator dot', () => {
    const tree = createTestRenderer(
      <StatusBadge label="NEAR 80% CROSS" variant="warning" showDot={true} testID="badge-warn" />
    );
    const root = tree.root;
    expect(root.findByProps({ testID: 'badge-warn-dot' })).toBeDefined();
  });

  test('renders purple overnight badge with icon', () => {
    const tree = createTestRenderer(
      <StatusBadge label="OVERNIGHT HOLD" variant="purple" icon="🌙" testID="badge-night" />
    );
    const root = tree.root;
    expect(root.findByProps({ testID: 'badge-night' })).toBeDefined();
  });

  test('supports all standard size presets', () => {
    ['sm', 'md', 'lg'].forEach((size) => {
      createTestRenderer(<StatusBadge label="TEST" size={size as any} />);
    });
  });
});

describe('Phase 9: SkeletonLoader Component Render', () => {
  test('renders single line skeleton with correct dimensions and progressbar role', () => {
    const tree = createTestRenderer(
      <SkeletonLoader width={200} height={24} testID="skel-single" />
    );
    const json = tree.toJSON();
    expect(json).toBeDefined();
    // @ts-ignore
    expect(json.props.accessibilityRole).toBe('progressbar');
  });

  test('renders multi-line skeleton with lines parameter', () => {
    const tree = createTestRenderer(
      <SkeletonLoader lines={3} height={16} spacing={8} testID="skel-multi" />
    );
    const root = tree.root;
    expect(root.findByProps({ testID: 'skel-multi-line-0' })).toBeDefined();
    expect(root.findByProps({ testID: 'skel-multi-line-1' })).toBeDefined();
    expect(root.findByProps({ testID: 'skel-multi-line-2' })).toBeDefined();
  });
});
