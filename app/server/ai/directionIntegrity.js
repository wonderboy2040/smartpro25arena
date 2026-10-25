// ============================================================
// server/ai/directionIntegrity.js — v21.25.0 DIRECTION INTEGRITY GUARD (DIG)
// ------------------------------------------------------------
// USER SPEC (verbatim intent): "Deeply recheck karo ki trade signals sahi
// LONG/SHORT direction me land kar rahe hain — kahin inversion (LONG signal
// → SHORT order, SHORT signal → LONG order) nahi ho raha. Fix karo."
//
// PROBLEM JO PEHLE THA:
//   Inversion ke 4 alag-alag vectors the aur kisi ek bhi jagah ek hi line
//   galat hona kaafi tha —
//     V1 TICKET GEOMETRY : side LONG par SL entry se upar / SHORT par SL neeche
//     V2 HANDOFF         : board side ≠ execution side (paper/live call ke beech)
//     V3 VOCABULARY      : LONG/BUY aur SHORT/SELL ka mix-up (exchange body)
//     V4 LEVEL REPAIR    : SL/T1/T2 re-anchor me sign ulta (LONG ka T1 neeche)
//   v21.23.x me V2/V3 individual jagah fix hue the, par koi EK JAGAH nahi thi
//   jahan poora invariant ek saath, machine-checkable form me likha ho.
//   Ye module wahi single source of truth hai — pure functions, koi network,
//   koi side-effect, koi silent default nahi (unknown side = explicit refuse).
//
// DESIGN RULES (doctrine):
//   1. HONEST REFUSE — unknown/blank side par kabhi LONG assume nahi.
//   2. GEOMETRY IS GROUND TRUTH — ek ticket ka side uske level-ordering se
//      independently derive ho sakta hai; conflict = inversion evidence.
//   3. NEVER FLIP SILENTLY — repair functions side ko geometry ke hisaab se
//      BADALTE hain aur `repairedFrom` stamp dete hain, chup-chaap nahi.
//   4. ADVISORY vs BLOCKING — `assessDirectionIntegrity` sirf measures karta
//      hai (counter-trend pullback legitimate hai); `isHardInversion` sirf
//      tab true hota hai jab TEENO independent reads side ke khilaaf hon.
// ============================================================

/** Canonical side. Accepts exchange vocabulary too. Unknown → null (refuse). */
export function normalizeSide(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'LONG';
  if (s === 'SHORT' || s === 'SELL') return 'SHORT';
  return null;
}

/** +1 for LONG/bullish reads, −1 for SHORT/bearish reads, null when unknown. */
export function sideSign(raw) {
  const s = normalizeSide(raw);
  return s === 'LONG' ? 1 : s === 'SHORT' ? -1 : null;
}

/** Opposite side, or null when side itself is not canonical. */
export function oppositeSide(raw) {
  const s = normalizeSide(raw);
  return s === 'LONG' ? 'SHORT' : s === 'SHORT' ? 'LONG' : null;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ------------------------------------------------------------
// V1 — TICKET GEOMETRY INVARIANT
// ------------------------------------------------------------
/**
 * A ticket is geometrically coherent only when:
 *   LONG  : SL < entry < T1 ≤ T2
 *   SHORT : SL > entry > T1 ≥ T2
 * T1 open (null/0) is tolerated at the entry stage; T2 needs T1.
 *
 * @returns {{ok:boolean, side:string|null, code:string, reason:string|null,
 *            impliedSide:string|null, inverted:boolean}}
 */
export function checkLevelGeometry({ side, entry, stopLoss, t1 = null, t2 = null } = {}) {
  const sd = normalizeSide(side);
  const e = num(entry);
  const sl = num(stopLoss);
  const a = num(t1);
  const b = num(t2);
  const base = { ok: false, side: sd, code: 'UNKNOWN', reason: null, impliedSide: null, inverted: false };
  if (!sd) return { ...base, code: 'SIDE_UNKNOWN', reason: `side "${side}" canonical LONG/SHORT nahi hai — refuse (no silent default)` };
  if (e == null) return { ...base, code: 'ENTRY_INVALID', reason: 'entry price missing/invalid' };
  if (sl == null) return { ...base, code: 'SL_INVALID', reason: 'stop-loss missing/invalid' };

  // Independent structural read: SL entry ke upar = SHORT structure, neeche = LONG.
  const impliedSide = sl > e ? 'SHORT' : sl < e ? 'LONG' : null;

  if (sl === e) return { ...base, impliedSide, code: 'SL_EQ_ENTRY', reason: 'SL == entry (zero risk) — ambiguous ticket' };

  if (sd === 'LONG') {
    if (sl > e) {
      return { ...base, impliedSide, inverted: true, code: 'LONG_SL_ABOVE_ENTRY', reason: `LONG ticket ka SL (${sl}) entry (${e}) ke UPAR hai — geometry SHORT structure hai (INVERSION)` };
    }
    if (a != null && !(a > e)) {
      return { ...base, impliedSide, inverted: true, code: 'LONG_T1_BELOW_ENTRY', reason: `LONG ka T1 (${a}) entry (${e}) ke neeche/barabar hai (INVERSION)` };
    }
    if (a != null && b != null && !(b >= a)) {
      return { ...base, impliedSide, inverted: true, code: 'LONG_T2_BELOW_T1', reason: `LONG ka T2 (${b}) < T1 (${a}) — target ladder ulta (INVERSION)` };
    }
  } else {
    if (sl < e) {
      return { ...base, impliedSide, inverted: true, code: 'SHORT_SL_BELOW_ENTRY', reason: `SHORT ticket ka SL (${sl}) entry (${e}) ke NEECHE hai — geometry LONG structure hai (INVERSION)` };
    }
    if (a != null && !(a < e)) {
      return { ...base, impliedSide, inverted: true, code: 'SHORT_T1_ABOVE_ENTRY', reason: `SHORT ka T1 (${a}) entry (${e}) ke upar/barabar hai (INVERSION)` };
    }
    if (a != null && b != null && !(b <= a)) {
      return { ...base, impliedSide, inverted: true, code: 'SHORT_T2_ABOVE_T1', reason: `SHORT ka T2 (${b}) > T1 (${a}) — target ladder ulta (INVERSION)` };
    }
  }
  return { ok: true, side: sd, code: 'OK', reason: null, impliedSide, inverted: false };
}

/**
 * v21.25.0 SELF-HEAL: geometry se side derive karke ticket ko coherent banao.
 * Doctrine #3 — kabhi silent nahi: `repaired` + `repairedFrom` + `note` stamp.
 * @returns {{side:string|null, repaired:boolean, repairedFrom:string|null,
 *            note:string|null, ok:boolean}}
 */
export function resolveSideFromGeometry({ side, entry, stopLoss, t1 = null, t2 = null } = {}) {
  const chk = checkLevelGeometry({ side, entry, stopLoss, t1, t2 });
  if (chk.ok) return { side: chk.side, repaired: false, repairedFrom: null, note: null, ok: true };
  // Side missing/invalid par geometry se honest derive (level-ordering invariant).
  const e = num(entry);
  const sl = num(stopLoss);
  const derived = e != null && sl != null && sl !== e ? (sl > e ? 'SHORT' : 'LONG') : null;
  if (derived) {
    const recheck = checkLevelGeometry({ side: derived, entry, stopLoss, t1, t2 });
    if (recheck.ok) {
      return {
        side: derived, repaired: true, repairedFrom: chk.side ?? (String(side ?? '').trim() || null), ok: true,
        note: `side geometry se derive kiya (SL ${sl > e ? '>' : '<'} entry ${e}) → ${derived}${chk.side ? ` (declared ${chk.side} tha)` : ''}`,
      };
    }
  }
  return { side: chk.side, repaired: false, repairedFrom: null, note: chk.reason, ok: false };
}

// ------------------------------------------------------------
// V2 — HANDOFF GUARD (board side → execution side)
// ------------------------------------------------------------
/**
 * Board/plan ne jo side decide kiya aur jo side execution (paper/live) me
 * ja rahi hai — dono identical hone chahiye. Ye wahi line hai jo ek din
 * `row.side` ki jagah kisi purane variable ko pass kar de to pakadti hai.
 *
 * @returns {{ok:boolean, code:string, reason:string|null, side:string|null}}
 */
export function assertExecutionSide({ signalSide, execSide, label = 'execution' } = {}) {
  const a = normalizeSide(signalSide);
  const b = normalizeSide(execSide);
  if (!a) return { ok: false, code: 'SIGNAL_SIDE_INVALID', side: null, reason: `signal side "${signalSide}" invalid — ${label} blocked (no silent LONG)` };
  if (!b) return { ok: false, code: 'EXEC_SIDE_INVALID', side: null, reason: `${label} side "${execSide}" invalid — blocked` };
  if (a !== b) return { ok: false, code: 'SIDE_MISMATCH', side: null, reason: `${label}: signal ${a} → order ${b} — INVERSION (blocked)` };
  return { ok: true, code: 'OK', side: a, reason: null };
}

/**
 * Scans any payload for side-vocabulary leaks (`buy`/`sell`, `LONG` in a
 * SHORT ticket, etc.). Used by the auditor + boot self-test.
 * @returns {{ok:boolean, leaks:string[]}}
 */
export function scanPayloadSideLeaks(payload, { expectSide = null } = {}) {
  const leaks = [];
  const want = normalizeSide(expectSide);
  const walk = (node, path) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      const lk = k.toLowerCase();
      if (lk === 'side' || lk === 'direction' || lk === 'transactiontype' || lk === 'orderside') {
        const n = normalizeSide(v);
        if (n && want && n !== want) leaks.push(`${p}=${v} (expected ${want})`);
      }
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if ((s === 'buy' || s === 'sell') && lk !== 'side' && lk !== 'direction') {
          // exchange vocab outside a side field is fine only if it matches.
          const n = s === 'buy' ? 'LONG' : 'SHORT';
          if (want && n !== want) leaks.push(`${p}="${v}" (expected ${want})`);
        }
      } else walk(v, p);
    }
  };
  walk(payload, '');
  return { ok: leaks.length === 0, leaks };
}

// ------------------------------------------------------------
// V3 — MULTI-FACTOR INDEPENDENT DIRECTION READ (advisory)
// ------------------------------------------------------------
/**
 * Builds the independent structural read of a ROW/TICKET from the plan data
 * so the row's declared side can be cross-examined without trusting any one
 * engine. Every vote is ±1/0 — no fabricated confidence.
 *
 * Votes:
 *   context   — deep-TF readContext dir
 *   trigger   — action-TF readTrigger dir (independent EMA/ROC/MACD net)
 *   emaStack  — trigger-TF EMA5/9/20 stacking at the last bar
 *   momentum  — ROC1/2/3 + MACD hist sign
 *   structure — higher-high/higher-low vs lower-high/lower-low from last bars
 *   ext       — 1d/4h HTF bias sign
 */
export function buildIndependentDirectionRead({ plan = null, snap = null } = {}) {
  const trig = plan?.trigger || {};
  const ctx = plan?.context || {};
  const votes = { context: 0, trigger: 0, emaStack: 0, momentum: 0, structure: 0, ext: 0 };
  const notes = [];

  const cd = Number(ctx.dir);
  if (Number.isFinite(cd) && cd !== 0) votes.context = cd > 0 ? 1 : -1;
  else notes.push('context dir neutral — no vote');

  const td = Number(trig.dir);
  if (Number.isFinite(td) && td !== 0) votes.trigger = td > 0 ? 1 : -1;

  const e5 = num(trig.ema5);
  const e9 = num(trig.ema9);
  const e20 = num(trig.ema20);
  const close = num(trig.lastBar?.close);
  if (e5 && e9 && e20 && close) {
    votes.emaStack = close > e5 && e5 >= e9 && e9 >= e20 ? 1
      : close < e5 && e5 <= e9 && e9 <= e20 ? -1
      : close > e20 && e9 >= e20 ? 0.5
      : close < e20 && e9 <= e20 ? -0.5 : 0;
  } else if (e9 && e20 && close) {
    votes.emaStack = close > e9 && e9 > e20 ? 1 : close < e9 && e9 < e20 ? -1 : 0;
  }

  const r1 = Number(trig.roc1 ?? 0);
  const r3 = Number(trig.roc3 ?? 0);
  const hist = Number(trig.macdHist ?? 0);
  const mom = (Number.isFinite(r1) ? r1 : 0) + (Number.isFinite(r3) ? r3 : 0) * 0.5;
  const macdS = Number.isFinite(hist) ? (hist > 0 ? 0.35 : hist < 0 ? -0.35 : 0) : 0;
  const momScore = (mom > 0.02 ? 0.5 : mom < -0.02 ? -0.5 : 0) + macdS;
  votes.momentum = momScore >= 0.5 ? 1 : momScore <= -0.5 ? -1 : momScore > 0 ? 0.5 : momScore < 0 ? -0.5 : 0;

  // Structure from the trigger bars we still have on the row.
  const last = trig.lastBar || null;
  const prev = trig.prevBar || null;
  if (last && prev) {
    if (last.close > prev.high) votes.structure = 1;
    else if (last.close < prev.low) votes.structure = -1;
    else if (last.close > last.open && last.close > (num(prev.high) ?? last.close) * 0.999) votes.structure = 0.5;
    else if (last.close < last.open) votes.structure = -0.5;
  }

  const bias = String(snap?.htfBias || snap?.consensus || '').toUpperCase();
  votes.ext = bias === 'BULLISH' ? 1 : bias === 'BEARISH' ? -1 : 0;

  // Weighted net of the independent reads (weights = how structural each is).
  const W = { context: 0.24, trigger: 0.26, emaStack: 0.20, momentum: 0.16, structure: 0.08, ext: 0.06 };
  const net = Object.entries(W).reduce((a, [k, w]) => a + w * (Number(votes[k]) || 0), 0);
  const netDir = net >= 0.18 ? 1 : net <= -0.18 ? -1 : 0;
  return { votes, net: Math.round(net * 1000) / 1000, netDir, notes };
}

/**
 * Full direction-integrity assessment of one board row / ticket.
 *
 * verdict:
 *   'MISSING_SIDE'  — side canonical nahi → refuse
 *   'GEOMETRY_BROKEN' — ticket levels hi inverted (HARD, always block)
 *   'INVERTED'      — declared side ke against ≥3 strong independent reads
 *                     (context + trigger + emaStack/momentum all opposite)
 *   'COUNTER_READ'  — 1-2 reads against (legit pullback/counter-trend WATCH)
 *   'ALIGNED'       — sab reads side ke saath
 *
 * @returns {{ok:boolean, verdict:string, hardBlock:boolean, score:number,
 *            side:string|null, netDir:number, agreeCount:number,
 *            againstCount:number, conflicts:string[], geometry:object,
 *            votes:object, label:string, note:string|null}}
 */
export function assessDirectionIntegrity({ side, plan = null, snap = null, entry = null, stopLoss = null, t1 = null, t2 = null } = {}) {
  const sd = normalizeSide(side);
  const geo = checkLevelGeometry({
    side: sd,
    entry: entry ?? plan?.plan?.entry,
    stopLoss: stopLoss ?? plan?.plan?.stopLoss,
    t1: t1 ?? plan?.plan?.t1,
    t2: t2 ?? plan?.plan?.t2,
  });
  const read = buildIndependentDirectionRead({ plan, snap });
  const sign = sideSign(sd);
  const conflicts = [];
  let agreeCount = 0;
  let againstCount = 0;
  if (sign != null) {
    for (const k of ['context', 'trigger', 'emaStack', 'momentum']) {
      const v = Number(read.votes[k] || 0);
      if (Math.abs(v) < 0.5) continue;
      if (Math.sign(v) === sign) agreeCount += 1;
      else { againstCount += 1; conflicts.push(`${k} ${v > 0 ? 'BULLISH' : 'BEARISH'} vs side ${sd}`); }
    }
    if (Math.abs(Number(read.votes.structure || 0)) >= 0.5 && Math.sign(read.votes.structure) !== sign) {
      conflicts.push(`structure ${read.votes.structure > 0 ? 'UP' : 'DOWN'} vs side ${sd}`);
    }
  }

  if (!sd) {
    return {
      ok: false, verdict: 'MISSING_SIDE', hardBlock: true, score: 0, side: null,
      netDir: read.netDir, agreeCount, againstCount, conflicts, geometry: geo, votes: read.votes,
      label: 'NO-SIDE', note: 'canonical LONG/SHORT side nahi — execution refuse',
    };
  }
  if (!geo.ok) {
    return {
      ok: false, verdict: 'GEOMETRY_BROKEN', hardBlock: true, score: 0, side: sd,
      netDir: read.netDir, agreeCount, againstCount, conflicts: [geo.reason, ...conflicts], geometry: geo, votes: read.votes,
      label: `GEOMETRY-BROKEN ${sd}`, note: geo.reason,
    };
  }

  // Score: 50 = neutral, 100 = perfectly aligned, 0 = fully inverted.
  const score = Math.max(0, Math.min(100, Math.round(50 + sign * read.net * 50)));
  const hardInversion = againstCount >= 3;
  const verdict = hardInversion ? 'INVERTED' : againstCount >= 1 ? 'COUNTER_READ' : 'ALIGNED';
  const label = verdict === 'INVERTED'
    ? `⚠ INVERTED-SUSPECT ${sd}`
    : verdict === 'COUNTER_READ'
      ? `COUNTER-READ ${sd} (${againstCount}/4)`
      : `ALIGNED ${sd} (${agreeCount}/4)`;
  return {
    ok: verdict !== 'INVERTED',
    verdict, hardBlock: hardInversion, score, side: sd,
    netDir: read.netDir, agreeCount, againstCount, conflicts, geometry: geo, votes: read.votes,
    label, note: verdict === 'INVERTED'
      ? `${againstCount} independent reads side ${sd} ke khilaaf (context/trigger/EMA/momentum) — inversion ka strong evidence, auto/live block`
      : verdict === 'COUNTER_READ'
        ? `counter-read ${againstCount}/4 — pullback/counter-trend WATCH (auto bar isse clear nahi karta)`
        : null,
  };
}

// ------------------------------------------------------------
// V4 — LEVEL / TRAIL / TARGET REPAIR GUARD
// ------------------------------------------------------------
/**
 * Post-execution level re-anchoring (fresh price, exchange fills, trailing SL)
 * must never cross the entry. This is the guard that keeps a live position's
 * SL/T1/T2 on the correct side of entry AFTER the order leaves the app.
 *
 * @returns {{ok:boolean, side:string, stopLoss:number, t1:number, t2:number,
 *            fixes:string[]}}
 */
export function guardLevelsForSide({ side, entry, stopLoss, t1 = null, t2 = null } = {}) {
  const sd = normalizeSide(side);
  const e = num(entry);
  const fixes = [];
  if (!sd || e == null) return { ok: false, side: sd, stopLoss: num(stopLoss), t1: num(t1), t2: num(t2), fixes: ['side/entry invalid — repair refuse'] };
  let sl = num(stopLoss);
  let a = num(t1);
  let b = num(t2);
  if (sd === 'LONG') {
    if (sl != null && sl >= e) { const bad = sl; sl = Math.min(e * 0.994, e - Math.max(e * 0.002, (e - (num(t1) ?? e)) * 0.5)); fixes.push(`LONG SL ${bad} entry ${e} ke upar tha → ${Math.round(sl * 1e4) / 1e4} pe repair (1R risk rebuild)`); }
    if (a != null && a <= e) { const bad = a; a = e + Math.max(e * 0.004, (e - (sl ?? e * 0.996)) * 1.2); fixes.push(`LONG T1 ${bad} entry se neeche tha → ${Math.round(a * 1e4) / 1e4}`); }
    if (a != null && b != null && b < a) { const bad = b; b = a + (a - e) * 0.6; fixes.push(`LONG T2 ${bad} < T1 ${a} → ${Math.round(b * 1e4) / 1e4}`); }
  } else {
    if (sl != null && sl <= e) { const bad = sl; sl = Math.max(e * 1.006, e + Math.max(e * 0.002, ((num(t1) ?? e) - e) * -0.5)); fixes.push(`SHORT SL ${bad} entry ${e} ke neeche tha → ${Math.round(sl * 1e4) / 1e4} pe repair`); }
    if (a != null && a >= e) { const bad = a; a = e - Math.max(e * 0.004, ((sl ?? e * 1.004) - e) * 1.2); fixes.push(`SHORT T1 ${bad} entry se upar tha → ${Math.round(a * 1e4) / 1e4}`); }
    if (a != null && b != null && b > a) { const bad = b; b = a - (e - a) * 0.6; fixes.push(`SHORT T2 ${bad} > T1 ${a} → ${Math.round(b * 1e4) / 1e4}`); }
  }
  const after = checkLevelGeometry({ side: sd, entry: e, stopLoss: sl, t1: a, t2: b });
  return { ok: after.ok, side: sd, stopLoss: sl, t1: a, t2: b, fixes, reason: after.reason };
}

// ------------------------------------------------------------
// BOOK-LEVEL WATCHDOG (AUTO Live Trade intelligence)
// ------------------------------------------------------------
/**
 * Audits every OPEN trade in an auto-link book: declared side vs ticket
 * geometry + declared side vs board side (when the row is available).
 * Returns counts + per-trade findings. Never mutates.
 */
export function auditBookDirectionIntegrity(book = [], boardRows = []) {
  const rows = Array.isArray(boardRows) ? boardRows : [];
  const bySymbol = new Map();
  for (const r of rows) {
    const k = String(r?.symbol || '').toUpperCase();
    if (k && !bySymbol.has(k)) bySymbol.set(k, r);
  }
  const findings = [];
  let checked = 0;
  let open = 0;
  for (const t of Array.isArray(book) ? book : []) {
    if (!t || typeof t !== 'object') continue;
    checked += 1;
    if (String(t.status || '').toUpperCase() !== 'OPEN') continue;
    open += 1;
    const sym = String(t.symbol || '').toUpperCase();
    const geo = checkLevelGeometry({ side: t.side, entry: t.entry, stopLoss: t.initialStopLoss ?? t.stopLoss, t1: t.t1, t2: t.t2 });
    const boardRow = bySymbol.get(sym);
    const handoff = boardRow && boardRow.side
      ? assertExecutionSide({ signalSide: boardRow.side, execSide: t.side, label: `${sym} live trade vs board` })
      : { ok: true, code: 'NO_BOARD_ROW', reason: null };
    if (!geo.ok || !handoff.ok) {
      findings.push({
        symbol: sym, side: normalizeSide(t.side), status: 'OPEN',
        code: !geo.ok ? geo.code : handoff.code,
        reason: !geo.ok ? geo.reason : handoff.reason,
        boardSide: boardRow?.side ?? null,
        severity: geo.inverted || !handoff.ok ? 'INVERSION' : 'BROKEN_TICKET',
      });
    }
  }
  return {
    ok: findings.length === 0,
    checked, open, findings,
    inversions: findings.filter(f => f.severity === 'INVERSION').length,
    asOf: Date.now(),
  };
}

/**
 * Compact, UI-ready digest of the integrity layer for the dual board payload.
 */
export function directionIntegrityDigest(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.directionIntegrity);
  const total = list.length;
  const count = (v) => list.filter(r => r.directionIntegrity.verdict === v).length;
  return {
    total,
    aligned: count('ALIGNED'),
    counterRead: count('COUNTER_READ'),
    inverted: count('INVERTED'),
    geometryBroken: count('GEOMETRY_BROKEN'),
    missingSide: count('MISSING_SIDE'),
    avgScore: total ? Math.round(list.reduce((a, r) => a + (Number(r.directionIntegrity.score) || 0), 0) / total) : null,
    hardBlocked: list.filter(r => r.directionIntegrity.hardBlock).map(r => r.symbol),
    asOf: Date.now(),
  };
}
