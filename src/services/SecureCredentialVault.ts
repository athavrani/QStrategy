/**
 * QStrategy — Secure Hardware Credential Vault
 * Backed exclusively by Android Keystore and Apple Keychain via expo-secure-store.
 * Zero plaintext AsyncStorage fallback.
 */

import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';

const VAULT_KEY_CLIENT_ID = 'QSTRATEGY_SECURE_CLIENT_ID';
const VAULT_KEY_ACCESS_TOKEN = 'QSTRATEGY_SECURE_ACCESS_TOKEN';
const VAULT_KEY_TAB_ID = 'QSTRATEGY_SECURE_TAB_ID';
const VAULT_KEY_STREAMER_MODE = 'QSTRATEGY_SECURE_STREAMER_MODE';

export interface DhanCredentials {
  clientId: string;
  token: string;
  tabId: string;
  isStreamerEnabled: boolean;
}

export interface StreamerTelemetry {
  status: 'STREAMING' | 'CONNECTING' | 'DISCONNECTED' | 'TOKEN_EXPIRED' | 'ERROR';
  lastTickTime: string | null;
  packetsReceived: number;
  latencyMs: number | null;
  lastError: string | null;
}

export class SecureCredentialVault {
  private inMemoryCache: DhanCredentials | null = null;
  private telemetry: StreamerTelemetry = {
    status: 'DISCONNECTED',
    lastTickTime: null,
    packetsReceived: 0,
    latencyMs: null,
    lastError: null,
  };

  /**
   * Retrieves credentials from hardware-encrypted storage.
   */
  public async getCredentials(): Promise<DhanCredentials> {
    if (this.inMemoryCache) {
      return { ...this.inMemoryCache };
    }

    try {
      const [clientId, token, tabId, streamerMode] = await Promise.all([
        SecureStore.getItemAsync(VAULT_KEY_CLIENT_ID),
        SecureStore.getItemAsync(VAULT_KEY_ACCESS_TOKEN),
        SecureStore.getItemAsync(VAULT_KEY_TAB_ID),
        SecureStore.getItemAsync(VAULT_KEY_STREAMER_MODE),
      ]);

      const creds: DhanCredentials = {
        clientId: (clientId || '').trim(),
        token: (token || '').trim(),
        tabId: (tabId || '1').trim(),
        isStreamerEnabled: streamerMode !== null ? streamerMode === 'true' : true,
      };

      this.inMemoryCache = creds;
      return { ...creds };
    } catch (err) {
      // Secure storage read failure — return empty, never leak or fallback to plaintext
      const empty: DhanCredentials = {
        clientId: '',
        token: '',
        tabId: '1',
        isStreamerEnabled: false,
      };
      this.inMemoryCache = empty;
      return empty;
    }
  }

  /**
   * Saves credentials strictly into hardware Keystore/Keychain.
   */
  public async saveCredentials(
    clientId: string,
    token: string,
    tabId = '1',
    isStreamerEnabled = true
  ): Promise<void> {
    const cleanId = (clientId || '').trim();
    const cleanToken = (token || '').trim();
    const cleanTab = (tabId || '1').trim();

    const secureOptions: SecureStore.SecureStoreOptions = {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    };

    await Promise.all([
      SecureStore.setItemAsync(VAULT_KEY_CLIENT_ID, cleanId, secureOptions),
      SecureStore.setItemAsync(VAULT_KEY_ACCESS_TOKEN, cleanToken, secureOptions),
      SecureStore.setItemAsync(VAULT_KEY_TAB_ID, cleanTab, secureOptions),
      SecureStore.setItemAsync(VAULT_KEY_STREAMER_MODE, String(isStreamerEnabled), secureOptions),
    ]);

    this.inMemoryCache = {
      clientId: cleanId,
      token: cleanToken,
      tabId: cleanTab,
      isStreamerEnabled,
    };
  }

  /**
   * Clears credentials from Keystore and memory.
   */
  public async clearCredentials(): Promise<void> {
    this.inMemoryCache = {
      clientId: '',
      token: '',
      tabId: '1',
      isStreamerEnabled: false,
    };

    await Promise.all([
      SecureStore.deleteItemAsync(VAULT_KEY_CLIENT_ID),
      SecureStore.deleteItemAsync(VAULT_KEY_ACCESS_TOKEN),
      SecureStore.deleteItemAsync(VAULT_KEY_TAB_ID),
      SecureStore.deleteItemAsync(VAULT_KEY_STREAMER_MODE),
    ]);
  }

  /**
   * Checks whether valid credentials exist in Keystore.
   */
  public async hasValidCredentials(): Promise<boolean> {
    const creds = await this.getCredentials();
    return Boolean(creds.clientId && creds.token && creds.token.length > 20);
  }

  /**
   * Decodes JWT expiry locally to check if token expires within thresholdMinutes.
   */
  public isTokenExpiringSoon(token: string, thresholdMinutes = 30): boolean {
    if (!token) return true;
    try {
      const parts = token.split('.');
      if (parts.length < 2) return false;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const parsed = JSON.parse(jsonPayload);
      if (typeof parsed.exp === 'number') {
        const nowSec = Math.floor(Date.now() / 1000);
        return parsed.exp - nowSec <= thresholdMinutes * 60;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Calculates remaining token lifetime in seconds.
   */
  public getTokenRemainingSeconds(token: string): number | null {
    if (!token) return null;
    try {
      const parts = token.split('.');
      if (parts.length < 2) return null;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const parsed = JSON.parse(jsonPayload);
      if (typeof parsed.exp === 'number') {
        const nowSec = Math.floor(Date.now() / 1000);
        return Math.max(0, parsed.exp - nowSec);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Enforces hardware biometric authentication before credential reveal or changes.
   */
  public async authenticateWithBiometrics(
    promptMessage = 'Authenticate to access QStrategy Secure Vault'
  ): Promise<boolean> {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) return true; // Device without biometric hardware passes through

      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!isEnrolled) return true; // Not enrolled passes through

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage,
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });

      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Live streamer telemetry management.
   */
  public getTelemetry(): StreamerTelemetry {
    return { ...this.telemetry };
  }

  public updateTelemetry(partial: Partial<StreamerTelemetry>): void {
    this.telemetry = { ...this.telemetry, ...partial };
  }
}

export const secureVault = new SecureCredentialVault();
