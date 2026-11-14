# Shared registry V4: finite community issuance authority

Normative source specification 4.0.2, 2026-11-14. Source-only successor of
registry commit bf480445c88030910501923ac12350b2fe1d7e6e. All V3 source,
compiled ABI, deployments and holder records remain unchanged. V4 is a distinct
immutable deployment and EIP-712 domain, not a proxy upgrade or a V3 fallback.
No deployment, migration or namespace activation is authorized by this packet.

## Frozen authorization and state interface

`ScopeAuthorization` has, in this order, `bytes32 namespaceId`,
`bytes32 communityId`, `bytes32 installationId`, `address controller`,
`bytes32 namespaceAuthorizationHash`, `uint64 namespaceAuthorizationRevision`,
and `bytes32 evidenceHash`. Every field must be
nonzero. The evidence identifies the authorization of this exact community,
installation and controller to issue in this namespace. Merely selecting the
same namespace or shared-registry address grants no rights.

`scopeAuthorizationHash(authorization)` is the EIP-712 digest of
`ScopeAuthorization(bytes32 namespaceId,bytes32 communityId,bytes32 installationId,address controller,bytes32 namespaceAuthorizationHash,uint64 namespaceAuthorizationRevision,bytes32 evidenceHash)`
under name `PirateSharedNames`, version `4`, actual chain ID and this registry.
The last evidence hash commits to the verifier's retained community binding
authorization, not each later namespace observation; it is not, by itself, proof
of an external fact. Namespace authorization hash and revision must equal the
current namespace binding and semantic epoch at activation, refresh, quote and
claim. New observations of that same authority do not alter those commitments.
A new ownership/delegation epoch closes old scopes until explicit admission.

`Scope` retains the V3 fields `submitter`, `totalClaimLimit`, `totalClaims`,
`revision`, `enabled`, followed by `authorizationHash`,
`namespaceAuthorizationHash`, `namespaceAuthorizationRevision`, `observedAt`,
and `validUntil`. Unconfigured scopes
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
configured policy, exact namespace authorization and epoch, nonzero fields, distinct grant
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
expired, disabled, revoked or namespace-epoch-stale authority. A pure refresh
does not increment the scope revision: existing grants retain their original
deadline; no signature gains a longer term. Namespace freshness is separate
from semantic authorization as specified below.

Revocation disables the scope and increments revision, retaining its commitment,
times and counters for audit. A stale CAS fails. Reactivation is explicit
activation with fresh evidence, not a refresh. Old signed grants cannot revive.

Events are `ScopeAuthorized(namespaceId indexed,communityId indexed,authorizationHash indexed,ScopeAuthorization authorization,address submitter,uint64 totalClaimLimit,uint64 observedAt,uint64 validUntil,uint64 revision)`,
`ScopeRefreshed(namespaceId indexed,communityId indexed,authorizationHash indexed,uint64 observedAt,uint64 validUntil,uint64 revision)` and
`ScopeRevoked(namespaceId indexed,communityId indexed,authorizationHash indexed,uint64 revision)`.
The new refusal is `ScopeUnavailable()`; invalid evidence/configuration and
revision/signature errors retain their existing categories. These declarations
are source interfaces, not a generated JSON ABI.

## Namespace authorization epoch and observation freshness

This finite correction leaves published V3 unchanged. In V4, `Authority` retains
its prior fields and appends `bytes32 authorizationHash` and
`uint64 freshnessVersion`. Its existing `revision` is the semantic authorization
epoch. `evidenceHash` identifies the latest retained observation evidence, not
the durable binding identity.

The stable authorization hash commits to the actual TLD identity, external
ownership/control epoch, delegation rights and exact registry/chain target.
The verifier must establish those facts from canonical external evidence; it
must not treat equal arbitrary hashes as proof. A change in ownership,
delegation rights or target requires explicit reauthorization even if the
controller address happens to remain the same.

V4 `attestNamespace(namespaceId,authorizationHash,evidenceHash,observedAt,validUntil,issuanceEnabled)`
is explicit activation/reauthorization. It increments both semantic `revision`
and `freshnessVersion`, including when readmitting the same binding after a
lapse. Existing `setNamespaceIssuance` increments semantic revision; it is an
explicit administrative change, never a freshness helper.

`refreshNamespace(namespaceId,authorizationHash,evidenceHash,observedAt,validUntil,expectedRevision,expectedFreshnessVersion)`
is admin-only and requires enabled, non-migrating, currently unexpired authority,
the exact existing authorization hash and both CAS versions. Observation must
strictly advance, cannot be in the future, and expiry cannot decrease.
The existing one-day bound from observation remains. It updates evidence,
observation and expiry and increments only `freshnessVersion`. It cannot
activate, enable, revive, rebind, change policy, rotate signers or increase caps.
It does not modify any community scope's validity or grant deadline.

`AuthorityAttested` includes `authorizationHash` immediately after namespaceId
and `freshnessVersion` immediately after revision. Consumers can distinguish
semantic changes from observation refresh without inferring identity from
evidence bytes. No delegated attester role is introduced.

Each scope stores and commits the namespace's semantic revision in addition to
its authorization hash. Consequently suspension, revocation, ownership change
or explicit reauthorization makes the old scope unusable, even if later evidence
returns to the same hash. Explicit scope admission is then required; a refresh
cannot revive it. Expired grants remain expired and consumed counters remain
consumed. A freshness-only update preserves otherwise valid collected signatures.

The SDK validates the canonical snapshot's namespace authorization/epoch and
observation fields independently. Freshness version is not added to a signed
claim: it must not cancel an otherwise valid original operation. All existing
safe-block, source verification, finite timing and immutable journal rules remain.

## Quote, consent and claim

`PROTOCOL_VERSION` and EIP-712 version are 4. `FreeClaim` retains V3 order with
`bytes32 scopeAuthorizationHash` inserted immediately after `scopeRevision`.
Both the issuer's `FreeClaim` and nested recipient `ClaimAcceptance` include it.
`NameQuote` appends `scopeAuthorizationHash` and `scopeValidUntil`.

Both quote and claim require the exact enabled scope, `now < validUntil`, and
matching namespace authorization and epoch. Claim additionally requires the current scope
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

## Fixed metadata size reduction

Version 4.0.2 specializes the inherited metadata accessors to the immutable
values this registry already uses. ERC-721 name remains Pirate Shared Names,
symbol remains PSN, and tokenURI still requires an existing token and returns
the empty string. The EIP-712 domain view still reports fields 0x0f, name
PirateSharedNames, version 4, current chain ID, this contract, zero salt and no
extensions. It reads the current chain/address just as the inherited view does.

OpenZeppelin EIP712 remains the hashing implementation, including its
chain/address-sensitive domain separator and standard digest construction.
ERC721 transfer, approval, safe receiver checks and all registry authorization,
expiry, counters, consent, receipts and renewal logic are unchanged. This
specialization removes unused generic string/URI paths from this concrete
immutable contract; it adds no proxy, mutable domain or metadata authority.

Callable/event ABI behavior is intended to remain unchanged. Root must compare
actual compiled ABIs, including any inherited library-error entries, before
acceptance. Source/code/ABI pins must always come from the new real build.
Compiler profile and EIP-170 limit remain unchanged. Savings are unmeasured;
passing tests cannot establish deployability.

## Qualification gates

All cases in the two new test files are prepared and UNRUN. The Solidity base
uses public fixture keys only on a disposable local chain. The SDK tests read
the actual V4 compiler artifact and intentionally require Root's prior build;
no invented ABI fixture is used. Required later gates: format, solc and Solar
compilation/tests, deployment bytecode size, generated interface comparison,
SDK types/tests, cross-language digest comparison, unchanged V3 regression,
source/ABI/code pin verification, and real verifier/HNS/caller acceptance.
No gate gains a pass from source review or from previous V3 test results.
