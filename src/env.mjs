// Load .env BEFORE any module reads process.env at import time (imported first by attest.mjs and near.mjs).
// Resolved from the repo root, not process.cwd(). Real environment variables win over the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.env.SAFEREDLINE_ENV_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
// On Vercel the environment comes from project settings: never read (or let the file tracer bundle) a .env file.
if ((!process.env.VERCEL || process.env.SAFEREDLINE_ENV_FILE) && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
