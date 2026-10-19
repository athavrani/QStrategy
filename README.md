# QStrategy
> **System Designation:** Standalone Ultra-Low Latency Quantitative Trading Terminal & Algorithmic Strategy Platform  
> **Exchange & Segment:** National Stock Exchange of India (NSE) — Capital Market (EQ) & Equity Derivatives (FNO)  
> **Market Session:** Indian Standard Time (IST, UTC+05:30) • 09:00:00 to 15:35:00 IST  
> **Benchmark Experience:** Dhan Trading App (Sub-second Option Chain, Live Greeks, Multi-Leg Payoffs, Zero-Flicker Execution)

---

## 1. Overview

**QStrategy** is a fully standalone institutional-grade mobile trading terminal and algorithmic execution radar designed specifically for Indian capital and derivatives markets.

Unlike standard broker retail apps, **QStrategy** combines high-frequency quantitative market scanning, deterministic state machines, and hardware-secured execution:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            CORE SYSTEM CAPABILITIES                             │
├──────────────────────────────────────────────────────────────────────────────────┤
│  1. Official DhanHQ v2 Market Feed: 8-byte Little-Endian binary WebSocket feeds. │
│  2. Hardware Keystore Protection: Android Keystore / Apple Keychain encryption.  │
│  3. Sub-Second Option Chain: Strikes shaded by moneyness, live Greeks & PCR.     │
│  4. Zero-Flicker UI: 250ms micro-batch buffer with selective Zustand atoms.      │
│  5. SEBI Compliant Dual-Mode: 1-Tap Companion Deep-Linking + Static IP Gateway.  │
│  6. Zero Data Fabrication: Strict nullability; never relies on synthetic quotes. │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Quantitative Strategy Engine

QStrategy features a modular, plug-and-play quantitative strategy engine:

### 1. Strategy 1: 20-Day Cumulative Volume Crossover Breakout (`20D_CROSSOVER`)
- **Baseline:** Computes 20-day historical completed daily average traded shares ($\bar{V}_{20}$) at 09:00:00 AM IST.
- **Opening Stabilization Gate:** Discards volume spikes $> 50\%$ in first 60 seconds (09:15–09:16 IST) to eliminate cached broker feed noise.
- **Directional Trigger:** Triggers when $\text{Today Traded Shares} \ge \bar{V}_{20} \land \text{LTP} \ge \text{Day Open} \land \Delta\% \ge 0$.
- **Monotonic Latch:** One-way latching ensures exactly one confirmed signal per stock per session.
- **4-State Trailing SL:** Initial SL (-20% Option / -1% Spot) $\to$ +1R breakeven $\to$ +2R lock +1R profit $\to$ EOD square-off at 15:35:00 IST.

### 2. Strategy 2: NIFTY 09:20 Overnight Strangle (`NIFTY_OVERNIGHT`)
- **Expiry Resolution:** Nearest weekly Tuesday expiry (skips today if today is expiry day to select $D+7$).
- **Selection:** Scans ₹50–₹75 range at 09:20:00 AM IST; selects CE and PE closest to ₹62.50.
- **Strict 25% Stop-Loss:** Permanent $\text{SL} = \text{Ref Price} \times 0.75$.
- **STRICTLY ZERO TARGET INVARIANT:** Never calculates, displays, or exits on profit target.
- **Overnight Lifecycle:** Exempt from 15:35 EOD square-off; liquidates at 09:25:00 AM IST on next valid NSE trading day.

### 3. Strategy 3: NIFTY 09:25 ₹180 Directional Breakout (`NIFTY_BREAKOUT_180`)
- **Pre-Selection:** Filters CE and PE strikes with 09:25 candle open strictly $< ₹180.00$.
- **First-Breakout Trigger:** Evaluated from 09:25 to 09:45 AM IST; first contract crossing $\ge ₹180$ triggers BUY.
- **One-Cancels-Other (OCO):** Triggering Leg A immediately and permanently disables Leg B.
- **Target & SL:** Fixed ₹220 Target (+40 pts) and ₹160 SL (-20 pts) for exact 1:2 Risk-to-Reward.
- **Mandatory Time Cutoff:** Force closed at market price at 09:45:00 AM IST.

---

## 3. Technology Stack

- **Framework:** React Native 0.74 / Expo SDK 51 (TypeScript, Hermes Engine)
- **Market Data Feeds:** DhanHQ API v2 (`wss://api-feed.dhan.co`)
- **Security:** `expo-secure-store` (Hardware Keystore) + `expo-local-authentication` (Biometrics)
- **State Management:** Zustand with micro-batched selectors
- **Design System:** Obsidian Dark Palette (`#080A0F`, `#10B981` Bullish, `#EF4444` Bearish)
- **Virtualization:** High-performance list rendering for 60+ stocks and multi-strike option chains

---

## 4. Key Documentation & Architectural Blueprints

- **[`APPLICATION_BIBLE.md`](./APPLICATION_BIBLE.md):** Complete master architectural specification, forensic audit, quant engine formulas, and DhanHQ integration contracts.
- **[`Integration.md`](./Integration.md):** Detailed step-by-step integration blueprint, DhanHQ v2 binary protocol offsets, SEBI Static IP routing, and 12-phase rebuild roadmap.
- **[`dhan-api-docs.md`](./dhan-api-docs.md):** Official DhanHQ v2 API export (Market Feed WebSocket, Quotes, Option Chains, Super Orders).
- **[`DetailIdea.md`](./DetailIdea.md):** Repository architectural master index.

---

## 5. Getting Started

### Prerequisites
- Node.js 18+ and npm
- Expo CLI (`npm install -g expo-cli`)
- Android Studio / Xcode or Expo Go on a physical device

### Installation
```bash
# Clone the standalone repository
git clone git@github.com:athavrani/QStrategy.git
cd QStrategy

# Install dependencies
npm install

# Start the Expo development server
npm start
```

### Building Standalone Android APK
```bash
# Build standalone preview APK using EAS Build
npm run build:apk
```

---

## 6. License & Compliance
This software is built for proprietary algorithmic trading on the National Stock Exchange of India (NSE). All order routing conforms to SEBI regulations and DhanHQ API terms of service.
