/** Resolver error codes from SPEC section 8. */
export type ResolveErrorCode =
  | 'label_invalid'
  | 'handshake_unavailable'
  | 'delegation_missing'
  | 'delegation_ambiguous'
  | 'delegation_malformed'
  | 'chain_not_allowed'
  | 'chain_mismatch'
  | 'rpc_unsupported'
  | 'stale_state'
  | 'clock_skew'
  | 'code_mismatch'
  | 'config_mismatch'
  | 'tld_mismatch'
  | 'not_registered'
  | 'not_active'
  | 'record_malformed'
  | 'rpc_error';

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;
  readonly detail: unknown;

  constructor(code: ResolveErrorCode, message: string, detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'ResolveError';
    this.code = code;
    this.detail = detail;
  }
}
