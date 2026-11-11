// Browser E2E for the SafeRedline UI. NOT a *.test.mjs file, so `npm test` stays offline.
// Usage: BASE_URL=http://127.0.0.1:3200 OUT=.work/e2e node tests/e2e/ui.e2e.mjs
// Needs devDependency `playwright-core` and a Chrome/Chromium (CHROME_PATH, Playwright cache, or system Chrome).
// Only the fictional bundled samples are ever loaded, logged or screenshotted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3200').replace(/\/$/, '');
const OUT = path.resolve(process.env.OUT || '.work/e2e');
const REPORT_TIMEOUT = 120000;
fs.mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright-core'); }
  catch (e) {
    if (process.env.PLAYWRIGHT_CORE_PATH) return await import(process.env.PLAYWRIGHT_CORE_PATH);
    console.error('playwright-core not found. Add it: npm i -D playwright-core (or set PLAYWRIGHT_CORE_PATH).');
    process.exit(2);
  }
}
function findChrome() {
  const home = os.homedir();
  const cands = [process.env.CHROME_PATH];
  for (const base of [path.join(home, 'Library/Caches/ms-playwright'), path.join(home, '.cache/ms-playwright')]) {
    try {
      for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
        cands.push(path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
        cands.push(path.join(base, d, 'chrome-linux/chrome'));
      }
    } catch {}
  }
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium');
  return cands.find((c) => c && fs.existsSync(c));
}

const results = [];
function record(scope, name, ok, detail = '') { results.push({ scope, name, ok, detail }); }
async function step(scope, name, fn) {
  try { const d = await fn(); record(scope, name, true, d || ''); return true; }
  catch (e) { record(scope, name, false, String(e.message || e).split('\n')[0].slice(0, 160)); return false; }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;
const exe = findChrome();
assert(exe, 'No Chrome found: set CHROME_PATH');
const browser = await chromium.launch({ executablePath: exe });

let health, samples;
try {
  health = await (await fetch(BASE + '/api/health')).json();
  samples = await (await fetch(BASE + '/api/samples')).json();
} catch (e) { console.error('Server unreachable at ' + BASE + ': ' + e.message); process.exit(2); }
const live = health.mode === 'live';
console.log(`E2E against ${BASE} (mode=${health.mode}, model=${health.model})`);

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy|refused to/i.test(m.text())) problems.push('console: ' + m.text().slice(0, 140)); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + String(e).slice(0, 140)));
  return { ctx, page, problems };
}
const safe = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

for (const s of samples) {
  const scope = s.title;
  const { ctx, page, problems } = await newPage();
  await page.goto(BASE + '/');
  const ok = await step(scope, 'load + analyze', async () => {
    await page.locator('#samples button', { hasText: s.title }).first().click();
    await page.click('#analyze');
    await page.waitForSelector('#results:not([hidden]) .risk', { timeout: REPORT_TIMEOUT });
    await page.waitForTimeout(2200); // let the staggered check reveal finish
  });
  if (ok) {
    await step(scope, 'verified badge', async () => {
      const t = await page.textContent('#vbadge');
      assert(/Hardware TEE verified/.test(t), 'badge: ' + t.slice(0, 60));
    });
    await step(scope, 'risk badge', async () => {
      const t = (await page.textContent('.risk')).trim();
      assert(/^(High|Medium|Low) risk$/i.test(t), 'risk: ' + t);
      if (s.riskHint && /^(High|Low)$/.test(s.riskHint)) assert(t.toLowerCase().startsWith(s.riskHint.toLowerCase()), `hint ${s.riskHint} vs ${t}`);
      return t;
    });
    await step(scope, 'clauses / empty state', async () => {
      const n = await page.locator('.clause').count();
      const low = /low/i.test(await page.textContent('.risk'));
      if (low) { assert(n === 0 && (await page.textContent('#analysis')).includes('No predatory clauses found'), 'Low without empty state'); return 'empty state'; }
      assert(n > 0, 'no clause cards'); return n + ' clauses';
    });
    await step(scope, 'transport row', async () => {
      const t = await page.locator('.kv', { hasText: 'Transport' }).first().textContent();
      if (live) assert(/attested TLS channel/.test(t), 'transport: ' + t.slice(0, 80));
      else assert(/attested TLS channel|not active/.test(t), 'transport: ' + t.slice(0, 80));
      return /attested TLS channel/.test(t) ? 'pinned' : 'not active';
    });
    await step(scope, 'counted checks all pass', async () => {
      const t = await page.locator('#tbody .stat').first().textContent();
      const m = t.match(/(\d+)\/(\d+)/); assert(m && m[1] === m[2], 'checks: ' + t);
      return m[0];
    });
    await step(scope, 'screenshots', async () => {
      await page.locator('#analysis').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${safe(s.title)}-report.png`) });
      await page.evaluate(() => document.getElementById('tbody').scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(OUT, `${safe(s.title)}-trust.png`) });
    });
    await step(scope, 'follow-up', async () => {
      await page.fill('#q', 'What is the single biggest risk to the recipient?');
      await page.click('#ask');
      await page.waitForFunction(() => document.getElementById('ask-out').textContent.trim().length > 0 || document.getElementById('ask-err').textContent.trim().length > 0, null, { timeout: REPORT_TIMEOUT });
      const err = (await page.textContent('#ask-err')).trim(); assert(!err, 'ask error: ' + err.slice(0, 100));
      assert(!/UNVERIFIED/.test(await page.textContent('#ask-out')), 'unverified answer');
      assert(/Hardware TEE verified/.test(await page.textContent('#vbadge')), 'badge not verified after ask');
    });
  }
  await step(scope, 'no console errors / CSP violations', async () => { assert(!problems.length, problems.join(' | ')); });
  await ctx.close();
}

{ // Verify enclave only
  const scope = 'Verify enclave only';
  const { ctx, page, problems } = await newPage();
  await page.goto(BASE + '/');
  const nonce = async () => {
    await page.click('#verifyonly');
    await page.waitForFunction(() => /Enclave verified|UNVERIFIED/.test(document.getElementById('vbadge').textContent), null, { timeout: 60000 });
    assert(/Enclave verified/.test(await page.textContent('#vbadge')), 'not verified');
    const h = page.locator('#tbody .kv dd', { has: page.locator('.hash') }).first().locator('.hash');
    await h.click(); // expand to the full nonce
    return (await h.textContent()).trim();
  };
  let n1;
  await step(scope, 'green state', async () => { n1 = await nonce(); return n1.slice(0, 14); });
  if (live) await step(scope, 'nonce differs across clicks', async () => {
    const n2 = await nonce(); assert(n1 && n2 && n1 !== n2, 'same nonce'); return n2.slice(0, 14);
  });
  else record(scope, 'nonce differs across clicks', true, 'skipped (twin replays recorded nonce)');
  await step(scope, 'no console errors / CSP violations', async () => { assert(!problems.length, problems.join(' | ')); });
  await ctx.close();
}
await browser.close();

console.log('\nScope'.padEnd(34) + 'Check'.padEnd(36) + 'Result  Detail');
for (const r of results) console.log(r.scope.slice(0, 32).padEnd(33) + ' ' + r.name.padEnd(35) + (r.ok ? 'PASS    ' : 'FAIL    ') + r.detail);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
