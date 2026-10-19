# QStrategy — Android APK Generation & Mobile Installation Guide

This guide provides step-by-step instructions to compile, build, download, and install a standalone Android `.apk` file for **QStrategy** on your mobile device for real-world testing.

---

## ⚡ Direct Download: Already Built & Ready

Your local standalone APK has been compiled and is ready right in your project root:
- **File location**: [`c:\Project\QStrategy\QStrategy.apk`](file:///c:/Project/QStrategy/QStrategy.apk)
- **Original Gradle output**: `c:\Project\QStrategy\android\app\build\outputs\apk\debug\app-debug.apk`
- **Size**: ~147 MB (includes 64-bit and 32-bit ARM/x86 architectures, SQLite C engine, encryption vault, and Hermes JS bundle)

### Quickest way to install on your phone right now:
1. **Option A (USB Cable)**: Connect your Android phone to your PC via USB, copy `QStrategy.apk` into your phone's `Downloads` folder, and tap to install.
2. **Option B (Google Drive / WhatsApp Web)**: Upload `QStrategy.apk` to Google Drive or send it to yourself on WhatsApp Web / Telegram, download it on your phone, and tap to install.
3. **Option C (ADB if developer mode is enabled)**:
   ```powershell
   adb install -r c:\Project\QStrategy\QStrategy.apk
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
.\gradlew.bat assembleDebug
```
The new APK will update at `c:\Project\QStrategy\android\app\build\outputs\apk\debug\app-debug.apk`.

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

### Q2: How do I build a new APK after making code changes?
- Commit your changes locally or push to Git.
- Run `npm run build:apk` again. EAS will compile the new code into an updated APK.

### Q3: Want to test immediately without waiting for a cloud build?
- You can run the app directly on your phone using **Expo Go**:
  1. Install **Expo Go** from Google Play Store on your phone.
  2. Run in terminal:
     ```powershell
     npx expo start --tunnel
     ```
  3. Scan the terminal QR code with the Expo Go app.
