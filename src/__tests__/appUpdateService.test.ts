import {
  compareSemver,
  resolveInstalledVersion,
  appUpdateService,
  AppUpdateService,
} from '../services/appUpdateService';
import { Linking } from 'react-native';

describe('AppUpdateService', () => {
  describe('compareSemver', () => {
    it('correctly compares newer versions', () => {
      expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
      expect(compareSemver('1.1.0', '1.0.9')).toBe(1);
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    });

    it('correctly compares older versions', () => {
      expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
      expect(compareSemver('1.0.9', '1.1.0')).toBe(-1);
    });

    it('handles equal versions', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
      expect(compareSemver('2.1.3', '2.1.3')).toBe(0);
    });

    it('strips leading "v" or "V" prefixes gracefully', () => {
      expect(compareSemver('v1.0.1', '1.0.0')).toBe(1);
      expect(compareSemver('V2.0.0', 'v1.9.9')).toBe(1);
      expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    });
  });

  describe('resolveInstalledVersion', () => {
    it('prefers the native APK version over a stale bundled config', () => {
      expect(
        resolveInstalledVersion(
          { version: '1.1.2', build: '22' },
          { version: '1.0.18', versionCode: 19 }
        )
      ).toEqual({ version: '1.1.2', versionCode: 22 });
    });

    it('falls back to the bundled config, then to defaults, when native values are missing', () => {
      expect(
        resolveInstalledVersion({ version: null, build: null }, { version: '1.0.18', versionCode: 19 })
      ).toEqual({ version: '1.0.18', versionCode: 19 });
      expect(resolveInstalledVersion({ version: '1.1.2', build: 'abc' }, {})).toEqual({
        version: '1.0.0',
        versionCode: 1,
      });
    });
  });

  describe('checkForUpdate network logic', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('detects an update when remote app.json has higher version', async () => {
      const mockManifest = {
        expo: {
          version: '1.0.1',
          android: {
            versionCode: 2,
          },
          extra: {
            releaseNotes: 'Fixed option chain delta calculation',
            apkDownloadUrl:
              'https://github.com/athavrani/QStrategy/releases/download/v1.0.1/QStrategy.apk',
          },
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockManifest,
      } as any);

      const result = await appUpdateService.checkForUpdate();
      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe('1.0.1');
      expect(result.latestVersionCode).toBe(2);
      expect(result.releaseNotes).toBe(
        'Fixed option chain delta calculation'
      );
    });

    it('reports no update available when versions match', async () => {
      const current = appUpdateService.getCurrentVersionInfo();
      const mockManifest = {
        expo: {
          version: current.version,
          android: {
            versionCode: current.versionCode,
          },
          extra: {
            releaseNotes: 'No changes',
          },
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockManifest,
      } as any);

      const result = await appUpdateService.checkForUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.latestVersion).toBe(current.version);
    });

    it('handles server network errors gracefully without crashing', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Network request failed'));

      const result = await appUpdateService.checkForUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.error).toBe('Network request failed');
    });

    it('handles non-200 HTTP responses gracefully', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as any);

      const result = await appUpdateService.checkForUpdate();
      expect(result.updateAvailable).toBe(false);
      expect(result.error).toContain('404');
    });
  });

  describe('dismiss and openApkDownload', () => {
    it('manages dismissed version state', () => {
      expect(appUpdateService.isDismissed('1.0.5')).toBe(false);
      appUpdateService.dismissVersion('1.0.5');
      expect(appUpdateService.isDismissed('1.0.5')).toBe(true);
      expect(appUpdateService.isDismissed('1.0.6')).toBe(false);
    });

    it('opens download URL using Linking.openURL', async () => {
      const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
      const testUrl = 'https://custom-apk-download.example.com/app.apk';
      const success = await appUpdateService.openApkDownload(testUrl);
      expect(success).toBe(true);
      expect(openSpy).toHaveBeenCalledWith(testUrl);
      openSpy.mockRestore();
    });
  });
});
