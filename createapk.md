# QStrategy — Android APK Generation & Mobile Installation Guide

This guide provides step-by-step instructions to compile, build, download, and install a standalone Android `.apk` file for **QStrategy** on your mobile device for real-world testing.

---

## ⚡ Direct Download: Already Built & Ready

Your local standalone APK has been compiled and is ready right in your project root:
- **File location**: [`c:\Project\QStrategy\QStrategy.apk`](file:///c:/Project/QStrategy/QStrategy.apk)
- **Original Gradle output**: `c:\Project\QStrategy\android\app\build\outputs\apk\release\app-release.apk`
- **Size**: ~75 MB (standalone release APK with offline Hermes bundle and native binaries)

### Quickest way to install on your phone right now:
1. **Uninstall the old app** from your phone first (to avoid debug/release signature conflicts).
2. **Option A (USB Cable)**: Connect your Android phone to your PC via USB, copy `QStrategy.apk` into your phone's `Downloads` folder, and tap to install.
3. **Option B (Google Drive / WhatsApp Web)**: Upload `QStrategy.apk` to Google Drive or send it to yourself on WhatsApp Web / Telegram, download it on your phone, and tap to install.
4. **Option C (ADB if developer mode is enabled)**:
   ```powershell
   adb install -r c:\Project\QStrategy\QStrategy.apk
   ```

---

## 🚀 1-Click Automated Release Script

Whenever you make improvements and want to release a new version so all installed mobile apps automatically receive the update:

```powershell
npm run release
```
*(Or directly: `.\scripts\release.ps1`)*

### What the Release Script Does Automatically:
1. **Prompts or Auto-Bumps Version**: Increments `version` and `versionCode` in both [`app.json`](file:///c:/Project/QStrategy/app.json) and [`package.json`](file:///c:/Project/QStrategy/package.json).
2. **Runs Pre-flight Quality Checks**: Executes TypeScript typecheck (`tsc --noEmit`) and Jest unit tests (`npm test`).
3. **Compiles Standalone Release APK**: Runs Gradle `assembleRelease` with Hermes bytecode and packages [`QStrategy.apk`](file:///c:/Project/QStrategy/QStrategy.apk) (~75MB).
4. **Git Versioning**: Creates a release commit and tag (`vX.Y.Z`).
5. **Pushes to GitHub**: Pushes commits and tags to `origin main`.
6. **GitHub Release Publication**:
   - If `GITHUB_TOKEN` is set, uploads `QStrategy.apk` directly via GitHub API.
   - Otherwise, opens the GitHub release creation page in your browser with tag, title, and release notes pre-filled for 1-click publishing.
7. **Mobile Over-The-Air Update**: All mobile phones with QStrategy installed immediately detect the new release on launch!

### Command Examples:
```powershell
# Interactive (prompts for notes and bumps patch: 1.0.0 -> 1.0.1)
npm run release

# One-liner with custom release notes
.\scripts\release.ps1 -Bump patch -Notes "Sensex 09:20 OOBTST improvements"

# Specific version
.\scripts\release.ps1 -Version 1.1.0 -Notes "Major update with enhanced Option Chains"

# Fast release skipping test suite
.\scripts\release.ps1 -SkipTests
```

---

## 🛠 Rebuilding Locally (Offline / Fast)

Whenever you make code changes, you can rebuild the APK locally in under 60 seconds (since all dependencies and tools are now permanently cached):

```powershell
# In PowerShell:
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "C:\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

npm run build:local
```
Or directly:
```powershell
cd c:\Project\QStrategy\android
.\gradlew.bat assembleRelease
```
The new standalone release APK will update at `c:\Project\QStrategy\android\app\build\outputs\apk\release\app-release.apk`.

---

## 1. Prerequisites

Before generating the APK, ensure you have:
1. **Free Expo Account**: If you don't have one, register for free at [https://expo.dev/signup](https://expo.dev/signup).
2. **Android Phone**: Running Android 8.0 or higher.
3. **Active Internet Connection** on your PC and mobile device.

---

## 2. Step-by-Step APK Generation

### Step 1: Open Terminal in Project Directory
Open PowerShell or your preferred terminal in the project root:
```powershell
cd c:\Project\QStrategy
```

### Step 2: Log in to Expo Application Services (EAS)
Run the following command:
```powershell
npx eas login
```
- Enter your Expo **Username / Email** and **Password**.
- Verify that login succeeds:
  ```powershell
  npx eas whoami
  ```
  *(Should output your logged-in username)*

---

### Step 3: Link Project to EAS (One-time Setup)
Run:
```powershell
npx eas project:init
```
- When prompted: `Would you like to link this project with @<username>/qstrategy?` ➔ Select **Yes** (press `Enter`).
- EAS will register your project and automatically inject a unique `projectId` into `app.json`.

---

### Step 4: Trigger the Cloud APK Build
Run the pre-configured npm script:
```powershell
npm run build:apk
```
*(Or directly: `npx eas build -p android --profile preview`)*

#### During the Build Command:
1. **Android Keystore Prompt**:
   - When asked: `Generate a new Android Keystore?` ➔ Select **Yes** (press `Enter`).
   - EAS will securely create and manage your Android signing keys in the cloud.
2. **Build Queue**:
   - EAS will upload your project JavaScript bundle and assets to the cloud build worker.
   - You will see a link to track real-time build progress on your browser (e.g. `https://expo.dev/accounts/.../builds/...`).
   - The build process usually takes **5 to 8 minutes**.

---

## 3. Downloading and Installing on Mobile

Once the build is complete:
1. **QR Code in Terminal**:
   - The terminal will display a URL and a scannable QR code.
   - Scan the QR code using your Android phone camera or QR scanner.
2. **Direct APK Download**:
   - Alternatively, open the build link on your phone's browser (Chrome) and tap **Download APK** (`.apk` file, ~40–50 MB).
3. **Install the APK**:
   - Once downloaded, tap on the downloaded `QStrategy.apk` file.
   - If prompted: *"For your security, your phone is not allowed to install unknown apps from this source"*:
     1. Tap **Settings**.
     2. Toggle **Allow from this source** to **ON**.
     3. Go back and tap **Install**.
4. **Open QStrategy**:
   - Launch **QStrategy** from your phone app drawer.

---

## 4. Mobile Testing & Verification Checklist

Once installed on your phone, test the following key features:

| Feature | Verification Steps |
|---|---|
| **Biometric Authentication** | Lock and unlock using your device's fingerprint or face unlock. |
| **Theme Switching** | Go to Settings ➔ Toggle between **Dark Mode** and **Light Mode**. Ensure all screens, cards, and modal components adapt cleanly. |
| **Dhan API Credentials** | In Settings / Options ➔ Enter your **Dhan Client ID** and **Access Token**. Verify live connectivity dot switches to green. |
| **SENSEX 09:20 OOBTST** | Open the strategy card and detail modal: <br>• Verify 3-step micro-stepper bar.<br>• Confirm target premium chips (`₹90`, `₹95`, `₹100`, `₹105`, `₹110`, `₹120`).<br>• Verify 2 CE and 2 PE candidate cards.<br>• Confirm **no** "Dhan Quick Order" button appears.<br>• Check 300ms live ticker refresh. |
| **NIFTY 09:20 OOBTST** | Verify dual candidate monitoring, ₹62.50 target selector, 1.5x breakout bars, and 50% stop-loss invariant. |
| **NIFTY 09:25 Breakout** | Check candidate discovery strictly below ₹180.00 and lock behavior. |
| **Network Resilience** | Toggle Airplane Mode ON for 10 seconds and OFF. Verify that the warning banner (`Dhan Feed Disconnected`) displays and reconnects gracefully. |

---

## 5. Troubleshooting & FAQ

### Q1: "App not installed" error when installing APK?
- **Cause**: An older build signed with a different debug keystore or Expo development client may already be on the phone.
- **Fix**: Uninstall any previous version of **QStrategy** or development build from your phone, then re-install the new `.apk`.

### Q2: How do mobile devices receive updates when I build a new version?
- **Automatic In-App Update Checker**:
  1. Bump `version` (e.g., `1.0.1`) and `android.versionCode` (e.g., `2`) in `app.json`.
  2. Add your changelog into `"extra.releaseNotes"` in `app.json`.
  3. Rebuild the APK (`npm run build:local`).
  4. Push your changes to GitHub:
     ```powershell
     git commit -am "release: v1.0.1"
     git push origin main
     ```
  5. Upload `QStrategy.apk` to your GitHub Release (`v1.0.1`) or direct download URL.
  6. Any phone running QStrategy will automatically detect the new version on next launch (or when tapping **"Check for Updates Now"** in Settings), display what's new, and prompt the user to download and update directly in place!

### Q3: Want to test immediately without waiting for a cloud build?
- You can run the app directly on your phone using **Expo Go**:
  1. Install **Expo Go** from Google Play Store on your phone.
  2. Run in terminal:
     ```powershell
     npx expo start --tunnel
     ```
  3. Scan the terminal QR code with the Expo Go app.
