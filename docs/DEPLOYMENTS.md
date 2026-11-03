# Deployments

## Base Sepolia (84532), release `base-sepolia-1`, 2026-11-03

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

No safe-head staleness occurred during this run. The real ceremony still
needs a fresh Handshake TLD published from Bob.
