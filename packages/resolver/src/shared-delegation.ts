import { getAddress, type Address } from 'viem';
import { parseDelegation } from './delegation.ts';
import type { HandshakeSource, TldLookup } from './handshake.ts';
import { sharedNamespaceIdFor } from './shared-keys.ts';
import type { SharedRegistrySource } from './shared-manifest.ts';
import { requireShared } from './shared-errors.ts';

export interface SharedDelegationProof {
  namespaceId: ReturnType<typeof sharedNamespaceIdFor>;
  registry: Address;
  observation: TldLookup;
  record: string;
}

export async function verifySharedDelegation(tld: string, handshake: HandshakeSource,
  source: SharedRegistrySource): Promise<SharedDelegationProof> {
  const namespaceId = sharedNamespaceIdFor(tld);
  const observation = await handshake.lookup(tld);
  if (observation.renewal) {
    requireShared(Number.isFinite(observation.renewal.blocksUntilExpire) && observation.renewal.blocksUntilExpire > 0,
      'authority_stale', 'Handshake TLD renewal deadline has passed');
  }
  const delegation = parseDelegation(observation.nsTargets);
  requireShared(delegation.chainId === BigInt(source.chainId), 'chain_mismatch', 'delegation names another chain');
  requireShared(getAddress(delegation.registry) === source.registry, 'source_mismatch', 'delegation names another registry');
  return { namespaceId, registry: source.registry, observation, record: delegation.record };
}
