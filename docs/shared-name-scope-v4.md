# Shared registry V4: finite community issuance authority

Normative source specification 4.0.0, 2026-11-14. Source-only successor of
registry commit bf480445c88030910501923ac12350b2fe1d7e6e. All V3 source,
compiled ABI, deployments and holder records remain unchanged. V4 is a distinct
immutable deployment and EIP-712 domain, not a proxy upgrade or a V3 fallback.
No deployment, migration or namespace activation is authorized by this packet.

## Frozen authorization and state interface

`ScopeAuthorization` has, in this order, `bytes32 namespaceId`,
`bytes32 communityId`, `bytes32 installationId`, `address controller`,
`bytes32 namespaceEvidenceHash`, and `bytes32 evidenceHash`. Every field must be
nonzero. The evidence identifies the authorization of this exact community,
installation and controller to issue in this namespace. Merely selecting the
same namespace or shared-registry address grants no rights.

`scopeAuthorizationHash(authorization)` is the EIP-712 digest of
`ScopeAuthorization(bytes32 namespaceId,bytes32 communityId,bytes32 installationId,address controller,bytes32 namespaceEvidenceHash,bytes32 evidenceHash)`
under name `PirateSharedNames`, version `4`, actual chain ID and this registry.
The last evidence hash commits to the verifier's complete retained evidence;
it is not, by itself, proof of an external fact. The namespace evidence hash
must equal the currently attested namespace evidence at activation, refresh,
quote and claim. Evidence changes close the old scope until explicit admission.

`Scope` retains the V3 fields `submitter`, `totalClaimLimit`, `totalClaims`,
`revision`, `enabled`, followed by `authorizationHash`,
`namespaceEvidenceHash`, `observedAt`, and `validUntil`. Unconfigured scopes
have zero state and are disabled. Counters are lifetime counters, never refilled.

The V3 `configureScope` selector is absent. The V4 functions are:

* `authorizeScope(ScopeAuthorization,address submitter,uint64 totalClaimLimit,uint64 observedAt,uint64 validUntil,uint64 expectedRevision)`;
* `refreshScope(ScopeAuthorization,uint64 observedAt,uint64 validUntil,uint64 expectedRevision)`;
* `revokeScope(bytes32 namespaceId,bytes32 communityId,uint64 expectedRevision)`.

Only the current Pirate admin can call these functions in this finite testnet
successor. That admin must be the authorized verifier or use a reviewed process
that verifies the real binding evidence before submitting its attestation.
No registrar, submitter, controller or grant signer gains this capability.
Adding delegated attester/registrar roles is a separate contract change.

Activation checks current namespace freshness/issuance, migration closure,
configured policy, exact namespace evidence, nonzero fields, distinct grant
signer and submitter, positive bounded lifetime limit no lower than claims
already consumed, and compare-and-swap on `expectedRevision`. Observations must
be non-future and nondecreasing. Validity must be strictly after now and the
observation, at most the existing one-day authority lifetime after observation,
and no later than namespace validity. Explicit activation increments revision;
it is the only way to change the binding/submitter/limit or resume an expired
or revoked scope. It never resets claims consumed.

Refresh requires an enabled, still-current scope, exactly the same authorization
digest and expected revision, a strictly newer observation, and nondecreasing
expiry within the same finite bounds. It cannot change limits, counters,
submitter, installation, controller or evidence commitment. It cannot revive
expired, disabled, revoked or namespace-evidence-stale authority. A pure refresh
does not increment the scope revision: existing grants retain their original
deadline; no signature gains a longer term. Namespace refresh behavior remains
V3 behavior in this P0 change, including its authority revision changes.

Revocation disables the scope and increments revision, retaining its commitment,
times and counters for audit. A stale CAS fails. Reactivation is explicit
activation with fresh evidence, not a refresh. Old signed grants cannot revive.

Events are `ScopeAuthorized(namespaceId indexed,communityId indexed,authorizationHash indexed,ScopeAuthorization authorization,address submitter,uint64 totalClaimLimit,uint64 observedAt,uint64 validUntil,uint64 revision)`,
`ScopeRefreshed(namespaceId indexed,communityId indexed,authorizationHash indexed,uint64 observedAt,uint64 validUntil,uint64 revision)` and
`ScopeRevoked(namespaceId indexed,communityId indexed,authorizationHash indexed,uint64 revision)`.
The new refusal is `ScopeUnavailable()`; invalid evidence/configuration and
revision/signature errors retain their existing categories. These declarations
are source interfaces, not a generated JSON ABI.

## Quote, consent and claim

`PROTOCOL_VERSION` and EIP-712 version are 4. `FreeClaim` retains V3 order with
`bytes32 scopeAuthorizationHash` inserted immediately after `scopeRevision`.
Both the issuer's `FreeClaim` and nested recipient `ClaimAcceptance` include it.
`NameQuote` appends `scopeAuthorizationHash` and `scopeValidUntil`.

Both quote and claim require the exact enabled scope, `now < validUntil`, and
matching namespace evidence. Claim additionally requires the current scope
commitment/revision and `deadline <= scope.validUntil`. The grant deadline is
inclusive, but scope expiry is exclusive: a claim at scope expiry always fails,
even when its signed deadline equals that time. The independent namespace
freshness check remains mandatory. Existing 900-second grant limit, recipient
consent, zero initial cost, 8-character minimum, reservations, migration closure,
role separation, namespace/community issuance caps and global full-name
uniqueness remain unchanged. No new numeric live policy is selected.

An enabled scope for community A never authorizes B. Fresh global authority
never makes B's expired scope valid. A changed binding or revocation increments
revision; wrong commitment, even with otherwise valid signatures, is refused.

## External verification and consumer join

The contract enforces the recorded attestation, not Handshake consensus, TLD
ownership, a Directory query or controller identity outside this registry.
Before activation the owning verifier must authenticate the canonical community
and installation mapping, controller authorization, current TLD ownership or
valid delegated authority, live registry delegation, ownership epoch and
configuration revision, and bounded canonical evidence. A hash supplied by the
wizard is insufficient. Scope validity must not outlive that evidence or the
community's verification. Stop grants/revoke on observed loss; expiry is the
on-chain backstop if the observer stops. These external checks require real
producer integration and acceptance; they are not delivered by this contract.

HNS `ReadyToSubmit` remains preparation only. Its existing ceremony does not
produce this attestation, submit a transaction or confer mint rights. An
automatic community registrar cannot activate scopes. The owning consumer
must explicitly select V4, verify its compiled source/code/ABI/deployment pins,
use canonical safe-block snapshots, and pass the exact authorization to the
V4 helper. The helper validates supplied snapshots and builds typed data; it
does not replace source, RPC, HNS, Directory or receipt verification.

The new SDK file is an opt-in module, not a package-index export. It consumes a
real compiler-produced ABI supplied by the caller, validates its SHA-256 against
an explicitly selected V4 profile, and derives typed fields from that ABI.
No JSON ABI or generated TypeScript ABI is supplied here. Root must allocate
compilation/generation and admit the actual generated outputs/profile and
resolver/HNS/caller adaptations separately. A V3 profile or envelope is refused.

The V4 helper is preparation only: no signer, broadcast, nonce allocation,
journal migration or recovery adapter is added. Existing V3 operations retain
their exact deployment, signed bytes, nonce, hash and receipt. V4 adoption must
add the same durable original-operation/receipt/reorg guarantees before sends.
Expiry never deletes an unknown submitted operation or frees its reservation.

## Retained rights and migration

Scope expiry/revocation affects new issuance only. NFT transfers, record rights,
normal active/grace/released lifecycle, locked renewal prices/currency,
permissionless renewal sponsorship and permanent claim receipts are retained.
No automatic burn, seizure, reassignment or cross-registry holder copying is
added. Existing name expiry clocks continue. Namespace authority loss can still
stop resolution under V3 resolver policy; an NFT is not a guarantee that an
independent TLD owner keeps delegating. Any V3-to-V4 cutover requires the existing
holder-preserving migration protocol before live issuance in an occupied
namespace. No resolver may silently repoint or treat matching token formulas as
proof that a token on another deployment belongs to this registry.

## Qualification gates

All cases in the two new test files are prepared and UNRUN. The Solidity base
uses public fixture keys only on a disposable local chain. The SDK tests read
the actual V4 compiler artifact and intentionally require Root's prior build;
no invented ABI fixture is used. Required later gates: format, solc and Solar
compilation/tests, deployment bytecode size, generated interface comparison,
SDK types/tests, cross-language digest comparison, unchanged V3 regression,
source/ABI/code pin verification, and real verifier/HNS/caller acceptance.
No gate gains a pass from source review or from previous V3 test results.
