# Shared names migration protocol 1

`pirate.shared-names-migration/1` specifies the required handoff. This release
does not execute imports, activate existing namespaces, repoint Handshake or
replace a selected resolver source. Existing V2 code, evidence, records and paid
renewal obligations remain authoritative for their deployed generations.

A migration manifest must identify the old and new source tuples (chain,
contract, protocol, deployment block/hash, source commit, runtime/ABI hashes),
canonical snapshot blocks, namespace and independently verified current TLD
authority. It must enumerate each logical name, old asset identity/generation,
holder, expiry/grace state, locked renewal currency/price, records and transfer
history needed to establish the cutover holder. New token IDs are explicitly
mapped; an equal label never proves equal ownership. Old name keys or token IDs
must not be silently interpreted using the V3 formula.

Pirate-controlled migrations must carry over holder identity, remaining term,
records and renewal obligations without a new purchase or lost entitlement.
An incompatible payment currency or inability to preserve obligations is a
blocking conflict, not permission to assign new terms. Record managers and NFT
approvals need explicit treatment and must never be blindly recreated as current
authorization. App membership, accounts and login permissions do not transfer
merely because a name asset transfers.

The manifest includes a deterministic digest of the complete inventory,
collision disposition, directory-instance/communityKey mapping, dependent post
and application references, a cutover fence, reconciliation through that fence,
verification requirements and rollback boundaries. A static snapshot is
insufficient while the old registry still accepts transfers and renewals. The
protocol must either establish an enforceable freeze/holder-authorized escrow or
otherwise prove an exclusive authoritative cutover with reconciliation. There
must not be two simultaneously spendable authoritative copies.

Migration approval and changing Pirate-controlled source selection require the
same custody protection as registry administration. Testnet currently permits
the explicit Pirate single-admin profile with two-step handover; multisig/delay
setup is deferred and must not be claimed as implemented. Resolver releases must
name the accepted new source explicitly; they cannot silently follow arbitrary
new contracts. External TLD owners retain independent repointing/lapse powers,
so holder carry-over in Pirate's registry cannot guarantee external resolution.

Namespaces with existing rights requiring migration are registered closed with
`migrationRequired=true`. V3 has no function that clears that flag or imports
historical names. Opening them requires a separately reviewed migration
implementation and source release. Clean disposable namespaces can exercise
the full local V3 flow without implying that any real namespace is ready.

Rollback must distinguish a pre-cutover cancellation from a post-cutover recovery
after new holder actions have occurred. Reverting a resolver pointer alone must
not erase those actions or revive superseded authorizations. Lost TLD authority
stops new issuance and is surfaced to holders; existing NFT data is retained.
The operational recovery and any compensation/extension policy must be explicit
before a real namespace is admitted. This source grants no live migration power.

Receipt reconciliation remains pinned to the original source after a migration
or external repointing. A new resolver source cannot erase original consumption
or justify a second entitlement. Historical consumption and current destination
ownership/resolution are separate proofs; the migration manifest must preserve
their explicit relationship rather than rewriting the original receipt.
