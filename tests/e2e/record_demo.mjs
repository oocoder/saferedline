// Records the ~70s demo video + 4 stills locally. Nothing leaves this machine.
// Usage: BASE_URL=http://127.0.0.1:3200 OUT=.work/demo node tests/e2e/record_demo.mjs
// Captions and the cursor dot are injected into the page ONLY during recording; the shipped UI has no overlay.
// Only the fictional bundled samples are used. The "Contract not sent" still is captured from a real twin
// instance started with TWIN_SCRIPT=attestation_failed (the TWIN MODE banner stays visible; this is honest).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3200').replace(/\/$/, '');
const OUT = path.resolve(process.env.OUT || '.work/demo');
const FFMPEG = process.env.FFMPEG || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
fs.mkdirSync(OUT, { recursive: true });
const RAW = path.join(OUT, 'raw');
fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright-core'); }
  catch { if (process.env.PLAYWRIGHT_CORE_PATH) return await import(process.env.PLAYWRIGHT_CORE_PATH); console.error('playwright-core missing'); process.exit(2); }
}
function findChrome() {
  const home = os.homedir(); const c = [process.env.CHROME_PATH];
  for (const b of [path.join(home, 'Library/Caches/ms-playwright'), path.join(home, '.cache/ms-playwright')]) {
    try { for (const d of fs.readdirSync(b).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      c.push(path.join(b, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), path.join(b, d, 'chrome-linux/chrome')); } } catch {}
  }
  c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium');
  return c.find((x) => x && fs.existsSync(x));
}
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;
const exe = findChrome();
if (!exe) { console.error('No Chrome found: set CHROME_PATH'); process.exit(2); }
const browser = await chromium.launch({ executablePath: exe });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = await (await fetch(BASE + '/api/health')).json().catch(() => { console.error('Server unreachable at ' + BASE); process.exit(2); });
console.log(`Recording against ${BASE} (mode=${health.mode})`);

// ---- 1. Main recording ----
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
  recordVideo: { dir: RAW, size: { width: 1440, height: 900 } },
});
const t0 = Date.now();
const page = await ctx.newPage();
const vt = () => (Date.now() - t0) / 1000; // seconds since the video started

async function installOverlay() {
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.id = '__cap';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:22px 48px;background:rgba(5,11,21,.92);color:#fff;font:600 34px/1.25 system-ui,-apple-system,sans-serif;text-align:center;pointer-events:none;opacity:0;transition:opacity .45s;border-top:3px solid #4cd68a';
    const dot = document.createElement('div');
    dot.id = '__cur';
    dot.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,200,0,.75);border:2px solid #fff;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 4px rgba(0,0,0,.25)';
    document.documentElement.appendChild(bar); document.documentElement.appendChild(dot);
    addEventListener('mousemove', (e) => { dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  });
}
async function caption(text) {
  await page.evaluate((t) => { const b = document.getElementById('__cap'); if (!t) { b.style.opacity = '0'; return; } b.textContent = t; b.style.opacity = '1'; }, text || '');
}
async function glide(sel, opts = {}) {
  const box = await page.locator(sel).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24), { steps: 25 });
}
async function smoothScroll(top) { await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), top); await sleep(1400); }
async function scrollToEl(sel, offset = 90) {
  const y = await page.locator(sel).first().evaluate((e, o) => Math.max(0, e.getBoundingClientRect().top + scrollY - o), offset);
  await smoothScroll(y);
}
async function asideScroll(top) { await page.evaluate((y) => document.querySelector('aside').scrollTo({ top: y, behavior: 'smooth' }), top); await sleep(1500); }

await page.goto(BASE + '/');
await installOverlay();
await page.mouse.move(700, 450);

// Hero
await sleep(800); await caption('Your NDA never touches a normal AI server'); await sleep(4200);

// Pick the predatory sample
await caption('A "mutual" NDA with traps. Fictional sample.');
await glide('#samples button:has-text("Predatory")'); await sleep(500);
await page.locator('#samples button:has-text("Predatory")').first().click(); await sleep(2800);

// Analyze + stepper
await caption('① Prove the enclave is real: fresh nonce · Intel TDX · NVIDIA GPUs');
await glide('#analyze'); await sleep(400);
await page.click('#analyze');
await sleep(4500);
await caption('\u2461 Your contract travels only over TLS bound to the enclave');
const ready = page.waitForSelector('#results:not([hidden]) .risk', { timeout: 120000 }).then(() => true);
let waitA = 0, waitB = 0;
if (!(await Promise.race([ready, sleep(4500).then(() => false)]))) {
  // live inference takes ~25s: keep the stepper on screen, and be honest that this stretch is sped up in the edit
  await caption('Running inside the TEE (real model, real hardware attestation)');
  await page.evaluate(() => { const d = document.createElement('div'); d.id = '__sp'; d.textContent = '\u23E9 sped up 3x'; d.style.cssText = 'position:fixed;right:24px;bottom:120px;z-index:2147483647;padding:8px 16px;border-radius:999px;background:#f5c04d;color:#1a1200;font:700 24px system-ui,sans-serif;pointer-events:none'; document.documentElement.appendChild(d); });
  waitA = vt() + 0.8;
  await ready;
  waitB = vt() - 0.3;
  await caption('Enclave verified. Report ready.');
  await sleep(500);
  await page.evaluate(() => document.getElementById('__sp')?.remove());
}
await sleep(2500);

// Redline report
const hideOv = (h) => page.evaluate((v) => { for (const id of ['__cap', '__cur', '__sp']) { const e = document.getElementById(id); if (e) e.style.visibility = v; } }, h ? 'hidden' : 'visible');
const stills = {
  verified: path.join(OUT, 'still-1-verified-panel.png'),
  report: path.join(OUT, 'still-2-high-risk-report.png'),
  redline: path.join(OUT, 'still-3-redline-card.png'),
  fail: path.join(OUT, 'still-4-contract-not-sent.png'),
};
await caption('Five traps, each with the verbatim quote and a ready-to-paste redline');
await scrollToEl('#analysis', 40); await sleep(1200);
await hideOv(true); await page.screenshot({ path: stills.report }); await hideOv(false);
await sleep(2300);
const clauseIdx = await page.locator('.clause h3').evaluateAll((hs) => { const i = hs.findIndex((h) => /IP|assign|feedback/i.test(h.textContent)); return i < 0 ? 0 : i; });
const card = page.locator('.clause').nth(clauseIdx);
await caption('Anything you say in meetings becomes theirs, for free. It drafts balanced wording.');
const cardTop = await card.evaluate((e) => e.getBoundingClientRect().top + scrollY - 110); await smoothScroll(cardTop); await sleep(1500);
await hideOv(true); await card.screenshot({ path: stills.redline }); await hideOv(false);
await sleep(2000);
const copyBtn = card.locator('.btn.sm').first();
await copyBtn.hover(); await sleep(800); await copyBtn.click(); await sleep(1800);

// Trust panel: scroll only the panel (it is sticky), never the page
await caption('\u2462 Every answer signed by the enclave key');
await glide('#vbadge'); await sleep(1500);
{ await hideOv(true);
  const b = await page.locator('aside').boundingBox();
  await page.screenshot({ path: stills.verified, clip: { x: b.x, y: Math.max(0, b.y - 8), width: b.width, height: Math.min(900 - Math.max(0, b.y - 8), b.height + 16) } });
  await hideOv(false); }
await caption('Every check, listed: TDX quote \u00B7 GPU attestation \u00B7 TLS binding \u00B7 signature');
await asideScroll(300); await sleep(900);
await asideScroll(700); await sleep(900);
await asideScroll(1100); await sleep(900);
await asideScroll(99999); await sleep(1000);
await asideScroll(0); await sleep(400);

// Verify only, then the closing hold on the green badge
await caption('Anyone can re-run this check. No contract needed.');
await glide('#verifyonly'); await sleep(500);
await page.click('#verifyonly');
await page.waitForFunction(() => /^vbadge (ok|warn|bad)/.test(document.getElementById('vbadge').className), null, { timeout: 60000 });
await sleep(2500);
await caption('Other tools promise zero retention. SafeRedline proves where it ran.');
await sleep(5000);

// End card (recording only)
await page.evaluate(() => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#050b15;color:#fff;display:flex;align-items:center;justify-content:center;font:600 44px/1.4 system-ui,sans-serif;text-align:center;opacity:0;transition:opacity .5s';
  c.textContent = 'SafeRedline \u00B7 github.com/oocoder/saferedline \u00B7 Built at NEAR HACKATHON';
  document.documentElement.appendChild(c); requestAnimationFrame(() => { c.style.opacity = '1'; });
});
await sleep(2400);
const videoPath = await page.video().path();
await ctx.close();
const recordedSec = ((Date.now() - t0) / 1000).toFixed(0);

// ---- 2. "Contract not sent" still from a real twin with TWIN_SCRIPT=attestation_failed ----
let twin; const failPort = 3290 + Math.floor(Math.random() * 9);
try {
  twin = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(failPort), TWIN_SCRIPT: 'attestation_failed', SAFEREDLINE_TWIN: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${failPort}/api/health`); break; } catch { await sleep(300); } }
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const p2 = await c2.newPage();
  await p2.goto(`http://127.0.0.1:${failPort}/`);
  await p2.locator('#samples button:has-text("Predatory")').first().click();
  await p2.click('#analyze');
  await p2.waitForSelector('#errbox .alert', { timeout: 60000 });
  await sleep(2500);
  await p2.screenshot({ path: stills.fail });
  await c2.close();
} catch (e) { console.error('fail-still error: ' + e.message); }
finally { if (twin) twin.kill(); }
await browser.close();

// ---- 3. Convert ----
const mp4 = path.join(OUT, 'saferedline-demo.mp4');
const sped = waitB - waitA > 4;
const vf = sped
  ? `[0:v]trim=0:${waitA.toFixed(2)},setpts=PTS-STARTPTS[v0];[0:v]trim=${waitA.toFixed(2)}:${waitB.toFixed(2)},setpts=(PTS-STARTPTS)/3[v1];[0:v]trim=${waitB.toFixed(2)},setpts=PTS-STARTPTS[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]`
  : null;
const r = spawnSync(FFMPEG, ['-y', '-i', videoPath, ...(vf ? ['-filter_complex', vf, '-map', '[v]'] : []), '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-an', mp4], { stdio: 'ignore' });
if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
const probe = spawnSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).stdout?.toString().trim();
const dur = Number(probe); const size = fs.statSync(mp4).size;
fs.rmSync(RAW, { recursive: true, force: true });
console.log(`\nVideo: ${mp4}\nDuration: ${dur.toFixed(1)}s (recorded ${recordedSec}s), size ${(size / 1e6).toFixed(1)} MB`);
for (const f of Object.values(stills)) console.log('Still: ' + f + (fs.existsSync(f) ? '' : '  (MISSING)'));
const bad = dur > 140 || size > 512e6 || Object.values(stills).some((f) => !fs.existsSync(f));
if (bad) { console.error('FAIL: exceeds X limits or missing stills'); process.exit(1); }
