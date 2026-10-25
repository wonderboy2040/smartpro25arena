// ============================================================
// test/v2125DirectionIntegrity.test.ts — v21.25.0
// DIRECTION INTEGRITY GUARD (DIG) + AUTO LIVE CONVICTION STACK
// ------------------------------------------------------------
// Ye suite do cheezein PROVE karta hai:
//   1. Inversion ke saare 4 vectors (geometry / handoff / vocabulary /
//      level repair) pakde jaate hain — aur koi bhi unknown side kabhi
//      silently LONG nahi banta.
//   2. Correct LONG/SHORT tickets kabhi galat se block nahi hote
//      (no false positive → warna board dead ho jayega).
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  normalizeSide, sideSign, oppositeSide,
  checkLevelGeometry, resolveSideFromGeometry, assertExecutionSide,
  buildIndependentDirectionRead, assessDirectionIntegrity,
  guardLevelsForSide, auditBookDirectionIntegrity, directionIntegrityDigest,
  scanPayloadSideLeaks,
} from '../server/ai/directionIntegrity.js';
import { fuseDualTf, dualAutoCandidates, selfVerifiedForAuto, autoEnsembleOk } from '../server/ai/mtfDualBoard.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = {
  link: readFileSync(path.join(ROOT, 'server', 'ai', 'mtfAutoLink.js'), 'utf8'),
  board: readFileSync(path.join(ROOT, 'server', 'ai', 'mtfDualBoard.js'), 'utf8'),
  dig: readFileSync(path.join(ROOT, 'server', 'ai', 'directionIntegrity.js'), 'utf8'),
};

const longTicket = { side: 'LONG', entry: 100, stopLoss: 98, t1: 104, t2: 108 };
const shortTicket = { side: 'SHORT', entry: 100, stopLoss: 102, t1: 96, t2: 92 };

function longPlan(over = {}) {
  return {
    ok: true, side: 'LONG', triggerFired: true,
    context: { dir: 1, score: 85 },
    trigger: {
      dir: 1, score: 82, overextended: false, opposingFlow: false, reversalRisk: false,
      ema5: 100.4, ema9: 100.1, ema20: 99.6, roc1: 0.12, roc3: 0.28, macdHist: 0.4,
      lastBar: { open: 99.8, high: 100.6, low: 99.7, close: 100.5 },
      prevBar: { high: 99.9, low: 98.9 },
    },
    plan: { entry: 100, stopLoss: 98, t1: 104, t2: 108, netRR: { t1: 1.5, t2: 2.6 } },
    worldIndicators: { aligned8Count: 7, alignedCount: 7, confluencePct: 88, estimatedWinRatePct: 74, trapVeto: false, zoneWallVeto: false },
    ...over,
  };
}

describe('v21.25.0 · side vocabulary (no silent LONG)', () => {
  it('normalizes LONG/SHORT and exchange BUY/SELL, refuses everything else', () => {
    expect(normalizeSide('long')).toBe('LONG');
    expect(normalizeSide('BUY')).toBe('LONG');
    expect(normalizeSide('sell')).toBe('SHORT');
    expect(normalizeSide('')).toBeNull();
    expect(normalizeSide('WAIT')).toBeNull();
    expect(normalizeSide(undefined)).toBeNull();
    expect(sideSign('SHORT')).toBe(-1);
    expect(sideSign('garbage')).toBeNull();
    expect(oppositeSide('LONG')).toBe('SHORT');
    expect(oppositeSide('nope')).toBeNull();
  });
});

describe('v21.25.0 · C1 ticket geometry invariant', () => {
  it('accepts coherent LONG and SHORT tickets', () => {
    expect(checkLevelGeometry(longTicket).ok).toBe(true);
    expect(checkLevelGeometry(shortTicket).ok).toBe(true);
  });

  it('flags a LONG ticket whose SL sits ABOVE entry (SHORT-shaped) as INVERSION', () => {
    const r = checkLevelGeometry({ side: 'LONG', entry: 100, stopLoss: 102, t1: 104, t2: 108 });
    expect(r.ok).toBe(false);
    expect(r.inverted).toBe(true);
    expect(r.impliedSide).toBe('SHORT');
    expect(r.code).toBe('LONG_SL_ABOVE_ENTRY');
  });

  it('flags a SHORT ticket whose SL sits BELOW entry (LONG-shaped) as INVERSION', () => {
    const r = checkLevelGeometry({ side: 'SHORT', entry: 100, stopLoss: 98, t1: 96, t2: 92 });
    expect(r.ok).toBe(false);
    expect(r.inverted).toBe(true);
    expect(r.impliedSide).toBe('LONG');
  });

  it('flags inverted target ladders in both directions', () => {
    expect(checkLevelGeometry({ side: 'LONG', entry: 100, stopLoss: 98, t1: 99, t2: 108 }).code).toBe('LONG_T1_BELOW_ENTRY');
    expect(checkLevelGeometry({ side: 'LONG', entry: 100, stopLoss: 98, t1: 105, t2: 103 }).code).toBe('LONG_T2_BELOW_T1');
    expect(checkLevelGeometry({ side: 'SHORT', entry: 100, stopLoss: 102, t1: 101, t2: 92 }).code).toBe('SHORT_T1_ABOVE_ENTRY');
    expect(checkLevelGeometry({ side: 'SHORT', entry: 100, stopLoss: 102, t1: 95, t2: 97 }).code).toBe('SHORT_T2_ABOVE_T1');
  });

  it('refuses unknown side instead of assuming LONG', () => {
    const r = checkLevelGeometry({ side: 'WAIT', entry: 100, stopLoss: 98 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SIDE_UNKNOWN');
  });

  it('derives the honest side from geometry when side is missing', () => {
    const r = resolveSideFromGeometry({ side: '', entry: 100, stopLoss: 102, t1: 96, t2: 92 });
    expect(r.ok).toBe(true);
    expect(r.side).toBe('SHORT');
    expect(r.repaired).toBe(true);
    expect(r.note).toMatch(/geometry se derive/);
  });
});

describe('v21.25.0 · V2 handoff guard (signal side → order side)', () => {
  it('passes when board side and execution side match', () => {
    expect(assertExecutionSide({ signalSide: 'LONG', execSide: 'LONG' }).ok).toBe(true);
    expect(assertExecutionSide({ signalSide: 'SHORT', execSide: 'SELL' }).ok).toBe(true);
  });
  it('blocks a LONG signal going out as a SHORT order (the user’s exact fear)', () => {
    const r = assertExecutionSide({ signalSide: 'LONG', execSide: 'SHORT' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SIDE_MISMATCH');
    expect(r.reason).toMatch(/INVERSION/);
  });
  it('blocks a missing/garbage execution side', () => {
    expect(assertExecutionSide({ signalSide: 'LONG', execSide: '' }).code).toBe('EXEC_SIDE_INVALID');
    expect(assertExecutionSide({ signalSide: '', execSide: 'LONG' }).code).toBe('SIGNAL_SIDE_INVALID');
  });
});

describe('v21.25.0 · V3 multi-factor direction read + verdicts', () => {
  it('aligned LONG plan → ALIGNED, not hard-blocked', () => {
    const r = assessDirectionIntegrity({ side: 'LONG', plan: longPlan() });
    expect(r.verdict).toBe('ALIGNED');
    expect(r.hardBlock).toBe(false);
    expect(r.agreeCount).toBeGreaterThanOrEqual(3);
    expect(r.score).toBeGreaterThan(70);
  });

  it('a bullish plan mislabelled SHORT → INVERTED + hard block', () => {
    // Side SHORT declared, SHORT-shaped ticket (SL above entry) — geometry
    // sahi hai, lekin saare structural reads BULLISH hain → inversion.
    const r = assessDirectionIntegrity({
      side: 'SHORT',
      plan: longPlan({ plan: { entry: 100, stopLoss: 102, t1: 96, t2: 92 } }),
    });
    expect(r.verdict).toBe('INVERTED');
    expect(r.hardBlock).toBe(true);
    expect(r.againstCount).toBeGreaterThanOrEqual(3);
    expect(r.conflicts.join(' ')).toMatch(/vs side SHORT/);
  });

  it('inverted geometry is a hard block regardless of reads', () => {
    const r = assessDirectionIntegrity({ side: 'LONG', plan: longPlan({ plan: { entry: 100, stopLoss: 103, t1: 104, t2: 108 } }) });
    expect(r.verdict).toBe('GEOMETRY_BROKEN');
    expect(r.hardBlock).toBe(true);
  });

  it('missing side is a hard block (no silent LONG default)', () => {
    const r = assessDirectionIntegrity({ side: null, plan: longPlan() });
    expect(r.verdict).toBe('MISSING_SIDE');
    expect(r.hardBlock).toBe(true);
  });

  it('independent read votes +1 for a rising tape and −1 for a falling tape', () => {
    const up = buildIndependentDirectionRead({ plan: longPlan() });
    expect(up.netDir).toBe(1);
    const downPlan = longPlan({
      context: { dir: -1, score: 85 },
      trigger: {
        ...longPlan().trigger, dir: -1, ema5: 99.6, ema9: 99.9, ema20: 100.4,
        roc1: -0.12, roc3: -0.28, macdHist: -0.4,
        lastBar: { open: 100.2, high: 100.3, low: 99.4, close: 99.5 },
        prevBar: { high: 101.1, low: 100.1 },
      },
    });
    expect(buildIndependentDirectionRead({ plan: downPlan }).netDir).toBe(-1);
  });
});

describe('v21.25.0 · V4 post-fill level repair', () => {
  it('repairs a LONG ticket whose SL/T1/T2 crossed the entry', () => {
    const r = guardLevelsForSide({ side: 'LONG', entry: 100, stopLoss: 103, t1: 99, t2: 98 });
    expect(r.ok).toBe(true);
    expect(r.stopLoss).toBeLessThan(100);
    expect(r.t1).toBeGreaterThan(100);
    expect(r.t2).toBeGreaterThan(r.t1);
    expect(r.fixes.length).toBeGreaterThanOrEqual(2);
  });
  it('repairs a SHORT ticket whose SL dropped below entry', () => {
    const r = guardLevelsForSide({ side: 'SHORT', entry: 100, stopLoss: 98, t1: 104, t2: 108 });
    expect(r.ok).toBe(true);
    expect(r.stopLoss).toBeGreaterThan(100);
    expect(r.t1).toBeLessThan(100);
    expect(r.t2).toBeLessThan(r.t1);
  });
  it('leaves a coherent ticket untouched (zero fixes)', () => {
    const r = guardLevelsForSide(shortTicket);
    expect(r.ok).toBe(true);
    expect(r.fixes.length).toBe(0);
    expect(r.stopLoss).toBe(102);
  });
});

describe('v21.25.0 · book watchdog (AUTO Live Trade)', () => {
  it('reports no findings for coherent open trades', () => {
    const book = [
      { symbol: 'BTC', side: 'LONG', status: 'OPEN', entry: 100, stopLoss: 98, t1: 104, t2: 108 },
      { symbol: 'ETH', side: 'SHORT', status: 'OPEN', entry: 100, stopLoss: 102, t1: 96, t2: 92 },
      { symbol: 'SOL', side: 'LONG', status: 'CLOSED', entry: 100, stopLoss: 103, t1: 104, t2: 108 },
    ];
    const r = auditBookDirectionIntegrity(book, []);
    expect(r.ok).toBe(true);
    expect(r.open).toBe(2);
    expect(r.inversions).toBe(0);
  });

  it('catches a wrong-side open trade and a board-side contradiction', () => {
    const book = [
      { symbol: 'BTC', side: 'LONG', status: 'OPEN', entry: 100, stopLoss: 102, t1: 104, t2: 108 },
      { symbol: 'ETH', side: 'LONG', status: 'OPEN', entry: 100, stopLoss: 98, t1: 104, t2: 108 },
    ];
    const rows = [{ symbol: 'ETH', side: 'SHORT' }];
    const r = auditBookDirectionIntegrity(book, rows);
    expect(r.ok).toBe(false);
    expect(r.inversions).toBe(2);
    expect(r.findings.map(f => f.code)).toEqual(expect.arrayContaining(['LONG_SL_ABOVE_ENTRY', 'SIDE_MISMATCH']));
  });
});

describe('v21.25.0 · payload side-leak scanner + board digest', () => {
  it('detects a wrong-side field inside an execution payload', () => {
    const leaks = scanPayloadSideLeaks({ side: 'SHORT', order: { side: 'LONG' } }, { expectSide: 'SHORT' });
    expect(leaks.ok).toBe(false);
    expect(leaks.leaks[0]).toMatch(/order\.side=LONG/);
  });
  it('passes a clean payload', () => {
    expect(scanPayloadSideLeaks({ side: 'SHORT', target1: 96 }, { expectSide: 'SHORT' }).ok).toBe(true);
  });
  it('board digest counts verdicts honestly', () => {
    const rows = [
      { symbol: 'A', directionIntegrity: { verdict: 'ALIGNED', score: 90, hardBlock: false } },
      { symbol: 'B', directionIntegrity: { verdict: 'COUNTER_READ', score: 60, hardBlock: false } },
      { symbol: 'C', directionIntegrity: { verdict: 'INVERTED', score: 10, hardBlock: true } },
    ];
    const d = directionIntegrityDigest(rows);
    expect(d.total).toBe(3);
    expect(d.aligned).toBe(1);
    expect(d.counterRead).toBe(1);
    expect(d.inverted).toBe(1);
    expect(d.hardBlocked).toEqual(['C']);
  });
});

describe('v21.25.0 · wiring source pins (regression guard)', () => {
  it('auto lane calls the direction-integrity gate before opening any ticket', () => {
    expect(SRC.link).toContain("import {\n  normalizeSide, checkLevelGeometry, assertExecutionSide,");
    expect(SRC.link).toContain('v21.25.0 DIRECTION INTEGRITY GATE (pre-execution, paper + live)');
    expect(SRC.link).toContain('assertExecutionSide({ signalSide: row.side, execSide: boardSide');
    expect(SRC.link).toContain('guardLevelsForSide({ side: boardSide, entry, stopLoss: sl, t1, t2 })');
    // the gate must run BEFORE the paper/live order is placed
    expect(SRC.link.indexOf('v21.25.0 DIRECTION INTEGRITY GATE')).toBeGreaterThan(0);
    expect(SRC.link.indexOf('v21.25.0 DIRECTION INTEGRITY GATE')).toBeLessThan(SRC.link.indexOf('direction: row.side,'));
    // post-fill proof + book watchdog + live conviction bar are wired
    expect(SRC.link).toContain('v21.25.0 POST-FILL DIRECTION PROOF');
    expect(SRC.link).toContain('auditBookDirectionIntegrity(st.book || [], [])');
    expect(SRC.link).toContain('const wantLiveOrderFinal = wantLiveOrder && liveConvictionOk');
    // side honesty: no silent LONG default anywhere in the gate
    expect(SRC.link).toContain('geometry: checkLevelGeometry({ side: row.side, entry: finalEntry');
  });
  it('dual board exposes per-row DIG + 8-check live conviction + board digests', () => {
    expect(SRC.board).toContain('row.directionIntegrity = assessDirectionIntegrity({ side: row.side, plan, snap: snapAligned })');
    expect(SRC.board).toContain('directionIntegrity: directionIntegrityDigest(trimmed)');
    expect(SRC.board).toContain("add('L1 direction integrity'");
    expect(SRC.board).toContain("add('L8 no structural veto'");
    expect(SRC.board).toContain('liveIntelligence: {');
  });
  it('DIG module keeps the honest-refuse doctrine', () => {
    expect(SRC.dig).toContain('export function normalizeSide');
    expect(SRC.dig).toContain('no silent default');
    expect(SRC.dig).toContain('export function auditBookDirectionIntegrity');
  });
});

describe('v21.25.1 · self-verified auto lane (user: "elite score pe bhi auto trade nahi lagta")', () => {
  const eliteRow = (over = {}) => ({
    ok: true, symbol: 'XAU', market: 'CRYPTO', mode: 'INTRADAY',
    side: 'SHORT', superScore: 96, tier: 'ELITE',
    directionVerified: true, triggerFired: true, dualAligned: true,
    counterTrend: false, counterHtf: false, trapVeto: false, zoneWallVeto: false, reversalRisk: false,
    ensembleSignalAvailable: false,          // main AI board ne symbol cover nahi kiya
    tfFit: 'GOOD', autoEligible: true, autoBlockers: [],
    context: { dir: -1 }, trigger: { dir: -1, opposingFlow: false, reversalRisk: false, overextended: false },
    plan: { entry: 100, stopLoss: 102, t1: 96, t2: 92, netRR: { t1: 1.4, t2: 2.6 } },
    directionIntegrity: { verdict: 'ALIGNED', hardBlock: false },
    ...over,
  });

  it('ELITE PAKKA row is auto-executable even when the main ensemble has no ACTION grade', () => {
    const out = dualAutoCandidates([eliteRow()], { minScore: 75 }, { openSymbols: new Set(), lastEntryAt: {} });
    expect(out[0].autoPickBlockers).toEqual([]);
  });

  it('self-verification is not a loophole — every hard veto still blocks it', () => {
    const cases = [
      { directionVerified: false },
      { triggerFired: false },
      { counterTrend: true },
      { counterHtf: true },
      { trapVeto: true },
      { zoneWallVeto: true },
      { reversalRisk: true },
      { boardSideConflict: true },
      { tfFit: 'MISMATCH' },
      { superScore: 60 },
      { plan: { entry: 100, stopLoss: 0, t1: 96, t2: 92 } },
      { directionIntegrity: { verdict: 'INVERTED', hardBlock: true } },
    ];
    for (const over of cases) {
      expect(selfVerifiedForAuto(eliteRow(over)), JSON.stringify(over)).toBe(false);
    }
    expect(selfVerifiedForAuto(eliteRow())).toBe(true);
  });

  it('autoEnsembleOk is true for actionable-ensemble rows AND for self-verified rows only', () => {
    expect(autoEnsembleOk(eliteRow({ ensembleSignalAvailable: true }))).toBe(true);
    expect(autoEnsembleOk(eliteRow())).toBe(true);
    expect(autoEnsembleOk(eliteRow({ directionVerified: false }))).toBe(false);
  });
});

describe('v21.25.0 · fuseDualTf side is never inverted by the integrity layer', () => {
  it('a clean LONG plan keeps side LONG through the fuse', () => {
    const plan = longPlan();
    const r = fuseDualTf({ symbol: 'DIGX', market: 'CRYPTO', boardSig: null, plan, snap: null, modeId: 'INTRADAY' });
    expect(r.side).toBe('LONG');
    expect(r.dir).toBe(1);
    expect(r.directionVerified).toBe(true);
  });
});
