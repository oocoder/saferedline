#!/usr/bin/env node
// Docs rot guard. For every markdown file: relative links must resolve; `file#Lnn` / `file#Lnn-Lmm` links must
// point inside the file, at non-blank, non-comment-only lines, and (via RULES) at the code the link text claims.
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
  [/sentinel/i, /zero retention|sentinel/i],
  [/Host\/Origin|CSRF/i, /guard|Origin/],
];

const isCommentOnly = (l) => /^\s*(\/\/|\/\*|\*|#)/.test(l);

/** Check one `path#Lnn[-Lmm]` link. `read(relPath)` returns file text or null. Returns problem string or null. */
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
  const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts);
  return { problems, links: n, scripts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, links, scripts } = checkDocs();
  problems.forEach((p) => console.log('STALE/BROKEN', p));
  console.log(`${links} links checked, ${problems.length} problem(s); scripts: ${scripts.join(', ')}`);
  process.exit(problems.length ? 1 : 0);
}
