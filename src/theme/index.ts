// Centralized Obsidian & Slate Design System for QStrategy Terminal
import { colors, darkColors, lightColors, ThemeColors } from './colors';
import { typography, spacing, borderRadius, Typography, Spacing, BorderRadius } from './tokens';

export const theme = {
  colors: darkColors,
  typography,
  spacing,
  borderRadius,
  isDark: true,
} as const;

export { colors, darkColors, lightColors };
export { typography, spacing, borderRadius };
export type { ThemeColors };
export type Theme = typeof theme;
export type { Typography, Spacing, BorderRadius };

// Dynamic Light/Dark Theme System Exports
export {
  useTheme,
  useThemeStore,
  createThemedStyles,
  darkTheme,
  lightTheme,
} from './useTheme';
export type { AppTheme, ThemeMode } from './useTheme';
