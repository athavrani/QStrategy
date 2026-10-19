// Financial Value Component with Dhan-Grade Colorization & Indian Numbering
import React from 'react';
import { Text, StyleSheet, TextStyle, StyleProp } from 'react-native';
import { theme as defaultTheme, useTheme } from '../../theme';

export type FinancialFormat = 'currency' | 'percent' | 'points' | 'compact' | 'raw';
export type FinancialSize = keyof typeof defaultTheme.typography.sizes;

export interface FinancialValueProps {
  /** Numeric value to format and display. If null/undefined, renders fallback */
  value: number | null | undefined;
  /** Presentation format: currency (₹), percent (%), points (pts), compact (L/Cr), raw */
  format?: FinancialFormat;
  /** Explicitly show sign prefix (+ / -). Defaults to true for percent/points, false for currency/raw */
  showSign?: boolean;
  /** Automatically colorize: green for positive, red for negative. Defaults to true */
  colorize?: boolean;
  /** Decimal places to render. Defaults to 2 */
  precision?: number;
  /** Preset font size token */
  size?: FinancialSize;
  /** Use monospace tabular numbers font for flicker-free alignment */
  mono?: boolean;
  /** Font weight */
  weight?: keyof typeof defaultTheme.typography.weights;
  /** Fallback string when value is null/undefined or NaN */
  fallback?: string;
  /** Optional custom prefix (placed before sign or value) */
  prefix?: string;
  /** Optional custom suffix */
  suffix?: string;
  /** Custom text style override */
  style?: StyleProp<TextStyle>;
  /** Test identifier */
  testID?: string;
}

/**
 * Formats a number with standard Indian number system grouping (Lakhs & Crores)
 * e.g. 1234567.89 -> 12,34,567.89
 */
export function formatIndianNumber(val: number, precision: number = 2): string {
  const isNegative = val < 0;
  const absVal = Math.abs(val);
  const fixedStr = absVal.toFixed(precision);
  const [intPart, decPart] = fixedStr.split('.');

  if (intPart.length <= 3) {
    const formatted = decPart !== undefined ? `${intPart}.${decPart}` : intPart;
    return isNegative ? `-${formatted}` : formatted;
  }

  const lastThree = intPart.slice(-3);
  const otherNumbers = intPart.slice(0, -3);
  const withCommas = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const formatted = `${withCommas},${lastThree}${decPart !== undefined ? `.${decPart}` : ''}`;
  return isNegative ? `-${formatted}` : formatted;
}

/**
 * Formats large Indian numbers compactly (e.g. 1.25 Cr, 45.50 L)
 */
export function formatCompactIndian(val: number, precision: number = 2): string {
  const isNegative = val < 0;
  const absVal = Math.abs(val);

  let formatted = '';
  if (absVal >= 10000000) {
    // 1 Crore = 10^7
    formatted = `${(absVal / 10000000).toFixed(precision)} Cr`;
  } else if (absVal >= 100000) {
    // 1 Lakh = 10^5
    formatted = `${(absVal / 100000).toFixed(precision)} L`;
  } else if (absVal >= 1000) {
    formatted = `${(absVal / 1000).toFixed(precision)} k`;
  } else {
    formatted = absVal.toFixed(precision);
  }

  return isNegative ? `-${formatted}` : formatted;
}

export function FinancialValue({
  value,
  format = 'currency',
  showSign,
  colorize = true,
  precision = 2,
  size = 'md',
  mono = true,
  weight = 'semibold',
  fallback = '—',
  prefix,
  suffix,
  style,
  testID,
}: FinancialValueProps): React.JSX.Element {
  const { theme } = useTheme();
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <Text
        testID={testID}
        accessibilityRole="text"
        accessibilityLabel="No value available"
        style={[
          styles.base,
          {
            color: theme.colors.textMuted,
            fontSize: theme.typography.sizes[size],
            fontFamily: mono ? theme.typography.fontMono : undefined,
            fontWeight: theme.typography.weights[weight],
          },
          style,
        ]}
      >
        {fallback}
      </Text>
    );
  }

  const isPositive = value > 0;
  const isNegative = value < 0;
  const isZero = value === 0;

  // Determine sign requirement
  const shouldShowSign = showSign ?? (format === 'percent' || format === 'points');
  const signPrefix = shouldShowSign && isPositive ? '+' : '';

  // Determine color
  let textColor: string = theme.colors.textPrimary;
  if (colorize) {
    if (isPositive) textColor = theme.colors.bullish;
    else if (isNegative) textColor = theme.colors.bearish;
    else textColor = theme.colors.textSecondary;
  }

  // Format string
  let formattedText = '';
  switch (format) {
    case 'currency': {
      const formattedAbs = formatIndianNumber(Math.abs(value), precision);
      if (isNegative) {
        formattedText = `-₹${formattedAbs}`;
      } else {
        formattedText = `${signPrefix}₹${formattedAbs}`;
      }
      break;
    }
    case 'percent': {
      const formattedAbs = Math.abs(value).toFixed(precision);
      formattedText = `${isNegative ? '-' : signPrefix}${formattedAbs}%`;
      break;
    }
    case 'points': {
      const formattedAbs = formatIndianNumber(Math.abs(value), precision);
      formattedText = `${isNegative ? '-' : signPrefix}${formattedAbs} pts`;
      break;
    }
    case 'compact': {
      const compactStr = formatCompactIndian(Math.abs(value), precision);
      formattedText = `${isNegative ? '-' : signPrefix}${compactStr}`;
      break;
    }
    case 'raw':
    default: {
      const formattedAbs = formatIndianNumber(Math.abs(value), precision);
      formattedText = `${isNegative ? '-' : signPrefix}${formattedAbs}`;
      break;
    }
  }

  const displayText = `${prefix ?? ''}${formattedText}${suffix ?? ''}`;

  return (
    <Text
      testID={testID}
      accessibilityRole="text"
      accessibilityLabel={displayText}
      style={[
        styles.base,
        {
          color: textColor,
          fontSize: theme.typography.sizes[size],
          fontFamily: mono ? theme.typography.fontMono : undefined,
          fontWeight: theme.typography.weights[weight],
        },
        style,
      ]}
    >
      {displayText}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
});
