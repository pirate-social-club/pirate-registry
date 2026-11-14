// Opt-in V4 preparation only. No ABI artifact, RPC, signing, journal or broadcast.
import { createHash } from 'node:crypto';
import { getAddress, hashTypedData, type Abi, type Address, type Hex } from 'viem';
import { requireCanonicalSharedLabel } from '../../resolver/src/shared-keys.ts';

export interface ScopeAuthorizationV4 {
  namespaceId: Hex;
  communityId: Hex;
  installationId: Hex;
  controller: Address;
  namespaceAuthorizationHash: Hex;
  namespaceAuthorizationRevision: bigint;
  evidenceHash: Hex;
}
export interface ScopeStateV4 {
  submitter: Address;
  totalClaimLimit: bigint;
  totalClaims: bigint;
  revision: bigint;
  enabled: boolean;
  authorizationHash: Hex;
  namespaceAuthorizationHash: Hex;
  namespaceAuthorizationRevision: bigint;
  observedAt: bigint;
  validUntil: bigint;
}
/** Selection from an externally verified V4 source profile, not a verifier. */
export interface SharedV4SourceSelection {
  schema: 'pirate.shared-registry-v4-preparation/1';
  protocolVersion: 4;
  chainId: 31337 | 6343;
  registry: Address;
  sourceCommit: string;
  sourceSha256: string;
  abiSha256: string;
  runtimeCodeHash: Hex;
}
export interface FreeClaimV4 {
  requestId: Hex;
  communityId: Hex;
  namespaceId: Hex;
  label: string;
  recipient: Address;
  generation: bigint;
  authorityRevision: bigint;
  policyRevision: bigint;
  scopeRevision: bigint;
  scopeAuthorizationHash: Hex;
  issuedAt: bigint;
  deadline: bigint;
  years_: number;
  maxCost: bigint;
}
export interface SharedV4QuoteSnapshot {
  chainId: number;
  registry: Address;
  block: { tag: 'safe'; number: bigint; hash: Hex; timestamp: bigint };
  authority: { authorizationHash: Hex; evidenceHash: Hex; revision: bigint; freshnessVersion: bigint;
    observedAt: bigint; validUntil: bigint; issuanceEnabled: boolean; migrationRequired: boolean };
  grantSigner: Address;
  scope: ScopeStateV4;
  quote: {
    authorityRevision: bigint; policyRevision: bigint; scopeRevision: bigint;
    scopeAuthorizationHash: Hex; scopeValidUntil: bigint; generation: bigint;
    status: number; reservedFor: Address; initialPrice: bigint; issuanceEnabled: boolean;
    namespaceClaimsRemaining: bigint; scopeClaimsRemaining: bigint;
    renewalToken: Address; annualRenewalPrice: bigint;
  };
}
export interface SharedV4Timing {
  collectionMarginSeconds: number;
  signingMarginSeconds: number;
  inclusionMarginSeconds: number;
}

function requireV4(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function nonzero32(value: unknown): asserts value is Hex {
  requireV4(typeof value === 'string' && /^0x[0-9a-f]{64}(?![\s\S])/.test(value)
    && value !== `0x${'0'.repeat(64)}`, 'v4_invalid_digest');
}
function uint64(value: bigint, positive = false): void {
  requireV4(typeof value === 'bigint' && value >= (positive ? 1n : 0n)
    && value <= (1n << 64n) - 1n, 'v4_invalid_uint64');
}
function nonzeroAddress(value: Address): Address {
  const address = getAddress(value);
  requireV4(address !== '0x0000000000000000000000000000000000000000', 'v4_zero_address');
  return address;
}
function selected(abi: Abi, source: SharedV4SourceSelection): void {
  requireV4(source.schema === 'pirate.shared-registry-v4-preparation/1' && source.protocolVersion === 4
    && (source.chainId === 31337 || source.chainId === 6343), 'v4_profile_required');
  requireV4(/^[0-9a-f]{40}(?![\s\S])/.test(source.sourceCommit)
    && /^[0-9a-f]{64}(?![\s\S])/.test(source.sourceSha256)
    && /^[0-9a-f]{64}(?![\s\S])/.test(source.abiSha256), 'v4_profile_pin');
  nonzeroAddress(source.registry);
  nonzero32(source.runtimeCodeHash);
  requireV4(createHash('sha256').update(JSON.stringify(abi)).digest('hex') === source.abiSha256,
    'v4_abi_pin');
}
function tupleFields(abi: Abi, name: string, expectedNames: readonly string[]) {
  const fn = abi.find(item => item.type === 'function' && item.name === name);
  requireV4(fn?.type === 'function', 'v4_compiled_interface_required');
  const tuple = fn.inputs[0];
  requireV4(tuple?.type === 'tuple' && 'components' in tuple, 'v4_compiled_interface_required');
  const fields = tuple.components.map(field => ({ name: field.name ?? '', type: field.type }));
  requireV4(fields.map(field => field.name).join(',') === expectedNames.join(',')
    && fields.every(field => ['bytes32', 'address', 'string', 'uint64', 'uint8', 'uint256'].includes(field.type)),
  'v4_compiled_interface_required');
  return fields;
}
function domain(source: SharedV4SourceSelection) {
  return { name: 'PirateSharedNames', version: '4', chainId: source.chainId,
    verifyingContract: getAddress(source.registry) };
}
export function scopeAuthorizationTypedDataV4(abi: Abi, source: SharedV4SourceSelection,
  authorization: ScopeAuthorizationV4) {
  selected(abi, source);
  for (const value of [authorization.namespaceId, authorization.communityId, authorization.installationId,
    authorization.namespaceAuthorizationHash, authorization.evidenceHash]) nonzero32(value);
  const fields = tupleFields(abi, 'scopeAuthorizationHash', ['namespaceId', 'communityId', 'installationId',
    'controller', 'namespaceAuthorizationHash', 'namespaceAuthorizationRevision', 'evidenceHash']);
  uint64(authorization.namespaceAuthorizationRevision, true);
  const message = { namespaceId: authorization.namespaceId, communityId: authorization.communityId,
    installationId: authorization.installationId, controller: nonzeroAddress(authorization.controller),
    namespaceAuthorizationHash: authorization.namespaceAuthorizationHash,
    namespaceAuthorizationRevision: authorization.namespaceAuthorizationRevision, evidenceHash: authorization.evidenceHash };
  return { domain: domain(source), primaryType: 'ScopeAuthorization' as const,
    types: { ScopeAuthorization: fields }, message };
}
export function claimTypedDataV4(abi: Abi, source: SharedV4SourceSelection, claim: FreeClaimV4) {
  selected(abi, source);
  const fields = tupleFields(abi, 'claimFreeName', ['requestId', 'communityId', 'namespaceId', 'label',
    'recipient', 'generation', 'authorityRevision', 'policyRevision', 'scopeRevision',
    'scopeAuthorizationHash', 'issuedAt', 'deadline', 'years_', 'maxCost']);
  return { domain: domain(source), primaryType: 'FreeClaim' as const, types: { FreeClaim: fields },
    message: { ...claim } };
}
export function acceptanceTypedDataV4(abi: Abi, source: SharedV4SourceSelection, claim: FreeClaimV4) {
  const issuer = claimTypedDataV4(abi, source, claim);
  return { domain: issuer.domain, primaryType: 'ClaimAcceptance' as const,
    types: { ...issuer.types, ClaimAcceptance: [{ name: 'claim', type: 'FreeClaim' }] },
    message: { claim: issuer.message } };
}

/**
 * Pure preflight over an already source-verified, canonical safe-block snapshot.
 * It checks recorded authorization, not external HNS/Directory evidence. The
 * caller must revalidate source, evidence and time before signing/submission.
 */
export function prepareSharedClaimV4(abi: Abi, source: SharedV4SourceSelection,
  snapshot: SharedV4QuoteSnapshot, authorization: ScopeAuthorizationV4,
  input: { requestId: Hex; label: string; recipient: Address }, now: bigint, timing: SharedV4Timing) {
  selected(abi, source);
  nonzero32(input.requestId);
  requireCanonicalSharedLabel(input.label);
  requireV4(input.label.length >= 8, 'v4_not_free');
  const recipient = nonzeroAddress(input.recipient);
  const { block, scope, quote, authority } = snapshot;
  nonzero32(block.hash);
  requireV4(snapshot.chainId === source.chainId && getAddress(snapshot.registry) === getAddress(source.registry)
    && block.tag === 'safe' && block.number >= 0n, 'v4_snapshot_binding');
  uint64(now); uint64(block.timestamp);
  requireV4(now >= block.timestamp, 'v4_clock');
  const authorizationHash = hashTypedData(scopeAuthorizationTypedDataV4(abi, source, authorization));
  for (const value of [scope.observedAt, scope.validUntil, authority.observedAt, authority.validUntil]) uint64(value);
  nonzero32(authority.evidenceHash);
  for (const value of [scope.revision, scope.namespaceAuthorizationRevision, quote.generation, quote.authorityRevision,
    quote.policyRevision, authority.revision, authority.freshnessVersion]) uint64(value, true);
  for (const value of [scope.totalClaims, scope.totalClaimLimit]) uint64(value);
  requireV4(authority.issuanceEnabled && !authority.migrationRequired && authority.validUntil > now
    && authority.observedAt <= block.timestamp && authority.validUntil > authority.observedAt
    && authority.validUntil - authority.observedAt <= 86400n,
    'v4_authority_unavailable');
  requireV4(scope.enabled && scope.observedAt <= block.timestamp && scope.validUntil > now
    && scope.validUntil > scope.observedAt && scope.validUntil - scope.observedAt <= 86400n,
  'v4_scope_unavailable');
  requireV4(scope.authorizationHash === authorizationHash && quote.scopeAuthorizationHash === authorizationHash
    && scope.namespaceAuthorizationHash === authorization.namespaceAuthorizationHash
    && authority.authorizationHash === authorization.namespaceAuthorizationHash
    && scope.namespaceAuthorizationRevision === authorization.namespaceAuthorizationRevision
    && authority.revision === authorization.namespaceAuthorizationRevision
    && quote.authorityRevision === authority.revision
    && quote.scopeRevision === scope.revision && quote.scopeValidUntil === scope.validUntil,
  'v4_scope_binding');
  requireV4(nonzeroAddress(scope.submitter) !== nonzeroAddress(snapshot.grantSigner), 'v4_roles');
  requireV4(scope.totalClaimLimit > scope.totalClaims && quote.namespaceClaimsRemaining > 0n
    && quote.scopeClaimsRemaining === scope.totalClaimLimit - scope.totalClaims, 'v4_issuance_limit');
  requireV4(quote.issuanceEnabled && quote.initialPrice === 0n && (quote.status === 0 || quote.status === 3),
    'v4_not_free');
  requireV4(quote.reservedFor === '0x0000000000000000000000000000000000000000'
    || getAddress(quote.reservedFor) === recipient, 'v4_reserved');
  nonzeroAddress(quote.renewalToken);
  requireV4(quote.annualRenewalPrice >= 0n && quote.annualRenewalPrice < (1n << 128n), 'v4_renewal_terms');
  const budgets = [timing.collectionMarginSeconds, timing.signingMarginSeconds, timing.inclusionMarginSeconds];
  const total = budgets.reduce((sum, value) => sum + value, 0);
  requireV4(budgets.every(value => Number.isSafeInteger(value) && value > 0) && total <= 900, 'v4_timing');
  const deadline = [block.timestamp + 900n, scope.validUntil - 1n, authority.validUntil - 1n]
    .reduce((minimum, value) => value < minimum ? value : minimum);
  requireV4(deadline - now >= BigInt(total), 'v4_claim_window_insufficient');
  const claim: Readonly<FreeClaimV4> = Object.freeze({ requestId: input.requestId,
    communityId: authorization.communityId, namespaceId: authorization.namespaceId, label: input.label,
    recipient, generation: quote.generation, authorityRevision: quote.authorityRevision,
    policyRevision: quote.policyRevision, scopeRevision: scope.revision, scopeAuthorizationHash: authorizationHash,
    issuedAt: block.timestamp, deadline, years_: 1, maxCost: 0n });
  return Object.freeze({ schema: 'pirate.member-name-claim/4' as const, transactionReady: false as const,
    source: Object.freeze({ ...source }), authorization: Object.freeze({ ...authorization }), claim,
    requestHash: hashTypedData(claimTypedDataV4(abi, source, claim)),
    quoteBlock: Object.freeze({ ...block }), renewalToken: getAddress(quote.renewalToken),
    annualRenewalPrice: quote.annualRenewalPrice, scopeValidUntil: scope.validUntil,
    timing: Object.freeze({ ...timing }),
    submitBy: deadline - BigInt(timing.signingMarginSeconds + timing.inclusionMarginSeconds) });
}
