import { SecureCredentialVault } from '../services/SecureCredentialVault';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';

// Mock expo-secure-store
const storeMock: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => storeMock[key] || null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    storeMock[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete storeMock[key];
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

// Mock expo-local-authentication
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

// Helper to create a fake JWT with given exp epoch seconds
function makeFakeJwt(expEpochSec: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub: '1000000001', exp: expEpochSec }));
  const signature = 'fake_signature_hash_bytes';
  return `${header}.${payload}.${signature}`;
}

describe('SecureCredentialVault (Hardware Keystore)', () => {
  let vault: SecureCredentialVault;

  beforeEach(async () => {
    // Clear storage mock
    for (const key of Object.keys(storeMock)) {
      delete storeMock[key];
    }
    jest.clearAllMocks();
    vault = new SecureCredentialVault();
  });

  describe('Credential Storage & Retrieval', () => {
    it('saves credentials into hardware Keystore using secure options', async () => {
      await vault.saveCredentials('DHAN_12345', 'jwt.valid.token.sample.with.length', '2', true);

      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        'QSTRATEGY_SECURE_CLIENT_ID',
        'DHAN_12345',
        expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' })
      );
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        'QSTRATEGY_SECURE_ACCESS_TOKEN',
        'jwt.valid.token.sample.with.length',
        expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' })
      );
    });

    it('retrieves saved credentials accurately', async () => {
      storeMock['QSTRATEGY_SECURE_CLIENT_ID'] = 'CLIENT_999';
      storeMock['QSTRATEGY_SECURE_ACCESS_TOKEN'] = 'super_secret_access_token_12345';
      storeMock['QSTRATEGY_SECURE_TAB_ID'] = '1';
      storeMock['QSTRATEGY_SECURE_STREAMER_MODE'] = 'true';

      const creds = await vault.getCredentials();

      expect(creds.clientId).toBe('CLIENT_999');
      expect(creds.token).toBe('super_secret_access_token_12345');
      expect(creds.tabId).toBe('1');
      expect(creds.isStreamerEnabled).toBe(true);
    });

    it('clears credentials completely from Keystore and memory', async () => {
      await vault.saveCredentials('DHAN_123', 'jwt_token_sample_abc_1234567890');
      await vault.clearCredentials();

      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('QSTRATEGY_SECURE_CLIENT_ID');
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('QSTRATEGY_SECURE_ACCESS_TOKEN');

      const creds = await vault.getCredentials();
      expect(creds.clientId).toBe('');
      expect(creds.token).toBe('');
    });

    it('validates presence of credentials correctly', async () => {
      expect(await vault.hasValidCredentials()).toBe(false);

      await vault.saveCredentials('DHAN_CLIENT_1', 'long_enough_valid_token_string_here');
      expect(await vault.hasValidCredentials()).toBe(true);
    });
  });

  describe('JWT Expiry & Health Monitoring', () => {
    it('detects tokens expiring within 30 minutes', () => {
      const nowSec = Math.floor(Date.now() / 1000);

      // Token expiring in 10 minutes (<= 30 min) -> should be true
      const token10Min = makeFakeJwt(nowSec + 10 * 60);
      expect(vault.isTokenExpiringSoon(token10Min, 30)).toBe(true);

      // Token expiring in 120 minutes (> 30 min) -> should be false
      const token2Hours = makeFakeJwt(nowSec + 120 * 60);
      expect(vault.isTokenExpiringSoon(token2Hours, 30)).toBe(false);

      // Empty token -> should be true
      expect(vault.isTokenExpiringSoon('', 30)).toBe(true);
    });

    it('calculates remaining lifetime in seconds', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const tokenRemaining = makeFakeJwt(nowSec + 3600); // 1 hour

      const remaining = vault.getTokenRemainingSeconds(tokenRemaining);
      expect(remaining).toBeGreaterThanOrEqual(3595);
      expect(remaining).toBeLessThanOrEqual(3605);
    });
  });

  describe('Biometric Gate', () => {
    it('successfully authenticates with biometric prompt', async () => {
      const success = await vault.authenticateWithBiometrics('Test Prompt');
      expect(success).toBe(true);
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ promptMessage: 'Test Prompt' })
      );
    });

    it('handles biometric failure safely without revealing credentials', async () => {
      (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValueOnce({
        success: false,
        error: 'user_cancel',
      });

      const success = await vault.authenticateWithBiometrics('Test Prompt');
      expect(success).toBe(false);
    });
  });
});
