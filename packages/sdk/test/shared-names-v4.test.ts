// Requires Root's actual V4 build. No fabricated or transcribed ABI fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hashTypedData, isHex, keccak256, type Abi, type Hex } from 'viem';
import { prepareSharedClaimV4, scopeAuthorizationTypedDataV4, claimTypedDataV4,
  acceptanceTypedDataV4, type ScopeAuthorizationV4, type SharedV4SourceSelection,
  type SharedV4QuoteSnapshot } from '../src/shared-names-v4.ts';

const artifact: { abi: Abi; deployedBytecode: { object: unknown } } = JSON.parse(readFileSync(
  new URL('../../../out/SharedNameRegistryV4.sol/SharedNameRegistryV4.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(artifact.abi), 'actual compiled V4 ABI required');
const code = artifact.deployedBytecode.object;
assert.ok(typeof code === 'string' && isHex(code) && code.length > 2, 'actual compiled runtime required');
const abi = artifact.abi;
const h = (byte: string): Hex => {
  const value = `0x${byte.repeat(64)}`;
  assert.ok(isHex(value) && value.length === 66);
  return value;
};

function fixture() {
  const source: SharedV4SourceSelection = {
    schema: 'pirate.shared-registry-v4-preparation/1', protocolVersion: 4, chainId: 31337,
    registry: '0x1111111111111111111111111111111111111111',
    // Fixture selection only: no release commit/source manifest exists for this proposal.
    sourceCommit: '1'.repeat(40), sourceSha256: '2'.repeat(64),
    abiSha256: createHash('sha256').update(JSON.stringify(abi)).digest('hex'), runtimeCodeHash: keccak256(code),
  };
  const authorization: ScopeAuthorizationV4 = { namespaceId: h('3'), communityId: h('4'),
    installationId: h('5'), controller: '0x2222222222222222222222222222222222222222',
    namespaceEvidenceHash: h('6'), evidenceHash: h('7') };
  const authorizationHash = hashTypedData(scopeAuthorizationTypedDataV4(abi, source, authorization));
  const snapshot: SharedV4QuoteSnapshot = {
    chainId: 31337, registry: source.registry,
    block: { tag: 'safe', number: 10n, hash: h('8'), timestamp: 1000n },
    authority: { evidenceHash: authorization.namespaceEvidenceHash, validUntil: 4000n,
      issuanceEnabled: true, migrationRequired: false },
    grantSigner: '0x3333333333333333333333333333333333333333',
    scope: { submitter: '0x4444444444444444444444444444444444444444', totalClaimLimit: 10n,
      totalClaims: 1n, revision: 1n, enabled: true, authorizationHash,
      namespaceEvidenceHash: authorization.namespaceEvidenceHash, observedAt: 900n, validUntil: 1500n },
    quote: { authorityRevision: 1n, policyRevision: 1n, scopeRevision: 1n, scopeAuthorizationHash: authorizationHash,
      scopeValidUntil: 1500n, generation: 1n, status: 0,
      reservedFor: '0x0000000000000000000000000000000000000000', initialPrice: 0n, issuanceEnabled: true,
      namespaceClaimsRemaining: 99n, scopeClaimsRemaining: 9n,
      renewalToken: '0x5555555555555555555555555555555555555555', annualRenewalPrice: 5n },
  };
  const input = { requestId: h('9'), label: 'member001', recipient: authorization.controller };
  const timing = { collectionMarginSeconds: 60, signingMarginSeconds: 60, inclusionMarginSeconds: 60 };
  const prepare = (now = 1000n) => prepareSharedClaimV4(abi, source, snapshot, authorization, input, now, timing);
  return { source, authorization, snapshot, input, timing, prepare };
}

test('V4 uses compiled fields, exact authorization and a deadline inside scope validity', () => {
  const f = fixture(), op = f.prepare();
  assert.equal(op.schema, 'pirate.member-name-claim/4');
  assert.equal(op.transactionReady, false);
  assert.equal(op.claim.deadline, 1499n);
  assert.equal(op.submitBy, 1379n);
  assert.equal(op.claim.scopeAuthorizationHash, f.snapshot.scope.authorizationHash);
  assert.equal(op.claim.communityId, f.authorization.communityId);
  assert.equal(op.claim.namespaceId, f.authorization.namespaceId);
  assert.equal(op.claim.requestId, f.input.requestId);
  assert.equal(op.requestHash, hashTypedData(claimTypedDataV4(abi, f.source, op.claim)));
});

test('unverified B cannot borrow A scope even in the same namespace', () => {
  const f = fixture();
  f.authorization.communityId = h('a');
  assert.throws(() => f.prepare(), /v4_scope_binding/);
});

test('expired B refuses while global namespace evidence is fresh', () => {
  const f = fixture();
  assert.equal(f.snapshot.authority.validUntil, 4000n);
  assert.throws(() => f.prepare(1500n), /v4_scope_unavailable/);
  assert.throws(() => f.prepare(1501n), /v4_scope_unavailable/);
});

test('revoked and unconfigured scopes refuse independently of quote flags', () => {
  const f = fixture();
  f.snapshot.scope.enabled = false;
  assert.throws(() => f.prepare(), /v4_scope_unavailable/);
  f.snapshot.scope.enabled = true;
  f.snapshot.scope.authorizationHash = h('0');
  assert.throws(() => f.prepare(), /v4_scope_binding/);
});

test('installation, controller and evidence changes cannot use the saved commitment', () => {
  for (const field of ['installationId', 'controller', 'evidenceHash'] as const) {
    const f = fixture();
    if (field === 'controller') f.authorization.controller = '0x6666666666666666666666666666666666666666';
    else f.authorization[field] = h('a');
    assert.throws(() => f.prepare(), /v4_scope_binding/);
  }
});

test('changed namespace evidence and inconsistent quote revisions refuse', () => {
  const f = fixture();
  f.snapshot.authority.evidenceHash = h('a');
  assert.throws(() => f.prepare(), /v4_scope_binding/);
  f.snapshot.authority.evidenceHash = f.authorization.namespaceEvidenceHash;
  f.snapshot.quote.scopeRevision++;
  assert.throws(() => f.prepare(), /v4_scope_binding/);
});

test('scope refresh keeps the commitment and cannot lengthen an already prepared grant', () => {
  const f = fixture(), original = f.prepare();
  f.snapshot.scope.observedAt = 1000n;
  f.snapshot.scope.validUntil = 2000n;
  f.snapshot.quote.scopeValidUntil = 2000n;
  const fresh = f.prepare();
  assert.equal(fresh.claim.scopeAuthorizationHash, original.claim.scopeAuthorizationHash);
  assert.equal(original.claim.deadline, 1499n);
  assert.equal(fresh.claim.deadline, 1900n);
  assert.notEqual(fresh.requestHash, original.requestHash);
  // Repreparing is not a permitted retry: the caller must retain the original operation.
  assert.equal(original.claim.requestId, f.input.requestId);
});

test('explicit collection margin includes the exact boundary and rejects one second later', () => {
  const f = fixture();
  assert.equal(f.prepare(1319n).claim.deadline, 1499n);
  assert.throws(() => f.prepare(1320n), /v4_claim_window_insufficient/);
});

test('scope-limited window can fail despite a long namespace lifetime', () => {
  const f = fixture();
  f.snapshot.scope.validUntil = 1180n;
  f.snapshot.quote.scopeValidUntil = 1180n;
  assert.throws(() => f.prepare(), /v4_claim_window_insufficient/);
});

test('namespace validity and the 900-second limit independently bound deadlines', () => {
  const f = fixture();
  f.snapshot.scope.validUntil = 5000n;
  f.snapshot.quote.scopeValidUntil = 5000n;
  assert.equal(f.prepare().claim.deadline, 1900n);
  f.snapshot.authority.validUntil = 1300n;
  assert.equal(f.prepare().claim.deadline, 1299n);
});

test('no zero, negative, noninteger or excessive timing policy is accepted', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 901]) {
    const f = fixture();
    f.timing.collectionMarginSeconds = value;
    assert.throws(() => f.prepare(), /v4_timing/);
  }
});

test('caps and grant-signer submitter separation remain enforced', () => {
  const f = fixture();
  f.snapshot.scope.totalClaims = 10n;
  f.snapshot.quote.scopeClaimsRemaining = 0n;
  assert.throws(() => f.prepare(), /v4_issuance_limit/);
  f.snapshot.scope.totalClaims = 1n;
  f.snapshot.quote.scopeClaimsRemaining = 9n;
  f.snapshot.scope.submitter = f.snapshot.grantSigner;
  assert.throws(() => f.prepare(), /v4_roles/);
});

test('premiums, reservations, short and noncanonical labels have no paid fallback', () => {
  const f = fixture();
  f.snapshot.quote.initialPrice = 1n;
  assert.throws(() => f.prepare(), /v4_not_free/);
  f.snapshot.quote.initialPrice = 0n;
  f.snapshot.quote.reservedFor = f.snapshot.grantSigner;
  assert.throws(() => f.prepare(), /v4_reserved/);
  f.snapshot.quote.reservedFor = f.input.recipient;
  for (const label of ['short', 'Member001', 'ab--cdefg', 'member001\n']) {
    f.input.label = label;
    assert.throws(() => f.prepare());
  }
});

test('safe snapshot chain and registry binding cannot be borrowed', () => {
  const f = fixture();
  f.snapshot.chainId = 6343;
  assert.throws(() => f.prepare(), /v4_snapshot_binding/);
  f.snapshot.chainId = 31337;
  f.snapshot.registry = '0x7777777777777777777777777777777777777777';
  assert.throws(() => f.prepare(), /v4_snapshot_binding/);
});

test('future clock and observations cannot extend the preparation lifetime', () => {
  const f = fixture();
  assert.throws(() => f.prepare(999n), /v4_clock/);
  f.snapshot.scope.observedAt = 1001n;
  assert.throws(() => f.prepare(), /v4_scope_unavailable/);
});

test('compiled ABI pin and exact canonical profile strings are mandatory', () => {
  const f = fixture();
  f.source.abiSha256 = 'a'.repeat(64);
  assert.throws(() => f.prepare(), /v4_abi_pin/);
  for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
    const g = fixture();
    g.source.sourceCommit += suffix;
    assert.throws(() => g.prepare(), /v4_profile_pin/);
  }
});

test('actual V3 artifact and profile cannot silently enter the V4 preparation path', () => {
  const v3: { abi: Abi } = JSON.parse(readFileSync(
    new URL('../../../out/SharedNameRegistryV3.sol/SharedNameRegistryV3.json', import.meta.url), 'utf8'));
  const f = fixture();
  f.source.abiSha256 = createHash('sha256').update(JSON.stringify(v3.abi)).digest('hex');
  assert.throws(() => prepareSharedClaimV4(v3.abi, f.source, f.snapshot, f.authorization, f.input, 1000n, f.timing),
    /v4_compiled_interface_required/);
  const wrong = { ...f.source, protocolVersion: 3 };
  // Exercise the untrusted runtime boundary without asserting it is a typed V4 profile.
  assert.throws(() => Reflect.apply(prepareSharedClaimV4, undefined,
    [abi, wrong, f.snapshot, f.authorization, f.input, 1000n, f.timing]), /v4_profile_required/);
});

test('nested consent and issuer digest bind commitment, chain, contract and version', () => {
  const f = fixture(), op = f.prepare();
  const issuer = claimTypedDataV4(abi, f.source, op.claim);
  const consent = acceptanceTypedDataV4(abi, f.source, op.claim);
  assert.equal(consent.domain.version, '4');
  assert.deepEqual(consent.types.ClaimAcceptance, [{ name: 'claim', type: 'FreeClaim' }]);
  assert.deepEqual(consent.message.claim, op.claim);
  assert.notEqual(hashTypedData(consent), hashTypedData(issuer));
  const changed = { ...op.claim, scopeAuthorizationHash: h('a') };
  assert.notEqual(hashTypedData(claimTypedDataV4(abi, f.source, changed)), op.requestHash);
  assert.notEqual(hashTypedData({ ...issuer, domain: { ...issuer.domain, chainId: 6343 } }), op.requestHash);
  assert.notEqual(hashTypedData({ ...issuer, domain: { ...issuer.domain,
    verifyingContract: '0x7777777777777777777777777777777777777777' } }), op.requestHash);
  assert.notEqual(hashTypedData({ ...issuer, domain: { ...issuer.domain, version: '3' } }), op.requestHash);
});

test('prepared request and its snapshot stay immutable when inputs are later changed', () => {
  const f = fixture(), op = f.prepare();
  f.input.requestId = h('a');
  f.authorization.communityId = h('b');
  f.snapshot.block.hash = h('c');
  f.source.registry = '0x7777777777777777777777777777777777777777';
  assert.equal(op.claim.requestId, h('9'));
  assert.equal(op.claim.communityId, h('4'));
  assert.equal(op.quoteBlock.hash, h('8'));
  assert.equal(op.source.registry, '0x1111111111111111111111111111111111111111');
  assert.ok(Object.isFrozen(op) && Object.isFrozen(op.claim) && Object.isFrozen(op.authorization)
    && Object.isFrozen(op.source) && Object.isFrozen(op.quoteBlock) && Object.isFrozen(op.timing));
});
