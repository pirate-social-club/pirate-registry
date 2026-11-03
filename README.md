# pirate-registry

A permissionless Handshake SLD registry: anyone who controls a Handshake TLD
can deploy an immutable registry on Base, sell second-level names as ERC-721
tokens for USDC, and let anyone verify a name without PIRATE servers.

`docs/SPEC.md` is the normative baseline (revision 2, 2026-11-03, with D1 to
D3 adopted: Base, a price fixed per registration generation, and payment into
the registry with a separate permissionless `sweep()`). The reviewed draft and
its review history are in the staging root at
`handoffs/pirate-registry-v1-spec-2026-11-03/`.

## Status

This is an experiment under the workspace control plane's `experiments/`
directory. It is not yet a registered canonical repository and has no remote.
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
- `script/Deploy.s.sol`: `DeployFactory` (pinned native USDC on Base and Base
  Sepolia, a mock on local anvil) and `DeployRegistry`, which prints the
  `_evm` delegation record to publish on the TLD.

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
```

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
