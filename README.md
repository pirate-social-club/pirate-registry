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
- `script/Deploy.s.sol`: `DeployFactory` (pinned native USDC on Base and Base
  Sepolia, a mock on local anvil) and `DeployRegistry`, which prints the
  `_evm` delegation record to publish on the TLD.

## Local tests

Requires Foundry (`foundryup`). From this directory:

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
