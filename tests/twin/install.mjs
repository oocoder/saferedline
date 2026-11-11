// Wire the twin into the app's injectable seams. Used by tests and by `npm run twin`.
import { deps, setDeps, attestModel, sha256hex } from '../../src/attest.mjs';
import { cfg, setNearDeps } from '../../src/near.mjs';
import { createTwin, fixture, wallet } from './near-twin.mjs';
import { twinCtx } from '../../src/twinctx.mjs';

// Named scenarios for TWIN_SCRIPT (case-insensitive; comma-separated to combine).
export const TWIN_SCRIPTS = {
  ok: {},
  fenced_json: { chat: 'fenced_json' },
  think_tags: { chat: 'think_tags' },
  think_unclosed: { chat: 'think_unclosed' },
  non_json: { chat: 'non_json' },
  non_json_body: { chat: 'non_json_body' },
  xss: { chat: 'xss' },
  '400_response_format': { chat: '400_response_format' },
  tampered_res: { signature: 'tampered_res' },
  tampered_req: { signature: 'tampered_req' },
  wrong_signer: { signature: 'wrong_signer' },
  model_mismatch: { signature: 'model_mismatch' },
  '404_then_ok': { signature: '404_then_ok' },
  attestation_failed: { attestation: 'tampered_compose' },
  attestation_auth: { attestation: '401' },
  attestation_unavailable: { attestation: '503' },
  nras_down: { nras: '503' },
  nras_bad_shape: { nras: 'bad_shape' },
  no_model_prefix: { signature: 'no_model_prefix' },
  nras_bad_jwt_sig: { nras: 'bad_jwt_sig' },
  nras_no_gpus: { nras: 'no_gpus' },
  nras_unknown_key: { jwks: 'empty' },
  missing_gateway: { attestation: 'missing_gateway' },
  bom_body: { chat: 'bom_body' },
  connection_drop: { chat: 'drop' },
  near_auth: { chat: '401' },
  inference_failed: { chat: '500' },
  inference_timeout: { chat: 'hang', timeoutMs: 3000 },
};

export function resolveScript(name) {
  const out = {};
  for (const n of String(name || 'ok').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(n in TWIN_SCRIPTS)) throw new Error(`Unknown TWIN_SCRIPT "${n}". Available: ${Object.keys(TWIN_SCRIPTS).join(', ')}`);
    Object.assign(out, TWIN_SCRIPTS[n]);
  }
  return out;
}

/** Start a twin and point the app at it. (`realSigner` is accepted for old callers and ignored: the attestation is never altered.) */
export async function installTwin({ script = {}, apiKey = 'sk-twin-test-key', timeoutMs = 5000 } = {}) {
  const twin = createTwin();
  await twin.listen();
  const saved = { deps: { ...deps, timeouts: { ...deps.timeouts } }, cfg: { ...cfg, sigRetry: { ...cfg.sigRetry } } };
  const { timeoutMs: scriptTimeout, ...s } = script;
  twin.script = s;
  twin.resolve = resolveScript; // lets the twin map a per-request X-Twin-Script name to a scenario
  const baseFetch = deps.fetch;
  setDeps({
    // Forward the per-request scenario (set by the server from X-Twin-Script) to the twin; no shared mutable state.
    fetch: (u, o = {}) => {
      const name = twinCtx.getStore()?.script;
      return baseFetch(u, name ? { ...o, headers: { ...(o.headers || {}), 'x-twin-script': name } } : o);
    },
    baseUrl: twin.url, nrasUrl: twin.nrasUrl, jwksUrl: twin.jwksUrl,
    getCollateral: async (_u, q) => {
      const c = fixture.collateral[sha256hex(q)];
      if (!c) throw new Error('no recorded collateral for quote');
      return c;
    },
    jwksTtlMs: 0, collateralCacheMs: 0, // tests must see every injected failure, never a cached success
    evidence: 'recorded', // tls_bound is reported as skipped: the twin speaks plain HTTP
    nowSec: () => fixture.recordedAt,
    newNonce: () => fixture.nonce,
    timeouts: { attest: 5000, pccs: 5000, nras: 5000, signature: 5000 },
  });
  setNearDeps({
    apiKey, timeoutMs: scriptTimeout || timeoutMs,
    model: fixture.model,
    sigRetry: { tries: 5, delays: [5, 5, 5, 5] },
    // The attestation is NEVER mutated: signingAddresses stay the recorded enclave's real key. The twin signs with a local
    // test key, so `sig_attested` is emitted as informational ("simulated") in twin mode (see verifyResponseSignature), and
    // responses carry `twinSigner` + `twinSignerNote`. A twin "verified" therefore proves the pipeline logic and the counted
    // checks (hashes, ECDSA recovery, model), not that a real enclave signed the answer.
    twinSignerNote: 'Twin signs responses with a local test key; live mode requires the attested enclave key.',
    twinSigner: wallet.address,
  });
  const restore = async () => { setDeps(saved.deps); setNearDeps(saved.cfg); await twin.close(); };
  return { twin, restore };
}
