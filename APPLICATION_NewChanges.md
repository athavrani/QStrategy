# QStrategy — End-to-End Application Audit & Comprehensive Change Proposal

**Target File:** `APPLICATION_NewChanges.md`  
**Date of Audit:** October 20, 2026  
**Auditor Roles:** Senior Software Architect, Full-Stack Engineer, QA Expert, Security Specialist, Indian Market Expert, and UI/UX Reviewer  
**Repository:** `c:\Project\QStrategy` (Current Release: `v1.0.3` / Build 4)  
**Execution Mode:** Read-Only Audit (Preserving existing functional behavior; zero unreviewed modifications)

---

## 1. Executive Summary

A comprehensive, multi-dimensional code audit of the entire **QStrategy** mobile quantitative trading terminal was conducted across its architecture, algorithms, data feeds, security boundaries, Indian capital market compliance, UI/UX interaction models, and automated test coverage.

### Codebase Overview & Technology Stack
- **Framework & Runtime:** React Native `0.74.5`, Expo `~51.0.38` (Bare/Prebuilt Android workflow with native `android/` directory), Hermes JavaScript Engine.
- **State Architecture:** Zustand `^4.5.2` (Global store `useRadarStore.ts`), React Context (`useTheme.ts`).
- **Data Persistence:** `expo-sqlite` `~14.0.6` (Local SQLite relational storage), `expo-secure-store` `~13.0.2` (Android Keystore / Apple Keychain), `@react-native-async-storage/async-storage` `1.23.1`.
- **Market Feed Protocol:** Direct WebSocket Little-Endian Binary Feed v2 (`wss://api-feed.dhan.co`), Direct REST Data API v2 (`https://api.dhan.co/v2`), On-Device Black-Scholes Greeks Engine (`BlackScholes.ts`).
- **Test Infrastructure:** Jest `^29.7.0`, `jest-expo` `~51.0.4`, 16 test suites (148 tests passing).

### Summary Findings Matrix
The audit identified **17 distinct findings** categorized by severity:

| Severity | Count | Primary Impact Areas |
| :--- | :---: | :--- |
| **CRITICAL** | 1 | Production credential exposure in client source code |
| **HIGH** | 7 | Regulatory expiry day errors, SEBI lot size violations, WebSocket frame dropping, state volatility on restart, WebView credential sniffing, UI re-render thrashing, 0% UI/Store test coverage |
| **MEDIUM** | 6 | Weekend session logic bug, bullish formula mismatch, broken haptic settings toggle, volatile trading journal, missing BSE notifications, Android gesture bar clipping |
| **LOW** | 3 | Dead code (`TrailingSLStateMachine`), tab unmounting on navigation, dense touch targets |
| **TOTAL** | **17** | |

---

## 2. Severity Assessment Matrix

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │                       SEVERITY DISTRIBUTION MATRIX                     │
   ├──────────────┬──────┬──────────────────────────────────────────────────┤
   │ Level        │ Count│ Core Risk Description                            │
   ├──────────────┼──────┼──────────────────────────────────────────────────┤
   │ 🔴 CRITICAL  │  1   │ Hardcoded live Dhan Client ID and JWT token      │
   │ 🟠 HIGH      │  7   │ Market invariants, packet dropping, render lag   │
   │ 🟡 MEDIUM    │  6   │ Logic divergence, session bug, UI state bugs     │
   │ 🔵 LOW       │  3   │ Dead code, tab unmounting, touch target padding  │
   └──────────────┴──────┴──────────────────────────────────────────────────┘
```

---

## 3. Detailed Audit Findings & Evidence

---

### 🔴 CRITICAL SEVERITY

#### FINDING-01: Hardcoded Live Production Dhan Credentials & JWT Token in Client Code
- **Category:** Security / Secret Management
- **Affected Files:**
  - `src/screens/SettingsScreen.tsx` (Lines 32–34, 198–200)
  - `src/services/SecureCredentialVault.ts` (Lines 30–32, 120–127)
  - `src/services/dhanDirectService.ts` (Lines 659–662)
- **Evidence:**
  ```typescript
  // src/screens/SettingsScreen.tsx:32-34
  const DEFAULT_DHAN_CLIENT_ID = '1113940120';
  const DEFAULT_DHAN_TOKEN =
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkyNDkxMDI1LCJpYXQiOjE3OTI0MDQ2MjUsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzOTQwMTIwIn0...';
  ```
  ```typescript
  // src/services/SecureCredentialVault.ts:120-126
  // Automatic fallback to verified default credentials
  return {
    clientId: DEFAULT_DHAN_CLIENT_ID,
    token: DEFAULT_DHAN_TOKEN,
    tabId: creds.tabId || '1',
    isStreamerEnabled: creds.isStreamerEnabled,
  };
  ```
- **Root Cause:** A working personal production JWT token and numeric client account ID were embedded as hardcoded fallback strings to allow out-of-the-box market data streaming without requiring manual setup.
- **Impact & Threat Vector:**
  1. Any user downloading the public APK (`QStrategy.apk`) or viewing the repository gains unauthorized access to the developer's personal Dhan account APIs (orders, portfolio, positions, profile).
  2. If multiple mobile installations connect simultaneously with the same credentials, Dhan HQ's WebSocket server severs the connection with error code `805` (connection limit exceeded; max 5 concurrent sockets allowed per Client ID).
  3. Direct violation of SEBI's Cybersecurity & Cyber Resilience framework and Google Play Store policies.
- **Recommended Fix:**
  1. Immediately revoke and regenerate the compromised token in the Dhan Web Developer console.
  2. Strip all hardcoded default tokens and client IDs from the codebase.
  3. Update `SecureCredentialVault.getEffectiveCredentials()` to return unconfigured status when Keystore is empty.
  4. Provide a first-run setup onboarding banner prompting users to enter their own Dhan Client ID and Data API token.

---

### 🟠 HIGH SEVERITY

#### FINDING-02: Incorrect NIFTY Option Expiry Day (Tuesday instead of Thursday) & Greek Distortion
- **Category:** Indian Market Domain / Quantitative Math
- **Affected Files:**
  - `src/services/TradingCalendarService.ts` (Lines 55–64, 80–85)
  - `src/services/niftyOptionFeedService.ts` (Lines 19–25, 43–46, 62–64)
  - `src/__tests__/NiftyOvernightStrategy.test.ts` (Lines 18–19, 28–33)
- **Evidence:**
  ```typescript
  // src/services/TradingCalendarService.ts:55-63
  /**
   * Computes the active weekly Tuesday expiry for NIFTY options.
   * If `skipIfTodayIsExpiry` is true and today is Tuesday/Expiry day...
   */
  public getActiveWeeklyExpiry(now = new Date(), skipIfTodayIsExpiry = true): ExpiryResolution {
    const currentDay = now.getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, ...
    const daysUntilTuesday = (2 - currentDay + 7) % 7;
    let candidateTuesday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilTuesday);
  ```
  ```typescript
  // src/services/niftyOptionFeedService.ts:23-24
  // 1. NIFTY Weekly options expire every Tuesday (shifted from Thursday per NSE circular).
  // 2. If Tuesday is an exchange holiday (e.g. Dussehra Oct 20), expiry prepones to preceding trading day (Monday Oct 19).
  ```
- **Root Cause:** A fundamental misconception regarding NSE circulars: While FINNIFTY expires on Tuesday and Bank Nifty weekly options were restructured, **NIFTY 50 weekly and monthly options strictly expire on THURSDAY** (or Wednesday if Thursday is a trading holiday).
- **Impact:**
  1. The calendar engine generates an invalid expiry date string (Tuesday) for NIFTY 50 options contracts.
  2. In `dhanDirectService.fetchOptionChain`, the query looks for this Tuesday date; finding no match in Dhan's official expiry list, it falls back to `list[0]` through exception recovery rather than deterministic resolution.
  3. **Black-Scholes Greeks Engine (`calculateGreeks`):** `timeToExpiryYears` is calculated based on Tuesday instead of Thursday. The model understates time to expiry by 2 calendar days (48 hours), severely distorting implied volatility (IV), Delta, and Theta.
  4. Unit tests (`NiftyOvernightStrategy.test.ts`) were written against the invalid Tuesday assumption, masking the defect.
- **Recommended Fix:**
  1. Update `TradingCalendarService.getActiveWeeklyExpiry` to use Thursday (day index `4`):
     ```typescript
     const daysUntilThursday = (4 - currentDay + 7) % 7;
     let candidateThursday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilThursday);
     ```
  2. Ensure SENSEX remains on Friday (day index `5`), which is already correctly handled by `getActiveWeeklySensexExpiry`.
  3. Align unit tests in `NiftyOvernightStrategy.test.ts` to test Thursday expiry cycles.

---

#### FINDING-03: Outdated Derivative Lot Sizes per SEBI Framework (NIFTY 25 vs 75, SENSEX 10 vs 20)
- **Category:** Indian Market Compliance / Risk Engine
- **Affected Files:**
  - `src/services/niftyOptionFeedService.ts` (Lines 14, 965, 967, 990, 992)
  - `src/services/sensexOptionFeedService.ts` (Lines 23, 674, 675)
  - `src/constants/dhanSecurityMaster.ts` (Constituent stock lot sizes)
  - `src/constants/stockUniverse.ts` (Constituent stock lot sizes)
- **Evidence:**
  ```typescript
  // src/services/niftyOptionFeedService.ts:14
  const NIFTY_LOT_SIZE = 25; // ⚠️ Outdated
  
  // Lines 965, 967:
  riskPerLot = +((executedPrice - slPrice) * NIFTY_LOT_SIZE).toFixed(2);
  pnlPerLot = +(pnlPerShare * NIFTY_LOT_SIZE).toFixed(2);
  ```
  ```typescript
  // src/services/sensexOptionFeedService.ts:23
  export const SENSEX_LOT_SIZE = 10; // ⚠️ Outdated
  ```
- **Root Cause:** In October 2024, SEBI issued comprehensive circulars revising index derivative contract sizes to a minimum of ₹15–₹20 Lakhs. Effective November 20, 2024:
  - **NSE NIFTY 50:** Lot size revised from 25 to **75**.
  - **BSE SENSEX:** Lot size revised from 10 to **20**.
  - **NSE Stock Derivatives:** Lot sizes across numerous F&O constituents (e.g. Tata Motors, Reliance, HDFC Bank) were revised.
- **Impact:**
  1. In `NiftyOptionFeedService`, `riskPerLot` and `pnlPerLot` calculations are understated by **3x** (calculated on 25 units instead of 75 units).
  2. In `SensexOptionFeedService`, `riskPerLot` and `pnlPerLot` are understated by **2x** (calculated on 10 units instead of 20 units).
  3. A trader deploying 1 lot based on the terminal's reported risk values risks 300% more capital than reported by the UI.
- **Recommended Fix:**
  1. Update `NIFTY_LOT_SIZE = 75` in `niftyOptionFeedService.ts`.
  2. Update `SENSEX_LOT_SIZE = 20` in `sensexOptionFeedService.ts`.
  3. Audit and update constituent stock derivative lot sizes in `stockUniverse.ts` and `dhanSecurityMaster.ts` against the latest NSE Master file.

---

#### FINDING-04: DhanHQ WebSocket Binary Packet Dropping on Concatenated Frames
- **Category:** Architecture / Market Feed Engine
- **Affected Files:**
  - `src/services/dhan/DhanBinaryCodec.ts` (Lines 108–212)
  - `src/services/dhan/DhanHqFeedSocket.ts` (Lines 231–259)
- **Evidence:**
  ```typescript
  // src/services/dhan/DhanBinaryCodec.ts:108-118
  export function decodeDhanBinaryPacket(buffer: ArrayBuffer): DhanParsedPacket | null {
    if (!buffer || buffer.byteLength < 8) return null;
    const view = new DataView(buffer);
    const responseCode = view.getUint8(0);
    const messageLength = view.getInt16(1, true); // Little-Endian
    ...
  ```
  ```typescript
  // src/services/dhan/DhanHqFeedSocket.ts:231-259
  private handleIncomingFrame(data: any): void {
    ...
    const parsed = decodeDhanBinaryPacket(arrayBuffer);
    if (!parsed) return;
    this.packetsReceivedCount++;
    const key = String(parsed.securityId);
    this.pendingTickBatch.set(key, parsed);
    this.ensureFlushTimer();
  }
  ```
- **Root Cause:** Per DhanHQ Live Market Feed v2 official documentation (`dhan-api-docs.md`, line 2074 & 6535):
  > *"A single WebSocket message can contain one packet or multiple packets concatenated together. Parse each message in a loop until the full binary buffer is consumed."*
  `decodeDhanBinaryPacket` only decodes the single packet starting at offset `0`. When the Dhan server batches multiple ticks (e.g. 500 bytes containing ten 50-byte Quote packets) into a single WebSocket binary frame, `handleIncomingFrame` only parses the first 50 bytes and drops the remaining 450 bytes (9 ticks).
- **Impact:**
  1. Massive packet loss during market hours when multiple subscribed stocks tick simultaneously.
  2. 20D Volume Crossover screener and breakout triggers miss price movements for stocks situated later in the binary frame.
- **Recommended Fix:**
  1. Refactor `decodeDhanBinaryPacket` to `decodeDhanBinaryPackets(buffer: ArrayBuffer): DhanParsedPacket[]` that loops through the buffer using `messageLength`:
     ```typescript
     export function decodeDhanBinaryPackets(buffer: ArrayBuffer): DhanParsedPacket[] {
       const packets: DhanParsedPacket[] = [];
       const view = new DataView(buffer);
       let offset = 0;
       while (offset + 8 <= buffer.byteLength) {
         const messageLength = view.getInt16(offset + 1, true);
         if (messageLength <= 0 || offset + messageLength > buffer.byteLength) break;
         const packet = decodeSinglePacket(view, offset, messageLength);
         if (packet) packets.push(packet);
         offset += messageLength;
       }
       return packets;
     }
     ```
  2. Update `handleIncomingFrame` to iterate through all decoded packets in the frame.

---

#### FINDING-05: In-Memory Volatility of Strategy Anchors and Breakout Locks across App Restarts
- **Category:** Architecture / State Persistence
- **Affected Files:**
  - `src/services/niftyOptionFeedService.ts` (Lines 161, 525–531, 1266–1295)
  - `src/services/sensexOptionFeedService.ts` (Lines 111, 414–420)
  - `src/db/schema.ts` (Tables defined but unused)
- **Evidence:**
  ```typescript
  // src/services/niftyOptionFeedService.ts:161
  private cachedAnchor: OobtstDayAnchor | null = null;
  private cachedBreakout180: Breakout180DayCache | null = null;
  ```
  ```typescript
  // src/services/sensexOptionFeedService.ts:111
  private cachedAnchor: SensexOobtstDayAnchor | null = null;
  ```
- **Root Cause:** OOBTST daily anchor strikes (selected at 09:20:00 AM) and Breakout 180 candidate strikes/candle opens (locked at 09:25:00 AM) are stored solely in volatile TypeScript class memory fields (`this.cachedAnchor`, `this.cachedBreakout180`).
- **Impact:**
  1. If Android OS terminates the app process in the background due to memory pressure, or if the user exits and reopens the app after 09:25 AM:
     - All in-memory state is destroyed.
     - On app relaunch at (for example) 10:45 AM, `cachedAnchor` is `null`. The engine executes anchor selection using the **10:45 AM spot price** rather than preserving the true 09:20:00 AM opening strikes.
     - Breakout 180 locks onto whichever strike happens to be under ₹180 at 10:45 AM rather than the official 09:25:00 candle open.
  2. Strategy invariance is broken; trading decisions become non-deterministic across restarts.
- **Recommended Fix:**
  1. Persist `cachedAnchor` and `cachedBreakout180` to SQLite (`strategy_positions` or a dedicated `session_anchors` table) immediately upon locking at 09:20 and 09:25.
  2. On service initialization (`initialize()`), query SQLite for today's trade date and restore locked anchors if present.

---

#### FINDING-06: In-App WebView Credential Sniffing & Reverse-Engineered AES Decryption Risk
- **Category:** Security / Architecture / App Store Compliance
- **Affected Files:**
  - `src/components/settings/DhanWebLoginModal.tsx` (Lines 30–48, 242–300, 480–550)
- **Evidence:**
  ```typescript
  // src/components/settings/DhanWebLoginModal.tsx:31-48
  function decryptDhanStorage(cipherTextBase64: string): string {
    if (!cipherTextBase64 || typeof cipherTextBase64 !== 'string') return '';
    try {
      const key = CryptoJS.PBKDF2('DHAN', CryptoJS.enc.Hex.parse('498960e491150a0fc0f21822a147fd62'), {
        keySize: 4,
        iterations: 1000,
      });
      const cipherParams = CryptoJS.lib.CipherParams.create({
        ciphertext: CryptoJS.enc.Base64.parse(cipherTextBase64),
      });
      const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
        iv: CryptoJS.enc.Hex.parse('320ef7705d1030f0a1a55b3dcf676cb8'),
      }).toString(CryptoJS.enc.Utf8);
      return decrypted;
    } catch {
      return '';
    }
  }
  ```
- **Root Cause:** To simplify user login, `DhanWebLoginModal` launches an embedded WebView pointing to `web.dhan.co`, injects scripts to intercept network requests, dumps `localStorage`/`sessionStorage`, and decrypts stored tokens using hardcoded reverse-engineered PBKDF2 salt/IV.
- **Impact:**
  1. **Google Play / App Store Violation:** Injecting scripts into a third-party financial broker's login portal to capture credentials and session tokens is classified as credential scraping / phishing-like behavior under Google Play's *Financial Services* and *Device and Network Abuse* policies, leading to immediate store rejection or account suspension.
  2. **Fragility:** Any front-end build update on `web.dhan.co` that modifies storage keys, salt, or IV breaks the login flow completely without notice.
  3. **Token Incompatibility:** A web session token extracted from `web.dhan.co` is a short-lived web front-end session (24h), not an official DhanHQ v2 Data API access token (30 days). Using web session tokens against the Data API endpoints can lead to unexpected 401/403 authorization failures.
- **Recommended Fix:**
  1. Deprecate the WebView DOM sniffing flow.
  2. Direct users to the official Dhan Developer Portal (`web.dhan.co` -> Profile -> Access DhanHQ APIs) via an external browser link (`Linking.openURL`) to generate a standard 30-day Data API token, which is then securely pasted into Settings and saved into hardware Keystore.

---

#### FINDING-07: Unbounded Re-rendering & UI Thread Thrashing from Broad Zustand Subscriptions
- **Category:** Performance / Mobile UX
- **Affected Files:**
  - `App.tsx` (Lines 34–42)
  - `src/navigation/AppNavigator.tsx` (Lines 16–19)
  - `src/screens/SignalsScreen.tsx` (Lines 30–43)
  - `src/screens/JournalScreen.tsx` (Line 11)
  - `src/store/useRadarStore.ts` (Lines 434–595)
- **Evidence:**
  ```typescript
  // App.tsx:34-42
  const clockTimer = setInterval(() => {
    ...
    setIstTime(timeStr); // Updates Zustand store every 1,000ms
  }, 1000);
  ```
  ```typescript
  // src/screens/SignalsScreen.tsx:30-43
  export function SignalsScreen({ onNavigateToOptions }: SignalsScreenProps = {}) {
    const {
      stocks,
      marketStatus,
      istTime,
      niftySpot,
      sensexSpot,
      oobtstState,
      sensexOobtstState,
      niftyBreakout180,
      signalsTodayCount,
      netPointsCaptured,
      isRefreshing,
      refreshAll,
    } = useRadarStore(); // ⚠️ No selector! Subscribes to the entire store
  ```
- **Root Cause:**
  1. `App.tsx` triggers `setIstTime` every single second (1,000ms).
  2. High-frequency WebSocket ticks trigger store updates every 250ms via `pendingTickBatch`.
  3. `SignalsScreen.tsx`, `JournalScreen.tsx`, and `AppNavigator.tsx` invoke `useRadarStore()` without atomic property selectors or shallow equality checks.
- **Impact:**
  - Every 1,000ms and every 250ms, `useRadarStore` emits a state change notification.
  - `SignalsScreen` re-renders completely: all strategy plugins (`allPlugins.map(...)`) re-evaluate their entire view tree and format JSX 4 to 5 times per second.
  - Leads to noticeable frame drops, high CPU consumption on low-to-mid-range Android devices, thermal throttling, and excessive battery consumption.
- **Recommended Fix:**
  1. In `SignalsScreen.tsx`, `JournalScreen.tsx`, and `AppNavigator.tsx`, replace broad store destructuring with fine-grained selectors:
     ```typescript
     const niftySpot = useRadarStore((s) => s.niftySpot);
     const sensexSpot = useRadarStore((s) => s.sensexSpot);
     const oobtstState = useRadarStore((s) => s.oobtstState);
     ```
  2. Isolate the live IST clock: extract `ClockHeader` into a separate memoized component that subscribes only to `s.istTime`, preventing the rest of `AppNavigator` and screen bodies from re-rendering every second.

---

#### FINDING-08: Zero Automated Test Coverage on Core UI Screens & Central Radar Store
- **Category:** QA / Code Reliability
- **Affected Files:**
  - `src/store/useRadarStore.ts` (0% Statement & Line Coverage)
  - `src/screens/RadarScreen.tsx` (0% Coverage)
  - `src/screens/SignalsScreen.tsx` (0% Coverage)
  - `src/screens/JournalScreen.tsx` (0% Coverage)
  - `src/screens/SettingsScreen.tsx` (0% Coverage)
  - `src/services/notificationService.ts` (0% Coverage)
  - `src/services/apiService.ts` (0% Coverage)
- **Evidence:**
  From Jest Code Coverage Report (`npm run test:coverage`):
  ```
  File                 | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
  ---------------------|---------|----------|---------|---------|-------------------
  store/useRadarStore  |    0    |    0     |    0    |    0    | 71-609
  screens/RadarScreen  |    0    |    0     |    0    |    0    | 26-689
  screens/SignalsScreen|    0    |    0     |    0    |    0    | 27-339
  screens/JournalScreen|    0    |    0     |    0    |    0    | 9-264
  screens/SettingsScreen    0    |    0     |    0    |    0    | 24-1116
  services/notification|    0    |    0     |    0    |    0    | 5-132
  services/apiService  |    0    |    0     |    0    |    0    | 15-262
  ```
- **Root Cause:** All 16 existing test suites focus exclusively on isolated helper classes and pure algorithms (`DhanBinaryCodec`, `BlackScholes`, `MonotonicLatchService`, `appUpdateService`). No integration or component render tests exist for the primary screens or the central Zustand store.
- **Impact:** Regressions in state wiring, tick merging, user interaction, filter criteria, or notification dispatch can pass automated CI completely undetected.
- **Recommended Fix:**
  1. Add unit tests for `useRadarStore.ts` verifying tick handling, stock list merging, monotonic volume guarantees, and strategy evaluation triggers.
  2. Add React Native Testing Library component tests for `RadarScreen`, `SignalsScreen`, and `JournalScreen`.

---

### 🟡 MEDIUM SEVERITY

#### FINDING-09: Market Session Status Bug on Weekends & Exchange Holidays
- **Category:** Indian Market Domain / Logic Bug
- **Affected Files:**
  - `src/services/apiService.ts` (Lines 59–78)
- **Evidence:**
  ```typescript
  // src/services/apiService.ts:59-77
  async fetchMarketSession(): Promise<{ status: MarketSessionStatus; istTime: string; isTradingDay: boolean }> {
    try {
      const data = await request<any>(API_CONFIG.ENDPOINTS.MARKET_SESSION);
      return data;
    } catch {
      const now = new Date();
      ...
      const totalMinutes = istHours * 60 + istMinutes;
      let status: MarketSessionStatus = 'CLOSED';
      if (totalMinutes >= 540 && totalMinutes < 555) status = 'PRE_MARKET';
      else if (totalMinutes >= 555 && totalMinutes < 556) status = 'STABILIZING';
      else if (totalMinutes >= 556 && totalMinutes < 930) status = 'REGULAR_HOURS';
      else if (totalMinutes >= 930 && totalMinutes < 935) status = 'POST_MARKET';

      return { status, istTime: istTimeStr, isTradingDay: true }; // ⚠️ Hardcodes isTradingDay: true
    }
  }
  ```
- **Root Cause:** The offline/direct-mode fallback in `fetchMarketSession` calculates session status strictly based on time-of-day (`totalMinutes`), without checking whether today is a weekend (`getDay() === 0 || getDay() === 6`) or an official NSE holiday (`isExchangeHoliday(now)`).
- **Impact:** On Saturdays, Sundays, and market holidays between 09:16 AM and 03:30 PM IST, the terminal erroneously reports `REGULAR_HOURS` and `isTradingDay: true`, leading users to believe the market is live and displaying misleading status badges.
- **Recommended Fix:**
  ```typescript
  const tradingDay = isTradingDay(now);
  if (!tradingDay) {
    return { status: 'CLOSED', istTime: istTimeStr, isTradingDay: false };
  }
  ```

---

#### FINDING-10: Bullish Crossover Direction Logic Inconsistency between Strategy & Store
- **Category:** Logic Discrepancy / Quantitative Engine
- **Affected Files:**
  - `src/strategies/VolumeCrossoverStrategy.ts` (Lines 81–83)
  - `src/store/useRadarStore.ts` (Lines 311, 534)
- **Evidence:**
  ```typescript
  // src/strategies/VolumeCrossoverStrategy.ts:81-83
  // Invariant 3: Directional Confirmation
  // Bullish requires LTP >= Day Open AND percentChange >= 0
  const isPriceBullish = stock.spotPrice >= stock.dayOpen && stock.percentChange >= 0;
  const crossoverDirection: 'BULLISH' | 'BEARISH' = isPriceBullish ? 'BULLISH' : 'BEARISH';
  ```
  ```typescript
  // src/store/useRadarStore.ts:311 & 534
  // ⚠️ Logic mismatch: uses OR instead of AND
  const isBullish = percentChange >= 0 || spotPrice >= dayOpen;
  ```
- **Root Cause:** `VolumeCrossoverStrategy.ts` requires both `LTP >= Day Open` **AND** `percentChange >= 0` to confirm a Bullish Accumulation signal. However, `useRadarStore.ts` (lines 311 and 534) uses the logical **OR** operator (`||`).
- **Impact:** If a stock gaps down heavily at open (e.g. -3.0%) but drifts 0.2% above its opening price (while still at -2.8% for the day), `useRadarStore` flags it as `BULLISH` and assigns a `GREEN` badge, triggering a BUY notification on a stock undergoing net distribution.
- **Recommended Fix:** Change `||` to `&&` in `useRadarStore.ts` lines 311 and 534 to conform with the mathematical invariant defined in `VolumeCrossoverStrategy.ts`.

---

#### FINDING-11: SettingsScreen Haptic Feedback Toggle Bug & Lack of Persistence
- **Category:** UI/UX Bug / State Persistence
- **Affected Files:**
  - `src/screens/SettingsScreen.tsx` (Lines 544–548)
  - `src/services/notificationService.ts` (Lines 44–130)
- **Evidence:**
  ```tsx
  // src/screens/SettingsScreen.tsx:544-548
  <Switch
    value={hapticsEnabled}
    onValueChange={setPushEnabled} // ⚠️ BUG: Wires haptic switch to push notification setter!
    trackColor={{ false: colors.border, true: colors.bullish }}
    thumbColor={colors.textPrimary}
  />
  ```
- **Root Cause:**
  1. The Haptic Feedback `Switch` component mistakenly specifies `onValueChange={setPushEnabled}` instead of `onValueChange={setHapticsEnabled}`. Toggling haptics flips the push notification state.
  2. Neither `pushEnabled`, `hapticsEnabled`, nor `soundEnabled` are saved to persistent storage (`AsyncStorage` / `SecureStore`). All three reset to `true` whenever the user leaves the screen or restarts the app.
  3. `notificationService.ts` never inspects `pushEnabled` or `soundEnabled` prior to scheduling notifications.
- **Recommended Fix:**
  1. Fix the callback to `onValueChange={setHapticsEnabled}`.
  2. Persist notification and haptic preferences in `AsyncStorage`.
  3. Gate `notificationService.scheduleNotificationAsync` calls behind the persisted `pushEnabled` and `soundEnabled` flags.

---

#### FINDING-12: Trading Journal Volatility & Unused SQLite Tables
- **Category:** Architecture / Data Persistence
- **Affected Files:**
  - `src/db/schema.ts` (Lines 14–31, 52–61)
  - `src/db/database.ts` (Lines 54–74)
  - `src/screens/JournalScreen.tsx` (Lines 11–24)
  - `src/store/useRadarStore.ts` (Lines 119–121, 353)
- **Evidence:**
  - `schema.ts` defines `strategy_positions` and `historical_baselines` tables with indexes.
  - However, across the entire project, **no service or screen ever queries or inserts rows into these tables**.
  - Meanwhile, all triggered trading signals are stored purely in memory in `useRadarStore` (`journal: [...]`).
  - When the session date changes or the app process is closed, `journal` is cleared or lost.
- **Impact:**
  - Users lose their entire signal log and theoretical P&L history every time the app closes.
  - The SQLite database engine maintains empty tables that provide zero utility.
- **Recommended Fix:**
  1. Create a `signal_journal` table in SQLite schema.
  2. Modify `useRadarStore` to write every generated signal into `signal_journal`.
  3. On app startup, populate the `journal` array from SQLite so trade audit logs persist across sessions.

---

#### FINDING-13: Missing SENSEX Notification Triggers
- **Category:** Features / Notification Engine
- **Affected Files:**
  - `src/services/notificationService.ts`
  - `src/store/useRadarStore.ts` (Lines 228–254)
- **Evidence:**
  `notificationService.ts` contains dedicated notification methods for:
  - 20D Volume Crossover (`notify20DCrossover`)
  - NIFTY 09:20 Strangle (`notify0920StrangleEntry`, `notify0920StopLossHit`)
  - NIFTY 09:25 Breakout (`notify180BreakoutTriggered`, `notify180TimeExit`)
  However, **zero notification methods or latch triggers exist for BSE SENSEX OOBTST strategy signals**!
- **Impact:** SENSEX OOBTST triggers at 09:20 and executions occurring on BSE contracts are displayed in UI cards but never dispatch mobile notifications to the trader.
- **Recommended Fix:**
  1. Add `notifySensexOobtstTrigger`, `notifySensexOobtstExecution`, and `notifySensexOobtstExit` to `notificationService.ts`.
  2. Wire SENSEX latch checks and notifications into `useRadarStore.ts` during tick evaluation.

---

#### FINDING-14: Android Gesture Navigation Bar Clipping
- **Category:** UI/UX / Android Insets
- **Affected Files:**
  - `src/navigation/AppNavigator.tsx` (Lines 2, 42, 105–120)
- **Evidence:**
  ```typescript
  // src/navigation/AppNavigator.tsx:2
  import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, StatusBar } from 'react-native';
  ```
  `AppNavigator.tsx` imports `SafeAreaView` from core `react-native`.
- **Root Cause:** Standard React Native `SafeAreaView` does not support edge-to-edge Android navigation bars or bottom gesture navigation insets. `react-native-safe-area-context` is already installed in `package.json` (`4.10.5`) but is not utilized in `AppNavigator.tsx`.
- **Impact:** On modern Android devices with gesture navigation enabled, the bottom tab bar (`styles.tabBar` with `paddingVertical: 8`) overlaps with the Android gesture pill, making bottom tabs difficult to tap.
- **Recommended Fix:**
  1. Import `SafeAreaView` or `useSafeAreaInsets` from `react-native-safe-area-context`.
  2. Apply `paddingBottom: insets.bottom` dynamically to `tabBar`.

---

### 🔵 LOW SEVERITY

#### FINDING-15: Dead / Unintegrated Code (`TrailingSLStateMachine.ts`)
- **Category:** Code Quality / Maintenance
- **Affected Files:**
  - `src/strategies/TrailingSLStateMachine.ts`
  - `src/strategies/index.ts`
- **Evidence:** `TrailingSLStateMachine` is exported in `src/strategies/index.ts` and tested in `VolumeCrossoverStrategy.test.ts`. However, it is never instantiated or integrated into any production strategy or store.
- **Recommended Fix:** Either integrate `TrailingSLStateMachine` into the live position tracking engine or document it as a utility module for future trailing stop-loss features.

---

#### FINDING-16: Tab Unmounting and Scroll State Reset on Navigation
- **Category:** UI/UX / Navigation Architecture
- **Affected Files:**
  - `src/navigation/AppNavigator.tsx` (Lines 26–39)
- **Evidence:**
  ```tsx
  const renderContent = () => {
    switch (activeTab) {
      case 'SIGNALS': return <SignalsScreen ... />;
      case 'RADAR': return <RadarScreen ... />;
      ...
    }
  };
  ```
- **Impact:** Switching between tabs completely unmounts the previous screen. When returning to `RadarScreen`, the stock list scroll position, filter selection, and search query are reset.
- **Recommended Fix:** Use `@react-navigation/bottom-tabs` (already present in `package.json`) or render tab bodies with `display: activeTab === tab ? 'flex' : 'none'` to preserve scroll state.

---

#### FINDING-17: Option Chain Dense View Touch Target Sizing
- **Category:** UI/UX / Accessibility
- **Affected Files:**
  - `src/screens/OptionChainScreen.tsx` (Lines 227–295)
- **Impact:** In Greeks mode on screens with widths under 360dp, the strike cell height and touch target padding are slightly below the recommended 48×48dp minimum, requiring precise fingertip touches.
- **Recommended Fix:** Increase vertical cell padding and expand hit slop (`hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}`).

---

## 4. Indian Capital Market Rules & SEBI Compliance Matrix

| Parameter | Current Codebase | Regulatory Standard (SEBI / NSE / BSE) | Status / Action Required |
| :--- | :--- | :--- | :--- |
| **NIFTY Weekly Expiry** | Tuesday (`TradingCalendarService:62`) | **Thursday** (NSE Derivatives Framework) | ❌ **NON-COMPLIANT** — Change to Thursday |
| **SENSEX Weekly Expiry** | Friday (`TradingCalendarService:131`) | **Friday** (BSE Derivatives Framework) | ✅ **COMPLIANT** |
| **NIFTY Lot Size** | 25 (`niftyOptionFeedService:14`) | **75** (SEBI Circular Nov 20, 2024) | ❌ **NON-COMPLIANT** — Change to 75 |
| **SENSEX Lot Size** | 10 (`sensexOptionFeedService:23`) | **20** (BSE Circular Nov 2024) | ❌ **NON-COMPLIANT** — Change to 20 |
| **Trading Hours** | 09:15 to 15:30 IST | 09:15 to 15:30 IST (Continuous Session) | ✅ **COMPLIANT** |
| **Opening Stabilization** | 09:15 to 09:16 IST | 09:15 to 09:16 IST (Filter spike noise) | ✅ **COMPLIANT** |
| **NSE Holidays Master** | 2026 Circular `NSE/CMTR/71775` | 2026 Circular `NSE/CMTR/71775` | ✅ **COMPLIANT** |
| **Preponement Rule** | Precedes to prior trading day | NSE Chapter 4: Prior trading day | ✅ **COMPLIANT** |
| **SEBI Disclaimer** | No P&L fabrication; raw points | SEBI Investment Adviser Regulations | ✅ **COMPLIANT** |

---

## 5. Architectural Recommendations & Structural Diagrams

### 5.1 Architecture: WebSocket Multi-Packet Decoding Pipeline

```mermaid
flowchart TD
    WS["DhanHQ Live WebSocket (wss://api-feed.dhan.co)"] -->|Binary Frame ArrayBuffer| FB["Frame Buffer"]
    FB --> Loop{"Offset + 8 <= byteLength?"}
    Loop -- Yes --> ReadHeader["Read 8-Byte Header (MsgCode, MsgLen, SecId)"]
    ReadHeader --> Parse["Decode Packet by MsgCode (2=Ticker, 4=Quote, 5=OI, 6=PClose)"]
    Parse --> Push["Push to Batch Array"]
    Push --> Adv["Offset += MsgLen"]
    Adv --> Loop
    Loop -- No --> Dispatch["Dispatch All Parsed Packets to 250ms Micro-Batch Buffer"]
```

### 5.2 Architecture: Resilient State Persistence (Surviving App Kills)

```mermaid
sequenceDiagram
    participant UI as Mobile UI
    participant Store as useRadarStore
    participant Engine as Nifty/Sensex Engine
    participant DB as SQLite (qstrategy.db)

    Note over Engine,DB: At 09:20:00 IST (Anchor Selection)
    Engine->>Engine: Select ATM strikes closest to target premium
    Engine->>DB: INSERT INTO session_anchors (date, strike, openPrice, status)
    
    Note over UI,Store: App killed by Android OS in background & relaunched
    UI->>Store: refreshAll() / initialize()
    Store->>DB: SELECT * FROM session_anchors WHERE date = today
    DB-->>Store: Return locked 09:20 strikes & prices
    Store-->>UI: Deterministically display locked anchor (Zero Drift)
```

---

## 6. Prioritized Action Plan & Implementation Checklist

### Phase 1: Security & Compliance Remediation (Immediate / Priority 1)
- [ ] **SEC-01:** Revoke compromised Dhan API token in Dhan Developer Portal.
- [ ] **SEC-02:** Remove hardcoded `DEFAULT_DHAN_TOKEN` and `DEFAULT_DHAN_CLIENT_ID` from `SettingsScreen.tsx` and `SecureCredentialVault.ts`.
- [ ] **SEC-03:** Deprecate WebView credential injection in `DhanWebLoginModal.tsx`; replace with external browser link to official Dhan Developer settings.
- [ ] **MKT-01:** Correct NIFTY weekly expiry calculation from Tuesday (day 2) to **Thursday (day 4)** in `TradingCalendarService.ts` and `niftyOptionFeedService.ts`.
- [ ] **MKT-02:** Update derivative lot sizes to current SEBI framework: NIFTY = **75**, SENSEX = **20**.

### Phase 2: Engine Reliability & State Persistence (Priority 2)
- [ ] **ENG-01:** Implement concatenated multi-packet parsing loop in `DhanBinaryCodec.ts` and `DhanHqFeedSocket.ts`.
- [ ] **ENG-02:** Create `session_anchors` and `signal_journal` SQLite tables in `schema.ts`.
- [ ] **ENG-03:** Persist 09:20 anchors and 09:25 breakout candidate locks to SQLite to guarantee session invariance across app restarts.
- [ ] **ENG-04:** Persist generated trading journal signals to SQLite so historical logs survive process termination.
- [ ] **ENG-05:** Fix weekend/holiday check in `apiService.fetchMarketSession` so non-trading days report `CLOSED`.

### Phase 3: Performance & UI/UX Polish (Priority 3)
- [ ] **PERF-01:** Refactor `SignalsScreen.tsx`, `JournalScreen.tsx`, and `AppNavigator.tsx` to use atomic Zustand selectors, eliminating 1-second and 250ms full-screen re-renders.
- [ ] **PERF-02:** Extract `ClockHeader` component to isolate 1-second IST clock re-renders.
- [ ] **UI-01:** Fix Haptic switch callback bug in `SettingsScreen.tsx` (`setHapticsEnabled`).
- [ ] **UI-02:** Persist notification and haptic toggles in `AsyncStorage`.
- [ ] **UI-03:** Replace core `SafeAreaView` in `AppNavigator.tsx` with `react-native-safe-area-context` to resolve Android navigation bar clipping.
- [ ] **UI-04:** Add BSE SENSEX OOBTST mobile notification dispatch to `notificationService.ts`.

### Phase 4: QA & Automated Testing Expansion (Priority 4)
- [ ] **QA-01:** Update `NiftyOvernightStrategy.test.ts` to validate Thursday weekly expiry cycles.
- [ ] **QA-02:** Add unit tests for `useRadarStore.ts` covering multi-packet tick processing, 20D monotonic volume merging, and alert latch acquisition.
- [ ] **QA-03:** Add component tests for `RadarScreen`, `SignalsScreen`, and `JournalScreen`.
- [ ] **QA-04:** Validate multi-packet binary decoding using synthetic multi-packet ArrayBuffers.

---

## 7. Expected Benefits & Impact Analysis

| Improvement Area | Current State | Post-Implementation State | Expected Benefit |
| :--- | :--- | :--- | :--- |
| **Security & Privacy** | Production token committed to repo; WebView scraping | Zero hardcoded secrets; hardware Keystore only | Eliminates unauthorized account access; compliant with Google Play policies |
| **Trading Accuracy** | NIFTY expiry on Tuesday; Lot size 25 | NIFTY expiry on Thursday; Lot size 75 | Greek models (IV, Delta, Theta) accurate; capital risk reports reflect actual 75-share contracts |
| **Market Feed Integrity** | Drops concatenated binary packets | Parses all packets in frame loop | 100% tick capture across all 60 constituent stocks and index options |
| **Restart Invariance** | 09:20/09:25 strikes lost on app kill | Anchors restored from SQLite | Zero strategy drift if app is closed or restarted during the day |
| **UI Performance & Battery**| Entire screen re-renders 1–4x/sec | Re-renders only on matching selector changes | 60 FPS scrolling, lower CPU usage, substantially reduced battery consumption |
| **State Persistence** | Signal journal erased on app close | Journal persisted in SQLite | Permanent audit trail of all generated trading signals |

---

*Report prepared and certified by Senior Software Architecture & Indian Capital Market Review Team.*  
*Next Step: Awaiting user review of `APPLICATION_NewChanges.md` prior to code modifications.*
