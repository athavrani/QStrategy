import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FirstRunOnboarding,
  shouldShowOnboarding,
  ONBOARDING_DISMISSED_KEY,
} from '../components/common/FirstRunOnboarding';
import { secureVault } from '../services/SecureCredentialVault';

describe('shouldShowOnboarding', () => {
  test('shows only without credentials and without a prior dismissal', () => {
    expect(shouldShowOnboarding({ clientId: '', token: '' }, false)).toBe(true);
    expect(shouldShowOnboarding({ clientId: '1100345678', token: '' }, false)).toBe(true);
    expect(shouldShowOnboarding({ clientId: '1100345678', token: 'eyJ.a.b' }, false)).toBe(false);
    expect(shouldShowOnboarding({ clientId: '', token: '' }, true)).toBe(false);
  });
});

describe('FirstRunOnboarding', () => {
  const emptyCreds = { clientId: '', token: '', tabId: '1', isStreamerEnabled: true };

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  const mount = async (onOpenSettings = jest.fn()) => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<FirstRunOnboarding onOpenSettings={onOpenSettings} />);
    });
    return { tree, onOpenSettings };
  };
  const texts = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(Text).map((t) => String(t.props.children));
  const press = async (tree: renderer.ReactTestRenderer, index: number) => {
    await act(async () => {
      tree.root.findAllByType(TouchableOpacity)[index].props.onPress();
    });
  };

  test('prompts when no credentials are stored and opens Settings', async () => {
    jest.spyOn(secureVault, 'getEffectiveCredentials').mockResolvedValue(emptyCreds);
    const { tree, onOpenSettings } = await mount();

    expect(texts(tree)).toContain('Connect your Dhan account');
    await press(tree, 1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(tree.toJSON()).toBeNull();
    expect(await AsyncStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBeNull();
  });

  test('"Not now" hides the prompt and remembers the choice', async () => {
    jest.spyOn(secureVault, 'getEffectiveCredentials').mockResolvedValue(emptyCreds);
    const { tree } = await mount();

    await press(tree, 0);
    expect(tree.toJSON()).toBeNull();
    expect(await AsyncStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe('true');

    const second = await mount();
    expect(second.tree.toJSON()).toBeNull();
  });

  test('stays hidden when credentials already exist', async () => {
    jest.spyOn(secureVault, 'getEffectiveCredentials').mockResolvedValue({
      ...emptyCreds,
      clientId: '1100345678',
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLWZvci10ZXN0cw',
    });
    const { tree } = await mount();
    expect(tree.toJSON()).toBeNull();
  });
});
