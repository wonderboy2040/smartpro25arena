# SmartAI Pro

Three-desk AI trading terminal: **Crypto (CoinDCX)**, **India Intraday (NSE)**, and **Portfolio** — with dual-timeframe MTF signal boards, paper trading, live-position monitoring, AI committee/ensemble scoring, Telegram alerts, and a local Ollama intelligence layer.

> **v21.25.0 — Direction Integrity Guard (DIG):** the LONG/SHORT invariant (ticket geometry, signal→order handoff, exchange vocabulary, post-fill level repair) is now enforced in one pure module (`app/server/ai/directionIntegrity.js`) across the MTF Dual-Timeframe Board, the AUTO Live lane, and the live book. Plus an 8-check AUTO-LIVE conviction stack. See `app/AUDIT-REPORT-v21.25.0.md` and `app/MEGA-UPGRADE-v21.25.0.md`.
>
> Current app version: see `app/package.json` (`check:version` keeps `package.json`, `package-lock.json`, and the build stamp in sync).

---

## Quick start (Windows)

1. Extract the project (no installer/`.exe` required).
2. Double-click **`app\Start-SmartAI-Watchdog.bat`**.
3. Open the URL printed in the console (default `http://localhost:5000`).

The watchdog serves the pre-built `app/dist/` immediately, then rebuilds when the source changes. Full setup, API keys, and troubleshooting are in **[`RUN-FIRST.md`](./RUN-FIRST.md)**.

### Manual start (development)

```bash
cd app
npm install
npm run dev          # Vite dev server (frontend)
npm start            # Express API server (http://localhost:5000)
```

Production-style run after a build:

```bash
cd app
npm run build        # vite build + postbuild stamp
npm start
```

---

## Project layout

```
smartpro25arena/
├─ app/
│  ├─ src/                 React + TypeScript frontend (three desks, panels, hooks)
│  ├─ server/              Express API, signal engines, execution, MCP mesh, Telegram
│  ├─ test/                Vitest suite (server + frontend contracts)
│  ├─ scripts/             Build/version/route checks, calibration, backups
│  ├─ dist/                Tracked production build (served by the watchdog)
│  ├─ docs/                CHANGES, audits, and operational notes
│  └─ telegram-bot/        Standalone Telegram bot package
├─ deploy/                 Deployment helpers
└─ RUN-FIRST.md            Step-by-step Windows setup + release notes
```

Runtime state lives under `app/server/data/` and `app/data/` (ignored by git). Do **not** delete these while positions/trades are open — they contain signal ledgers, paper trades, journals, and bot state.

---

## Quality gates

Run from `app/`:

```bash
npm run boot-smoke    # boot + version + board contract + direction certificate (10 checks, version-agnostic)
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint (server + src)
npm run check:version # version consistency
npm test              # vitest (sequential; can take 10+ minutes)
npm run build         # production bundle
npm run check:routes  # frontend fetch calls vs backend routes
npm run audit:all     # npm audit for app + telegram-bot
npm run audit:direction  # v21.25.0 — LONG/SHORT inversion auditor (exit 1 on inversion)
```

Or the full chain: `npm run check`.

---

## Notes

- Trade-signal generation and execution engines are sensitive; changes should stay additive and be verified with the relevant tests.
- `app/dist/` is intentionally committed so the watchdog can serve immediately after extraction. Rebuild before committing so `dist` matches `src`.
- API keys and secrets belong in `app/.env` (see `app/.env.example`); never commit real credentials.
- Historical changes and known environment-dependent test failures are documented in `app/docs/CHANGES.md`.
