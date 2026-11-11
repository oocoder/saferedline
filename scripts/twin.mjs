#!/usr/bin/env node
// `npm run twin`: serve SafeRedline against the in-process NEAR twin (recorded real attestation, simulated model).
// This is the ONLY entry that imports tests/twin: src/server.mjs and api/index.mjs have no path into tests/,
// so deployment bundles never reference it.
process.env.SAFEREDLINE_TWIN = '1'; // before attest.mjs loads (skips the endpoint-override guard)
const { installTwin, resolveScript } = await import('../tests/twin/install.mjs');
let script;
try { script = resolveScript(process.env.TWIN_SCRIPT); } catch (e) { console.error(`\n  ${e.message}\n`); process.exit(1); }
await installTwin({ script });
const { startServer } = await import('../src/server.mjs');
startServer({ mode: 'twin' });
