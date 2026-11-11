// Vercel Node.js function: the whole app (UI, API, headers) behind one handler. vercel.json rewrites every path here.
// Hard-coded on purpose: this entry point is ONLY ever the public hosted demo (bundled fictional samples, rate limits,
// Host allowlist, trusted Vercel proxy headers). It never depends on env flags to stay safe.
import { createHandler, applyServerlessTuning } from '../src/server.mjs';

applyServerlessTuning();

export default createHandler({
  mode: 'live',
  hostedDemo: true,
  host: 'vercel',
  platform: 'vercel',
  trustProxy: true,
  deadlineMs: 100000, // answer with our JSON envelope before the 120 s function limit
});
