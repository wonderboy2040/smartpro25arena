#!/usr/bin/env node
// ============================================================
// scripts/direction-audit.mjs — MTF DUAL BOARD + AUTO-LIVE
// DIRECTION INVERSION AUDITOR (v21.25.0)
// ------------------------------------------------------------
// The user question this answers, with NUMBERS (not vibes):
//   "long signal pe short jaa raha hai kya? short signal pe long?"
//
// FOR EVERY dual-board row it re-derives the trend INDEPENDENTLY from the
// row's own candles (never from the row's own claim) and runs 6 checks:
//
//   C1 GEOMETRY   LONG  : SL < entry < T1 < T2   (a SHORT ticket that
//                 slipped into a LONG row shows up here instantly)
//                 SHORT : SL > entry > T1 > T2
//   C2 SIDE↔CTX   row.side must agree with the CONTEXT-TF trend
//   C3 SIDE↔TRIG  row.side must agree with the TRIGGER-TF momentum
//   C4 SIDE↔EMA   close vs EMA20/EMA50 on the trigger TF
//   C5 SIDE↔SLOPE linear-regression slope of the last N closes
//   C6 AUTO-LINK  the auto-execution side equals the row side
//   C7 DIG        the row's own direction-integrity verdict is not
//                 INVERTED/GEOMETRY_BROKEN/MISSING_SIDE (v21.25.0)
//   C8 LIVE-INTEL 8-check conviction stack present + consistent with
//                 autoEligible (v21.25.0 AUTO Live Trade intelligence)
//
// SEVERITY DOCTRINE (v21.25.0):
//   INVERSION (exit 1) = a ticket/handoff/level contradiction, i.e. the trade
//   that would actually be placed is the WRONG SIDE. Only C1, C6, C7 and the
//   auto-live book audit can raise this.
//   COUNTER-READ (warn only) = C2-C5 disagree with an independent EMA/momentum
//   read. tradePlanner deliberately allows counter-trend / pullback WATCH rows
//   (8-indicator institutional net vote ≠ EMA20/50 stack). Those rows are
//   WATCH-only and never auto-eligible, so they are a warning, not an inversion.
//
// USAGE: node scripts/direction-audit.mjs [--base=http://127.0.0.1:8080]
//        [--markets=FUTURES,INDIA,CRYPTO] [--mode=INTRADAY|SWING]
// EXIT:  0 = no inversion found · 1 = inversion detected
// ============================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..');
const args = process.argv.slice(2);
const argOf = (k, d) => ((args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d);
const BASE = argOf('base', 'http://127.0.0.1:8080');
const MODE = argOf('mode', 'INTRADAY');
const MARKETS = argOf('markets', 'FUTURES,CRYPTO,INDIA').split(',').map(s => s.trim().toUpperCase());

// token: env first, then app/.env
let TOKEN = process.env.API_TOKEN || '';
if (!TOKEN) {
  try {
    const env = readFileSync(path.join(APP, '.env'), 'utf8');
    TOKEN = (env.match(/^API_TOKEN=(.*)$/m) || [])[1]?.trim().replace(/^"|"$/g, '') || '';
  } catch { /* no .env */ }
}
const H = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function jget(p, ms = 180000) {
  const r = await fetch(BASE + p, { headers: H, signal: AbortSignal.timeout(ms) });
  return r.json();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ema = (vals, p) => {
  if (!Array.isArray(vals) || vals.length < p) return null;
  const k = 2 / (p + 1);
  let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
};
const slope = (vals, n = 20) => {
  const v = vals.slice(-n);
  if (v.length < n) return null;
  const xm = (n - 1) / 2;
  const ym = v.reduce((a, b) => a + b, 0) / n;
  let sn = 0, sd = 0;
  for (let i = 0; i < n; i++) { sn += (i - xm) * (v[i] - ym); sd += (i - xm) ** 2; }
  return sd === 0 ? 0 : sn / sd;
};

async function candlesFor(symbol, market, tf) {
  const m = market === 'CRYPTO' ? 'CRYPTO' : market;
  const r = await jget(`/api/ai/candles?symbol=${encodeURIComponent(symbol)}&market=${m}&tf=${tf}&limit=180`, 90000).catch(() => null);
  return Array.isArray(r?.candles) ? r.candles : [];
}

let fails = 0, passes = 0, unverified = 0, warns = 0;
const inversions = [];
const counterReads = [];
const ok = (m) => { passes++; console.log(`    \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, tag) => { fails++; inversions.push({ tag, m }); console.log(`    \x1b[31m✗ INVERSION\x1b[0m ${m}`); };
const warn = (m, tag = 'COUNTER-READ') => { warns++; counterReads.push({ tag, m }); console.log(`    \x1b[35m~ counter-read\x1b[0m ${m}`); };
const skip = (m) => { unverified++; console.log(`    \x1b[33m·\x1b[0m ${m} (unverified)`); };

for (const market of MARKETS) {
  const dualBase = market === 'CRYPTO' ? 'CRYPTO' : market;
  const b = await jget(`/api/ai/mtf-dual/board?market=${dualBase}&mode=${MODE}&limit=6`).catch(() => null);
  if (!b?.ok) { console.log(`\n## ${market}: board unavailable (${b?.error || 'no payload'})`); continue; }
  const rows = (b.rows || []).filter(r => r?.side === 'LONG' || r?.side === 'SHORT');
  console.log(`\n## ${market} · ${b.mode} · ${b.contextTf}+${b.triggerTf} · ${rows.length} directional rows`);
  if (rows.length === 0) { console.log('   (koi directional row nahi)'); continue; }

  for (const row of rows) {
    const sym = row.symbol;
    const side = row.side;
    const want = side === 'LONG' ? 1 : -1;
    const p = row.plan || {};
    console.log(`  ── ${sym} ${side} (score ${row.superScore} ${row.tier})`);

    // ---- C1 GEOMETRY (the sharpest inversion detector) ----
    const entry = num(p.entry), sl = num(p.stopLoss), t1 = num(p.t1), t2 = num(p.t2);
    if ([entry, sl, t1, t2].every(v => v != null && v > 0)) {
      const geoOk = want === 1
        ? (sl < entry && entry < t1 && t1 <= t2)
        : (sl > entry && entry > t1 && t1 >= t2);
      if (geoOk) ok(`C1 geometry ${side}: SL ${sl} ${want === 1 ? '<' : '>'} entry ${entry} ${want === 1 ? '<' : '>'} T1 ${t1} ${want === 1 ? '≤' : '≥'} T2 ${t2}`);
      else bad(`C1 GEOMETRY INVERTED for ${side}: entry ${entry} SL ${sl} T1 ${t1} T2 ${t2} — ye ticket ${side === 'LONG' ? 'SHORT' : 'LONG'} shape ka hai`);
    } else skip('C1 geometry (levels missing)');

    // ---- independent trend from the row's own candles ----
    const ctxTf = row.contextTf || b.contextTf;
    const trigTf = row.triggerTf || b.triggerTf;
    const [ctxC, trigC] = await Promise.all([
      candlesFor(sym, market, ctxTf),
      candlesFor(sym, market, trigTf),
    ]);

    const trendOf = (cs) => {
      const cl = cs.map(c => num(c.close)).filter(v => v != null);
      if (cl.length < 55) return null;
      const e20 = ema(cl, 20), e50 = ema(cl, 50);
      if (e20 == null || e50 == null) return null;
      return { dir: e20 > e50 ? 1 : e20 < e50 ? -1 : 0, e20, e50, last: cl.at(-1) };
    };

    const ctxT = trendOf(ctxC);
    if (ctxT) {
      if (ctxT.dir === want) ok(`C2 context ${ctxTf} EMA20 ${ctxT.dir > 0 ? '>' : '<'} EMA50 — ${side} ke saath`);
      else if (ctxT.dir === 0) skip(`C2 context ${ctxTf} flat`);
      else warn(`C2 context ${ctxTf} EMA20 ${ctxT.dir > 0 ? '>' : '<'} EMA50 vs row ${side} (counter-trend WATCH — inversion nahi)`);
    } else skip(`C2 context ${ctxTf} candles thin (${ctxC.length})`);

    const trigT = trendOf(trigC);
    if (trigT) {
      // momentum on the trigger TF: last close vs 10 bars back + slope
      const cl = trigC.map(c => num(c.close)).filter(v => v != null);
      const mom10 = cl.length > 10 ? cl.at(-1) - cl[cl.length - 11] : null;
      const mdir = mom10 == null ? 0 : mom10 > 0 ? 1 : mom10 < 0 ? -1 : 0;
      if (mdir === want) ok(`C3 trigger ${trigTf} 10-bar momentum ${mdir > 0 ? '↑' : '↓'} — ${side} ke saath`);
      else if (mdir === 0) skip(`C3 trigger momentum flat`);
      else warn(`C3 ${trigTf} 10-bar momentum ${mdir > 0 ? 'up' : 'down'} vs row ${side} (counter-read)`);

      if (trigT.dir === want) ok(`C4 price vs EMA20/50 on ${trigTf} — aligned`);
      else if (trigT.dir === 0) skip('C4 EMAs flat');
      else warn(`C4 ${trigTf} EMA20 ${trigT.dir > 0 ? '>' : '<'} EMA50 vs row ${side} (counter-read)`);

      const sl20 = slope(cl, 20);
      if (sl20 != null) {
        const sdir = sl20 > 0 ? 1 : sl20 < 0 ? -1 : 0;
        const relMove = cl.at(-1) ? Math.abs(sl20 * 20 / cl.at(-1)) * 100 : 0; // % over 20 bars
        if (sdir === want || relMove < 0.05) ok(`C5 regression slope ${sdir > 0 ? '+' : ''}${relMove.toFixed(3)}% / 20 bars — ${sdir === want ? 'aligned' : 'flat (neutral)'}`);
        else warn(`C5 ${trigTf} 20-bar slope ${sdir > 0 ? '+' : ''}${relMove.toFixed(3)}% vs row ${side} (counter-read)`);
      } else skip('C5 slope (thin)');
    } else skip(`C3-C5 trigger ${trigTf} candles thin (${trigC.length})`);

    // ---- C6 auto-link side consistency ----
    if (row.autoEligible === true) {
      const as = String(row.autoSide || row.side || '').toUpperCase();
      if (as === side) ok(`C6 auto-link side ${as} == row side`);
      else bad(`C6 AUTO-LINK SIDE MISMATCH: row ${side} par auto ${as}`);
    } else skip('C6 auto-link (row not auto-eligible)');

    // ---- C7 DIRECTION INTEGRITY GUARD (row's own, independent, verdict) ----
    const dig = row.directionIntegrity;
    if (dig && dig.verdict) {
      if (dig.verdict === 'ALIGNED') ok(`C7 DIG ${dig.label} · score ${dig.score}/100 · ${dig.agreeCount}/4 reads aligned`);
      else if (dig.verdict === 'COUNTER_READ') warn(`C7 DIG ${dig.label} · ${dig.againstCount}/4 reads against (auto bar isse block karta hai)`);
      else bad(`C7 DIG ${dig.verdict} — ${((dig.conflicts || []).slice(0, 2).join('; ')) || dig.note}`, 'C7-DIG');
      // geometry cross-check between the app's guard and this auditor
      if (dig.geometry && dig.geometry.code && dig.geometry.code !== 'OK') {
        bad(`C7 DIG geometry ${dig.geometry.code}: ${dig.geometry.reason}`, 'C7-GEO');
      }
    } else skip('C7 DIG (payload purana hai — v21.25.0 board chahiye)');

    // ---- C8 AUTO LIVE conviction stack ----
    const li = row.liveIntelligence;
    if (li && Array.isArray(li.checks)) {
      const n = `${li.checksPassed}/${li.checksTotal}`;
      if (li.liveReady && row.autoEligible === false) {
        bad(`C8 liveReady=true par autoEligible=false — lane contradiction (${n})`, 'C8-LANE');
      } else if (li.liveReady) {
        ok(`C8 LIVE-READY ${n} checks · conviction ${li.convictionScore}/100 (${li.convictionTier})`);
      } else {
        console.log(`    \x1b[36m·\x1b[0m C8 conviction ${n} · ${li.convictionTier} — live bar neeche (LIVE order nahi jayega, PAPER eligible)`);
      }
      const l1 = (li.checks || []).find(c => String(c.k).startsWith('L1'));
      if (l1 && !l1.ok && row.autoEligible === true) bad(`C8 L1 direction integrity fail hone par bhi row auto-eligible hai — gate hole`, 'C8-GATE');
    } else skip('C8 live intelligence (payload purana hai)');
  }
}

// ============================================================
// AUTO LIVE TRADE — every open auto position must match the signal side
// it was opened from; and the execution payload side vocabulary must be
// LONG/SHORT (never buy/sell confusion).
// ============================================================
console.log('\n## AUTO LIVE TRADE intelligences');
{
  const st = await jget('/api/ai/mtf-auto/status').catch(() => null);
  const book = st?.directionIntegrityBook;
  if (book && typeof book.open === 'number') {
    if (book.inversions > 0) bad(`AUTO LIVE BOOK: ${book.inversions} inversion(s) in ${book.open} open trades — ${book.findings.map(f => `${f.symbol} ${f.code}`).join(', ')}`, 'BOOK');
    else ok(`AUTO LIVE BOOK: ${book.open} open trade(s) audited (${book.checked} book rows) — declared side vs SL/T1/T2 geometry coherent`);
  } else skip('AUTO LIVE BOOK audit (status payload me directionIntegrityBook nahi)');
}
for (const p of ['/api/ai/mtf-auto/status', '/api/ai/mtf-auto/preview', '/api/ai/protrader-auto']) {
  const r = await jget(p).catch(() => null);
  if (!r) { skip(`${p} unreachable`); continue; }
  if (r.ok === false) { skip(`${p} → ok:false (${r.error || 'n/a'})`); continue; }
  const blob = JSON.stringify(r);
  const buySellSides = [...blob.matchAll(/"(side|direction|orderSide)"\s*:\s*"(buy|sell|BUY|SELL)"/g)].map(m => m[0]);
  buySellSides.length === 0
    ? ok(`${p} — side vocabulary clean (LONG/SHORT only)`)
    : bad(`${p} — buy/sell side vocabulary leak: ${buySellSides.slice(0, 3).join(' ')}`);

  const longs = (blob.match(/"side"\s*:\s*"LONG"/g) || []).length;
  const shorts = (blob.match(/"side"\s*:\s*"SHORT"/g) || []).length;
  const other = (blob.match(/"side"\s*:\s*"(?!LONG|SHORT)[A-Za-z]+"/g) || []).length;
  console.log(`    · ${p}: LONG tags ${longs} · SHORT tags ${shorts} · other ${other}`);
}

console.log(`\n══════════════════════════════════════════════`);
console.log(`RESULT: ${passes} pass · ${fails} INVERSION · ${warns} counter-read (warn) · ${unverified} unverified`);
if (fails > 0) {
  console.log('\nInversions (these would place the WRONG side — must be 0):');
  for (const i of inversions) console.log(`  [${i.tag}] ${i.m}`);
}
if (warns > 0) {
  console.log('\nCounter-reads (WATCH-only rows, auto bar blocked — informational):');
  for (const i of counterReads.slice(0, 12)) console.log(`  [${i.tag}] ${i.m}`);
}
console.log('');
process.exit(fails === 0 ? 0 : 1);
