import { Platform } from 'react-native';

export const typography = {
  fontMono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  sizes: {
    micro: 10,
    xs: 11,
    sm: 12,
    md: 14,
    lg: 16,
    xl: 20,
    hero: 26,
  },
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    extrabold: '800' as const,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const borderRadius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export type Typography = typeof typography;
export type Spacing = typeof spacing;
export type BorderRadius = typeof borderRadius;
