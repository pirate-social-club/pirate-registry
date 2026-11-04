# Deployments

## MegaETH testnet (6343), release `megaeth-testnet-1`, 2026-11-04

Deployed with the CLI from the solc build of commit
`245c83c854cdbf393b3df8dc7a6a2262c513d5a8` (protocol version 2) by the
throwaway testnet operator `0x274f223809F00CBdD51d05De3aBC8fd3368fDE16`,
through `https://carrot.megaeth.com/rpc` with the RPC's own gas estimates.

| Item | Value |
|---|---|
| Payment token (PirateTestUSD, ptUSD, 6 decimals, no value) | `0xC5321666F425812D1C12F44dA7BFe08CEB00044B` |
| Token deploy transaction | `0x6921283c840aa8f68416477efdb819256aa0be3189f1e0cae4e2297db268ec0a` (block 34068238, 19,698,824 gas) |
| Factory | `0x702185797cD23E153fd0b83B672f969eA4aCfCc6` |
| Implementation | `0x1BFd3B5B227cfa1BD1E1bA8Acf2855B7fCDfDfdA` |
| Factory deploy transaction | `0x5fd59148d245f84f4d773dd711a5d2db4f372eba096df4cd799d153497de1971` (block 34068270, 172,421,064 gas) |
| Implementation code hash | `0x165fdfb3246f0ea9e4df8f1e9ce74f359ce907f20303dd65a5331539be186af0` |
| Factory code hash | `0x4bd9541c1194d770625f54d998407c0a9ae539a0d8d32ab998e2d4da0fbe17e8` |

Both deployments paid an effective gas price of 0.001 gwei, about 0.00002
and 0.00017 test ETH. MegaETH's storage gas charges 10,000 gas per byte of
deployed code, so deployment gas is far above Base's for the same bytecode
while the fee stays small.

`node scripts/verify-release.ts --rpc https://carrot.megaeth.com/rpc --factory
0x702185797cD23E153fd0b83B672f969eA4aCfCc6 --name megaeth-testnet
--write-manifest packages/resolver/manifest/manifest.json --block safe`
rebuilt commit 245c83c independently. At safe block 34068484
(`0x1bdb297b6c3d50e27c6d48f6db14e30d25a0af4b7f494e0483966a6d1591e415`) it
reported an exact implementation match and a factory match outside its two
immutable slots, which held the implementation and test-token addresses. It
wrote the manifest entry.

Registries deployed from this factory for rehearsal TLDs confer no authority
over any real Handshake TLD; only a TLD's `_evm` record does.

### Rehearsal on MegaETH testnet, 2026-11-04

`node harness/testnet-rehearsal.ts` ran against these contracts with a local
hsd regtest TLD `testtld` delegated to `0xb23c3510e6a30e470d67cbc6848c731f32ff42cd.6343._evm.`
and passed. The evidence is `docs/rehearsals/megaeth-testnet-2026-11-04.json`.

- The CLI deployed registry `0xB23c3510E6A30E470D67CBc6848C731f32ff42Cd`
  closed (block 34068664) and then opened it with `--min-length 8` at
  1 ptUSD a year.
- The operator set a premium price of 2 ptUSD for `ceo`, then reserved it for
  the buyer `0x39943fc46312b031A57B9c2C54013f44052DD497`. An independent
  review then found that order unsafe: between the two transactions anyone
  could have bought `ceo`. The harness now reserves first, and SPEC 6.2
  states the order.
- `verify-registry` verified the delegation, manifest `megaeth-testnet-1` and
  protocol version 2 at the `safe` tag.
- `check` reported the six-letter `studio` as not for sale.
- The buyer bought `studiohq` and the reserved premium `ceo` through the
  verified CLI. The delegation was verified before and after each purchase,
  in transactions `0x0cdb72b4e0c61d02e6244c7113caeae78bf2353a0c422328358c9d16455446f7`
  and `0xc61c30aeea5d2142f436cc724489431afc31156720aea2c8dc4c2a1f51a7634a`.
- After an A record was set, `studiohq.testtld` resolved through hnsd and the
  MegaETH RPC with the system clock at safe block 34069128, returning the
  buyer as holder and `192.0.2.10`.

Gas used, at 0.001 gwei:

| Transaction | Gas |
|---|---|
| Deploy registry (closed) | 893,413 |
| Open the 8+ band | 308,628 |
| Premium price for `ceo` | 146,008 |
| Reserve `ceo` | 127,724 |
| Register `studiohq` (approval separate) | 351,277 |
| Register reserved premium `ceo` | 312,786 |
| Set an A record | 133,857 |
| Mint test token | 127,175 |
| Plain transfer | 60,000 |

The `safe` tag trailed `latest` by 111 to 171 seconds and `finalized` by
1,817 to 1,885 seconds during the run.

### c22 ceremony on MegaETH testnet, 2026-11-04

Real Handshake authority, test registrations. The workspace_owner's
instruction was: "repoint c22's Handshake delegation to a MegaETH testnet
registry and run the c22 ceremony against it." The staging package is
`handoffs/pirate-registry-c22-megaeth-repoint-2026-11-04/`.

- c22 registry `0xe56E25eAf86FB8BF641754Fd7918735B98851744` was deployed
  from this factory in
  `0x2b5a8518cd7e8f0a3b856f83e6d62730b8c5fd627c338367457ef37c579b48f3`
  (block 34069840) with the 8+ band at 1 ptUSD.
- Bob wallet psc1 replaced c22's NS record
  `0x39e01249d867791f92acc70abfdcd97ee82884c9.84532._evm.` with
  `0xe56e25eaf86fb8bf641754fd7918735b98851744.6343._evm.` in Handshake
  transaction `f860ac4676d3a0c2107fc52755267064a069fd0a0dfce348e09713453aa2a024`
  (fee 0.0301 HNS). It was mined at height 354290 in block
  `000000000000000b588415110994796faae539b624dc40da249aa8a51aafb8a9` and
  committed to the name tree at 354312.
- The local mainnet hnsd first verified the delegation at height 354328
  (15:15 UTC), four blocks after the expected 354324. Two earlier attempts
  ran while hnsd was re-syncing after the watcher's cache-clearing restart.
  Two more, at hnsd heights 354324 and 354327, returned
  `handshake_unavailable`; their cause was not diagnosed.
- `harness/ceremony.ts` then passed from 15:15 to 15:24 UTC:
  - `studiohq.c22` was bought through the verified CLI in
    `0x5282b00a96cb2475e623aa596b25a205fe79dff8384a3c1839e863309c451a7a`,
    with the delegation verified again after confirmation.
  - The A record `192.0.2.22` and a TXT record were set and resolved through
    hnsd and the MegaETH RPC on the system clock.
  - The name was transferred to the operator in
    `0xb3ca7fb1279982dbcfe78953542db22cd442a9206d348f2676e1361890fec0d3`
    and resolved again with its records kept.

  The evidence is `docs/ceremonies/c22-2026-11-04-megaeth.json`. The c22
  delegation remains published as a test deployment.

## Base Sepolia (84532), release `base-sepolia-1`, 2026-11-03 (retired)

Retired by SPEC revision 3 on 2026-11-04: Base is no longer supported and the
bundled manifest no longer lists this release, so resolvers built from later
commits refuse these contracts. The record below is kept as history. On
2026-11-04 c22 was repointed from the Base Sepolia registry
`0x39E01249d867791F92acC70AbFdcD97Ee82884C9` to MegaETH testnet (above).

Deployed from the solc build of commit
`ba92e01460c83e840fbebe833678603c729116d0` by the throwaway testnet operator
`0x7C10aD766F955Bcd6c9ED9CF548D707bf55a33d2`.

| Item | Value |
|---|---|
| Factory | `0xCC6420FE45F6596784B84fFD2b39B0333ab3ea7C` |
| Implementation | `0x8D576F531f1718eEf42183e954cE4323cD82F8Ac` |
| Payment token (Circle USDC, 6 decimals) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Deploy transaction | `0x3c56bc895967fe8801ac9d2b5da89c229b4da4866463361913015dc1d9573b49` (block 53879417) |
| Implementation code hash | `0x081349664c5f921c937b5f798150b9121a713aca763d8f6886ea66c389088893` |
| Factory code hash | `0x7842d7dbde2d18ab4cdf3744376190a2e616558c2213c5dae9d42e38b7bcf703` |

`node scripts/verify-release.ts --rpc https://sepolia.base.org --factory
0xCC6420FE45F6596784B84fFD2b39B0333ab3ea7C --block safe` rebuilt the commit
independently and reported, at safe block 53880463
(`0x8f666685aad6c54b68a0671e1f3497de71abe58110e3b1edcbc459fd13a0b2b7`), an
exact implementation match and a factory match outside its two immutable
slots, which held the implementation and USDC addresses. The implementation
code hash equals the one from local anvil deployments of the same source.
These entries are in `packages/resolver/manifest/manifest.json`.

The deployment took about 3.5 minutes to reach the safe head.

Registries deployed from this factory for rehearsal TLDs confer no authority
over any real Handshake TLD; only a TLD's `_evm` record does.

### Rehearsal on Base Sepolia, 2026-11-03

`node harness/sepolia-rehearsal.ts` ran against these contracts with a local
hsd regtest TLD `testtld` standing in for a real Handshake TLD, which has not
been bought yet. It passed:

- Rehearsal registry `0x6C6e36d9621a07a912675f1e78b27a7321026FE1` for
  `testtld`, price 1 USDC, deployed in transaction
  `0x8cf9b2c5208f791660d6932baec3b8ef3cf7dec19e2e9d8da728b4dcfba74022`.
- `verify-registry` through hnsd (`local-spv`) and the public RPC
  (`remote-rpc`) at safe block 53881299, system clock, release
  `base-sepolia-1`.
- The buyer `0xd77193a3B794c70dC116b5F7Eeca0C59dEec9098` bought
  `studio.testtld` through the verified CLI in transaction
  `0x21b4c42b19977993322e4d6582ef1bca4cff0f50bdeb45da29cd59929d5b779b`;
  the delegation was verified before and after confirmation. The buyer's
  USDC fell from 20 to 19 and the registry holds 1.
- After setting an A record, `resolve` returned the buyer as holder and
  `192.0.2.10` at safe block 53882197, 30 seconds old by the system clock.

No safe-head staleness occurred during this run. The real ceremony with a
Handshake TLD followed on `c22`, below.

### Real Handshake ceremony on `c22`, 2026-11-03

Real Handshake authority, test registrations: the mainnet TLD `c22` is
delegated to a registry on Base Sepolia. Registrations and payments are
testnet only. Evidence is in `docs/ceremonies/c22-2026-11-03.json`, written
by `harness/ceremony.ts`, and `docs/ceremonies/c22-2026-11-03-supplement.json`.

Registry `0x39E01249d867791F92acC70AbFdcD97Ee82884C9` for `c22`, price 1
USDC, was deployed from the release `base-sepolia-1` factory in transaction
`0x3d4da5e11bf07d1c9295d5574fde03a4b25e3b8331e0e5cee3428383751061eb`. Its
admin and treasury are the testnet operator.

The Handshake update publishing the single NS record
`0x39e01249d867791f92acc70abfdcd97ee82884c9.84532._evm.` was transaction
`e158e4f4d0a524ef53772fd82f3ad35b595aaf70a17474016a399da53408032c`, mined in
block 354155 (`000000000000000a5982e38ddca4ba1de49073c3f6d433a73deb6c389d524e66`).
c22 previously published no records; the reversal is an UPDATE back to an
empty resource.

The two gates were evidenced separately. Inclusion was read from Bob's SPV
header chain and wallet. Independent verification came from a local mainnet
hnsd v2.0.0: `verify-registry` first succeeded at hnsd height 354180, as
expected, since hnsd uses the tree commitment at 354168 only once 12 blocks
sit on it. Every check from 354156 to 354178 returned `delegation_missing`.

The ceremony then ran from 13:26:50 to 13:30:46 UTC with hnsd at 354180, the
public RPC and the system clock:

- `verify-registry` passed at safe block 53951999.
- The buyer `0xd77193a3B794c70dC116b5F7Eeca0C59dEec9098` bought `studio.c22`
  for one year through the verified CLI (approve
  `0xe34e2e5d5bb12b2e83b63368fb36ab2fc99818c67f216c5623a230684b60feb6`,
  purchase
  `0x5a40369e34b9d02445917845474090355e00769f0e05f621d114c59692e4de07` in
  block 53952761). The delegation was verified before and after confirmation.
- An A record `192.0.2.22` and a TXT record were set, and `resolve` returned
  the buyer as holder with both records at safe block 53952865.
- The name was transferred to the operator
  `0x7C10aD766F955Bcd6c9ED9CF548D707bf55a33d2` in
  `0xeca58ad144f40b783992562a1593ff54203826092e461b089f84e798d929c069`, and
  `resolve` returned the operator as holder with the records kept at safe
  block 53953719.

At that safe block the registry held 1 USDC and the buyer 18, down from 19.
The `c22` delegation remains published as a test deployment.
