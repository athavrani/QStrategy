// =====================================================================
// QStrategy — Plain-Text Unencrypted Credential Storage (Option 1)
// Stores Client ID & Dhan Access/Session Token directly without Keystore encryption
// =====================================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_CLIENT_ID = 'QM_PLAIN_DHAN_CLIENT_ID';
const STORAGE_KEY_TOKEN = 'QM_PLAIN_DHAN_TOKEN';
const STORAGE_KEY_TAB_ID = 'QM_PLAIN_DHAN_TAB_ID';
const STORAGE_KEY_MODE = 'QM_PLAIN_DHAN_STREAMER_MODE';

export const DEFAULT_CLIENT_ID = '';
export const DEFAULT_TOKEN = '';

export interface DhanPlainCredentials {
  clientId: string;
  token: string;
  tabId: string;
  isStreamerEnabled: boolean;
}

export interface DhanStreamerTelemetry {
  status: 'STREAMING' | 'CONNECTING' | 'DISCONNECTED' | 'TOKEN_EXPIRED' | 'ERROR';
  lastTickTime: string | null;
  packetsReceived: number;
  latencyMs: number | null;
  lastError: string | null;
}

class DhanPlainStorage {
  private cachedClientId: string = '';
  private cachedToken: string = '';
  private cachedTabId: string = '1';
  private isStreamerEnabled: boolean = true;
  private isLoaded: boolean = false;

  private telemetry: DhanStreamerTelemetry = {
    status: 'DISCONNECTED',
    lastTickTime: null,
    packetsReceived: 0,
    latencyMs: null,
    lastError: null,
  };

  /**
   * Loads credentials directly from unencrypted AsyncStorage
   */
  public async load(): Promise<DhanPlainCredentials> {
    if (this.isLoaded) {
      return this.getCredentials();
    }

    try {
      const [storedId, storedToken, storedTab, storedMode] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY_CLIENT_ID),
        AsyncStorage.getItem(STORAGE_KEY_TOKEN),
        AsyncStorage.getItem(STORAGE_KEY_TAB_ID),
        AsyncStorage.getItem(STORAGE_KEY_MODE),
      ]);

      if (storedId?.trim()) this.cachedClientId = storedId.trim();
      if (storedToken?.trim()) this.cachedToken = storedToken.trim();
      if (storedTab?.trim()) this.cachedTabId = storedTab.trim();
      if (storedMode !== null) this.isStreamerEnabled = storedMode === 'true';

      this.isLoaded = true;
    } catch {
      this.isLoaded = true;
    }

    return this.getCredentials();
  }

  /**
   * Synchronous getter for loaded credentials
   */
  public getCredentials(): DhanPlainCredentials {
    return {
      clientId: this.cachedClientId,
      token: this.cachedToken,
      tabId: this.cachedTabId,
      isStreamerEnabled: this.isStreamerEnabled,
    };
  }

  /**
   * Saves credentials in plain text without encryption
   */
  public async save(clientId: string, token: string, tabId = '1', isEnabled = true): Promise<void> {
    const cleanId = clientId.trim() || DEFAULT_CLIENT_ID;
    const cleanToken = token.trim();
    const cleanTab = tabId.trim() || '1';

    this.cachedClientId = cleanId;
    this.cachedToken = cleanToken;
    this.cachedTabId = cleanTab;
    this.isStreamerEnabled = isEnabled;
    this.isLoaded = true;

    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEY_CLIENT_ID, cleanId),
      AsyncStorage.setItem(STORAGE_KEY_TOKEN, cleanToken),
      AsyncStorage.setItem(STORAGE_KEY_TAB_ID, cleanTab),
      AsyncStorage.setItem(STORAGE_KEY_MODE, String(isEnabled)),
    ]);
  }

  /**
   * Resets/clears stored credentials
   */
  public async clear(): Promise<void> {
    this.cachedClientId = DEFAULT_CLIENT_ID;
    this.cachedToken = '';
    this.cachedTabId = '1';
    this.isStreamerEnabled = false;

    await Promise.all([
      AsyncStorage.removeItem(STORAGE_KEY_CLIENT_ID),
      AsyncStorage.removeItem(STORAGE_KEY_TOKEN),
      AsyncStorage.removeItem(STORAGE_KEY_TAB_ID),
      AsyncStorage.removeItem(STORAGE_KEY_MODE),
    ]);
  }

  /**
   * Returns live streamer telemetry
   */
  public getTelemetry(): DhanStreamerTelemetry {
    return { ...this.telemetry };
  }

  /**
   * Updates telemetry state
   */
  public updateTelemetry(partial: Partial<DhanStreamerTelemetry>): void {
    this.telemetry = { ...this.telemetry, ...partial };
  }
}

export const dhanPlainStorage = new DhanPlainStorage();
