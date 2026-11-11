// Typed application error; mapped 1:1 onto the API error envelope (docs/plans §4).
// Messages here must NEVER contain contract text or upstream/parser output.
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL', stage = 'server', contractSent = false, attestation } = {}) {
    super(message);
    this.status = status; this.code = code; this.stage = stage; this.contractSent = contractSent;
    if (attestation) this.attestation = attestation;
  }
}
