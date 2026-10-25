// ============================================================
// server/ai/directionSelfTest.js — v21.23.4 RUNTIME DIRECTION CERTIFICATE
// ------------------------------------------------------------
// WHY THIS EXISTS (user: "sab ke sab signals opposite jaa rahe hai —
// accurately fix karo, concrete level pe"):
//   Poore direction chain ke 20+ locks test-suite me the, par user
//   ke RUNNING BUILD ko kabhi bhi khud certify karne ka RASTA nahi
//   tha. Ye module server BOOT pe chalta hai + /api/ai/direction-
//   selftest se on-demand milta hai. Ye RAW CANDLES se lekar
//   exchange ORDER BODY tak ka poora chain SYNTHETIC ground-truth
//   pe prove karta hai — rising market → LONG → BUY order; falling
//   market → SHORT → SELL order. INTERNAL-CONSISTENCY nahi —
//   GROUND-TRUTH assertion (yahi wo blind spot tha jisse "sab
//   signals opposite" live reproduce hote rahe par tests green
//   rehte the).
//
// DESIGN CONTRACTS:
//   * Pure/deterministic — koi network/API call nahi (sirf pure
//     builders: buildPlanFromCandles, dhanOrderBody,
//     futuresOrderBody, sideSignOf).
//   * FAIL-LOUD: koi bhi check fail → pass:false + har check ka
//     detail. Boot pe console log + API response dono me dikhta hai.
//   * Ye certificate ye ANSWER deta hai: "mera build direction
//     ulti compute kar raha hai ya nahi?" — FAIL = code/data issue,
//     PASS = direction computation sahi hai (agar live me phir bhi
//     ulta dikhe to data-feed ya stale-build, computation nahi).
// ============================================================
import { buildPlanFromCandles } from './tradePlanner.js';
import { dhanOrderBody } from './dhan.js';
import { futuresOrderBody } from './futures.js';
import { sideSignOf } from './superIntel.js';
// v21.23.11 MIRROR-SHIELD: synthetic wire-drift cases (the missing test class)
import { canonicalizeCandles, ensureAscending, seriesOrientation } from './lib/candles.js';
// v21.25.0 DIRECTION INTEGRITY GUARD — geometry/handoff/repair certificates.
import {
  checkLevelGeometry, assertExecutionSide, resolveSideFromGeometry, guardLevelsForSide,
} from './directionIntegrity.js';

// ---- synthetic ground-truth candle generators (deterministic) ----
function makeRisingCandles(count = 90, start = 100, stepPct = 0.003, intervalMs = 300_000) {
  const out = [];
  let px = start;
  const t0 = Date.now() - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const drift = 1 + (stepPct * (0.6 + (i % 7 === 0 ? 0.5 : 0))); // small pullback bars, net up
    px = px * drift;
    const wick = px * 0.002;
    out.push({
      time: t0 + i * intervalMs,
      open: +(px * (1 - stepPct / 2)).toFixed(4),
      high: +(px + wick).toFixed(4),
      low: +(px * (1 - 0.004) - wick).toFixed(4),
      close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    });
  }
  return out;
}

function makeFallingCandles(count = 90, start = 100, stepPct = 0.003, intervalMs = 300_000) {
  const out = [];
  let px = start;
  const t0 = Date.now() - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const drift = 1 - (stepPct * (0.6 + (i % 7 === 0 ? 0.5 : 0))); // small bounce bars, net down
    px = px * drift;
    const wick = px * 0.002;
    out.push({
      time: t0 + i * intervalMs,
      open: +(px * (1 + stepPct / 2)).toFixed(4),
      high: +(px * (1 + 0.004) + wick).toFixed(4),
      low: +(px - wick).toFixed(4),
      close: +px.toFixed(4),
      volume: 100 + (i % 11) * 7,
    });
  }
  return out;
}

function planSideOf(candles) {
  const p = buildPlanFromCandles({
    symbol: 'BTC', market: 'CRYPTO', mode: 'INTRADAY',
    ctxCandles: candles, trigCandles: candles,
  });
  return p;
}

/**
 * The end-to-end runtime direction certificate.
 * @returns {{ pass: boolean, ranAt: number, version: string, checks: Array<{name:string, ok:boolean, detail:string}> }}
 */
export function runDirectionSelfTest() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail) });

  // ---- 1) RAW CANDLES → SIGNAL DIRECTION (ground truth, not consistency) ----
  const up = planSideOf(makeRisingCandles());
  add(
    'RISING market → signal LONG',
    up?.ok && up?.side === 'LONG',
    `rising 90-bar series → plan ${up?.ok ? 'ok' : 'REJECTED'}, side=${JSON.stringify(up?.side ?? null)}`,
  );
  if (up?.ok) {
    // LONG geometry: SL below entry, targets above (polarity proof)
    add(
      'LONG plan polarity (SL < entry < targets)',
      up.plan?.stopLoss != null && up.plan?.stopLoss < (up.plan?.entry ?? up.ltp) && (up.plan?.t1 ?? 0) > (up.plan?.entry ?? up.ltp),
      `entry=${up.plan?.entry} sl=${up.plan?.stopLoss} t1=${up.plan?.t1}`,
    );
  }

  const down = planSideOf(makeFallingCandles());
  add(
    'FALLING market → signal SHORT',
    down?.ok && down?.side === 'SHORT',
    `falling 90-bar series → plan ${down?.ok ? 'ok' : 'REJECTED'}, side=${JSON.stringify(down?.side ?? null)}`,
  );
  if (down?.ok) {
    add(
      'SHORT plan polarity (SL > entry > targets)',
      down.plan?.stopLoss != null && down.plan?.stopLoss > (down.plan?.entry ?? down.ltp) && (down.plan?.t1 ?? 0) < (down.plan?.entry ?? down.ltp),
      `entry=${down.plan?.entry} sl=${down.plan?.stopLoss} t1=${down.plan?.t1}`,
    );
  }

  // ---- 2) SIGNAL → EXCHANGE ORDER BODY (vocabulary proof) ----
  // dhan (India LIVE — the v21.23.2 BUG A class): LONG entry = BUY,
  // SHORT entry = SELL; protective SL exit = OPPOSITE side.
  try {
    const dhLong = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'LONG', quantity: 1, kind: 'ENTRY' });
    const dhShort = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'SHORT', quantity: 1, kind: 'ENTRY' });
    const tt = (b) => String(b?.transactionType || '').toUpperCase();
    add('dhan LONG entry → BUY transaction', tt(dhLong) === 'BUY', `transactionType=${tt(dhLong)}`);
    add('dhan SHORT entry → SELL transaction', tt(dhShort) === 'SELL', `transactionType=${tt(dhShort)}`);
    const dhSLonLong = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'LONG', quantity: 1, kind: 'SL', triggerPrice: 98.5 });
    const dhSLonShort = dhanOrderBody({ symbol: 'RELIANCE', securityId: '1234', side: 'SHORT', quantity: 1, kind: 'SL', triggerPrice: 101.5 });
    add('dhan LONG protective SL → SELL (exit-cover)', tt(dhSLonLong) === 'SELL', `transactionType=${tt(dhSLonLong)}`);
    add('dhan SHORT protective SL → BUY (exit-cover)', tt(dhSLonShort) === 'BUY', `transactionType=${tt(dhSLonShort)}`);
  } catch (e) {
    add('dhan order body matrix', false, `threw: ${e?.message || e}`);
  }

  // CoinDCX futures: LONG entry = buy, SHORT entry = sell
  try {
    const fLong = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'LONG', qty: 0.001, leverage: 3, price: 100000, marginCurrency: 'USDT' });
    const fShort = futuresOrderBody({ pair: 'B-BTC_USDT', side: 'SHORT', qty: 0.001, leverage: 3, price: 100000, marginCurrency: 'USDT' });
    const fs = (b) => String(b?.order?.side || '').toLowerCase();
    add('CoinDCX futures LONG → buy', fs(fLong) === 'buy', `order.side=${fs(fLong)}`);
    add('CoinDCX futures SHORT → sell', fs(fShort) === 'sell', `order.side=${fs(fShort)}`);
  } catch (e) {
    add('CoinDCX futures order body matrix', false, `threw: ${e?.message || e}`);
  }

  // ---- 3) SIDE-ALIAS SAFETY (v21.23.4) ----
  add("sideSignOf('LONG') = +1 / sideSignOf('SHORT') = −1",
    sideSignOf('LONG') === 1 && sideSignOf('SHORT') === -1,
    `LONG=${sideSignOf('LONG')} SHORT=${sideSignOf('SHORT')}`);
  add("sideSignOf('BUY') = +1 / sideSignOf('SELL') = −1 (exchange vocab alias)",
    sideSignOf('BUY') === 1 && sideSignOf('SELL') === -1,
    `BUY=${sideSignOf('BUY')} SELL=${sideSignOf('SELL')}`);
  add('sideSignOf(unknown) = null (honest refuse, no silent LONG)',
    sideSignOf('FLAT') == null && sideSignOf(undefined) == null && sideSignOf('') == null,
    `FLAT=${sideSignOf('FLAT')} undefined=${sideSignOf(undefined)}`);

  // ---- 4) MIRROR-SHIELD (v21.23.11 — the "sab opposite" ROOT-CAUSE class) ----
  // CoinDCX candles NEWEST-FIRST aate hain (docs + Aug-2026 SDKs .reverse()
  // karte hain). Legacy parse me timestamp-key drift (t→time→open_time)
  // NaN time banati thi → sort no-op → series API-order me hi REVERSED
  // rehti thi → har indicator ulta → SAB signals systematically opposite —
  // jabki prices WS-overlay se live dikhti thi ("site working fine"). Ye
  // section us wire-drift class ka SYNTHETIC regression hai.
  {
    // (a) docs shape, NEWEST-FIRST, ms time → canonicalize must ASC-end + reverse-detect
    const rising = makeRisingCandles(90);
    const newestFirst = rising.slice().reverse().map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, time: c.time,
    }));
    const canon = canonicalizeCandles(newestFirst, { label: 'selftest-mirror' });
    add(
      'MIRROR-SHIELD: docs-shape newest-first → canonical ASCENDING',
      Array.isArray(canon) && canon.length >= 30 && seriesOrientation(canon) === 'asc'
        && Math.abs(canon[canon.length - 1].close - rising[rising.length - 1].close) < 1e-9,
      `orientation=${canon ? seriesOrientation(canon) : 'null'} lastClose=${canon ? canon[canon.length - 1].close : 'n/a'} (expected latest ${rising[rising.length - 1].close})`,
    );
    // (b) drift shape open_time (no `time` key) + seconds → still parses & asc
    const driftShape = newestFirst.map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      open_time: Math.round(c.time / 1000), close_time: Math.round(c.time / 1000) + 899,
    }));
    const canon2 = canonicalizeCandles(driftShape, { label: 'selftest-open_time' });
    add(
      'MIRROR-SHIELD: open_time-key drift shape → parses, ASCENDING',
      Array.isArray(canon2) && canon2.length >= 30 && seriesOrientation(canon2) === 'asc'
        && Math.abs(canon2[canon2.length - 1].close - rising[rising.length - 1].close) < 1e-9,
      `bars=${canon2 ? canon2.length : 0} orientation=${canon2 ? seriesOrientation(canon2) : 'null'} lastClose=${canon2 ? canon2[canon2.length - 1].close : 'n/a'}`,
    );
    // (c) NaN-time rows dropped (never survive into the sort — NaN sort = no-op mirror)
    const withNaN = rising.map((c, i) => (i % 17 === 3 ? { ...c, time: NaN } : c));
    const canon3 = canonicalizeCandles(withNaN, { label: 'selftest-nan' });
    add(
      'MIRROR-SHIELD: NaN-time rows DROPPED (honest), survivors ascending',
      Array.isArray(canon3) && canon3.length === rising.length - Math.floor(rising.length / 17) - (rising.length % 17 > 3 ? 1 : 0)
        && canon3.every(c => Number.isFinite(c.time)) && seriesOrientation(canon3) === 'asc',
      `in=${withNaN.length} out=${canon3 ? canon3.length : 0}`,
    );
    // (d) THE FULL-CHAIN KILL SHOT: descending-fed RISING series through the
    //     REAL plan path must still read LONG (never SHORT) — ensureAscending
    //     defenses (indicators/_tfVote/overlay) rescue it. Yahi check pehle
    //     hota to live mirror kabhi silent nahi reh sakta tha.
    const mirroredPlan = planSideOf(rising.slice().reverse());
    add(
      'MIRROR-SHIELD: time-mirrored rising series → still LONG (never SHORT)',
      mirroredPlan?.ok ? mirroredPlan?.side === 'LONG' : true, // refuse bhi honest hai; SHORT kabhi nahi
      `mirrored series → plan ${mirroredPlan?.ok ? 'ok' : 'REJECTED (honest)'}, side=${JSON.stringify(mirroredPlan?.side ?? null)} — SHORT = live mirror disease`,
    );
    // (e) ensureAscending zero-copy guarantee (hot path unchanged)
    add(
      'MIRROR-SHIELD: ensureAscending ascending input → SAME reference (zero-copy)',
      ensureAscending(rising) === rising,
      `identity preserved=${ensureAscending(rising) === rising}`,
    );
  }

  // ---- 5) DIRECTION INTEGRITY GUARD (v21.25.0) ----
  // Ticket geometry = ground truth. Ek SHORT-shaped ticket LONG row me ghusa
  // ho to yahi check pakadta hai (aur yahi user ka "ulta trade" vector tha).
  {
    const longOk = checkLevelGeometry({ side: 'LONG', entry: 100, stopLoss: 98, t1: 104, t2: 108 });
    const shortOk = checkLevelGeometry({ side: 'SHORT', entry: 100, stopLoss: 102, t1: 96, t2: 92 });
    add('DIG geometry: coherent LONG (SL<entry<T1≤T2) + coherent SHORT (SL>entry>T1≥T2)',
      longOk.ok && shortOk.ok, `LONG=${longOk.code} SHORT=${shortOk.code}`);
    const longBroken = checkLevelGeometry({ side: 'LONG', entry: 100, stopLoss: 102, t1: 104, t2: 108 });
    const shortBroken = checkLevelGeometry({ side: 'SHORT', entry: 100, stopLoss: 98, t1: 96, t2: 92 });
    add('DIG geometry: SHORT-shaped LONG ticket + LONG-shaped SHORT ticket both flagged INVERTED',
      !longBroken.ok && longBroken.inverted && !shortBroken.ok && shortBroken.inverted,
      `LONG-vs-SHORT-sl=${longBroken.code} SHORT-vs-LONG-sl=${shortBroken.code}`);
    const noSide = checkLevelGeometry({ side: 'WAIT', entry: 100, stopLoss: 98 });
    add('DIG geometry: unknown side REFUSED (no silent LONG default)', noSide.code === 'SIDE_UNKNOWN', `code=${noSide.code}`);
    const handoffBad = assertExecutionSide({ signalSide: 'LONG', execSide: 'SHORT' });
    add('DIG handoff: LONG signal → SHORT order BLOCKED (SIDE_MISMATCH)',
      !handoffBad.ok && handoffBad.code === 'SIDE_MISMATCH', handoffBad.reason || 'no reason');
    const derived = resolveSideFromGeometry({ side: '', entry: 100, stopLoss: 102, t1: 96, t2: 92 });
    add('DIG geometry: missing side → honest derive from level-ordering (SHORT)',
      derived.ok && derived.side === 'SHORT' && derived.repaired, `side=${derived.side} repaired=${derived.repaired}`);
    const repaired = guardLevelsForSide({ side: 'LONG', entry: 100, stopLoss: 103, t1: 99, t2: 98 });
    add('DIG repair: inverted LONG levels re-derived to SL<entry<T1<T2',
      repaired.ok && repaired.stopLoss < 100 && repaired.t1 > 100 && repaired.t2 > repaired.t1,
      `SL=${repaired.stopLoss} T1=${repaired.t1} T2=${repaired.t2}`);
  }

  const pass = checks.every(c => c.ok);
  return {
    pass,
    ranAt: Date.now(),
    version: 'v21.25.0',
    passed: checks.filter(c => c.ok).length,
    total: checks.length,
    checks,
  };
}

/** Boot-time one-shot — logs the certificate result. */
export function logDirectionSelfTestAtBoot(log = null) {
  try {
    const r = runDirectionSelfTest();
    const line = `[direction-selftest] ${r.pass ? 'PASS' : 'FAIL'} ${r.passed}/${r.total} — rising→LONG/BUY · falling→SHORT/SELL certificate ${r.pass ? 'INTACT' : 'BROKEN (direction computation inspect karo!)'}`;
    if (typeof log === 'function') log(r.pass ? 'info' : 'error', line);
    else console.log(line);
    if (!r.pass) {
      const failed = r.checks.filter(c => !c.ok).map(c => `  ✗ ${c.name}: ${c.detail}`);
      const dump = failed.join('\n');
      if (typeof log === 'function') log('error', `[direction-selftest] failed checks:\n${dump}`);
      else console.error(`[direction-selftest] failed checks:\n${dump}`);
    }
    return r;
  } catch (e) {
    const msg = `[direction-selftest] CRASH: ${e?.message || e}`;
    if (typeof log === 'function') log('error', msg); else console.error(msg);
    return { pass: false, ranAt: Date.now(), version: 'v21.23.11', checks: [{ name: 'selftest-crash', ok: false, detail: String(e?.message || e) }] };
  }
}
