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
