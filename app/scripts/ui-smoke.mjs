#!/usr/bin/env node
// ============================================================
// UI SMOKE — real-browser end-to-end check (Playwright/Chromium)
// ============================================================
// v21.25.2 RECHECK: server-side probes (route-sweep.mjs, full-diagnostic.mjs)
// prove the APIs answer, but they can NEVER prove the React app actually
// mounts, the PIN gate unlocks, the three desks render their panels, and no
// uncaught promise/console error fires. This script drives a headless
// Chromium against a running server and reports:
//   • login flow (wrong PIN rejected, real PIN unlocks)
//   • per-desk mount (INDIA / CRYPTO / BOTS) + visible text sample
//   • console errors, page errors, and failed /api/* responses
//   • screenshots per desk (data/ui-audit-<ts>/)
//
// Usage:  node scripts/ui-smoke.mjs [--base http://localhost:8080]
// Env:    APP_PIN (defaults to reading app/.env), API_TOKEN
// Exit:   0 = clean, 1 = at least one FAIL
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = argVal('--base', process.env.UI_BASE || 'http://localhost:8080');

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const raw = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8');
    const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const PIN = envValue('APP_PIN');

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(APP_DIR, 'data', `ui-audit-${ts}`);
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail = '') => results.push({ ok: false, name, detail });

const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
let loginPhase = true; // console noise during the deliberate wrong-PIN step is expected

let playwright;
// ESM ignores NODE_PATH, so resolve playwright from the app FIRST and then from
// a scratch install (PLAYWRIGHT_HOME=/path/to/dir-with-node_modules).
const playwrightCandidates = [
  'playwright',
  ...(process.env.PLAYWRIGHT_HOME
    ? [pathToFileURL(path.join(process.env.PLAYWRIGHT_HOME, 'node_modules', 'playwright', 'index.js')).href]
    : []),
];
for (const cand of playwrightCandidates) {
  try {
    const mod = await import(cand);
    playwright = mod.chromium ? mod : (mod.default || mod);
    if (playwright?.chromium) break;
  } catch { /* next */ }
}
if (!playwright) {

  console.error('ui-smoke: playwright not installed — run `npm i playwright && npx playwright install chromium` in a scratch dir, then PLAYWRIGHT_HOME=<that dir> node scripts/ui-smoke.mjs');
  process.exit(1);
}

const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const t = msg.text();
    // Favicon / manifest noise is not a product bug.
    if (/favicon|manifest\.json|sw\.js/i.test(t)) return;
    // 401 from the deliberate wrong-PIN attempt is expected noise.
    if (loginPhase && /401 \(Unauthorized\)/.test(t)) return;
    consoleErrors.push(t.slice(0, 400));
  }
});
page.on('pageerror', (err) => pageErrors.push(String(err?.message || err).slice(0, 400)));
page.on('response', (res) => {
  const u = res.url();
  if (!u.includes('/api/')) return;
  const s = res.status();
  // The wrong-PIN step deliberately produces a 401 on /api/auth/login — that
  // is the security gate working, not a defect.
  if (s >= 400 && !/^\/api\/auth\/login$/.test(new URL(u).pathname)) {
    badResponses.push(`${s} ${new URL(u).pathname}${new URL(u).search}`);
  }
});

try {
  // ---------------- 1. Login gate ----------------
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  pass('login screen renders (PIN input present)');

  if (!PIN) {
    fail('APP_PIN not resolvable — cannot test login');
  } else {
    await page.fill('input[type="password"]', 'definitely-wrong-pin');
    await page.click('button:has-text("Unlock Terminal")');
    const wrongErr = await page
      .waitForSelector('text=/invalid|galat|wrong|incorrect|too many|throttl/i', { timeout: 12000 })
      .then(() => true).catch(() => false);
    wrongErr ? pass('wrong PIN rejected with a visible error') : fail('wrong PIN produced no error message');

    await page.fill('input[type="password"]', PIN);
    await page.click('button:has-text("Unlock Terminal")');
    // NOTE: `text=SMARTAI PRO` is NOT a valid unlock probe — Playwright text
    // matching is case-insensitive, so it also matches the LOGIN screen's
    // "SmartAI Pro" heading. That false positive made an earlier run report
    // "unlocked" while still on the PIN gate. The terminal shell's desk
    // tablist only exists AFTER auth, so that is the real signal.
    const unlocked = await page
      .waitForSelector('[role="tab"]', { timeout: 45000 })
      .then(() => true).catch(() => false);
    unlocked ? pass('correct PIN unlocks the terminal') : fail('correct PIN did not unlock the terminal');
    // NOTE: a bare `input[type=password]` also exists elsewhere in the shell
    // (masked secret fields), so the gate is identified by its Unlock button.
    const pinGone = (await page.locator('button:has-text("Unlock Terminal")').count()) === 0;
    pinGone ? pass('PIN gate is gone after unlock') : fail('PIN input still visible after a "successful" unlock');
    loginPhase = false;
  }

  // ---------------- 2. Desks ----------------
  const DESKS = [
    { key: 'INDIA', matches: /India|Intraday/i },
    { key: 'CRYPTO', matches: /CoinDCX|Crypto/i },
    { key: 'BOTS', matches: /Bot Lab|Bots/i },
  ];

  for (const d of DESKS) {
    const tab = page.locator('[role="tab"]', { hasText: d.matches }).first();
    const found = await tab.count();
    if (!found) { fail(`desk tab ${d.key} present`); continue; }
    await tab.click();
    await page.waitForTimeout(6000); // let lazy chunk + first API burst settle
    const crashed = await page.locator('text=Desk crash').count();
    crashed ? fail(`desk ${d.key} rendered (ErrorBoundary tripped)`) : pass(`desk ${d.key} rendered`);

    const body = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    body.length > 120
      ? pass(`desk ${d.key} has content`, `${body.length} chars`)
      : fail(`desk ${d.key} looks empty`, `${body.length} chars: ${body.slice(0, 120)}`);
    fs.writeFileSync(path.join(outDir, `desk-${d.key}.txt`), body);
    await page.screenshot({ path: path.join(outDir, `desk-${d.key}.png`), fullPage: false }).catch(() => {});
  }

  // ---------------- 3. Theme + reload persistence ----------------
  const themeBtn = page.locator('button[aria-label*="Switch to"]').first();
  if (await themeBtn.count()) {
    await themeBtn.click();
    const light = await page.locator('div.light').count();
    light ? pass('theme toggle switches to light mode') : fail('theme toggle had no visible effect');
    await themeBtn.click();
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  const stillIn = await page.waitForSelector('[role="tab"]', { timeout: 30000 }).then(() => true).catch(() => false);
  const noPin = (await page.locator('button:has-text("Unlock Terminal")').count()) === 0;
  stillIn && noPin ? pass('session survives reload (no PIN re-entry)') : fail('session lost on reload');
} catch (e) {
  fail('ui-smoke crashed', String(e?.message || e).slice(0, 300));
} finally {
  await browser.close();
}

// ---------------- 4. Error budget ----------------
pageErrors.length === 0 ? pass('no uncaught page errors') : fail('uncaught page errors', pageErrors.slice(0, 3).join(' | '));
consoleErrors.length === 0 ? pass('no console errors') : fail('console errors', consoleErrors.slice(0, 3).join(' | '));
badResponses.length === 0 ? pass('no 4xx/5xx /api responses during UI session') : fail('failing /api responses', [...new Set(badResponses)].slice(0, 8).join(' | '));

const okCount = results.filter(r => r.ok).length;
const failCount = results.length - okCount;
const lines = [];
lines.push('============================================================');
lines.push(' SmartAI Pro — UI SMOKE (headless Chromium)');
lines.push(` base: ${BASE}   at: ${new Date().toISOString()}`);
lines.push('============================================================');
for (const r of results) lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
lines.push('');
if (consoleErrors.length) { lines.push('CONSOLE ERRORS:'); consoleErrors.slice(0, 10).forEach(e => lines.push('  • ' + e)); }
if (pageErrors.length) { lines.push('PAGE ERRORS:'); pageErrors.slice(0, 10).forEach(e => lines.push('  • ' + e)); }
if (badResponses.length) { lines.push('FAILING /api RESPONSES:'); [...new Set(badResponses)].slice(0, 20).forEach(e => lines.push('  • ' + e)); }
lines.push('');
lines.push(`RESULT: ${failCount === 0 ? 'PASS' : 'FAIL'}  (pass ${okCount} · fail ${failCount})`);
lines.push(`artifacts: ${outDir}`);

const report = lines.join('\n');
console.log(report);
fs.writeFileSync(path.join(APP_DIR, 'data', `ui-smoke-${ts}.txt`), report + '\n');
process.exit(failCount === 0 ? 0 : 1);
