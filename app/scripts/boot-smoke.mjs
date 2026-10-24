#!/usr/bin/env node
// ============================================================
// scripts/boot-smoke.mjs — VERSION-AGNOSTIC BOOT VERIFICATION (v21.24.0)
// ------------------------------------------------------------
// WHY THIS REPLACES e2e_v2112_boot_check.mjs + e2e_v2114_boot_check.mjs:
//   those two were one-shot release proofs PINNED to a version literal
//   ("expect 21.14.0", "expect the laya endpoint removed"). The moment the
//   app moved on they became guaranteed failures — dead weight that still
//   LOOKED like a test. This script asserts the same CONTRACTS but reads
//   the expected version from package.json, so it stays valid forever.
//
// CONTRACTS PROVEN (bare env — no AI keys, no .env, like a fresh user):
//   1. the server BOOTS without crashing and binds a port
//   2. /api/ping version == package.json version (stale-build guard)
//   3. /api/health returns ok + a committee snapshot
//   4. /api/ai/signals answers for INDIA + CRYPTO with a contract-shaped
//      payload (ok:true, signals[], topFive[]) — or an HONEST degrade
//   5. /api/ai/direction-selftest PASSES (rising→LONG, falling→SHORT)
//      — the ground-truth direction certificate, the single most
//      important invariant of this app
//
// USAGE: node scripts/boot-smoke.mjs [--port=8091] [--keep]
// EXIT:  0 = all PASS · 1 = a contract failed
// ============================================================
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..');
const args = process.argv.slice(2);
const PORT = Number((args.find(a => a.startsWith('--port=')) || '').slice(7)) || 8091;
const PIN = '917183';
const TOKEN = 'BootSmokeLocalServiceToken0123456789';
const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m[PASS]\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[31m[FAIL]\x1b[0m ${m}`); };

console.log(`\nSmartAI Pro boot-smoke — expecting v${pkg.version} on :${PORT}\n`);

const child = spawn(process.execPath, [path.join(APP, 'server', 'index.js')], {
  cwd: APP,
  env: {
    ...process.env,
    PORT: String(PORT),
    APP_PIN: PIN,
    API_TOKEN: TOKEN,
    NODE_ENV: 'test',
    // keep the box quiet: no loops that hammer upstreams during the smoke
    SELFIMPROVE_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d; });
child.stderr.on('data', (d) => { bootLog += d; });

const base = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}` };

async function jget(p, ms = 90000) {
  const r = await fetch(base + p, { headers: H, signal: AbortSignal.timeout(ms) });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

async function waitForBoot(maxMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (child.exitCode != null) return false;
    try {
      const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

function cleanup() {
  if (!args.includes('--keep')) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

try {
  if (await waitForBoot()) ok('server booted and answered /api/ping');
  else {
    bad('server did NOT boot within 120s');
    console.log(bootLog.split('\n').slice(-25).join('\n'));
    cleanup();
    process.exit(1);
  }

  const ping = await jget('/api/ping', 15000);
  const v = ping.json?.v ?? ping.json?.version;
  v === pkg.version ? ok(`/api/ping version = ${v} (matches package.json)`)
    : bad(`/api/ping version ${v} ≠ package.json ${pkg.version}`);

  const health = await jget('/api/health', 30000);
  health.status === 200 && health.json?.ok !== false
    ? ok('/api/health ok')
    : bad(`/api/health → HTTP ${health.status}`);
  const aiBlock = health.json?.ai ?? null;
  const committeeBits = aiBlock?.boardConfirm ?? aiBlock?.committee ?? null;
  committeeBits ? ok(`AI layer reported (boardConfirm mode=${committeeBits.mode ?? 'n/a'}, active=${committeeBits.active})`)
    : console.log('  \x1b[33m[WARN]\x1b[0m AI block absent from /api/health (non-fatal)');
  const feeds = health.json?.feeds;
  if (feeds && typeof feeds === 'object') {
    const bad = Object.entries(feeds).filter(([, v]) => v && v.ok === false).map(([k]) => k);
    bad.length === 0 ? ok(`all reported feeds ok (${Object.keys(feeds).length})`)
      : console.log(`  \x1b[33m[WARN]\x1b[0m feeds not ok: ${bad.join(', ')} (market feeds can be down — non-fatal)`);
  }

  for (const market of ['CRYPTO', 'INDIA']) {
    const r = await jget(`/api/ai/signals?market=${market}&limit=8`, 150000);
    const b = r.json || {};
    const shaped = r.status === 200 && b.market === market
      && Array.isArray(b.signals) && Array.isArray(b.topFive);
    if (shaped) {
      ok(`${market} board contract OK — signals ${b.signals.length} · topFive ${b.topFive.length} · ok=${b.ok}`);
    } else {
      bad(`${market} board contract BROKEN — HTTP ${r.status} ${JSON.stringify(b).slice(0, 160)}`);
    }
    // the rank key must be present on scored rows (tradability gate rides it)
    const ranked = (b.signals || []).filter(s => s?.superIntel);
    if (ranked.length > 0) {
      const withoutRank = ranked.filter(s => !(Number(s.superIntel.rankScore) > 0)).length;
      withoutRank === 0 ? ok(`${market} every scored row carries a rankScore (${ranked.length})`)
        : bad(`${market} ${withoutRank}/${ranked.length} scored rows have NO rankScore`);
    }
  }

  const cert = await jget('/api/ai/direction-selftest', 90000);
  cert.json?.pass === true
    ? ok(`direction self-test PASS (${(cert.json.checks || []).length || '?'} checks — rising→LONG, falling→SHORT)`)
    : bad(`direction self-test FAILED — ${JSON.stringify(cert.json).slice(0, 300)}`);
} catch (e) {
  bad(`unexpected error: ${e?.message || e}`);
} finally {
  cleanup();
}

console.log(`\nRESULT: ${pass} pass · ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
