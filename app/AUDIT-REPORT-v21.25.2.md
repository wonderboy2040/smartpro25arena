# AUDIT REPORT — v21.25.2 FULL-SITE ADVANCE RECHECK (2026-10-25)

**User ask:** *"latest repo ko pull karo aur full site code advance pro level pe recheck karo aur issues fix kardo — sab features and functions working flow theek se kaam kar raha hai ya nahi."*

**Verdict: site chal rahi hai — teeno desk (India Intraday · CoinDCX · Bot Lab) live data par render hote hain, board LONG/SHORT sahi de rahe hain (0 inversion), AUTO paper trade sach me lagta hai, paper desk round-trip OK, kill-switch gate karta hai, SSE streams live hain. 3 real defects mile + fix hue, 2 harness defects (jinka "failure" report jhoota tha) bhi fix hue. Jo cheezein band hain wo SIRF missing credentials / optional services ki wajah se hain — code break nahi.**

---

## 0) Repo pull

| Step | Result |
|---|---|
| `git remote -v` | koi remote nahi tha → `origin` add kiya = `https://github.com/wonderboy2040/smartpro25arena` |
| `git fetch origin` | `origin/main` = **`54e7716`** ("feat(v21.25.0)…") |
| `git diff --stat origin/main` | tracked files **already identical** — sirf v21.25.1 ke naye artefacts extra the |
| Verdict | **Koi naya upstream commit nahi tha** → merge/rebase ki zaroorat nahi. Recheck latest code par hi chala, phir usi par v21.25.2 fixes. |

---

## 1) Kya-kya chalaya gaya (verification surface)

| Gate | Natija |
|---|---|
| `npm install` + `npm run build` + `dist/.build-version` | OK → **21.25.2** |
| Boot `[direction-selftest]` | **PASS 24/24** · committee 16 voting + 4 shadow · accuracy-suite ON |
| `npm test` (full vitest) | **236 files · 4458 tests · 0 fail** (450s) |
| `npm run typecheck` | clean (0 error) |
| `npm run lint` | clean |
| `npm run check:routes` | **PASS** |
| `npm run check:version` | OK — 21.25.2 (app + telegram-bot lockfiles sync) |
| `npm run audit:direction` | **42 pass · 0 INVERSION** · 4 counter-read (WATCH-only rows, auto-bar blocked) |
| `npm run diagnose` (full-diagnostic) | **PASS 26 · WARN 5 · FAIL 0** |
| `node scripts/route-sweep.mjs` | **106 routes · 5xx 6 (sab declared degrade) · failures 0 · contracts 27/27 · PASS** |
| `node scripts/ui-smoke.mjs` (naya, headless Chromium) | **PASS 15/15** |
| `npm run boot-smoke` | **10 pass · 0 fail** |

### Live flow proofs (real market data, is machine)
- **5 MTF dual boards** (FUTURES · CRYPTO · INDIA · METALS · GLOBALFUTURES): sab `ok:true`, sides sirf **LONG/SHORT**, digest `inverted:0 · geometryBroken:0`, har ticket geometry side se match (LONG: SL < entry < T1; SHORT: ulta).
- **AUTO paper tick ne asli trade liya:** `BNB LONG · score 82 STRONG · leverage 5` → entry 743 · SL 738.63 · T1 747.37 · T2 751.74 · fee-breakeven 743.89 · source `mtf-auto` → CoinDCX tab ke Paper Desk me turant dikha.
- **Paper round-trip:** open → list → close (`MANUAL`) → history me pnl ke saath. NSE band hone par INDIA entry honestly **refuse** hui ("NSE closed / past 15:00 cutoff") — galat trade nahi lagta.
- **Kill-switch:** ON → auto tick skip `"global kill-switch ON"`; OFF → normal. (Ab empty body se silently disarm nahi hota — Fix 2.)
- **SSE:** `/api/stream`, `/api/intraday-stream` (`IN_BTC`/`FUT_BTC` ticks), `/api/ai/positions/stream` — sab live events bhej rahe hain.
- **UI:** PIN gate (galat PIN → error, sahi PIN → unlock), teeno desk render (INDIA 29k chars · CRYPTO 19k · BOT LAB 1.8k), theme toggle, reload ke baad session bacha, **0 console error · 0 page error · 0 failing `/api/*`** during a full browser session.

---

## 2) Fixes (v21.25.2)

### Fix 1 — AUTO skip-reason galat wajah bata raha tha (user-facing honesty bug)
Har non-self-verified row par ek hi line chhapti thi: *"main AI-BOARD ensemble signal unavailable"* — chahe ensemble theek chal raha ho aur asli rukawat **score floor / trigger pending / adhoora ticket** ho.
Live evidence (fix se pehle): `NVDA: score 64 < 75, main AI-BOARD ensemble signal unavailable`.

Ab `selfVerifyMissing(row)` + `autoSkipReason(row)` (server/ai/mtfDualBoard.js) har fail condition naam se batate hain, aur `selfVerifiedForAuto()` **isi list ka empty hona** hai (single source of truth — gating me zero behaviour change, prove by 8-case parity test):

```
ZRO: score 64 < 75, main AI-BOARD ensemble signal unavailable —
     self-verify pending: direction PAKKA verify pending, trigger not fired, reversal risk +1 more
```

### Fix 2 — kill-switch route silent DISARM (safety bug)
`POST /api/ai/trading/kill-switch` sirf `{enabled}` padhta tha. `{"on":true}` bhejne par `enabled=false` ban jaata tha → switch **chup-chaap DISARM**. Safety switch ke liye galat default.
Ab: `enabled` / `on` / `killSwitch` teeno alias, aur **koi explicit boolean na ho to `400`** ("send {\"enabled\":true}") — no-body mutation se disarm impossible.
Live proof: `{}`→400 · `{on:true}`→killSwitch true · `{enabled:false}`→false.

### Fix 3 — route-sweep harness reliable gate bana
Pehla run 11 "failures" dikha raha tha jo bug nahi the (5 SSE routes ka 45s timeout + 6 optional-service 5xx). Ab harness:
- **SSE-aware** — `isSseRoute()` source se detect, `hitSse()` stream khol kar bounded 4s me pehle bytes padhta hai → live/dead classify (phantom fail khatam).
- **declared-degrade aware** — orderbook / expert(ml-service) / cloud load / intraday-briefing ko **named WARN** (chhupata nahi, print karta hai), FAIL nahi.
- **param-aware** — GET sweep ke 400 (missing query param) = route validate kar raha hai → WARN, aur error object readable.
- **kill-switch contract** live assert (empty 400 · `{on:true}` arms · `{enabled:false}` disarms).
Result: `failures 0 · contracts 27/27 · RESULT PASS`.

### Fix 4 — full-diagnostic ka WebSocket false-alarm
`coindcxFutures` / `binanceFutures` ko "WS down" WARN karta tha jab `lastTickAt` null par **failStreak 0 + koi cooldown nahi** (yaani handshake fail nahi hua, sirf koi attributable tick nahi aaya — REST poller prices de raha hai). Ab wo case **INFO** hai; WARN sirf real handshake failure/cooldown par. (WARN 7 → 5, dono asli credential warns bache.)

### Naya tool — `scripts/ui-smoke.mjs`
Server probes UI prove nahi kar sakte. Ye script headless Chromium se asli app chalata hai: login gate (galat PIN ka negative test bhi), teeno desk render + visible content, theme toggle, reload session, aur console/page/API error budget. Screenshots + per-desk text `app/data/ui-audit-<ts>/`. Chalane ke liye: `PLAYWRIGHT_HOME=<dir with playwright> node scripts/ui-smoke.mjs` (playwright production dependency nahi banaya — install heavy na ho).

> Note (harness honesty): isi script ne khud ek false-positive pakda — `text=SMARTAI PRO` Playwright me case-insensitive hai, to login screen ka "SmartAI Pro" heading bhi match ho jaata tha ("unlocked" jhooth). Ab unlock probe `[role="tab"]` (terminal shell sirf auth ke baad) + "Unlock Terminal" button gayab hona — dono real signals.

---

## 3) Jo band hai — aur WO BHI HONESTLY (code break nahi)

| Feature | Status | Reason / kya chahiye |
|---|---|---|
| ⚡ LIVE auto-trade (real money) | **blocked** | `COINDCX_API_KEY` + `COINDCX_SECRET` nahi → LIVE arm hi nahi hota (by design). Paper lane 100% chalti hai. |
| 🤖 Jev AI-confirm layer (Bot Lab + board AI chip) | inactive | `TYPESAFE_API_KEY` empty → provider none, layer `active:false` (signals normal chalte hain) |
| India 1s LTP tier | public 1.5s tier | `GROWW_API_KEY/SECRET` nahi |
| Mesh seats 4/10 | partial | `ALPHAVANTAGE / TRADINGCENTRAL / QUIVER / MASSIVE / COINAPI / ALPACA` keys nahi |
| `/api/ai/expert/*` | 503 | `ml-service` optional sidecar (is host par nahi chalta) |
| `/api/ai/orderbook`, `/api/ai/depth` | 502 / ok:false | CoinDCX public depth is host se reachable nahi (koi exchange key nahi) |
| `/api/cloud/load*` | 502 | cloud-sync Apps Script URL configure nahi |
| `/api/intraday-briefing` | 502 | LLM engines 0/7 ready (ollama off, cloud keys nahi) — fake briefing nahi banata, honest degrade |
| Telegram bot | not started | `node-telegram-bot-api` install nahi + `TG_TOKEN` invalid (`getMe` 404) — web terminal par asar nahi |
| CoinDCX futures **WS** | REST poller par | is sandbox network se futures WS tick attributable nahi (failStreak 0, cooldown nahi) — `coindcx-spot-ws` healthy, `coindcx-fut-rt` 2s REST live, prices fresh |
| `/api/bots/backtest` | 400 by design | `bars[]` (≥60) chahiye — bars ke bina kuch calculate nahi karta (fake pWin nahi) |

---

## 4) Changed files (v21.25.2)

```
server/ai/mtfDualBoard.js      + selfVerifyMissing / autoSkipReason, precise skip text (gating same)
server/ai/routes.js            kill-switch: enabled|on|killSwitch + explicit-boolean 400
server/index.js                doc comment corrected (no-body disarm no longer possible)
scripts/route-sweep.mjs        SSE-aware + declared-degrade + param-aware + kill-switch contract
scripts/full-diagnostic.mjs    WS "no attributable tick yet" = INFO, not WARN
scripts/ui-smoke.mjs           NEW — headless Chromium end-to-end UI gate
test/v21252Recheck.test.ts     NEW — 17 cases (skip reasons · gating parity · kill-switch · harness)
docs/CHANGES.md                v21.25.2 entry
package.json / src/version.ts / package-lock.json / Start-SmartAI-Watchdog.bat   version 21.25.2
```

## 5) Artifacts (is build par)

- `app/data/ui-audit-<ts>/` — per-desk screenshots + visible text (INDIA / CRYPTO / BOTS)
- `app/data/diagnostic-report-<ts>.txt` — full-diagnostic output
- `app/data/ui-smoke-<ts>.txt` — UI smoke output

## 6) Agla step (agar real money / full AI chahiye)

1. `.env` → `COINDCX_API_KEY` + `COINDCX_SECRET` (LIVE lane + depth/orderbook)
2. `.env` → `TYPESAFE_API_KEY` (Jev AI-confirm + Bot Lab AI arm)
3. `.env` → `GROWW_API_KEY` + `GROWW_SECRET` (India 1s tier)
4. Optional: `ALPHAVANTAGE / TRADINGCENTRAL / QUIVER / MASSIVE / COINAPI / ALPACA` (mesh 4/10 → 10/10), valid `TG_TOKEN`
5. Phir: `npm run boot-smoke && npm run diagnose && node scripts/route-sweep.mjs` — teeno green hone par hi LIVE lane arm karo.
