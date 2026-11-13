# Shared names protocol 3

This is the normative source specification for `pirate.shared-names/3`, revision
3, authored before its affected implementation. Compilation, generated ABI, test vectors,
independent review and local acceptance are pending. It describes no deployed
registry, admitted live namespace, fee selection or funded service. Protocol 2
and its specification, deployments, manifests and locked terms remain unchanged.

## Ownership and scope

Pirate deploys and administers one shared registry on the selected application
chain. Community operators receive application permissions, not registry admin
keys. The testnet administrator has a two-step handover. Multisig provisioning
and administrative timelocks are deferred. The registry is a constructor-created
ERC-721 contract without a proxy, initializer, upgrade entry point or arbitrary
execution. The admin cannot confiscate, burn, transfer or edit a holder's name.
Standard NFT approvals authorize transfers, not record edits.

This release accepts chain 6343 and disposable chain 31337 only. No mainnet or
public deployment is authorized by source acceptance. Payment-contract spending
limits are outside this protocol. Name issuance budgets below are mandatory.

## Identity and canonical bytes

Registration inputs are canonical ASCII lowercase LDH strings of 1 through 63
bytes, without leading/trailing hyphens or hyphens in both positions 3 and 4.
This rejects `xn--`, Unicode, uppercase, dots, trailing root dots and whitespace.
TLD and label helpers reject invalid inputs rather than normalizing them. Member
validation consumes the entire string, including rejecting LF, CRLF, U+2028 and
U+2029 suffixes. Descriptors likewise require exact-length digests/commits and
canonical unsigned decimal block strings. Mixed-case addresses must have a
valid EIP-55 checksum; lowercase addresses are normalized after validation. Member
issuance additionally requires 8 through 63 bytes. There is no particular-name
exception. DNS read presentation may separately normalize case/root dots before
passing canonical labels to these helpers.

All derivations use Solidity `abi.encode`, never packed encoding. `H` denotes
Keccak-256, and domain strings are UTF-8:

```
namespaceId = H(abi.encode(H("pirate.namespace/1"), H(bytes(tld))))
nameKey = H(abi.encode(H("pirate.name/1"), namespaceId, H(bytes(label))))
tokenId = uint256(H(abi.encode(H("pirate.name-token/1"), nameKey, uint64(generation))))
```

Zero namespace/name keys and generation zero are rejected by the applicable
helpers. SDK wire-format bytes32 identifiers use lowercase hexadecimal, rejecting
case variants rather than storing inconsistent receipt lookup strings.
Generation starts at one. `name.tld1` and `name.tld2` are independent;
two communities issuing under the same TLD compete for the same name key.

These are portable logical name identifiers. They do not synchronize ownership
across chains or deployments. An NFT asset is identified by chain, contract and
token ID. One explicit verified source is selected per namespace; changing that
source requires the migration protocol. Multiple `_evm` records fail closed.

Community identity is independent of registry address. The caller protocol uses
a persistent random public `communityKey` as its portable reference, and
`H(abi.encode(H("pirate.community/2"), uint256(chainId), communityKey))` as the
chain-specific directory instance ID. This distinction permits explicit mapping
of instances during chain migration without conflating them. Directory creation
must bind the key to an authorized registrant; knowing a public key alone grants
no right to register it. Directory implementation belongs to the caller lane.

## Namespace authority

`registerNamespace(tld, migrationRequired)` creates one permanent namespace
record. It starts closed, without configured pricing or issuance scopes.
`attestNamespace` records an evidence digest, observation time, expiry and a
monotonic authority revision. Evidence must be nonzero, observed no later than
the current block, still valid, and valid for at most 24 hours from observation.
Observation timestamps cannot move backwards. Equal timestamps are permitted
for a corrected evidence record; every accepted attestation advances revision.
Every refresh or issuance toggle advances the revision and invalidates old
grants. A pause affects new issuance immediately. It does not change ownership,
record rights, locked renewal terms or ordinary holder renewals.

The Pirate administrator is the attestation authority in this testnet profile.
The evidence producer must independently observe current Handshake control and
delegation, with source/height/hash/freshness provenance. A hosting origin or old
registry-admin signature is insufficient. The EVM contract checks the attestation
and its expiry; it does not validate Handshake consensus or ownership proofs.
The independent resolver additionally checks current Handshake delegation.

An authority change closes issuance pending fresh evidence, policy and scope
review. Existing NFTs and recorded rights survive. External TLD owners can
repoint or lapse their TLD and thereby interrupt resolution. Pirate-controlled
source changes must preserve holders and their remaining terms/records/renewal
obligations as specified in `SHARED-NAMES-MIGRATION-V1.md`; no registry promises
control over an external owner's Handshake actions. Namespace flags alone are
not evidence that historical holders were migrated. A namespace marked as
requiring migration cannot be opened by this release.

## Configured policy and bounded issuance

The administrator explicitly configures the grant signer, annual renewal price
in the constructor-selected ERC-20 token's base units, and a positive finite
namespace lifetime claim budget. There is no default configured fee, currency,
open namespace, unlimited budget or subsidy. An explicitly configured zero
renewal fee is a real locked zero; an absent policy refuses issuance.

Each `(namespaceId, communityId)` scope has an independently configured
transaction submitter, revision, enabled flag and finite lifetime claim budget.
These are Pirate service roles; community operators use application permissions.
The submitter must differ from the grant signer. A claim requires that exact
submitter plus both signatures described below. Role separation must also be
maintained operationally: different keys and custody, not two names for one key.
The contract cannot determine whether two keys share a compromised host.

Namespace and scope issued counters only increase on successful claims. They
are not reset by authority refresh, signer/submitter rotation, reconfiguration,
expiry, transfer or re-registration. Re-registration consumes another claim.
The admin may explicitly replenish budgets by raising their total ceilings;
changing a signing key cannot replenish them. Both caps are checked on-chain.

Per-name policy records an initial price and an optional reserved recipient.
Nonzero initial price, including a closed/premium price, refuses the free path.
Reservations constrain the recipient, never seize an existing name. Changes
advance namespace policy revision and affect future registrations only.

## Claims, consent and receipts

`FreeClaim` contains request ID, community ID, namespace ID, canonical label,
recipient, expected generation, authority/policy/scope revisions, issued-at,
deadline, years and maxCost. Request/community/recipient are nonzero. The member
path is exactly one 365-day year with `maxCost == 0` and effective initial price
zero. It never approves or transfers ERC-20 tokens, attempts a paid fallback or
issues a short name. Expiry is transaction block time plus 365 days.

EIP-712 domain is name `PirateSharedNames`, version `3`, current chain ID and
this registry address. The exact primary type is:

```
FreeClaim(bytes32 requestId,bytes32 communityId,bytes32 namespaceId,string label,address recipient,uint64 generation,uint64 authorityRevision,uint64 policyRevision,uint64 scopeRevision,uint64 issuedAt,uint64 deadline,uint8 years_,uint256 maxCost)
```

`requestHash` is the EIP-712 digest of that type, with the label hashed per
EIP-712. The independently held grant signer signs it after checking current
intended membership, installation/grant binding, namespace scope, recipient,
quote and bounded gas authorization. Private account/installation identifiers
stay in the durable application grant; they are not added to public calldata.
The recipient separately signs a nested `ClaimAcceptance(FreeClaim claim)`.
Its EIP-712 encoded type is that string followed immediately by the complete
`FreeClaim(...)` definition above. The message contains the full claim, so wallets
can display label, recipient, namespace, term and deadline instead of an opaque
digest. Namespace/community identifiers remain hashes; clients must display the
verified human-readable namespace and locked renewal quote alongside consent.
The issuer `FreeClaim` digest is unchanged. `recipientAcceptanceHash(FreeClaim)`
returns the recipient digest, not the issuer digest. EOA and ERC-1271 signatures
are supported. Code-bearing EIP-7702 accounts require an ERC-1271-compatible
delegate under the pinned SignatureChecker; no unreviewed EOA fallback exists.
Both signatures are required, including when recipient equals submitter. A
grant lasts at most 15 minutes; issued-at cannot be in the future and deadline
is inclusive. Every revision and expected generation must still match.

The exact request ID is durably allocated before signing/broadcast. A receipt
is keyed by community and request ID across namespaces and permanently records
requestHash, tokenId and the claim's block number. Reuse fails even after expiry
or transfer. `FreeNameClaimed` carries namespace, community, request ID/hash,
name key, label, token/generation, original recipient, expiry and locked renewal
price. All counters/state/receipt are initialized before the ERC-721 callback;
a failed signature, cap, payment or receiver rolls the whole transaction back.

SDK preparation verifies an explicit source and one canonical block, obtains
the quote, and binds exact fields. Issued-at uses that block's timestamp so
simulation at the same block is possible. Deadline is bounded by issued-at plus
900 seconds and authority expiry. Callers explicitly provide positive signing
and inclusion margins whose sum is below 900 seconds; preparation requires both
remaining, and broadcast requires the inclusion margin after signing and durable
persistence. An insufficient window has its own error and reports selected-block
lag. No default operational gas or timing policy is selected. Chain 6343 safe
lag must be measured before selecting those margins for a live service.

A pending/unknown broadcast retains the original signed operation and transaction
hash; it must not silently generate a new request or retry with a fresh nonce.
Prepared operations use `pirate.member-name-claim/2`; the unaccepted earlier
source shape is not silently upgraded or submitted with a different consent.
Automatic nonce replacement/cancellation is not implemented; a later admitted
caller must retain the original request and explicitly coordinate that operation.
Persistence must fsync the file and its containing directory, including every
newly created directory link, before permitting broadcast. Any persistence or
sync failure prevents send. Durable storage and exclusive operation leases belong
to the admitted caller; the local acceptance journal exercises the same boundary.

Recovery rechecks application authorization and verifies the original pinned
source/deployment, token namespace, permanent claimReceipt, complete original
event and canonical successful transaction receipt. Live Handshake delegation,
fresh issuance authority and unchanged holder are not prerequisites for proving
consumption. The event must be emitted by the selected registry and present in
that receipt; the outer transaction may target a contract submitter. A different
transaction hash is reported as correlation information, not rejected if it
proves the same original request. A consumed result carries immutable original
recipient/term and separate current generation/registrant/status/expiry. It does
not authorize app activation: current membership, active ownership and fresh
resolution eligibility require separate checks. Callback transfer, later transfer,
expiry and re-registration cannot turn a consumed grant into an unused grant.

With no receipt, recovery reports pending until the selected canonical block is
strictly past the grant deadline, then expired-unconsumed at that observation.
All observations remain bound to block hash and may be invalidated by a reorg.
Conflict, ambiguous event, reorg, unavailable source and authorization failure
remain errors/unknown; none means unused or authorizes automatic reissue.

## Lifecycle and fees

Status ordinal values are `Unknown=0`, `Active=1`, `Grace=2`, `Released=3`,
`Superseded=4`. Active ends exactly at expiry. Grace lasts 30 days; a name is
Released at expiry plus grace. Only Active names transfer or edit records.
Standard ERC-721 ownership remains observable until the old token is burned on
re-registration. `effectiveOwner` returns a holder only while Active; callers
must not infer current naming rights from raw NFT ownership alone.

The first year is included in issuance. Its annual renewal price is separately
locked for that token generation, survives transfer and cannot be raised by
policy changes. Anyone may pay a renewal of an Active or Grace name for 1–5
years, extending from the old expiry, with at most 3,650 days remaining from the
current block. Renewal has maxCost and deadline protection. The contract token
is immutable; changing treasury does not change renewal price/currency.
The SDK's explicit renewal preparation verifies the original pinned registry
source and token namespace, without requiring current TLD delegation or a fresh
issuance attestation. Lost external authority can interrupt name resolution but
must not prevent a holder from preparing renewal of retained on-chain rights.
The admitted payment token must have ordinary fixed-unit ERC-20 transfers;
fee-on-transfer and rebasing currencies are unsupported. Token issuer pauses or
blacklists can block paid renewals or revenue sweeps. Zero-cost issuance and
explicitly zero-cost renewals do not call token transfer functions.
Zero-price renewal sponsorship is retained: any account can keep extending a
name within the same term bounds. Names still expire without renewal; lifetime
issuance budgets never refill when a name expires. This repair changes neither
that policy nor the 24-hour resolution authority requirement.

Renewal price, currency/token address and operational policy values remain
deployment/admission decisions. Fixture values are only local test data. Paid
initial purchases are deferred; a future purchase may include year one but is
not exposed by this release. Initial zero cost is not a promise of free gas.

Re-registration of a Released label burns the previous NFT, increments its
generation and starts empty records/manager at the new locked renewal price.
The historical token state remains inspectable as Superseded. The holder or its
current explicit record manager can edit records while Active; a transfer clears
the manager, including a round trip to the former holder. Existing record key
encodings are reused unchanged. Record values are capped at 1,024 bytes.

## Source verification and generated interface

`pirate.shared-registry-source/1` is an explicit local descriptor, validated by
the accompanying JSON schema and implementation. It pins chain, registry,
deployment transaction/block/hash, runtime code hash, protocol version, source
commit, generated ABI SHA-256 and compiler settings. No active V3 manifest or
invented address/code hash ships in this change. An expected source is supplied
by a separately accepted release; callers must not trust an attacker-provided
descriptor merely because it is internally consistent.

All code/state reads use one safe/finalized block hash with `requireCanonical`,
check chain, maximum age and clock skew, and refuse providers without that
support. The deployment block and receipt must remain canonical. Runtime hash,
protocol version, namespace/TLD identity and current delegation must match.
No automatic V2, other-chain, latest-block or alternate-contract fallback exists.
Resolution reports EVM and Handshake trust separately and bounds DNS TTL by
both name expiry and authority freshness. Unknown enum values fail closed.
The reused Handshake adapters expose node/SPV observations, not a portable
consensus proof or block-hash attestation. Full-node renewal metadata indicating
expiry is refused. Operator evidence production must retain its own canonical
height/hash evidence; these adapters alone do not satisfy that admission gate.

The Solidity interface and implementation are the source authority. ABI files
are generated only from their actual solc artifacts by `gen-shared-abi.mjs` and
must match compilation before adoption. They are not manually transcribed.
The generator emits identity test vectors alongside the ABI using the owning
encoding functions. Solidity tests independently check the formulas; TypeScript
tests reproduce the generated vectors and local acceptance compares each vector
against the compiled contract's helpers.
Independent literal vector sections in the existing Solidity and TypeScript key
tests must be populated by Root's later allocated computation and compared with
both implementations. Until populated, those explicit gates fail; fabricated
hash literals or a same-helper-only check cannot satisfy this gate.

The release verifier uses explicitly pinned Forge/solc binaries, approved child
environments and archived committed sources plus committed dependency gitlinks.
It refuses ambient Git/Foundry/Solidity overrides, symlinks and unpinned source
imports, checks artifact metadata source hashes against that archived closure,
and rejects viaIR=true (false or absent is the accepted non-IR profile). No local
untracked library content or external configuration participates in the rebuild.
Prepared tests and source without compilation are explicitly unverified.

## Required acceptance

Acceptance covers same-TLD cross-community collision and distinct-TLD reuse;
canonical label and 7/8/9 boundaries; source/chain/delegation tampering; stale
authority; migration refusal; both signatures and domain separation; reservations
and premiums; cumulative budgets under rotations; replay and request conflicts;
receiver failure/reentrancy; exact receipt recovery and reorgs; lifecycle boundary
seconds; transfer/manager rights; locked renewal prices and token failures.
Foundry, Solar, TypeScript, ABI reproducibility and local acceptance remain
UNRUN until Root allocates them. No downstream resume or deployed readiness is
implied by this source document.
