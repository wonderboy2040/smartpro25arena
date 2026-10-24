// ============================================================
// server/ai/lib/liquidity.js — TRADABILITY GATE (v21.24.0)
// ------------------------------------------------------------
// WHY THIS EXISTS (pro-trader audit finding):
//   The board ranked PURELY on signal quality (aiScore × entry-band ×
//   staleness). On a live INDIA scan the top-15 was dominated by
//   micro-caps doing ₹0.3-2 crore of turnover (ALANKIT, LIBAS,
//   GAYAHWS, SIGNPOST) while the T1 large-cap head (TCS, NIFTY50
//   names) sat far below them. A signal on a stock you cannot fill
//   without moving price is NOT a signal — a real desk gates it out.
//   Same class on crypto: a 24h-turnover-$40k perp prints a beautiful
//   ATR plan that nobody can execute at the quoted price.
//
// WHAT THIS MODULE DOES (pure, no fetch/clock/state — test-pinnable):
//   turnover (₹ or USDT) + relVolume + spread → a LIQUIDITY TIER plus
//   a *ranking factor* (0.55–1.06) and an honest `tradable` flag.
//
// DESIGN CONTRACTS:
//   • MISSING data is NEVER punished (tier UNKNOWN, factor 1.0).
//     Honest neutral — a feed gap must not silently re-rank the board.
//   • factor ≤ 1.06 — liquidity can promote a name a little, never
//     dominate the signal edge (quality stays the primary driver).
//   • ILLIQUID (measured) → tradable:false → the executor + auto-agent
//     skip the row and the card carries a visible "ILLIQUID" chip.
//   • Never throws — the board calls this per symbol per cycle.
// ============================================================

/** ₹ crore helper (India desks think in crore). */
const CR = 1e7;

export const LIQUIDITY_TIERS = Object.freeze({
  DEEP: 'DEEP',
  OK: 'OK',
  THIN: 'THIN',
  ILLIQUID: 'ILLIQUID',
  UNKNOWN: 'UNKNOWN',
});

// Turnover thresholds. INDIA = daily traded VALUE in ₹.
// CRYPTO/FUTURES = 24h quote turnover in USDT.
const THRESHOLDS = Object.freeze({
  INDIA: { deep: 25 * CR, ok: 5 * CR, thin: 1 * CR },      // ₹25cr / ₹5cr / ₹1cr
  CRYPTO: { deep: 20e6, ok: 3e6, thin: 5e5 },               // $20M / $3M / $500k
});

// Ranking multipliers — deliberately conservative.
const FACTORS = Object.freeze({
  DEEP: 1.06,
  OK: 1.0,
  THIN: 0.88,
  ILLIQUID: 0.55,
  UNKNOWN: 1.0,
});

function tierScale(market) {
  const m = String(market || 'INDIA').toUpperCase();
  return (m === 'INDIA' || m === 'METALS') ? THRESHOLDS.INDIA : THRESHOLDS.CRYPTO;
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Assess tradability for ONE instrument.
 *
 * @param {object} a
 * @param {'INDIA'|'CRYPTO'|'FUTURES'|'GLOBALFUTURES'} a.market
 * @param {number|null} a.turnover      day turnover in the desk's quote ccy
 *                                      (₹ for INDIA, USDT for crypto/futures)
 * @param {number|null} a.relVolume     today's volume / 20-day average
 * @param {number|null} a.spreadPct     bid-ask spread as % of price (optional)
 * @returns {{tier:string, factor:number, tradable:boolean, flags:string[], note:string, measured:boolean}}
 */
export function assessLiquidity({ market = 'INDIA', turnover = null, relVolume = null, spreadPct = null } = {}) {
  const m = String(market || 'INDIA').toUpperCase();
  const isIndia = m === 'INDIA' || m === 'METALS';
  const t = positive(turnover);
  const flags = [];

  // --- spread gate (independent of turnover) ---
  const sp = Number(spreadPct);
  const spreadBad = Number.isFinite(sp) && sp > 0.25;
  const spreadFatal = Number.isFinite(sp) && sp > 1.0;
  if (spreadBad) flags.push(`spread ${sp.toFixed(2)}% wide`);

  let tier;
  if (t == null) {
    // no turnover published → honest UNKNOWN (never a silent punish)
    tier = LIQUIDITY_TIERS.UNKNOWN;
  } else {
    const s = tierScale(m);
    tier = t >= s.deep ? LIQUIDITY_TIERS.DEEP
      : t >= s.ok ? LIQUIDITY_TIERS.OK
        : t >= s.thin ? LIQUIDITY_TIERS.THIN
          : LIQUIDITY_TIERS.ILLIQUID;
  }

  // A dead tape (relative volume collapsing) downgrades one notch — but
  // only when we actually measured turnover (UNKNOWN stays UNKNOWN).
  const rv = Number(relVolume);
  const deadTape = Number.isFinite(rv) && rv > 0 && rv < 0.35;
  if (deadTape && tier !== LIQUIDITY_TIERS.UNKNOWN) {
    flags.push(`rel-vol ${rv.toFixed(2)}× (dead tape)`);
    if (tier === LIQUIDITY_TIERS.DEEP) tier = LIQUIDITY_TIERS.OK;
    else if (tier === LIQUIDITY_TIERS.OK) tier = LIQUIDITY_TIERS.THIN;
    else if (tier === LIQUIDITY_TIERS.THIN) tier = LIQUIDITY_TIERS.ILLIQUID;
  }

  let factor = FACTORS[tier];
  if (spreadFatal) factor = Math.min(factor, FACTORS[LIQUIDITY_TIERS.ILLIQUID]);
  else if (spreadBad) factor = Math.min(factor, FACTORS[LIQUIDITY_TIERS.THIN]);

  const tradable = !(tier === LIQUIDITY_TIERS.ILLIQUID || spreadFatal);

  const fmt = (v) => isIndia
    ? `₹${(v / CR).toFixed(2)}cr`
    : `$${v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'k'}`;

  const note = tier === LIQUIDITY_TIERS.UNKNOWN
    ? 'turnover unpublished — liquidity unverified (neutral rank weight)'
    : tier === LIQUIDITY_TIERS.ILLIQUID
      ? `turnover ${fmt(t)} — below the ${isIndia ? '₹1cr' : '$500k'} fillable floor; entry/exit slippage risk`
      : tier === LIQUIDITY_TIERS.THIN
        ? `turnover ${fmt(t)} — thin book, size chhota rakho`
        : tier === LIQUIDITY_TIERS.DEEP
          ? `turnover ${fmt(t)} — deep book, full size OK`
          : `turnover ${fmt(t)} — normal liquidity`;

  return {
    tier,
    factor,
    tradable,
    flags,
    note,
    measured: tier !== LIQUIDITY_TIERS.UNKNOWN,
  };
}

/**
 * Convenience wire payload for a signal card (compact, UI-facing).
 * Returns null when liquidity could not be measured — the card then
 * shows nothing rather than a fake "OK".
 */
export function liquidityWire(a) {
  const r = assessLiquidity(a);
  if (!r.measured && r.flags.length === 0) return null;
  return {
    tier: r.tier,
    factor: +r.factor.toFixed(2),
    tradable: r.tradable,
    flags: r.flags,
    note: r.note,
  };
}
