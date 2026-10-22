const { withAndroidManifest } = require('@expo/config-plugins');

// Android 14 requires a foreground service type for the background-actions service.
module.exports = function withBackgroundMonitor(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const perms = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.WAKE_LOCK',
    ];
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    for (const name of perms) {
      if (!manifest['uses-permission'].some((p) => p.$['android:name'] === name)) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    const app = manifest.application[0];
    app.service = app.service || [];
    const serviceName = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
    if (!app.service.some((s) => s.$['android:name'] === serviceName)) {
      app.service.push({
        $: {
          'android:name': serviceName,
          'android:foregroundServiceType': 'dataSync',
          'android:exported': 'false',
        },
      });
    }
    return cfg;
  });
};
