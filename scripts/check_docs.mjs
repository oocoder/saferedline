#!/usr/bin/env node
// Docs rot guard. For every markdown file: relative links must resolve; `file#Lnn` / `file#Lnn-Lmm` links must
// point inside the file, at non-blank, non-comment-only lines, and (via RULES) at the code the link text claims.
// Also: every `npm run <x>` / `npm <x>` command mentioned in the docs must exist in package.json scripts, and
// sentinel-labeled links must land inside the sentinel describe block (found by its title).
// SCOPE: README.md, OUTLINE.md, AGENTS.md, CLAUDE.md and docs/*.md only. docs/plans/ is deliberately EXCLUDED:
// it is a historical planning record whose line references describe the pre-fix code and are not maintained.
// Run: npm run check:docs   (also run by tests/docs.test.mjs, so `npm test` catches stale links)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [regex over "<text before link> <link label>", substring that must appear in the linked line range]
export const RULES = [
  [/dropped after use|#L114/, /text = (question = )?null/],
  [/metadata only|#L142/i, /console\.log/],
  [/no-store/, /no-store/],
  [/createServer/, /127\.0\.0\.1/],
  [/`HOST`/, /HOST/],
  [/`listen`/, /listen\(/],
  [/analyzeContract/, /analyzeContract/],
  [/attestOrThrow|called at|#L194|#L220/, /attestOrThrow/],
  [/makePinCheck/, /makePinCheck/],
  [/pinnedFetch/, /pinnedFetch/],
  [/tls_bound/, /tls_bound/],
  [/pin-mismatch|TLS_PIN_MISMATCH/, /TLS_PIN_MISMATCH/],
  [/verifyJwt/, /verifyJwt/],
  [/gpuClaimProblems/, /gpuClaimProblems/],
  [/verifyResponseSignature/, /verifyResponseSignature/],
  [/sig_req/, /sig_req/],
  [/sig_model/, /sig_model/],
  [/sig_attested/, /sig_attested/],
  [/verifyOne/, /verifyOne/],
  [/rd_signer/, /rd_signer/],
  [/attestModel/, /attestModel/],
  [/sentinel|asserts?|proves?|test that/i, /assert/], // links claiming a test asserts something must land on an assert line (see also sentinelBlock)
  [/Host\/Origin|CSRF/i, /guard|Origin/],
];

const isCommentOnly = (l) => /^\s*(\/\/|\/\*|\*|#)/.test(l);

/** Check one `path#Lnn[-Lmm]` link. `read(relPath)` returns file text or null. Returns problem string or null. */
const SENTINEL_TITLE = /describe\('zero retention \(sentinel\)'/;
/** 1-based [start, end] of the sentinel describe block (to the next top-level describe/EOF), or null. */
export function sentinelBlock(lines) {
  const a = lines.findIndex((l) => SENTINEL_TITLE.test(l));
  if (a < 0) return null;
  let b = lines.findIndex((l, i) => i > a && /^describe\(/.test(l));
  if (b < 0) b = lines.length;
  return [a + 1, b];
}

export function checkLineLink(href, context, read) {
  const m = href.match(/^(.+?)#L(\d+)(?:-L(\d+))?$/);
  if (!m) return null;
  const [, file, a, b] = m;
  const text = read(file);
  if (text == null) return `file not found: ${file}`;
  const lines = text.split('\n');
  const start = Number(a), end = Number(b || a);
  if (start < 1 || end < start || end > lines.length) return `${href} is outside ${file} (${lines.length} lines)`;
  const range = lines.slice(start - 1, end);
  if (range.every((l) => !l.trim() || isCommentOnly(l))) return `${href} points at blank/comment-only lines`;
  if (/sentinel/i.test(context) && /pipeline\.test\.mjs$/.test(file)) {
    const blk = sentinelBlock(lines);
    if (!blk) return `${href}: sentinel describe block not found in ${file}`;
    if (start < blk[0] || end > blk[1]) return `${href} is outside the sentinel describe block (lines ${blk[0]}-${blk[1]})`;
  }
  for (const [ctx, need] of RULES) {
    if (ctx.test(context)) {
      if (!range.some((l) => need.test(l))) return `${href}: expected ${need} in lines ${start}-${end} (link says: ${context.trim().slice(-70)})`;
      break;
    }
  }
  return null;
}

export function checkDocs(root = ROOT) {
  const problems = []; let n = 0;
  const read = (rel, from = '') => { try { return fs.readFileSync(path.join(root, from, rel), 'utf8'); } catch { return null; } };
  const docs = ['README.md', 'OUTLINE.md', 'AGENTS.md', 'CLAUDE.md', ...(fs.existsSync(path.join(root, 'docs')) ? fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f) : [])];
  for (const f of docs) {
    const t = read(f); if (t == null) continue;
    const dir = path.dirname(f);
    t.split('\n').forEach((line, i) => {
      let prevEnd = 0;
      for (const m of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
        const before = line.slice(Math.max(prevEnd, m.index - 60), m.index); // text since the previous link only
        prevEnd = m.index + m[0].length;
        const href = m[2];
        if (/^(https?:|mailto:|#)/.test(href)) continue;
        n++;
        const target = path.join(dir, href.split('#')[0]);
        if (!fs.existsSync(path.join(root, target))) { problems.push(`${f}:${i + 1} BROKEN ${href}`); continue; }
        const context = before + ' ' + m[1];
        const p = checkLineLink(path.join(dir, href).replace(/^\.\//, ''), context, (rel) => read(rel));
        if (p) problems.push(`${f}:${i + 1} ${p}`);
      }
    });
  }
  const scriptNames = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts);
  const builtins = new Set(['ci', 'install', 'i', 'init', 'pack', 'publish', 'audit', 'ls', 'outdated', 'update', 'config', 'exec', 'help', 'version', 'view', 'cache', 'prune']);
  const shortcuts = new Set(['test', 'start', 'stop', 'restart']);
  for (const f of docs) {
    const t = read(f); if (t == null) continue;
    t.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bnpm run(?:-script)?(?: -[-\w]+)* ([A-Za-z0-9:_-]+)/g)) if (!scriptNames.includes(m[1])) problems.push(`${f}:${i + 1} unknown npm script: npm run ${m[1]}`);
      for (const m of line.matchAll(/\bnpm ([a-z][a-z-]*)\b/g)) {
        if (m[1] === 'run' || m[1] === 'run-script' || builtins.has(m[1])) continue;
        if (shortcuts.has(m[1]) ? !scriptNames.includes(m[1]) : true) { if (shortcuts.has(m[1])) problems.push(`${f}:${i + 1} npm ${m[1]} has no script`); }
      }
    });
  }
  const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts);
  return { problems, links: n, scripts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, links, scripts } = checkDocs();
  problems.forEach((p) => console.log('STALE/BROKEN', p));
  console.log(`${links} links checked, ${problems.length} problem(s); scripts: ${scripts.join(', ')}`);
  process.exit(problems.length ? 1 : 0);
}
