/**
 * QStrategy Version Management Utility
 * Reads and updates app.json and package.json safely without PowerShell escaping bugs.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const appJsonPath = path.join(projectRoot, 'app.json');
const pkgJsonPath = path.join(projectRoot, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const command = process.argv[2] || 'get';

if (command === 'get') {
  const app = readJson(appJsonPath);
  const version = app.expo?.version || '1.0.0';
  const versionCode = app.expo?.android?.versionCode || 1;
  console.log(JSON.stringify({ version, versionCode }));
  process.exit(0);
}

if (command === 'bump' || command === 'set') {
  const target = process.argv[3] || 'patch';
  const notes = process.argv[4] || '';

  const app = readJson(appJsonPath);
  const pkg = readJson(pkgJsonPath);

  const currentVer = app.expo?.version || '1.0.0';
  const currentCode = app.expo?.android?.versionCode || 1;

  let newVer = currentVer;
  if (command === 'set') {
    newVer = target.replace(/^v/i, '').trim();
  } else {
    // bump
    const parts = currentVer.split('.').map((n) => parseInt(n, 10) || 0);
    let major = parts[0] || 1;
    let minor = parts[1] || 0;
    let patch = parts[2] || 0;

    if (target === 'major') {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (target === 'minor') {
      minor += 1;
      patch = 0;
    } else {
      // patch
      patch += 1;
    }
    newVer = `${major}.${minor}.${patch}`;
  }

  const newCode = currentCode + 1;

  // Update app.json
  if (!app.expo) app.expo = {};
  app.expo.version = newVer;
  if (!app.expo.android) app.expo.android = {};
  app.expo.android.versionCode = newCode;
  if (!app.expo.extra) app.expo.extra = {};
  if (notes) {
    app.expo.extra.releaseNotes = notes;
  }

  // Update package.json
  pkg.version = newVer;

  writeJson(appJsonPath, app);
  writeJson(pkgJsonPath, pkg);

  console.log(
    JSON.stringify({
      previousVersion: currentVer,
      newVersion: newVer,
      previousVersionCode: currentCode,
      newVersionCode: newCode,
      notes: notes || app.expo.extra.releaseNotes,
    })
  );
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
