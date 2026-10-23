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
const VAULT_KEY_SANDBOX_CLIENT_ID = 'QSTRATEGY_SECURE_SANDBOX_CLIENT_ID';
const VAULT_KEY_SANDBOX_TOKEN = 'QSTRATEGY_SECURE_SANDBOX_TOKEN';

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

/**
 * Validates whether a token is a formatted Dhan JWT Access Token.
 * Dhan Data API requires a JWT starting with "eyJ" and containing 3 dot-separated sections.
 */
export function isDhanJwtToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const clean = token.replace(/[\s\r\n]+/g, '');
  if (!clean.startsWith('eyJ')) return false;
  const parts = clean.split('.');
  return parts.length === 3 && clean.length > 50;
}

/**
 * Validates whether a client ID is a numeric trading account ID (not an API Key).
 */
export function isNumericClientId(clientId: string | null | undefined): boolean {
  if (!clientId) return false;
  return /^\d{5,12}$/.test(clientId.trim());
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
   * Retrieves raw credentials stored in hardware-encrypted storage.
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
    } catch {
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
   * Returns active, validated credentials for network operations.
   * A missing or malformed token (empty, API Secret, UUID) yields empty clientId/token,
   * which callers treat as "unconfigured"; there is no built-in fallback account.
   */
  public async getEffectiveCredentials(): Promise<DhanCredentials> {
    const creds = await this.getCredentials();

    if (isDhanJwtToken(creds.token)) {
      const embeddedId = this.extractDhanClientId(creds.token);
      const isIdValid = isNumericClientId(creds.clientId);
      return {
        ...creds,
        clientId: isIdValid ? creds.clientId : (embeddedId || ''),
      };
    }

    return {
      clientId: '',
      token: '',
      tabId: creds.tabId || '1',
      isStreamerEnabled: creds.isStreamerEnabled,
    };
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
   * Extracts embedded Dhan Client ID from JWT token payload.
   */
  public extractDhanClientId(token: string): string | null {
    if (!token) return null;
    try {
      const parts = token.trim().split('.');
      if (parts.length < 2) return null;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const parsed = JSON.parse(jsonPayload);
      return parsed.dhanClientId || null;
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
   * Dhan sandbox credentials, kept apart from the live ones: a sandbox token never works on the live
   * API, and a live token must never be sent to the sandbox.
   */
  public async getSandboxCredentials(): Promise<{ clientId: string; token: string }> {
    try {
      const [clientId, token] = await Promise.all([
        SecureStore.getItemAsync(VAULT_KEY_SANDBOX_CLIENT_ID),
        SecureStore.getItemAsync(VAULT_KEY_SANDBOX_TOKEN),
      ]);
      return {
        clientId: (clientId || '').trim(),
        token: (token || '').replace(/\s+/g, ''),
      };
    } catch {
      return { clientId: '', token: '' };
    }
  }

  public async saveSandboxCredentials(clientId: string, token: string): Promise<void> {
    const secureOptions: SecureStore.SecureStoreOptions = {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    };
    await Promise.all([
      SecureStore.setItemAsync(VAULT_KEY_SANDBOX_CLIENT_ID, (clientId || '').trim(), secureOptions),
      SecureStore.setItemAsync(VAULT_KEY_SANDBOX_TOKEN, (token || '').replace(/\s+/g, ''), secureOptions),
    ]);
  }

  public async clearSandboxCredentials(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(VAULT_KEY_SANDBOX_CLIENT_ID),
      SecureStore.deleteItemAsync(VAULT_KEY_SANDBOX_TOKEN),
    ]);
  }

  /**
   * Like authenticateWithBiometrics, but fails closed: a device with no biometric hardware or no
   * enrolment is refused rather than waved through. Used before actions that move money or lock settings.
   */
  public async authenticateStrict(promptMessage: string): Promise<boolean> {
    try {
      if (!(await LocalAuthentication.hasHardwareAsync())) return false;
      if (!(await LocalAuthentication.isEnrolledAsync())) return false;
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
