// ============================================================
// test/v21252Recheck.test.ts — v21.25.2 PRO-LEVEL RECHECK FIXES
// ------------------------------------------------------------
// Guards the three real defects the v21.25.2 deep recheck found (and the
// broader suite could not see):
//
//  1. AUTO skip-visibility was mis-leading. Every non-self-verified row
//     printed the SAME line — "main AI-BOARD ensemble signal unavailable" —
//     even when the real blocker was the score floor, a pending trigger, or
//     an incomplete ticket. `autoSkipReason` / `selfVerifyMissing` now name
//     the actual missing condition, and `selfVerifiedForAuto` derives from
//     that same list (one source of truth, gating unchanged).
//
//  2. `POST /api/ai/trading/kill-switch` silently DISARMED the safety switch
//     for any body that did not spell the key `enabled` (e.g. `{"on":true}`).
//     It now accepts `enabled` / `on` / `killSwitch` and rejects a body with
//     no explicit boolean.
//
//  3. The route-sweep harness called SSE endpoints failures (phantom
//     "ERR 45001ms") and counted declared optional-service degrades as hard
//     failures — so its RESULT line could not be trusted as a gate.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  selfVerifyMissing, selfVerifiedForAuto, autoSkipReason, dualAutoCandidates, mtfProEntryGate,
} from '../server/ai/mtfDualBoard.js';

/** Fully trade-ready row (mirrors what the board emits for a clean ELITE row). */
function readyRow(over = {}) {
  return {
    ok: true, symbol: 'TESTCO', side: 'LONG', superScore: 84, tier: 'STRONG',
    directionVerified: true, triggerFired: true, tfFit: 'GOOD',
    directionIntegrity: { verdict: 'ALIGNED', score: 88, hardBlock: false },
    trigger: { overextended: false },
    plan: { entry: 100, stopLoss: 99, t1: 102, t2: 104 },
    autoEligible: true, autoBlockers: [],
    ...over,
  };
}

describe('selfVerifyMissing — names the real auto-lane blocker (v21.25.2)', () => {
  it('a fully ready row reports nothing missing', () => {
    expect(selfVerifyMissing(readyRow())).toEqual([]);
    expect(selfVerifiedForAuto(readyRow())).toBe(true);
    expect(autoSkipReason(readyRow())).toBeNull();
  });

  it('score below the ACTION floor is named with both numbers', () => {
    const miss = selfVerifyMissing(readyRow({ superScore: 64 }));
    expect(miss).toContain('score 64 < 65');
    expect(autoSkipReason(readyRow({ superScore: 64 }))).toMatch(/score 64 < 65/);
  });

  it('pending trigger + unverified direction are named individually', () => {
    const miss = selfVerifyMissing(readyRow({ triggerFired: false, directionVerified: false }));
    expect(miss).toContain('trigger not fired');
    expect(miss).toContain('direction PAKKA verify pending');
  });

  it('structural vetoes and hard blocks are surfaced', () => {
    expect(selfVerifyMissing(readyRow({ trapVeto: true }))).toContain('trap veto');
    expect(selfVerifyMissing(readyRow({ zoneWallVeto: true }))).toContain('zone-wall veto');
    expect(selfVerifyMissing(readyRow({ boardSideConflict: true, boardSide: 'SHORT' })))
      .toContain('main board SHORT conflict');
    expect(selfVerifyMissing(readyRow({ directionIntegrity: { hardBlock: true } }))).toContain('DIG hard block');
    expect(selfVerifyMissing(readyRow({ trigger: { overextended: true } }))).toContain('overextended');
  });

  it('an incomplete ticket and a bad TF fit are named', () => {
    expect(selfVerifyMissing(readyRow({ plan: { entry: 100, stopLoss: 0, t1: 102 } }))).toContain('incomplete ticket');
    expect(selfVerifyMissing(readyRow({ tfFit: 'POOR' }))).toContain('TF fit POOR');
  });

  it('selfVerifiedForAuto is exactly "nothing missing" (gating parity)', () => {
    const cases = [
      readyRow(),
      readyRow({ superScore: 64 }),
      readyRow({ triggerFired: false }),
      readyRow({ counterHtf: true, htfBias: 'BEARISH' }),
      readyRow({ reversalRisk: true }),
      readyRow({ plan: { entry: 0 } }),
      { ok: false },
      null,
    ];
    for (const row of cases) {
      expect(selfVerifiedForAuto(row)).toBe(selfVerifyMissing(row).length === 0);
    }
  });

  it('the skip line is deduped and capped so the UI stays readable', () => {
    const bad = readyRow({
      superScore: 40, triggerFired: false, directionVerified: false, trapVeto: true,
      zoneWallVeto: true, reversalRisk: true, tfFit: 'POOR',
    });
    const line = autoSkipReason(bad);
    expect(line).toMatch(/^self-verify pending: /);
    expect(line).toMatch(/\+\d+ more/);
    expect(line.length).toBeLessThan(160);
  });

  it('null row is handled without throwing', () => {
    expect(selfVerifyMissing(null)).toEqual(['plan unavailable']);
    expect(selfVerifiedForAuto(null)).toBe(false);
  });
});

describe('skip-reason visibility — the ensemble line now carries the real cause', () => {
  it('dualAutoCandidates names score + trigger, not just "ensemble unavailable"', () => {
    const row = readyRow({ ensembleSignalAvailable: false, superScore: 64, triggerFired: false });
    const out = dualAutoCandidates([row], { minScore: 75 }, { openSymbols: new Set(), lastEntryAt: {} });
    const blockers = out[0].autoPickBlockers.join(' | ');
    expect(blockers).toContain('score 64 < 75');
    expect(blockers).toContain('ensemble signal unavailable');
    expect(blockers).toContain('self-verify pending');
    expect(blockers).toContain('trigger not fired');
  });

  it('a self-verified row with no main-board coverage still has zero blockers', () => {
    const out = dualAutoCandidates(
      [readyRow({ ensembleSignalAvailable: false, superScore: 80 })],
      { minScore: 75 },
      { openSymbols: new Set(), lastEntryAt: {} },
    );
    expect(out[0].autoPickBlockers).toEqual([]);
  });

  it('mtfProEntryGate explains why the ensemble lane is closed', () => {
    const g = mtfProEntryGate(readyRow({ ensembleSignalAvailable: false, triggerFired: false }), { mainSignal: null });
    expect(g.ok).toBe(false);
    const text = g.blockers.join(' | ');
    expect(text).toContain('ensemble signal unavailable');
    expect(text).toContain('trigger not fired');
  });
});

describe('kill-switch route — explicit boolean contract (v21.25.2)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'server', 'ai', 'routes.js'), 'utf8',
  );
  const block = src.slice(
    src.indexOf("app.post('/api/ai/trading/kill-switch'"),
    src.indexOf("app.post('/api/ai/trading/kill-switch'") + 1600,
  );

  it('accepts the enabled / on / killSwitch aliases', () => {
    expect(block).toMatch(/body\.enabled/);
    expect(block).toMatch(/body\.on\b/);
    expect(block).toMatch(/body\.killSwitch/);
  });

  it('rejects a body with no explicit boolean instead of silently disarming', () => {
    expect(block).toMatch(/status\(400\)/);
    expect(block).toMatch(/explicit boolean/i);
  });

  it('still arms the switch and cancels exchange orders when enabled', () => {
    expect(block).toMatch(/killSwitch:\s*enabled/);
    expect(block).toMatch(/cancelAllExchangeOrders\(\)/);
  });
});

describe('route-sweep harness — trustworthy as a gate (v21.25.2)', () => {
  const sweep = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'route-sweep.mjs'), 'utf8',
  );

  it('probes SSE routes with a bounded read instead of a 45s hang', () => {
    expect(sweep).toMatch(/function isSseRoute/);
    expect(sweep).toMatch(/async function hitSse/);
    expect(sweep).toMatch(/text\\\/event-stream/);
  });

  it('declares the credential/optional-service degrades it tolerates', () => {
    expect(sweep).toMatch(/DECLARED_DEGRADE/);
    for (const route of ['/api/ai/orderbook', '/api/ai/expert/status', '/api/cloud/load', '/api/intraday-briefing']) {
      expect(sweep).toContain(route);
    }
  });

  it('asserts the kill-switch contract live', () => {
    expect(sweep).toMatch(/kill-switch: empty body is rejected/);
    expect(sweep).toMatch(/kill-switch: \{on:true\} alias arms it/);
  });
});
