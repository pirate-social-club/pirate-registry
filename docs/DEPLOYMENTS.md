# Deployments

## MegaETH testnet (6343), release `megaeth-testnet-1`

Pending. SPEC revision 3 moves the registry to MegaETH testnet and adds sale
policy (protocol version 2). The order is `deploy-test-token`, pinning its
address in `script/Deploy.s.sol`, `deploy-factory` from the committed build,
`scripts/verify-release.ts --name megaeth-testnet --write-manifest`, then
`harness/testnet-rehearsal.ts`.

## Base Sepolia (84532), release `base-sepolia-1`, 2026-11-03 (retired)

Retired by SPEC revision 3 on 2026-11-04: Base is no longer supported and the
bundled manifest no longer lists this release, so resolvers built from later
commits refuse these contracts. The record below is kept as history. c22 on
Handshake mainnet still delegates to the Base Sepolia registry
`0x39E01249d867791F92acC70AbFdcD97Ee82884C9` until a separate Handshake
update repoints it.

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
