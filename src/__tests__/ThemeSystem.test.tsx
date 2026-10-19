import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useThemeStore,
  useTheme,
  createThemedStyles,
  darkColors,
  lightColors,
  darkTheme,
  lightTheme,
} from '../theme';
import { HeaderBar } from '../components/common/HeaderBar';

describe('Theme System: Dynamic Light and Dark Modes', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    act(() => {
      useThemeStore.getState().setMode('dark');
    });
  });

  test('default darkColors and lightColors meet institutional contrast standards', () => {
    // Dark mode obsidian contrast
    expect(darkColors.obsidian).toBe('#080A0F');
    expect(darkColors.surface).toBe('#0F131D');
    expect(darkColors.textPrimary).toBe('#F9FAFB');
    expect(darkColors.bullish).toBe('#10B981');
    expect(darkColors.bearish).toBe('#EF4444');

    // Light mode slate contrast
    expect(lightColors.obsidian).toBe('#F8FAFC');
    expect(lightColors.surface).toBe('#FFFFFF');
    expect(lightColors.textPrimary).toBe('#0F172A');
    expect(lightColors.bullish).toBe('#059669');
    expect(lightColors.bearish).toBe('#DC2626');
  });

  test('useThemeStore switches mode between dark and light', () => {
    const store = useThemeStore.getState();
    expect(store.mode).toBe('dark');
    expect(store.effectiveMode).toBe('dark');

    act(() => {
      store.setMode('light');
    });

    const updated = useThemeStore.getState();
    expect(updated.mode).toBe('light');
    expect(updated.effectiveMode).toBe('light');
    expect(updated.colors.obsidian).toBe(lightColors.obsidian);
    expect(updated.colors.textPrimary).toBe(lightColors.textPrimary);
  });

  test('toggleTheme alternates between dark and light', () => {
    act(() => {
      useThemeStore.getState().setMode('dark');
    });
    expect(useThemeStore.getState().effectiveMode).toBe('dark');

    act(() => {
      useThemeStore.getState().toggleTheme();
    });
    expect(useThemeStore.getState().effectiveMode).toBe('light');

    act(() => {
      useThemeStore.getState().toggleTheme();
    });
    expect(useThemeStore.getState().effectiveMode).toBe('dark');
  });

  test('persists theme selection in AsyncStorage', async () => {
    await act(async () => {
      useThemeStore.getState().setMode('light');
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@qstrategy_theme_mode', 'light');

    await act(async () => {
      useThemeStore.getState().setMode('dark');
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@qstrategy_theme_mode', 'dark');
  });

  test('initTheme restores persisted theme mode from AsyncStorage', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('light');

    await act(async () => {
      await useThemeStore.getState().initTheme();
    });

    expect(useThemeStore.getState().mode).toBe('light');
    expect(useThemeStore.getState().effectiveMode).toBe('light');
  });

  test('createThemedStyles returns styles adapted to current theme and updates dynamically', async () => {
    const useThemedBox = createThemedStyles((colors) => ({
      box: {
        backgroundColor: colors.surface,
        borderColor: colors.cardBorder,
      },
    }));

    function TestComponent() {
      const styles = useThemedBox();
      return <>{styles.box.backgroundColor}</>;
    }

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      await useThemeStore.getState().setMode('dark');
      tree = renderer.create(<TestComponent />);
    });
    expect(tree.toJSON()).toBe(darkColors.surface);

    await act(async () => {
      await useThemeStore.getState().setMode('light');
    });

    expect(tree.toJSON()).toBe(lightColors.surface);
  });

  test('HeaderBar displays 🌙 in dark mode and ☀️ in light mode, and toggles theme on press', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      await useThemeStore.getState().setMode('dark');
      tree = renderer.create(<HeaderBar />);
    });

    // In dark mode, toggle button shows 🌙
    const buttons = tree.root.findAllByType(require('react-native').TouchableOpacity);
    const themeBtn = buttons.find((btn) => {
      const textNodes = btn.findAllByType(require('react-native').Text);
      return textNodes.some((t) => t.props.children === '☀️' || t.props.children === '🌙');
    });
    expect(themeBtn).toBeDefined();

    const iconText = themeBtn!.findByType(require('react-native').Text);
    expect(iconText.props.children).toBe('🌙');

    // Press the toggle button
    await act(async () => {
      themeBtn!.props.onPress();
    });

    // Effective mode is now light, toggle button should show ☀️
    expect(useThemeStore.getState().effectiveMode).toBe('light');
    expect(iconText.props.children).toBe('☀️');
  });
});
