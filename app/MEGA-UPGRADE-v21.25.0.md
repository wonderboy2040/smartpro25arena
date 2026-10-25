# MEGA UPGRADE — v21.25.0 (Direction Integrity + Dual-Board + AUTO Live)

Aapka sawaal tha: **"signals sahi LONG/SHORT direction me land kar rahe hain? Kahin ulta nahi ho raha (LONG signal → SHORT trade)? Fix karo."**
Aur do features ko deep-analyse karke upgrade karna tha — **MTF Dual-Timeframe Signal Board** aur **AUTO Live Trade intelligence**.

---

## 1. Seedha jawaab (short)

- **Inversion NAHI mili.** Har live row ka ticket geometry sahi side ka hai (`LONG: SL<entry<T1≤T2`, `SHORT: SL>entry>T1≥T2`), aur board side se order side tak koi flip nahi hota (`LONG/BUY → 'buy'`, `SHORT/SELL → 'sell'`, unknown side par order **refuse**).
- **Lekin** pehle ye baat kisi ek jagah par machine-checkable form me likhi hui nahi thi — 4 alag-alag vectors (geometry, handoff, vocabulary, level-repair) alag-alag files me bikhre hue the. Ek din koi bhi ek line badalti to ulta trade chup-chaap chala jaata.
- **Ab ek hi guard hai:** 🧭 **DIRECTION INTEGRITY GUARD (DIG)** — `server/ai/directionIntegrity.js`. Ye board row, paper/live execution, post-fill levels, aur poore auto-live book — chaaron jagah same invariant lagata hai.
- **Boot certificate:** `[direction-selftest] PASS 24/24` (18 purane + 6 naye DIG checks).
- **Independent auditor:** `npm run audit:direction` → **72 pass · 0 INVERSION · 28 counter-read (warn) · exit 0** (FUTURES + CRYPTO + INDIA).

---

## 2. MTF Dual-Timeframe Signal Board — naya kya hai

Har card par do naye chips:

| Chip | Kya batata hai |
|---|---|
| 🧭 **DIG ALIGNED 4/4 · 96/100** | Ticket geometry + context + trigger + EMA-stack + momentum — sab side ke saath. Hover par poora breakdown. |
| 🟢 **LIVE-READY 8/8 · 97/100** (ya `🎯 PAPER 4/8`) | AUTO LIVE ke 8-check conviction stack ka result. Hover par har check ✔/✘. |

Verdict ladder (jhooth nahi, sirf measurement):

- `ALIGNED` — ≥3/4 independent reads side ke saath.
- `COUNTER_READ` — 1–2 reads against (pullback / counter-trend). **1 read** = entry allowed par labelled; **2+ reads** = auto band (`WATCH-only`).
- `INVERTED` — 3+ reads against → **hard block** (yehi actual inversion ka signature hai).
- `GEOMETRY_BROKEN` — SL/T1/T2 hi ulti side ke → **hard block**.
- `MISSING_SIDE` — side hi nahi → **hard block** (silent LONG kabhi nahi).

Header par **board digest**: `🧭 DIR-INTEGRITY CLEAN · 6/6 aligned · 0 counter · 0 inverted` aur `🟢 LIVE-READY 1/6 · conviction 76/100`.

---

## 3. AUTO Live Trade intelligence — naya kya hai

1. **8-check LIVE conviction stack** (paper bar se strictly stricter): L1 direction-integrity → L2 pakka verification → L3 trigger fired → L4 6/8 institutional confluence → L5 2/3 AI models → L6 net RR (T1 ≥ 0.35R, T2 ≥ 1.2R) → L7 entry freshness → L8 koi trap/wall/reversal veto nahi.
   Conviction score = 0.34·superScore + 0.22·DIG + 0.16·confluence + 0.14·AI + 0.14·P(win) → `LIVE-A` / `LIVE-B` / `PAPER` / `WATCH`.
2. **Live bar gate:** `liveMinConvictionChecks` (default 5). Bar se neeche row **real order nahi lagati** — strict LIVE me entry skip, auto-sync me paper entry + `live-downgrade` log (silent kuch nahi).
3. **Pre-execution gate:** order jaane se *pehle* side canonical → DIG hard-block → geometry (auto-logged repair) → handoff assert. Fail = skip.
4. **Post-fill proof:** exchange fill ke baad SL/T1/T2 wapas validate; inverted ho to repair + log; repair na ho to trade **alert flag** ke saath track (untracked live position usse bhi kharab hai).
5. **Book watchdog:** `/api/ai/mtf-auto/status → directionIntegrityBook` — har OPEN trade ka side vs uske levels. UI me 🧭 **DIR-INTEGRITY BOOK CLEAN/INVERSION** chip.
6. Har book record par stamp: `signalSide` + `directionIntegrity {verdict, score, geometry, handoff:'VERIFIED', alert}`.

---

## 4. Kaise verify karein (aap khud)

```bash
cd app
npm run audit:direction          # 0 INVERSION chahiye (exit 0)
npm run boot-smoke               # 10 pass · 0 fail
curl -s -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8080/api/ai/mtf-dual/board?market=FUTURES&mode=INTRADAY" | jq '.directionIntegrity, .liveIntelligence'
```

Server boot par line dikhegi: `[direction-selftest] PASS 24/24 — rising→LONG/BUY · falling→SHORT/SELL certificate INTACT`.

---

## 5. Gates (is build par chale hue)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 errors) |
| `npm run check:version` | PASS — 21.25.0 |
| `npm run check:routes` | PASS |
| `npx vitest run` | PASS — 260 tests (naya `test/v2125DirectionIntegrity.test.ts` = 27) |
| `npm run build` + stamp | PASS — `dist/.build-version = 21.25.0` |
| `npm run boot-smoke` | 10 pass · 0 fail |
| `npm run audit:direction` | 79 pass · 0 INVERSION · 18 warn · exit 0 |

Detail report: **`app/AUDIT-REPORT-v21.25.0.md`**.
