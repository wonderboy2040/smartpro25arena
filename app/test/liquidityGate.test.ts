// ============================================================
// test/liquidityGate.test.ts — v21.24.0 TRADABILITY GATE
// ------------------------------------------------------------
// Locks the audit fix: the board may no longer headline an unfillable
// instrument. Contract (lib/liquidity.js):
//   • measured turnover → DEEP/OK/THIN/ILLIQUID tiers on the desk's own
//     scale (₹ for INDIA, USDT for crypto/futures)
//   • ranking factor is bounded 0.55–1.06 and NEVER dominates the edge
//   • a dead relative-volume tape downgrades exactly one notch
//   • wide spread downgrades; fatal (>1%) spread marks untradable
//   • MISSING data = UNKNOWN + factor 1.0 (honest neutral, never a
//     silent punish — a feed gap must not re-rank the board)
//   • liquidityWire() returns null when nothing was measured
// ============================================================
import { describe, it, expect } from 'vitest';
import { assessLiquidity, liquidityWire, LIQUIDITY_TIERS } from '../server/ai/lib/liquidity.js';

const CR = 1e7;

describe('assessLiquidity — INDIA (₹ turnover scale)', () => {
  it('₹30cr turnover → DEEP with a small positive factor', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: 30 * CR });
    expect(r.tier).toBe(LIQUIDITY_TIERS.DEEP);
    expect(r.tradable).toBe(true);
    expect(r.factor).toBeGreaterThan(1);
    expect(r.factor).toBeLessThanOrEqual(1.06);
    expect(r.note).toContain('₹30.00cr');
  });

  it('₹8cr → OK (neutral 1.0)', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: 8 * CR });
    expect(r.tier).toBe(LIQUIDITY_TIERS.OK);
    expect(r.factor).toBe(1);
    expect(r.tradable).toBe(true);
  });

  it('₹2cr → THIN (penalised but still tradable)', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: 2 * CR });
    expect(r.tier).toBe(LIQUIDITY_TIERS.THIN);
    expect(r.factor).toBeLessThan(1);
    expect(r.tradable).toBe(true);
  });

  it('₹40L → ILLIQUID and NOT tradable (the micro-cap headline class)', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: 0.4 * CR });
    expect(r.tier).toBe(LIQUIDITY_TIERS.ILLIQUID);
    expect(r.tradable).toBe(false);
    expect(r.factor).toBeLessThanOrEqual(0.55);
    expect(r.flags.join(' ')).not.toContain('spread'); // turnover-only verdict
  });
});

describe('assessLiquidity — crypto / futures (USDT turnover scale)', () => {
  it('$40M → DEEP, $1M → THIN, $40k → ILLIQUID', () => {
    expect(assessLiquidity({ market: 'FUTURES', turnover: 40e6 }).tier).toBe(LIQUIDITY_TIERS.DEEP);
    expect(assessLiquidity({ market: 'FUTURES', turnover: 1e6 }).tier).toBe(LIQUIDITY_TIERS.THIN);
    const dead = assessLiquidity({ market: 'CRYPTO', turnover: 4e4 });
    expect(dead.tier).toBe(LIQUIDITY_TIERS.ILLIQUID);
    expect(dead.tradable).toBe(false);
  });
});

describe('assessLiquidity — honest degradation + overrides', () => {
  it('unpublished turnover → UNKNOWN, factor 1.0, no punish', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: null });
    expect(r.tier).toBe(LIQUIDITY_TIERS.UNKNOWN);
    expect(r.factor).toBe(1);
    expect(r.tradable).toBe(true);
    expect(r.measured).toBe(false);
  });

  it('garbage/negative turnover is treated as unpublished, never as ILLIQUID', () => {
    for (const bad of [0, -5, NaN, 'abc', undefined]) {
      const r = assessLiquidity({ market: 'INDIA', turnover: bad as never });
      expect(r.tier).toBe(LIQUIDITY_TIERS.UNKNOWN);
      expect(r.tradable).toBe(true);
    }
  });

  it('dead relative volume (0.2×) downgrades exactly one notch', () => {
    expect(assessLiquidity({ market: 'INDIA', turnover: 30 * CR, relVolume: 0.2 }).tier).toBe(LIQUIDITY_TIERS.OK);
    expect(assessLiquidity({ market: 'INDIA', turnover: 30 * CR, relVolume: 8 }).tier).toBe(LIQUIDITY_TIERS.DEEP);
  });

  it('fatal spread (>1%) blocks the row even on a deep book', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: 50 * CR, spreadPct: 1.4 });
    expect(r.tradable).toBe(false);
    expect(r.factor).toBeLessThanOrEqual(0.55);
    expect(r.flags.join(' ')).toContain('spread 1.40%');
  });

  it('mild spread (0.4%) downgrades the factor but keeps tradability', () => {
    const r = assessLiquidity({ market: 'INDIA', turnover: 50 * CR, spreadPct: 0.4 });
    expect(r.tradable).toBe(true);
    expect(r.factor).toBeLessThan(1);
  });

  it('factor always stays inside the documented 0.55–1.06 band', () => {
    const samples = [0, 1, 1e5, 5e6, 5e7, 3e9, null];
    for (const t of samples) {
      for (const market of ['INDIA', 'CRYPTO', 'FUTURES', 'GLOBALFUTURES']) {
        const r = assessLiquidity({ market, turnover: t, relVolume: 0.1, spreadPct: 2 });
        expect(r.factor).toBeGreaterThanOrEqual(0.55);
        expect(r.factor).toBeLessThanOrEqual(1.06);
      }
    }
  });
});

describe('liquidityWire — card payload contract', () => {
  it('returns null when nothing was measured (no fake OK chip)', () => {
    expect(liquidityWire({ market: 'INDIA', turnover: null })).toBeNull();
  });

  it('carries tier/factor/tradable/note for a measured row', () => {
    const w = liquidityWire({ market: 'INDIA', turnover: 0.5 * CR });
    expect(w).not.toBeNull();
    expect(w!.tier).toBe(LIQUIDITY_TIERS.ILLIQUID);
    expect(w!.tradable).toBe(false);
    expect(typeof w!.note).toBe('string');
  });
});
