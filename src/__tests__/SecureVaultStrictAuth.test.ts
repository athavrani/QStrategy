import * as LocalAuthentication from 'expo-local-authentication';
import { SecureCredentialVault } from '../services/SecureCredentialVault';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'x',
}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));

const la = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

describe('sandbox credentials', () => {
  const SecureStore = require('expo-secure-store');
  const store: Record<string, string> = {};

  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    SecureStore.getItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
    SecureStore.setItemAsync.mockImplementation(async (k: string, v: string) => {
      store[k] = v;
    });
    SecureStore.deleteItemAsync.mockImplementation(async (k: string) => {
      delete store[k];
    });
  });

  test('are stored apart from the live credentials and cleaned of whitespace', async () => {
    const vault = new SecureCredentialVault();
    await vault.saveSandboxCredentials(' 2000000001 ', 'abc def\nghi');
    expect(await vault.getSandboxCredentials()).toEqual({ clientId: '2000000001', token: 'abcdefghi' });
    expect(Object.keys(store).every((k) => k.includes('SANDBOX'))).toBe(true);

    // The live credential getter does not see them.
    expect((await vault.getCredentials()).token).toBe('');

    await vault.clearSandboxCredentials();
    expect(await vault.getSandboxCredentials()).toEqual({ clientId: '', token: '' });
  });
});

describe('authenticateStrict', () => {
  const vault = new SecureCredentialVault();

  test('refuses devices with no biometric hardware or enrolment, unlike the lenient check', async () => {
    la.hasHardwareAsync.mockResolvedValue(false);
    expect(await vault.authenticateStrict('x')).toBe(false);
    expect(await vault.authenticateWithBiometrics('x')).toBe(true);

    la.hasHardwareAsync.mockResolvedValue(true);
    la.isEnrolledAsync.mockResolvedValue(false);
    expect(await vault.authenticateStrict('x')).toBe(false);
  });

  test('passes only on a successful prompt and fails closed on errors', async () => {
    la.hasHardwareAsync.mockResolvedValue(true);
    la.isEnrolledAsync.mockResolvedValue(true);
    la.authenticateAsync.mockResolvedValue({ success: true } as any);
    expect(await vault.authenticateStrict('x')).toBe(true);

    la.authenticateAsync.mockResolvedValue({ success: false } as any);
    expect(await vault.authenticateStrict('x')).toBe(false);

    la.authenticateAsync.mockRejectedValue(new Error('boom'));
    expect(await vault.authenticateStrict('x')).toBe(false);
  });
});
