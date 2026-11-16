# Naming contract inventory

SharedNameRegistryV3 is the target for new naming integrations: one Pirate-managed
ERC-721 registry across admitted TLD namespaces and communities. Operators use
application permissions rather than deploying per-TLD clones. Full-name identity
includes both namespace and label. External TLD authority and holder rights
remain distinct from Pirate administration.

## Source selection

| Contract | Role | Selection |
| --- | --- | --- |
| SharedNameRegistryV3 | Shared ownership, transfer, records, registration and renewal | Feature-branch source; not yet accepted, deployed or selected downstream. |
| SLDRegistry | One registry per TLD | Retained implementation for existing deployments and their locked terms. |
| RegistryFactory | Deploys the older per-TLD registries | Retained deployment provenance and verification. |
| PirateTestUSD | Valueless test currency | Testnet helper, excluded from application-contract counts. |

The shared feature branch owns `docs/SHARED-NAMES-V3.md` and
`docs/SHARED-NAMES-MIGRATION-V1.md`. They define the new protocol and the
holder-preserving migration requirements. At exact source `56d63ad`, CI run
[43452867716](https://github.com/pirate-social-club/pirate-registry/actions/runs/43452867716)
passes release solc and separate Solar tests, generated ABI byte comparison,
types, Node tests and shared acceptance using a committed-source rebuild plus
full-node and SPV Handshake resolution. Application membership/grant persistence
remains fixture-only, and downstream adoption or a live migration is not implied.
The canonical protocol-2 manifest still selects the retained per-TLD model.

Do not offer the factory/clone deployment model as the intended new-community
setup. Its source, deployment scripts, SDK, resolver and manifests remain needed
while current callers and existing namespaces use protocol 2. They must not be
deleted or silently rewritten to refer to V3.

## Cutover

Before selecting V3, accept its compiled ABI and source verification, migrate
directory/community identity and actual SDK/resolver/application callers, and
record the explicit source selection. Existing holders, records, expiry, locked
renewal terms, pending receipts and dependent community/post references require
an accepted migration. Namespaces requiring migration remain closed to new
shared issuance until that migration is implemented and accepted.

Historical verification stays pinned to the original source. A new address or
an equal label cannot replace proof of old ownership or transaction consumption.
Deployment records and older source remain unchanged by this inventory.
