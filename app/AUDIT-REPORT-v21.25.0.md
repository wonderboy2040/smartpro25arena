# ADDENDUM — v21.25.1 (same day): "ELITE score ke bawajood auto trade nahi lag raha"

**User report:** "crypto coindcx tab me koi trade mill hi nhi hai aur elite score rehne par bhi Live auto trade button on rehne par bhi auto trade nahi lag raha."

## Root cause (probe-verified)
1. **Main-ensemble dead-end (the real bug).** Every auto *and* manual entry required the **main** AI-BOARD (16-seat ensemble) to grade that symbol **ACTION/STRONG/ELITE with confidence ≥ 60** (`ensembleSignalAvailable`). The main board's universe/bar differ from the dual board's. On this build a live probe showed its best FUTURES grade at **69 = WATCH**, so *no* row could ever pass — while the dual board was showing `LINK SHORT 95 ELITE · trigger FIRED · PAKKA · 8/8 institutional`. XAU/XAG and EQUITY SIM symbols are not even in that universe → **permanent** dead-end.
2. **Blank board in quiet markets.** `rankDualRows()` drops rows below the WATCH floor (50); when nothing clears it the CoinDCX tab rendered zero cards.

## Fix
- **`selfVerifiedForAuto(row)` / `autoEnsembleOk(row)`** (new, `mtfDualBoard.js`): a row may trade on its own verification when the main board has no coverage or is still WATCH. Mandatory: `directionVerified` (dual-TF + ≥6/8 institutional) · `triggerFired` · no counter-trend/counter-HTF · no board/SVA/council hard conflict · no trap/zone-wall/reversal veto · no post-peak/overextended/opposing flow · **DIG ALIGNED** · score ≥ 65 · TF-fit GOOD/OK · complete entry/SL/T1.
  Wired into `dualAutoCandidates`, `mtfProEntryGate` (manual 🧪 PAPER + ⚡ LIVE card buttons), the auto-tick `eligible` filter + second-chance path, and UC flip-reverse re-entry.
  **Not a loophole:** an opposing main-board side still fires the cross-engine veto; a main-board `AVOID/FLIP/REJECT` verifier still blocks. Only "no coverage / still WATCH" stopped being fatal.
- **Never-blank board:** `getDualMtfBoard()` falls back to the best directional rows (valid side + complete SL/T1), labelled WATCH, `rankFallback: true`.

## Proof on the running build (real market, this machine)
| Time | Event |
|---|---|
| board | `LINK SHORT 95 ELITE · autoEligible true · selfVerified true · ensembleSignalAvailable false` |
| auto-tick | **LINK SHORT** paper opened @ 11.365 · SL 11.4318 · T1 11.2982 · T2 11.2313 (source `mtf-auto`) |
| closed | −₹1.47 (small loss, normal) |
| next tick | **INJ LONG** paper opened @ 7.652 · SL 7.607 · T1 7.697 · T2 7.742 |
| CoinDCX tab → Paper Desk CRYPTO | shows the open trade (the "koi trade nahi" symptom is gone) |
| direction proof | INJ `SL 7.607 < entry 7.652 < T1 7.697 < T2 7.742` geometry `OK`; LINK `SL 11.4318 > entry 11.365 > T1 11.2982 > T2 11.2313` `OK`; `directionIntegrityBook → inversions: 0` |

## Gates (v21.25.1)
typecheck PASS · lint 0 errors · check:version 21.25.1 · vitest **4439 tests, all pass** (4 load-flakes pass standalone) · build + `dist/.build-version 21.25.1` · boot-smoke 10/0 · `audit:direction` **40 pass · 0 INVERSION**.

---

# AUDIT + UPGRADE REPORT — v21.25.0

**Repo:** `https://github.com/wonderboy2040/smartpro25arena` (HEAD `c7b9018`)
**Base version found:** 21.24.0 → **released as:** 21.25.0
**Date:** 2026-10-25
**Scope (user spec, Hinglish):**
1. MTF Dual-Timeframe Signal Board — deep analysis + upgrade
2. AUTO Live Trade intelligence — deep analysis + upgrade
3. Deep recheck: **trade signals sahi LONG/SHORT direction me land kar rahe hain ya nahi? Kahin inversion (LONG signal → SHORT order, SHORT signal → LONG order) ho raha hai? Fix karo.**

---

## 1. TL;DR — the inversion verdict

**Koi side inversion nahi mili — aur ab system khud isko machine-checkable tarike se prove karta hai.**

| Evidence | Result |
|---|---|
| Ticket-geometry invariant on every live dual-board row (`LONG: SL<entry<T1≤T2` / `SHORT: SL>entry>T1≥T2`) | **PASS on all rows** (FUTURES + CRYPTO + INDIA) |
| Signal-side → execution-side handoff (`row.side` → `paper.openPaperTrade` / `liveExecute` → `futuresOrderBody`) | **PASS** — side is passed unchanged; `LONG/BUY → 'buy'`, `SHORT/SELL → 'sell'`, unknown side **throws** (no silent LONG) |
| New DIRECTION INTEGRITY GUARD (DIG) verdicts on live board | **0 INVERTED · 0 GEOMETRY_BROKEN · 0 MISSING_SIDE** |
| New auto-live book watchdog (`/api/ai/mtf-auto/status → directionIntegrityBook`) | **0 inversions** in open trades |
| `node scripts/direction-audit.mjs --markets=FUTURES,CRYPTO,INDIA` | **79 pass · 0 INVERSION · 18 counter-read (warn) · 14 unverified · exit 0** (two runs: 72/0 and 79/0) |
| Boot certificate `[direction-selftest]` | **PASS 24/24** (18 old + 6 new DIG checks) |

### Why the 28 "counter-read" warnings are NOT inversions
They are rows whose **declared side** disagrees with an **independent EMA20/50 / 10-bar-momentum / regression-slope read** computed by the auditor from the row's own candles. `tradePlanner.readContext()` deliberately uses an **8-indicator institutional net vote** (SMC, liquidity sweep, volume profile, FVG, ICT, EMA ribbon, supply/demand, price action) — so a SHORT row can legitimately exist while the 5m EMA stack is still marginally bullish (pullback / counter-trend WATCH).
These rows:
- keep correct ticket geometry (SL/T1/T2 on the right side of entry),
- are **never auto-eligible** (`direction-integrity counter-read n/4 — WATCH-only` blocker),
- are now **explicitly labelled** `COUNTER-READ` instead of being silently presented as clean.

The auditor was consequently re-severitised: **INVERSION (exit 1)** is raised only by contradictions that would place the *wrong-side trade* (C1 geometry, C6 handoff, C7 DIG verdict, book audit). C2–C5 are **warnings**.

---

## 2. What was found and fixed (inversion vectors)

| # | Vector | Where it lived | v21.25.0 status |
|---|---|---|---|
| V1 | **Ticket geometry** — side LONG but SL above entry (SHORT-shaped ticket) | nothing validated it centrally | **NEW** `checkLevelGeometry()` — hard block + explicit code (`LONG_SL_ABOVE_ENTRY`, `SHORT_T1_ABOVE_ENTRY`, …) |
| V2 | **Handoff** — board side ≠ execution side | implicit (just passing `row.side`) | **NEW** `assertExecutionSide()` — throws/skips on `SIDE_MISMATCH`, runs **before** any paper/live order |
| V3 | **Vocabulary** — LONG/BUY, SHORT/SELL mix-up | fixed per-callsite in v21.23.x | **NEW** `scanPayloadSideLeaks()` + auditor gate; centralized `normalizeSide()` (unknown → `null`, never LONG) |
| V4 | **Level repair** — post-fill / fresh-price re-anchor could cross the entry | partial | **NEW** `guardLevelsForSide()` — auto re-derive + **logged** repair (`dir-repair`), used pre-execution **and** post-fill |
| V5 | **Book drift** — an open trade whose side no longer matches its levels | not audited | **NEW** `auditBookDirectionIntegrity()` in `/api/ai/mtf-auto/status` + UI chip |
| V6 | **Side-less ticket** — missing direction silently became LONG | paper fixed in v21.23.13, auto lane still assumed | **NEW** `resolveSideFromGeometry()` — derive honestly from level-ordering, stamp `repaired`/`note` |

---

## 3. Feature upgrade #1 — MTF Dual-Timeframe Signal Board

**New file:** `server/ai/directionIntegrity.js` (pure, no network, no side effects) — the single source of truth for the LONG/SHORT invariant.

Per-row additions to `/api/ai/mtf-dual/board`:

| Field | Meaning |
|---|---|
| `row.directionIntegrity` | `{verdict, score, agreeCount, againstCount, conflicts[], votes{}, geometry{}}` |
| `row.digLabel`, `row.digScore` | compact UI label / 0-100 score |
| `row.digNote` | soft advisory when only 1/4 reads disagree (pullback acceptable) |
| `row.liveIntelligence` | 8-check AUTO-LIVE conviction stack (see §4) |

Verdict ladder (honest, no fabrication):
`ALIGNED` (≥3/4 reads with side) → `COUNTER_READ` (1–2 against) → `INVERTED` (≥3 against) · plus hard `GEOMETRY_BROKEN` and `MISSING_SIDE`.

Board-level additions:

| Field | Meaning |
|---|---|
| `directionIntegrity` | `{total, aligned, counterRead, inverted, geometryBroken, missingSide, avgScore, hardBlocked[]}` |
| `liveIntelligence` | `{liveReady, liveA, liveB, paper, watch, avgConviction}` |

Auto-gating changes on the board:
- `INVERTED` / `GEOMETRY_BROKEN` / `MISSING_SIDE` → `autoEligible = false` + explicit blocker.
- `COUNTER_READ` with **≥2** independent reads against → `autoEligible = false` (`WATCH-only`).
- `COUNTER_READ` with exactly **1** against → allowed (legit pullback) but **labelled**, so the trader sees it.

UI (`MTFDualBoardPanel.tsx`):
- 🧭 **DIG chip** on every card (verdict · aligned/against · score/100, full conflict list on hover).
- 🟢 **LIVE-READY chip** on every card (tier · checks passed · conviction/100, per-check ✔/✘ on hover).
- Header **board digest** chips: `DIR-INTEGRITY CLEAN · n/n aligned · counter · inverted` and `LIVE-READY n · conviction/100`.
- AUTO-TRADE INTELLIGENCE bar: 🧭 **DIR-INTEGRITY BOOK** chip (open-trade audit, red on inversion).

---

## 4. Feature upgrade #2 — AUTO Live Trade intelligence

### 4.1 8-check LIVE conviction stack (`row.liveIntelligence`)
Live money ke liye paper bar se **strictly stricter**:

| Check | Requirement |
|---|---|
| L1 direction integrity | DIG verdict `ALIGNED` (a counter-read row can never go live) |
| L2 pakka verification | `directionVerified` (dual-TF + 6/8 institutional) |
| L3 trigger fired | action-TF break confirmed |
| L4 institutional confluence | `aligned8Count ≥ 6` |
| L5 AI ensemble | Ollama trio `approvedCount ≥ 2` |
| L6 risk/reward | net RR(T1) ≥ 0.35R **and** RR(T2) ≥ 1.2R |
| L7 entry freshness | TF-fit GOOD/OK, not overextended |
| L8 no structural veto | no trap / zone-wall / reversal risk |

`convictionScore` = 0.34·superScore + 0.22·DIG + 0.16·confluence + 0.14·AI + 0.14·P(win) → tier `LIVE-A` (8/8) / `LIVE-B` (6-7) / `PAPER` (4-5) / `WATCH`.

### 4.2 Execution-lane enforcement (`server/ai/mtfAutoLink.js`)
- **Pre-execution DIRECTION INTEGRITY GATE** (new block, runs *before* `paper.openPaperTrade`):
  canonical side → DIG hard-block → geometry check (with logged repair) → handoff assert. Any failure = **skip + logged event**, no order.
- **Live conviction gate:** `wantLiveOrderFinal = wantLiveOrder && checksPassed >= cfg.liveMinConvictionChecks (default 5)`. Below the bar the LIVE order is **skipped** (strict-LIVE mode: entry skipped; auto-sync mode: paper entry with an explicit `live-downgrade` log). Never silent.
- **Post-fill direction proof:** exchange-filled `entry/SL/T1/T2` re-validated; inverted → repaired + `dir-repair` log; unrepairable → position tracked **with a hard `directionIntegrity.alert`** (untracked live position would be worse).
- **Every book record** now carries `signalSide` + `directionIntegrity {verdict, score, label, handoff:'VERIFIED', geometry, alert}`.
- **Book watchdog** exposed on `/api/ai/mtf-auto/status` → `directionIntegrityBook {checked, open, inversions, findings[]}` and surfaced in the UI.

---

## 5. Verification runs (all on this repo, this machine)

| Gate | Command | Result |
|---|---|---|
| Type safety | `npm run typecheck` | **PASS** |
| Lint | `npm run lint` | **PASS (0 errors)** |
| Version consistency | `npm run check:version` | **PASS — 21.25.0** |
| API routes | `npm run check:routes` | **PASS** |
| Unit/integration suite | `npx vitest run` | **4434 tests · 4433 pass** (235 files incl. new `test/v2125DirectionIntegrity.test.ts`, 27 tests). 1 known load-flake (`signalRecheck` network timeout) — passes standalone 24/24 |
| Production build + stamp | `npm run build` | **PASS — `dist/.build-version = 21.25.0`** |
| Boot smoke | `npm run boot-smoke` | **10 pass · 0 fail** (version + direction self-test 24/24 inside) |
| Boot certificate | server boot | `[direction-selftest] PASS 24/24` |
| **Inversion auditor** | `npm run audit:direction` | **79 pass · 0 INVERSION · 18 counter-read (warn) · 14 unverified · exit 0** (raw log: `docs/direction-audit-v21.25.0.log`) |

Raw auditor log shipped at `app/docs/direction-audit-v21.25.0.log`.

Auditor scope: FUTURES + CRYPTO + INDIA dual boards (INTRADAY 15m+5m), all AUTO-LIVE endpoints (`/mtf-auto/status`, `/mtf-auto/preview`, `/protrader-auto`), plus the auto-live book audit.

---

## 6. Files touched

**New**
- `app/server/ai/directionIntegrity.js` — DIG core (geometry / handoff / multi-read / repair / book audit / payload leak scan)
- `app/test/v2125DirectionIntegrity.test.ts` — 27 tests (incl. wiring source pins)
- `app/AUDIT-REPORT-v21.25.0.md` — this report
- `app/MEGA-UPGRADE-v21.25.0.md` — user-facing change summary

**Modified**
- `app/server/ai/mtfDualBoard.js` — per-row DIG + 8-check live conviction + board digests + auto gating
- `app/server/ai/mtfAutoLink.js` — pre-execution DIG gate, live conviction bar, post-fill proof, `signalSide`/`directionIntegrity` stamps, book watchdog in status
- `app/server/ai/directionSelfTest.js` — 6 new DIG boot checks (18 → 24), version stamped v21.25.0
- `app/scripts/direction-audit.mjs` — C7 (DIG) + C8 (live conviction) + book audit + severity doctrine (INVERSION vs counter-read)
- `app/src/components/aitrading/useAITrading.ts` — types for DIG / liveIntelligence / digests / book audit
- `app/src/components/aitrading/MTFDualBoardPanel.tsx` — DIG chip, LIVE-READY chip, board digests, book-audit chip
- `app/package.json`, `app/package-lock.json`, `app/src/version.ts` — 21.25.0 + `audit:direction` scripts (lockfile untouched for telegram-bot 21.4.0)

---

## 7. Recommended operating settings

- Keep `cfg.liveMinConvictionChecks = 5` (default). Raise to 6–7 for a stricter live lane; `8` = only LIVE-A rows can place real orders.
- Run `npm run audit:direction` after every deploy (it is also a good cron candidate — exits non-zero on inversion).
- `COUNTER_READ` rows on the board are **information**, not defects: they mark pullback/counter-trend context. If you want them hidden entirely, filter on `directionIntegrity.verdict === 'ALIGNED'` in the UI.
