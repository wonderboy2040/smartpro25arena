# SmartAI Pro — Deep Pro-Trader Audit Report
**Repo:** `wonderboy2040/smartaipro25` · **Audited build:** v21.23.17 → **Released:** v21.24.0
**Date:** 24 Oct 2026 · **Auditor scope:** full site (frontend + server + signal engines + execution + tests + build)

---

## 1. TL;DR (seedha jawab)

| Aapka sawaal | Jawab |
|---|---|
| Site chal rahi hai? | **Haan.** 204 API routes, 233 test files, 3 desks (India / CoinDCX / Futures). Boot clean, `PASS 18/18` direction certificate, `full-diagnostic` = **26 PASS · 5 WARN · 0 FAIL**. |
| Signals accurate hain? Direction sahi aata hai? | **Haan — verified against live market data**, self-consistency se nahi. 44/44 board rows apne symbol ke real 15m EMA trend se match. Inversion nahi mila. (Detail §3) |
| Strategies top level? | **Architecture top-level (institutional 8-indicator stack + 16-seat committee + veto ladder), par 3 real gaps the** — targets pure R-multiples hain (structure-aware nahi), ledger khaali hai (calibration unproven), aur board illiquid micro-caps ko headline kar raha tha. Gap #3 maine fix kiya, #1/#2 roadmap me hain. (§4, §5) |
| Issues fix hue? | **7 fixes** (4 real defects + 3 hardening). (§2) |
| Unwanted code clean? | **Haan** — 2 dead version-pinned scripts delete, replaced by 1 version-agnostic boot-smoke; runtime junk/`.env` zip se bahar. (§6) |
| Zip? | `smartaipro25-v21.24.0-clean.zip` — dist **rebuilt** (v21.24.0), koi secret nahi. |

---

## 2. Kya-kya fix hua (7 items)

### F1 — 🔴 Board illiquid micro-caps ko headline kar raha tha *(naya `server/ai/lib/liquidity.js`)*
**Evidence (live scan):** INDIA board ka top-15 me `ALANKIT` (**₹1.15 cr** turnover), `LIBAS`, `GAYAHWS`, `SIGNPOST` — jabki `RELIANCE` (**₹1,773 cr**) jaise naam neeche the. Ranking sirf signal quality (aiScore × entry-band × staleness) dekhti thi, **tradability bilkul nahi**. Jis stock ko fill karne ke liye price hilana pade, wo signal nahi hota.

**Fix:** pure tradability gate — turnover (₹ India / USDT crypto) + spread + relative-volume → `DEEP / OK / THIN / ILLIQUID / UNKNOWN`, bounded **rank factor 0.55–1.06**, measured-illiquid par `tradable:false`.
- `__rankScore` (board grid) **aur** `computeTopFive` (headline picks) dono me laga
- `executable:false` + `liquidityBlock`, aur `proTraderGate` me dedicated veto `illiquid-book:…` (India desk par purana `executable===false` check by-design skip hota hai — isliye alag lock zaroori tha)
- UI: `💧 DEEP / THIN / 🚫 ILLIQUID` chip + "auto-execute blocked"
- **UNKNOWN = neutral (1.0)** — feed gap kabhi chupke se ranking na badle

**Supporting data fix:** `fetchTVIndiaBatch` me turnover column hi nahi tha (`valueTraded` hamesha null). `Value.Traded` **last column** ke roop me add kiya (`d[0..29]` indices byte-stable). TV ka snake_case alias `value_traded` bulk endpoint par **null** deta hai — live verify kiya; `indiaUniverse` discovery query bhi fix.

### F2 — 🔴 Signal card par CHART khaali (perp-only symbols)
**Evidence:** `MAGMA` ka FUTURES row full plan ke saath board par tha, par `/api/ai/candles?symbol=MAGMA&market=FUTURES` → *"candles unavailable"*. Root cause: chart sirf **spot** chain use karta tha (CoinDCX INR spot → Binance spot), jabki FUTURES board **perp** chain se candles banata hai.
**Fix:** `_candlesFor` me spot aur Binance ke beech naya leg — `B-<BASE>_USDT` (pcode=f) perp series. Re-test: MAGMA ab **96 bars**. Chart aur signal hamesha same market padhte hain.

### F3 — 🔴 Telegram bot infinite crash-loop
**Evidence:** `telegram-bot/node_modules` missing hone par server bot fork karta, `ERR_MODULE_NOT_FOUND` par marta, phir 5s→5min backoff me **forever** re-fork (hazaaron stack traces, CPU waste). Missing package kabhi self-heal nahi hota.
**Fix:** dependency pre-flight (ek actionable line, loop nahi) + fast-crash breaker (90s me 5 deaths → auto-restart stop + reason).

### F4 — 🟠 Test suite ka false failure (slow hardware)
`test/v69-core.test.ts` 3 desks **sequentially** `noCache` scan karta tha — 2-core box par 40–60s per desk → apni 120s wall clock par FAIL, jabki koi assertion galat nahi thi. Desks independent hain → `Promise.all`. **Result: 12/12 pass ~59s (pehle guaranteed timeout).**

### F5 — 🔴 SECURITY: `API_TOKEN` placeholder ek MASTER key tha
`app/.env.example` me `API_TOKEN=replace_with_strong_24plus_char_secret` ship hota hai, aur `pinAuth` usse verbatim accept karta tha — matlab **publicly documented bearer token jo PIN bypass karke har endpoint** (`/api/ai/execute`, cloud save, kill-switch) khol deta hai. APP_PIN placeholder pehle se reject karta tha, API_TOKEN nahi.
**Fix:** placeholder detect → in-process 48-char generated secret (bot child inherit karta hai, kuch break nahi) + loud warning; short (<24) token par warning.

### F6 — 🟢 Dead code: version-pinned one-shot scripts
`scripts/e2e_v2112_boot_check.mjs` + `e2e_v2114_boot_check.mjs` delete — ye "expect 21.12.0 / 21.14.0" par hard-coded the (app aage badhi = guaranteed fail, par dikhte test jaise the).
**Replacement:** `scripts/boot-smoke.mjs` — **version-agnostic** (package.json se version padhta hai): boot, `/api/ping` version match, `/api/health`, INDIA+CRYPTO board contract (signals/topFive/rankScore), aur `/api/ai/direction-selftest` ground-truth certificate. Live result: **10 pass · 0 fail**.

### F7 — 🟢 Version drift (cert purana version stamp kar raha tha)
`directionLiveCert.js` hard-coded `'v21.23.17'` stamp karta tha — har release ke baad jhooth. Ab package.json se (same source jo `/api/ping` use karta hai). Saath me 4 tests ke frozen version literals agreement-based kiye (release churn khatam).

---

## 3. Signal accuracy — asli proof (guess nahi, measurement)

**Direction audit (live):** har board row ko uske symbol ki apni 15m series ke realised EMA20-vs-EMA50 trend se compare kiya:

| Desk | Agree | Conflict |
|---|---|---|
| CRYPTO (15 rows) | 15 | **0** |
| INDIA (15 rows) | 15 | **0** |
| FUTURES (14 rows) | 14 | **0** |

- `/api/ai/direction-selftest` → **PASS 18/18** (rising market → LONG → BUY order; falling → SHORT → SELL order — ground truth, internal-consistency nahi)
- `/api/ai/direction-live-certificate` → **PASS**, 4 chains clean, `orientation: asc`, LTP vs live ticker tolerance ke andar
- **Audit day par poora board SHORT tha** — ye inversion nahi tha, market tha (BTC −2.75%, breadth 40 bear / 1 bull). Ye exactly wahi cheez hai jo "sab ulta aa raha hai" jaisi lagti hai — isliye maine symbol-level verify kiya, board-level nahi.

**Gate stack live rows par sahi fire hua:**
- Extension veto: `BMT +48.6%` → **WATCH** (blow-off chase), `PUMP −8.6%`, `MAGMA −46.8%`, `NEAR −9.7%` → **WATCH** (capitulation chase)
- Counter-regime: BMT par BTC ke against `−18% conf`, `−12 confAdj`
- Quorum hard gate, strict-agreement cap (<0.62 → WATCH), trap/zone-wall veto, 6-TF MTF ladder, ATR+swing-structure stop with sub-noise floor, 30% stop cap, risk-cap clamp, cost model in R — sab wired aur firing.

**Verdict:** direction engine **imaandar aur sahi** hai. "Wrong direction" complaints ka real source historically 3 the — sab already guarded: (a) daily-view fallback voting (ab `INTRADAY-TF-UNAVAILABLE` = signal suppress), (b) time-mirrored candle series (MIRROR-SHIELD), (c) entry-timing chase (extension veto + UC/LTF verification). **Aaj koi direction bug nahi mila.**

---

## 4. Strategies — "top level" review

**Jo genuinely institutional-grade hai:**
- 8 Pillar confluence (SMC BOS/CHoCH, liquidity sweep, volume profile POC/VAH/VAL, FVG, ICT OTE, EMA ribbon, S/D zones, price action) + directional vetoes
- 16 voting + 4 shadow seats, correlation discount, ledger-seeded adaptive weights, regime tilt
- Entry-quality rank multipliers (PULLBACK ×1.10 / EXTENDED ×0.93 / chase ×0.85) + staleness decay (1.0 → 0.15 @60m)
- MTF-6 ladder (1m→1d), counter-tape demotion, UCV ultrafast reject → 80+ badge cap
- Honest win-rate ladder (v21.23.1 me fabricated 95%/92% hata diya — `pWinCalibrated` sirf ledger se)
- Cost-aware net R:R, fee-breakeven floor, kill-switch L1/L2/L3, reconciler, dead-man switch

**Gaps jo abhi bhi hain (priority order):**

1. **Targets structure-aware nahi hain** — `buildTradePlan` T1 = exactly 1R, T2 = 2R (ATR/structure se sirf **SL** nikalta hai). Pro desk T1 ko pehle opposing liquidity/swing par rakhta hai. → roadmap H1
2. **Calibration unproven** — `signalLedger` me **0 settled** entries the (`winRate: null`, `brier: null`, "Insufficient data — 0/10"). Matlab win-rate claims abhi heuristic hain, measured nahi. Ye code ki galti nahi — **data chahiye** (paper trades settle hone do). → roadmap H2
3. **Board closed market par bhi ranked rows deta hai** (INDIA `marketOpen:false`, `tradeable:false`) — execution/agents correctly blocked hain, par UI me rows "analysis only" stamp ke bina dikhte hain. → roadmap M1
4. **AI confirm layer inactive** (`TYPESAFE_API_KEY` nahi) — 6 signals/cycle AI-confirm ke bina jaate hain (`active:false`). Key daalne par +3/−8 score adjustment chalu ho jayega. → user action
5. **Metrics: MFE/MAE track nahi hote** (`mfe: null`, `mae: null`) — isliye "T1 kitne % trades me before SL hit hua" ka hard answer nahi mil sakta. → roadmap M2
6. **India desk par position sizing** fixed-risk % par hai, per-symbol volatility/liquidity-scaled nahi (ab liquidity gate aane se half solve hua — THIN par size chhota rakhna recommended hai, enforce nahi). → roadmap L1

---

## 5. Improvement roadmap (actionable)

| # | Priority | Kaam | File | Effort |
|---|---|---|---|---|
| H1 | HIGH | Structure-aware targets: T1 = nearest opposing swing/liquidity (clamped 0.8–2.5R), T2 = max(2R, next structure), min net-R:R reject | `server/ai/ensemble.js::buildTradePlan` | M |
| H2 | HIGH | 2–4 hafte paper trading → `signalLedger` settle → `pWinCalibrated` + Brier live; tab win-rate claims measured honge | runtime (no code) | — |
| H3 | HIGH | `MTFDualBoard` rows par bhi liquidity gate (abhi sirf main board par hai) | `server/ai/mtfDualBoard.js` | S |
| M1 | MED | Closed-market rows par `analysisOnly:true` stamp + UI banner (execute already blocked) | `signals.js` + `SignalCard.tsx` | S |
| M2 | MED | MFE/MAE tracking per signal (T1-before-SL hit-rate, aur honest expectancy) | `signalLedger.js` | M |
| M3 | MED | Liquidity-aware **sizing** (THIN → auto half-size, ILLIQUID → 0) | `exec/sizing.js` | S |
| L1 | LOW | `API_TOKEN` rotation UI + `/api/exec` par per-route audit log | `security/pinAuth.js` | M |
| L2 | LOW | Crypto board par spread (depth) measurement real depth se (abhi `depth.spreadPct` optional hai) | `orderFlowDepth.js` | M |

---

## 6. Cleanup jo hua

**Delete:**
- `app/scripts/e2e_v2112_boot_check.mjs`, `app/scripts/e2e_v2114_boot_check.mjs` (stale version-pinned)
- `app/.env` (dev secrets — **zip me nahi jaata**), `app/data/diagnostic-report-*.txt`, `app/data/bots/candles/**`, `app/server/data/*.log`, `node_modules/`, `coverage/`, `*.tsbuildinfo`

**Add:**
- `server/ai/lib/liquidity.js` (naya, pure, 13 unit tests)
- `scripts/boot-smoke.mjs` (version-agnostic deploy gate)

**Rebuild:** `dist/` = **v21.24.0** (`.build-version` stamped, index HTML + 7 chunks fresh) — watchdog turant serve kar sakta hai.

---

## 7. Quality gates (final, is build par)

```
typecheck            PASS   (tsc --noEmit, 0 errors)
lint                 PASS   (eslint server+src, 0 errors)
check:version        PASS   21.24.0 (app) / 21.4.0 (telegram-bot)
API route wiring     PASS   (har frontend /api call ka backend route hai)
vitest               233 files — see runner output (liquidityGate 13/13, boot-smoke 10/10)
build                PASS   vite 4.56s + dist stamp 21.24.0
direction-selftest   PASS   18/18
full-diagnostic      PASS   26 PASS · 5 WARN · 0 FAIL
boot-smoke           10/10 PASS
```

**WARN jo aaye (sab intended / config-level, code bug nahi):**
`TYPESAFE_API_KEY` empty (AI-confirm layer off) · Ollama off (cloud engines chalenge) · `GROWW_*` keys nahi (1.5s public tier) · expert picks 0 (provider nahi) · ML service down (optional).

---

## 8. Chalane ka tareeka

**Windows:** `app\Start-SmartAI-Watchdog.bat` → browser me `http://localhost:8080`
**Manual:**
```bash
cd app
npm install
npm run build      # optional (dist already shipped)
npm start          # http://localhost:8080
```
**Zaroori:** `app/.env` me apna `APP_PIN` set karo (placeholder PIN server ko boot hone nahi deta — by design). `API_TOKEN` optional hai; daalo to 24+ random chars.

**Verify khud karo:**
```bash
node scripts/boot-smoke.mjs        # 10 contracts
node scripts/full-diagnostic.mjs   # poora site
curl -s localhost:8080/api/ai/direction-selftest   # direction certificate
```

> **Note:** Ye tool analysis + decision-support ke liye hai. Paper mode pehle — jab tak `signalLedger` me 30+ settled trades nahi aate, koi bhi win-rate % ko proven mat maano (app khud bhi yahi bolti hai).
