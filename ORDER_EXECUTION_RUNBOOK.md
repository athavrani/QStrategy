# Order execution runbook

How to run QStrategy's Dhan order execution safely. It covers the daily routine, what each alert means, and what to do by hand when something goes wrong.

This feature places real orders. Read the "Known limits" section before you rely on it, and review the code and these steps with someone you trust before using it with money you cannot afford to lose.

## Before the market opens

Do these in Settings. Tap Run checks on the Readiness check card to test most of them in one go. It shows OK, CHECK or FIX for each item; fix every FIX before trading.

1. **Dhan live token.** Save a current access token. Tokens expire, so generate a fresh one if it is more than a day old.
2. **IP whitelist.** Tap Refresh IP status. It must say MATCH. If it says MISMATCH, your phone is on a different network from the one you whitelisted, and Dhan will reject every order. A mobile-network IP can change at any time.
3. **Mode.** Set Confirm for live trading. Off ignores signals. Paper records orders and sends nothing.
4. **Strategies.** Enable only the strategies you want, one lot each.
5. **Kill switch.** Must be off.
6. **Arm live trading.** Needs your fingerprint or face. It lasts until 15:30 IST and is cleared if the app restarts, so arm it again after any restart.
7. **Background monitoring and battery.** Keep background monitoring on and set the app to Unrestricted in Android battery settings, or Android may stop it and your stop-losses will not be placed.

## During the day

- A signal that passes every rule becomes a proposal on the Orders tab, with a notification. It expires after 2 minutes.
- To send it, tap Confirm and send live, accept the prompt, and pass the fingerprint check. The app re-checks everything first.
- Once the entry fills, the app places a stop-loss order at the exchange. The position shows PROTECTED. Until then it shows ENTRY PENDING or NO STOP-LOSS.
- If a target or time exit is reached, the position shows "Exit suggested". Nothing is sold until you tap Exit now.
- Exit now sells the whole position at market. The stop-loss is cancelled first so the shares are not sold twice.
- Exit ALL positions (red button above the positions) does the same for everything the app holds. Use it if you need to get out quickly. It reports any position it could not exit.
- The kill switch only stops new signals. It never removes a stop-loss and does not stop you from exiting.
- At the bottom of the Orders tab, Today's execution report shows how many signals were sent, missed or blocked, how fills compared with the limit price, and the closed profit and loss.

## What the alerts mean

| Alert | Meaning | What to do |
|---|---|---|
| NO STOP-LOSS | Shares are held and no stop-loss order is working. Usually Dhan rejected it (IP mismatch, expired token) or no price was set. | Fix the cause and tap Place stop-loss, or tap Exit now. If unsure, open the Dhan app and place a stop-loss or exit there. |
| Exit failed | The market exit was refused. | The app puts the stop-loss back. Read the reason on the position and try again, or exit in the Dhan app. |
| Cannot manage your positions / Dhan access token expired | The app cannot reach Dhan (after three failed checks in a row), or the token has expired. Stop-losses already at the exchange still work; new ones and exits through the app do not. | Open the Dhan app and check your positions. Renew the token and reopen QStrategy. |
| Dhan access token ends soon | Your access token ends within half an hour while you hold a position. | Renew it before it ends. |
| Connection to Dhan restored | The app can reach Dhan again after a failure. | Check the positions on the Orders tab are as you expect. |
| Stop-loss hit | The stop-loss order traded. The position is closed. | Check the P&L on the Orders tab and in Dhan. |
| Result unknown / UNCERTAIN | Dhan did not answer in time, so the order may or may not exist. | Do not send it again. Open the order book in the Dhan app. The app looks it up by its reference and will track it if it exists. |

## If the app is not working

The Dhan app is always the source of truth. If you are ever unsure what the app is doing, open Dhan, check Positions and Orders, and manage them there. Cancelling an order in Dhan is safe; the app will notice.

## Settings and defaults

| Setting | Default | Notes |
|---|---|---|
| Mode | Off | Confirm sends live orders after you confirm each one. |
| Live lots per order | 1 | Hard cap in the code (LIVE_MAX_LOTS), overriding the lots setting. |
| Orders per day | 3 | Counts live orders sent today that are not cancelled or rejected. |
| Value per order | Rs 50,000 | Price times quantity. |
| Value per day | Rs 1,00,000 | All of today's live orders. |
| Entry price buffer | 1% above the signal price | Buy limit, rounded up to the 0.05 tick. |
| Stop-loss limit price | 3% below the trigger | A stop-loss limit order, not a stop-loss market order. |
| Order hours | 09:15 to 15:25 IST | Trading days only. |
| Proposal time limit | 2 minutes | Then it expires and cannot be sent. |
| Manual test order | Up to 10 shares and Rs 5,000 | Same checks as a signal order. |

## Known limits

- **Overnight stop-losses.** Dhan day orders end at the close, and this app does not use Dhan's long-lived Forever Order. An overnight (OOBTST) position has no stop-loss at the exchange between the close and the next morning. The app places a new one after it confirms with Dhan that the shares are still held.
- **A stop-loss limit order can fail to fill** if the price gaps below its limit price.
- **Market exits can fill at a worse price** than the last price shown.
- **A mobile IP can change.** If it no longer matches, new orders and new stop-losses are rejected.
- **The app must be running.** Android can stop apps in the background. Stop-losses already placed at the exchange keep working without the app.
- **Only BUY entries on the three option strategies** (Breakout 180 and the two OOBTST strategies) are supported. The 20D volume screener is alert-only. There is no short selling and no fully automatic mode.
- **Sandbox behaviour differs from live.** Orders may sit in TRANSIT in the sandbox, and a sandbox test does not prove your live token or IP setup works.

## Rules and compliance

Check Dhan's and the exchange's current rules for retail API and algorithmic trading with Dhan or your compliance contact before using this with real money. This document is not advice on those rules.

## Raising the one-lot cap

Do this only after at least a few full cycles at one lot, each with an entry, a stop-loss or exit, and a record that matches the Dhan app. It is a code change (LIVE_MAX_LOTS in src/config/orderConfig.ts), so it needs a new build.
