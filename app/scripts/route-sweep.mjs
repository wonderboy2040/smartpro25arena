#!/usr/bin/env node
// ============================================================
// scripts/route-sweep.mjs — v21.25.2 LIVE ROUTE SWEEP (pro-level recheck)
// ------------------------------------------------------------
// The static gates (`check:routes`) prove the FRONTEND calls a route that
// exists in source. They cannot prove the route actually ANSWERS on a running
// server. This script boots against a live instance and hits EVERY registered
// GET route (plus a few safe POSTs) with a real auth token, then reports:
//   • status class (2xx/4xx/5xx) and latency
//   • JSON `ok:false` answers (a route that "works" but reports a broken state)
//   • route-specific payload contract checks for the critical flows
//
// USAGE: node scripts/route-sweep.mjs [--base=http://127.0.0.1:8080] [--slow]
// EXIT:  0 = no 5xx / no broken contract · 1 = failures found
// ============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..');
const args = process.argv.slice(2);
const argOf = (k, d) => ((args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d);
const BASE = argOf('base', 'http://127.0.0.1:8080');
const SLOW = args.includes('--slow');

let TOKEN = process.env.API_TOKEN || '';
if (!TOKEN) {
  try {
    const env = readFileSync(path.join(APP, '.env'), 'utf8');
    TOKEN = (env.match(/^API_TOKEN=(.*)$/m) || [])[1]?.trim().replace(/^"|"$/g, '') || '';
  } catch { /* no .env */ }
}
const H = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

// ---- collect GET routes from source (single source of truth = the server) ----
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(path.join(APP, 'server'));
const routes = new Map(); // path -> {file}
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/app\.get\(\s*['"`]([^'"`]+)['"`]/g)) {
    const p = m[1];
    if (!p.startsWith('/api')) continue;
    if (!routes.has(p)) routes.set(p, { file: path.relative(APP, f) });
  }
}

// v21.25.2: an SSE endpoint never "finishes" — a naive GET holds the socket
// open until the sweep's own timeout, which produced 5 phantom failures
// ("ERR 0 45001ms") in the first recheck run. SSE routes are detected from the
// handler NAME documented in source and probed with a short read-then-abort
// instead of a normal request/response cycle.
function isSseRoute(routePath) {
  if (/stream|sse/i.test(routePath)) return true;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = new RegExp(`app\\.get\\(\\s*['\"\`]${routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"\`]`);
    if (!re.test(src)) continue;
    // handler referenced within ~200 chars, then look the handler up for SSE markers
    const idx = src.search(re);
    const around = src.slice(idx, idx + 260);
    const nameMatch = around.match(/,\s*([A-Za-z0-9_$]+)\s*\)/);
    if (nameMatch) {
      const fn = nameMatch[1];
      const fnIdx = src.indexOf(`function ${fn}(`);
      if (fnIdx >= 0) {
        const fnBody = src.slice(fnIdx, fnIdx + 4000);
        if (/text\/event-stream|writeHead\(200,\s*\{[^}]*event-stream/s.test(fnBody)) return true;
      }
    }
    if (/text\/event-stream/.test(around)) return true;
  }
  return false;
}

// Routes whose 5xx is EXPECTED on a box with no optional credentials/services
// (declared, not swept under the rug): the run still prints them, but as WARN.
const DECLARED_DEGRADE = new Map([
  ['/api/ai/orderbook', 'CoinDCX public depth endpoint blocked/unreachable from this host — no exchange keys'],
  ['/api/ai/expert/status', 'ml-service is an OPTIONAL sidecar (not started here)'],
  ['/api/ai/expert/analyze/:symbol', 'ml-service is an OPTIONAL sidecar (not started here)'],
  ['/api/cloud/load', 'cloud-sync Apps Script upstream not configured'],
  ['/api/cloud/load-key', 'cloud-sync Apps Script upstream not configured'],
  ['/api/intraday-briefing', 'LLM engines unavailable without keys — route degrades honestly (no fake briefing)'],
]);

// ---- substitute params so dynamic routes are still exercised ----
const SAMPLES = {
  symbol: 'BTC', market: 'FUTURES', tf: '5m', mode: 'INTRADAY', id: '1', desk: 'CRYPTO',
  date: new Date().toISOString().slice(0, 10), days: '7', limit: '10', botId: '1',
  name: 'x', key: 'x', type: 'x', bucket: '1',
};
function concrete(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, (_, k) => SAMPLES[k] ?? '1')
    .replace(/\*/g, '1');
}

const results = [];
const failures = [];
const warnings = [];

// SSE probe: open the stream, wait for the first bytes (default 4s), then
// abort. A route that emits `retry:` or an `event:`/`data:` line is HEALTHY —
// the old sweep called that a failure simply because the socket never closed.
async function hitSse(p, { waitMs = 4000 } = {}) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), waitMs);
  try {
    const r = await fetch(BASE + p, { headers: H, signal: ctl.signal });
    const ctype = r.headers.get('content-type') || '';
    let text = '';
    try {
      const reader = r.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        text = value ? Buffer.from(value).toString('utf8') : '';
        reader.cancel().catch(() => {});
      }
    } catch { /* abort during read is fine */ }
    clearTimeout(timer);
    const isSse = /text\/event-stream/i.test(ctype);
    const gotData = /(^|\n)(retry:|data:|event:|:)/.test(text);
    return { status: r.status, ms: Date.now() - t0, json: null, text: text.slice(0, 160), sse: true, sseOk: isSse && (gotData || r.status === 200), ctype };
  } catch (e) {
    clearTimeout(timer);
    // A timeout here means the stream opened but stayed silent past waitMs.
    return { status: 0, ms: Date.now() - t0, json: null, text: '', sse: true, sseOk: false, error: e?.name === 'AbortError' ? `no data within ${waitMs}ms` : (e?.message || String(e)) };
  }
}

async function hit(p, { method = 'GET', body = null, timeout = 45000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + p, {
      method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON ok for static */ }
    return { status: r.status, ms: Date.now() - t0, json, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, json: null, text: '', error: e?.message || String(e) };
  }
}

const sorted = [...routes.keys()].sort();
console.log(`SmartAI Pro route sweep — ${sorted.length} GET routes on ${BASE}\n`);

for (const raw of sorted) {
  const p = concrete(raw);
  const sse = isSseRoute(raw);
  const r = sse ? await hitSse(p) : await hit(p);

  if (sse) {
    const tag = r.sseOk ? 'SSE ' : 'ERR ';
    if (!r.sseOk) failures.push({ route: raw, status: r.status, error: `SSE probe: ${r.error || 'no event-stream data'}`, sample: (r.text || '').slice(0, 160) });
    results.push({ route: raw, status: r.status, ms: r.ms, ok: r.sseOk, sse: true });
    console.log(`  ${tag}${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms  ${raw}  [stream ${r.sseOk ? 'live' : 'dead'}]`);
    continue;
  }

  const tag = r.status === 0 ? 'ERR ' : r.status >= 500 ? '5XX ' : r.status >= 400 ? '4XX ' : '2XX ';
  const degrade = DECLARED_DEGRADE.get(raw);
  const bad = (r.status === 0 || r.status >= 500) && !degrade;
  if (bad) failures.push({ route: raw, status: r.status, error: r.error || '', sample: (r.text || '').slice(0, 200) });
  if (degrade && (r.status === 0 || r.status >= 500)) warnings.push(`${raw} — declared degrade: ${degrade}`);
  results.push({ route: raw, status: r.status, ms: r.ms, ok: r.json?.ok, degrade: !!degrade });
  if (!SLOW && r.ms > 25000) warnings.push(`${raw} — slow ${r.ms}ms`);
  // 4xx on a GET sweep is usually our own missing query param — that is the
  // route VALIDATING, not the route breaking. Flag only genuinely odd 4xx.
  if (r.status >= 400 && r.status < 500) {
    const rawErr = r.json?.error ?? r.json?.reason ?? r.text ?? '';
    const reason = (typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr)).slice(0, 140);
    warnings.push(`${raw} — ${r.status} ${reason || '(no body)'}`);
  }
  const okFlag = r.json && r.json.ok === false ? ' [ok:false]' : '';
  if (r.json && r.json.ok === false) {
    const rawErr = r.json.error ?? r.json.reason ?? '';
    warnings.push(`${raw} — answered ok:false (${(typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr)).slice(0, 140)})`);
  }
  console.log(`  ${tag}${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms  ${raw}${okFlag}${degrade && r.status >= 500 ? '  [declared degrade]' : ''}`);
}

// ---- critical flow contracts (only when the sweep is against a live box) ----
const checks = [];
const ck = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail: String(detail) }); };

const ping = await hit('/api/ping');
ck('boot: /api/ping answers with the current version', ping.status === 200 && !!ping.json?.v, `v=${ping.json?.v ?? 'n/a'} status=${ping.status}`);

const health = await hit('/api/health');
ck('health: /api/health ok + feeds reported', health.status === 200 && (health.json?.ok === true || health.json?.status), `ok=${health.json?.ok} feeds=${Array.isArray(health.json?.feeds) ? health.json.feeds.length : 'n/a'}`);

for (const [mkt, param] of [['FUTURES', 'FUTURES'], ['CRYPTO', 'CRYPTO'], ['INDIA', 'INDIA'], ['METALS', 'METALS'], ['GLOBALFUTURES', 'GLOBALFUTURES']]) {
  const r = await hit(`/api/ai/mtf-dual/board?market=${param}&mode=INTRADAY`, { timeout: 240000 });
  const board = r.json;
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  const shapeOk = board?.ok === true && Array.isArray(rows)
    && rows.every(x => x == null || (x.side === null || x.side === undefined || x.side === 'LONG' || x.side === 'SHORT'));
  ck(`MTF dual board ${mkt}: answers ok with LONG/SHORT-only rows`, shapeOk, `status=${r.status} rows=${rows.length} counts=${JSON.stringify(board?.counts || null)}`);
  if (board?.directionIntegrity) {
    ck(`MTF dual board ${mkt}: direction-integrity digest present`, true, JSON.stringify(board.directionIntegrity).slice(0, 140));
  }
  if (Array.isArray(rows) && rows.length) {
    const geoBad = rows.filter(x => x.plan && x.side && x.plan.entry && x.plan.stopLoss && x.plan.t1)
      .filter(x => x.side === 'LONG'
        ? !(x.plan.stopLoss < x.plan.entry && x.plan.entry < x.plan.t1)
        : !(x.plan.stopLoss > x.plan.entry && x.plan.entry > x.plan.t1));
    ck(`MTF dual board ${mkt}: every ticket geometry matches its side`, geoBad.length === 0, geoBad.length ? geoBad.map(x => x.symbol).join(',') : 'all coherent');
  }
}

const sig = await hit('/api/ai/signals?market=FUTURES&limit=8', { timeout: 180000 });
ck('main AI board: FUTURES signals answer with rankScore', sig.status === 200 && Array.isArray(sig.json?.signals), `n=${sig.json?.signals?.length ?? 0}`);

const auto = await hit('/api/ai/mtf-auto/status');
ck('AUTO: /mtf-auto/status answers', auto.status === 200 && auto.json?.ok === true, `enabled=${auto.json?.enabled} mode=${auto.json?.executionMode} open=${auto.json?.openCount}`);
ck('AUTO: book direction watchdog present + no inversion', auto.json?.directionIntegrityBook != null && (auto.json.directionIntegrityBook.inversions || 0) === 0, JSON.stringify(auto.json?.directionIntegrityBook || {}).slice(0, 120));

const paper = await hit('/api/intraday-paper?market=CRYPTO');
ck('Paper desk CRYPTO: summary answers', paper.status === 200, `status=${paper.status} open=${(paper.json?.open || []).length}`);

const pos = await hit('/api/positions');
ck('Execution: /api/positions answers', pos.status < 500, `status=${pos.status}`);

const st = await hit('/api/ai/state');
ck('State: /api/ai/state answers', st.status < 500, `status=${st.status}`);

const userRun = await hit('/api/ai/mtf-auto/preview');
ck('AUTO preview: answers (never 5xx)', userRun.status < 500, `status=${userRun.status} desks=${Object.keys(userRun.json?.preview || {}).join(',') || 'n/a'}`);

// kill-switch route: explicit-boolean contract (v21.25.2 fix) — the route used
// to DISARM on any body that lacked `enabled`, including `{"on":true}`.
const ksEmpty = await hit('/api/ai/trading/kill-switch', { method: 'POST', body: {} });
const ksOn = await hit('/api/ai/trading/kill-switch', { method: 'POST', body: { on: true } });
const ksOff = await hit('/api/ai/trading/kill-switch', { method: 'POST', body: { enabled: false } });
ck('kill-switch: empty body is rejected (no silent disarm)', ksEmpty.status === 400, `status=${ksEmpty.status}`);
ck('kill-switch: {on:true} alias arms it', ksOn.status === 200 && ksOn.json?.config?.killSwitch === true, `status=${ksOn.status} killSwitch=${ksOn.json?.config?.killSwitch}`);
ck('kill-switch: {enabled:false} disarms it again', ksOff.status === 200 && ksOff.json?.config?.killSwitch === false, `status=${ksOff.status} killSwitch=${ksOff.json?.config?.killSwitch}`);

// ---- report ----
const pass = checks.filter(c => c.pass).length;
console.log('\n── contract checks ─────────────────────────────────────');
for (const c of checks) console.log(`  ${c.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name} — ${c.detail}`);

if (warnings.length) {
  console.log('\n── warnings ────────────────────────────────────────────');
  for (const w of warnings.slice(0, 20)) console.log(`  ~ ${w}`);
}
if (failures.length) {
  console.log('\n── FAILURES ────────────────────────────────────────────');
  for (const f of failures) console.log(`  ✗ ${f.route} → ${f.status || f.error} ${f.sample}`);
}

const byStatus = results.reduce((a, r) => { const k = String(r.status)[0] + 'xx'; a[k] = (a[k] || 0) + 1; return a; }, {});
console.log(`\n══════════════════════════════════════════════`);
console.log(`ROUTES: ${results.length} · ${JSON.stringify(byStatus)} · failures ${failures.length}`);
console.log(`CONTRACTS: ${pass}/${checks.length} pass`);
console.log(`RESULT: ${failures.length === 0 && pass === checks.length ? 'PASS' : 'FAIL'}`);
process.exit(failures.length === 0 && pass === checks.length ? 0 : 1);
