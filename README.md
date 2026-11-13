# pirate-registry

## Shared names V3 source draft

The new Pirate-managed shared registry is specified in
[SHARED-NAMES-V3.md](docs/SHARED-NAMES-V3.md), with explicit holder-preserving
[migration requirements](docs/SHARED-NAMES-MIGRATION-V1.md). It namespaces names
by canonical TLD and label across communities. Operators receive application
permissions; Pirate administers the shared contract.

This is uncompiled source awaiting independent review. No V3 deployment,
admitted live namespace, generated ABI or passing test result is supplied.
Compilation, ABI generation, type checks, tests and local acceptance are **UNRUN**
until separately allocated. The two ABI output files are deliberately absent
until generated from the actual compiler artifacts. Live currency, renewal fee,
role addresses and finite issuance budgets still require explicit configuration.

After verified pinned dependencies and a runtime allocation are supplied, the
validation order is solc build, `npm run gen:shared-abi`, `npm run typecheck`,
Foundry tests, `npm run test:shared`, and independent source rebuild/local
acceptance. `npm run acceptance:shared -- --execute-local` requires separately
managed disposable Anvil (31337 on port 18545), hsd regtest and hnsd; it does not
start or stop services. `npm run verify:shared-release -- --source FILE --rpc URL`
verifies an explicit V3 source without updating a deployment manifest.
`node packages/sdk/src/shared-cli.ts --help` describes the read-only V3 CLI.

## Existing protocol 2 baseline

A permissionless Handshake SLD registry: anyone who controls a Handshake TLD
can deploy an immutable registry on an EVM chain (MegaETH testnet in this
release), sell second-level names as ERC-721 tokens for a pinned payment
token, and let anyone verify a name without PIRATE servers.

`docs/SPEC.md` is the normative baseline (revision 3, 2026-11-04): MegaETH
testnet (D1), a price fixed per registration generation (D2), payment into
the registry with a separate permissionless `sweep()` (D3), and operator sale
policy for new registrations (D5): an annual price per label length, premium
prices and reservations, after HNS.ID's `DefaultRegistrationStrategy`. The
current app's 8+ open sale band is `--min-length 8` at deployment. The
reviewed draft and its review history are in the staging root at
`handoffs/pirate-registry-v1-spec-2026-11-03/`.

## Status

This is an experiment under the workspace control plane's `experiments/`
directory, published as `pirate-social-club/pirate-registry`. Base and Base
Sepolia are no longer supported; the Base Sepolia release and the c22
ceremony of 2026-11-03 remain as history in `docs/DEPLOYMENTS.md`.
Milestone 1 is independent ownership and record lookup. DNS serving, the
storefront and any `.pirate` migration are later work; `.pirate`, 8s28 and
a18n are excluded.

## Layout

- `src/SLDRegistry.sol`: the registry implementation (cloned per TLD).
- `src/RegistryFactory.sol`: ownerless factory that deploys and initializes clones.
- `src/Labels.sol`, `src/RecordKeys.sol`: label rules and record-key derivation.
- `test/`: Foundry tests, including a mock USDC with blacklist and pause.
- `packages/resolver/`: the independent resolver (Handshake delegation from
  hsd or hnsd, manifest verification, reads pinned to one block hash with
  `requireCanonical`) and its unit tests.
- `packages/sdk/`: operator and buyer transactions and the `pirate-registry` CLI.
- `harness/`: local acceptance (anvil, hsd regtest, hnsd in Docker).
- `script/Deploy.s.sol`: `DeployTestToken` (MegaETH testnet only),
  `DeployFactory` (the pinned payment token on MegaETH testnet, a mock on
  local anvil) and `DeployRegistry`, which prints the `_evm` delegation record
  to publish on the TLD. `script/testnet/PirateTestUSD.sol` is the valueless
  six-decimal test token.
- `harness/testnet-rehearsal.ts`: MegaETH testnet rehearsal with a local
  regtest TLD, the 8+ band, a premium and a reserved label, recording gas and
  block-tag lag.

## Local tests

Contracts need Foundry (`foundryup`). The resolver, SDK, CLI and acceptance
harness need Node 24 (TypeScript runs natively) and Docker for hnsd.

```
npm install
npm run typecheck
npm run test:ts                                   # resolver unit tests
docker build -t pirate-registry-hnsd:v2.0.0-regtest harness/hnsd
node harness/acceptance.ts                        # SPEC 11.1, about five seconds
node packages/sdk/src/cli.ts --help
node scripts/verify-release.ts --rpc URL --factory ADDR   # rebuild-and-hash check
```

`scripts/verify-release.ts` rebuilds the committed source (via `git archive`,
with submodules checked against the commit's gitlinks) using the pinned solc
settings and compares it byte for byte with the deployed implementation and
factory; only the factory's two immutable slots may differ, and they must hold
the implementation and payment-token addresses. It writes the manifest entry
only on success. Acceptance uses it to produce its local manifest, so the run
fails if the deployed code is not reproducible from the committed source.

The acceptance script starts its own anvil (one slot per epoch, so `safe`
trails by one block), an in-memory hsd 8.0.0 regtest node and hnsd v2.0.0 in
Docker, and stops them when it finishes. It writes `harness/.run/` (ignored).
Because it moves anvil's clock forward a year, it passes the chain time as the
resolver's `--now` override, which the output reports as `clock: "override"`.

Contract tests, from this directory:

```
forge build
forge test
```

`FOUNDRY_PROFILE=solar forge test --use solar` runs the same suite compiled
with Paradigm's Solar (bundled with Foundry 1.9.0, reporting itself as
Solidity 0.8.38) into separate `out-solar/` and `cache-solar/` directories.
It is a fast development loop and a cross-compiler check, not proof of
behavioural equivalence. Release and deployed bytecode, and the manifest's
code hashes, are always rebuilt with the pinned solc.

The compiler is pinned to solc 0.8.30 with `evm_version = "cancun"`,
optimizer 200 runs and no CBOR metadata, so runtime bytecode is reproducible
from source for the release manifest (SPEC section 7).
