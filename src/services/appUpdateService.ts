import { Linking } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  currentVersionCode: number;
  latestVersion: string;
  latestVersionCode: number;
  releaseNotes: string;
  apkDownloadUrl: string;
  checkTimestamp: number;
  error?: string;
}

export interface RemoteAppManifest {
  expo?: {
    version?: string;
    android?: {
      versionCode?: number;
    };
    extra?: {
      updateManifestUrl?: string;
      apkDownloadUrl?: string;
      releaseNotes?: string;
    };
  };
}

const DEFAULT_LOCAL_VERSION = '1.0.0';
const DEFAULT_LOCAL_VERSION_CODE = 1;
const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/athavrani/QStrategy/main/app.json';
const DEFAULT_APK_DOWNLOAD_URL =
  'https://github.com/athavrani/QStrategy/releases/latest/download/QStrategy.apk';

/**
 * Compares two semantic version strings (e.g. "1.0.1" vs "1.0.0").
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 === v2
 */
export function compareSemver(v1: string, v2: string): number {
  const clean1 = (v1 || '').replace(/^v/i, '').trim();
  const clean2 = (v2 || '').replace(/^v/i, '').trim();

  const p1 = clean1.split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = clean2.split('.').map((n) => parseInt(n, 10) || 0);

  const maxLen = Math.max(p1.length, p2.length, 3);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] ?? 0;
    const num2 = p2[i] ?? 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Picks the installed version: the native APK values when present, then the bundled app config, then defaults.
 */
export function resolveInstalledVersion(
  native: { version?: string | null; build?: string | null },
  config: { version?: string | null; versionCode?: number | null }
): { version: string; versionCode: number } {
  const nativeCode = parseInt(native.build ?? '', 10);
  const hasNative = !!native.version && Number.isFinite(nativeCode) && nativeCode > 0;
  if (hasNative) return { version: native.version as string, versionCode: nativeCode };
  return {
    version: config.version || DEFAULT_LOCAL_VERSION,
    versionCode: config.versionCode ?? DEFAULT_LOCAL_VERSION_CODE,
  };
}

export class AppUpdateService {
  private static instance: AppUpdateService;
  private lastCheckResult: UpdateCheckResult | null = null;
  private dismissedVersion: string | null = null;

  private constructor() {}

  public static getInstance(): AppUpdateService {
    if (!AppUpdateService.instance) {
      AppUpdateService.instance = new AppUpdateService();
    }
    return AppUpdateService.instance;
  }

  /**
   * The installed version and build. The native values come from the installed APK itself, so they cannot
   * go stale. The bundled app config is only a fallback: its asset can be left over from an older build.
   */
  public getCurrentVersionInfo(): { version: string; versionCode: number } {
    return resolveInstalledVersion(
      { version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion },
      {
        version: Constants.expoConfig?.version,
        versionCode: Constants.expoConfig?.android?.versionCode,
      }
    );
  }

  /**
   * Gets the configured manifest URL.
   */
  public getManifestUrl(): string {
    return (
      Constants.expoConfig?.extra?.updateManifestUrl || DEFAULT_MANIFEST_URL
    );
  }

  /**
   * Gets the default fallback APK download URL.
   */
  public getDefaultApkUrl(): string {
    return (
      Constants.expoConfig?.extra?.apkDownloadUrl || DEFAULT_APK_DOWNLOAD_URL
    );
  }

  /**
   * Dismisses an update version for the current app session.
   */
  public dismissVersion(version: string): void {
    this.dismissedVersion = version;
  }

  /**
   * Returns whether a specific version was dismissed by the user.
   */
  public isDismissed(version: string): boolean {
    return this.dismissedVersion === version;
  }

  /**
   * Fetches the remote manifest (app.json) from GitHub and checks for updates.
   */
  public async checkForUpdate(
    overrideManifestUrl?: string
  ): Promise<UpdateCheckResult> {
    const { version: currentVersion, versionCode: currentVersionCode } =
      this.getCurrentVersionInfo();
    const manifestUrl = overrideManifestUrl || this.getManifestUrl();

    // Cache-busting query param so mobile clients always receive latest app.json
    const urlWithCacheBuster = `${manifestUrl}${
      manifestUrl.includes('?') ? '&' : '?'
    }_t=${Date.now()}`;

    try {
      const response = await fetch(urlWithCacheBuster, {
        method: 'GET',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Update server returned HTTP ${response.status} (${response.statusText})`
        );
      }

      const remoteData: RemoteAppManifest = await response.json();
      const latestVersion =
        remoteData.expo?.version || DEFAULT_LOCAL_VERSION;
      const latestVersionCode =
        remoteData.expo?.android?.versionCode ?? currentVersionCode;
      const releaseNotes =
        remoteData.expo?.extra?.releaseNotes ||
        'Performance improvements and updated algo trading strategies.';
      const apkDownloadUrl =
        remoteData.expo?.extra?.apkDownloadUrl || this.getDefaultApkUrl();

      // Check both versionCode (primary for Android) and semantic version
      const codeIsNewer = latestVersionCode > currentVersionCode;
      const semverIsNewer =
        compareSemver(latestVersion, currentVersion) > 0;
      const updateAvailable = codeIsNewer || semverIsNewer;

      const result: UpdateCheckResult = {
        updateAvailable,
        currentVersion,
        currentVersionCode,
        latestVersion,
        latestVersionCode,
        releaseNotes,
        apkDownloadUrl,
        checkTimestamp: Date.now(),
      };

      this.lastCheckResult = result;
      return result;
    } catch (err: any) {
      const fallbackResult: UpdateCheckResult = {
        updateAvailable: false,
        currentVersion,
        currentVersionCode,
        latestVersion: currentVersion,
        latestVersionCode: currentVersionCode,
        releaseNotes: '',
        apkDownloadUrl: this.getDefaultApkUrl(),
        checkTimestamp: Date.now(),
        error: err?.message || 'Could not connect to update server.',
      };
      this.lastCheckResult = fallbackResult;
      return fallbackResult;
    }
  }

  /**
   * Opens the download link for the APK in the Android browser / Download Manager.
   */
  public async openApkDownload(url?: string): Promise<boolean> {
    const targetUrl = url || this.getDefaultApkUrl();
    try {
      await Linking.openURL(targetUrl);
      return true;
    } catch (err) {
      console.error('Failed to open APK download URL:', err);
      return false;
    }
  }

  public getLastCheckResult(): UpdateCheckResult | null {
    return this.lastCheckResult;
  }
}

export const appUpdateService = AppUpdateService.getInstance();
