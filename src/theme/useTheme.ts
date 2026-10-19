import { useMemo } from 'react';
import { StyleSheet, Appearance, ColorSchemeName } from 'react-native';
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { darkColors, lightColors, ThemeColors } from './colors';
import { typography, spacing, borderRadius } from './tokens';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppTheme {
  colors: ThemeColors;
  typography: typeof typography;
  spacing: typeof spacing;
  borderRadius: typeof borderRadius;
  isDark: boolean;
  mode: ThemeMode;
}

export const darkTheme: AppTheme = {
  colors: darkColors,
  typography,
  spacing,
  borderRadius,
  isDark: true,
  mode: 'dark',
};

export const lightTheme: AppTheme = {
  colors: lightColors,
  typography,
  spacing,
  borderRadius,
  isDark: false,
  mode: 'light',
};

const THEME_STORAGE_KEY = '@qstrategy_theme_mode';

function resolveEffectiveMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    const systemScheme = Appearance.getColorScheme();
    return systemScheme === 'light' ? 'light' : 'dark';
  }
  return mode;
}

interface ThemeState {
  mode: ThemeMode;
  effectiveMode: 'dark' | 'light';
  theme: AppTheme;
  colors: ThemeColors;
  isDark: boolean;
  isInitialized: boolean;
  setMode: (mode: ThemeMode) => Promise<void>;
  toggleTheme: () => Promise<void>;
  initTheme: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'dark',
  effectiveMode: 'dark',
  theme: darkTheme,
  colors: darkColors,
  isDark: true,
  isInitialized: false,

  setMode: async (mode: ThemeMode) => {
    try {
      Haptics.selectionAsync();
    } catch {}

    const effectiveMode = resolveEffectiveMode(mode);
    const isDark = effectiveMode === 'dark';
    const activeTheme = isDark ? darkTheme : lightTheme;

    set({
      mode,
      effectiveMode,
      theme: activeTheme,
      colors: activeTheme.colors,
      isDark,
    });

    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch (err) {
      // Ignore storage errors silently
    }
  },

  toggleTheme: async () => {
    const current = get().effectiveMode;
    const nextMode: ThemeMode = current === 'dark' ? 'light' : 'dark';
    await get().setMode(nextMode);
  },

  initTheme: async () => {
    if (get().isInitialized) return;

    try {
      const savedMode = (await AsyncStorage.getItem(THEME_STORAGE_KEY)) as ThemeMode | null;
      const initialMode: ThemeMode = savedMode || 'dark';
      const effectiveMode = resolveEffectiveMode(initialMode);
      const isDark = effectiveMode === 'dark';
      const activeTheme = isDark ? darkTheme : lightTheme;

      set({
        mode: initialMode,
        effectiveMode,
        theme: activeTheme,
        colors: activeTheme.colors,
        isDark,
        isInitialized: true,
      });

      // Listen for OS scheme updates if in system mode
      Appearance.addChangeListener(({ colorScheme }: { colorScheme: ColorSchemeName }) => {
        if (get().mode === 'system') {
          const sysEffective: 'dark' | 'light' = colorScheme === 'light' ? 'light' : 'dark';
          const sysIsDark = sysEffective === 'dark';
          const sysTheme = sysIsDark ? darkTheme : lightTheme;
          set({
            effectiveMode: sysEffective,
            theme: sysTheme,
            colors: sysTheme.colors,
            isDark: sysIsDark,
          });
        }
      });
    } catch (err) {
      set({ isInitialized: true });
    }
  },
}));

/**
 * Primary React hook to access current active theme, colors, and controls.
 */
export function useTheme() {
  const mode = useThemeStore((s) => s.mode);
  const effectiveMode = useThemeStore((s) => s.effectiveMode);
  const theme = useThemeStore((s) => s.theme);
  const colors = useThemeStore((s) => s.colors);
  const isDark = useThemeStore((s) => s.isDark);
  const setMode = useThemeStore((s) => s.setMode);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const initTheme = useThemeStore((s) => s.initTheme);

  return {
    mode,
    effectiveMode,
    theme,
    colors,
    isDark,
    setMode,
    toggleTheme,
    initTheme,
  };
}

/**
 * Type-safe helper to create dynamic themed StyleSheet hooks.
 * Automatically recalculates styles whenever theme colors change.
 */
export function createThemedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  creator: (colors: ThemeColors, theme: AppTheme) => T
): () => T {
  return function useThemedStyles(): T {
    const { colors, theme } = useTheme();
    return useMemo(() => creator(colors, theme), [colors, theme]);
  };
}
