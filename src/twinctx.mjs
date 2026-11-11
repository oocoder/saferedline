// Per-request context for twin mode only: carries the X-Twin-Script override through async calls without global state.
import { AsyncLocalStorage } from 'node:async_hooks';
export const twinCtx = new AsyncLocalStorage();
// Only these scenarios may be selected per request (UI "Try an attack" buttons).
export const TWIN_HEADER_ALLOWLIST = ['ok', 'tampered_res', 'attestation_failed', 'wrong_signer'];
