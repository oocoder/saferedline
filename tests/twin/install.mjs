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

/** Start a twin and point the app at it. `realSigner:true` keeps the fixture's real enclave key (wrong-signer demo). */
export async function installTwin({ script = {}, apiKey = 'sk-twin-test-key', timeoutMs = 5000, realSigner = false } = {}) {
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
    evidence: 'recorded', // tls_bound is reported as skipped: the twin speaks plain HTTP
    nowSec: () => fixture.recordedAt,
    newNonce: () => fixture.nonce,
    timeouts: { attest: 5000, pccs: 5000, nras: 5000, signature: 5000 },
  });
  setNearDeps({
    apiKey, timeoutMs: scriptTimeout || timeoutMs,
    model: fixture.model,
    sigRetry: { tries: 5, delays: [5, 5, 5, 5] },
    // SIGNER SWAP (twin only): the recorded attestation binds NEAR's real enclave key, whose private half we do not
    // have, so the twin cannot produce a signature that verifies against it. For the happy path we keep every real
    // check on the recorded evidence but replace the attested signer list with the twin's local test key. This means a
    // twin "verified" proves the pipeline logic, NOT that a real enclave signed the answer; responses carry
    // `twinSignerNote` to say so. `realSigner: true` keeps the real key to demonstrate the wrong-signer failure.
    twinSignerNote: realSigner ? undefined : 'Twin signs responses with a local test key; live mode requires the attested enclave key.',
    attest: realSigner ? attestModel : async (m, k) => { const a = await attestModel(m, k); a.signingAddresses = [wallet.address]; return a; },
  });
  const restore = async () => { setDeps(saved.deps); setNearDeps(saved.cfg); await twin.close(); };
  return { twin, restore };
}
