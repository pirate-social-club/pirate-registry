import { getAddress, hashTypedData, parseEventLogs, type ContractFunctionReturnType, type Hex } from 'viem';
import { sharedRegistryAbi } from '../../resolver/src/shared-abi.ts';
import { requireShared } from '../../resolver/src/shared-errors.ts';
import { verifySharedRegistry } from '../../resolver/src/shared-resolve.ts';
import { sharedClaimTypedData, type PreparedSharedClaim } from './shared-claims.ts';
import { sharedNameKeyFor, sharedTokenIdFor } from '../../resolver/src/shared-keys.ts';
import type { SharedNamingOptions } from './shared-names.ts';

/** Original operation only. This function never sends, retries or allocates an ID. */
export async function reconcileSharedClaim(options: SharedNamingOptions, operation: PreparedSharedClaim,
  authorizeRecovery: (operation: PreparedSharedClaim) => Promise<void>, expectedTransactionHash?: Hex) {
  await authorizeRecovery(operation);
  const verified = await verifySharedRegistry(options.tld, options);
  const { source, reader } = verified;
  const c = operation.claim;
  const nameKey = sharedNameKeyFor(c.namespaceId, c.label);
  requireShared(operation.requestHash === hashTypedData(sharedClaimTypedData(operation.chainId, operation.registry, c))
    && operation.expectedTokenId === sharedTokenIdFor(nameKey, c.generation),
  'digest_mismatch', 'stored original operation was changed');
  requireShared(operation.schema === 'pirate.member-name-claim/1' && operation.sourceSha256 === verified.sourceSha256
    && operation.chainId === source.chainId && getAddress(operation.registry) === source.registry
    && getAddress(operation.renewalToken) === source.constructor.paymentToken && c.namespaceId === verified.delegation.namespaceId,
  'source_mismatch', 'recovery source differs');
  const recorded = await reader.read(source.registry, sharedRegistryAbi, 'claimReceipt', [c.communityId, c.requestId]) as
    ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'claimReceipt'>;
  if (recorded.requestHash === `0x${'0'.repeat(64)}`) {
    await verified.finish();
    return { state: 'pending' as const, reason: 'no_canonical_claim_receipt', transactionHash: expectedTransactionHash };
  }
  requireShared(recorded.requestHash === operation.requestHash && recorded.tokenId === operation.expectedTokenId,
    'receipt_conflict', 'request ID was consumed by another operation');
  requireShared(recorded.blockNumber <= reader.block.number, 'receipt_unconfirmed', 'claim not yet confirmed');
  const claimBlock = await reader.client.getBlock({ blockNumber: recorded.blockNumber });
  requireShared(claimBlock.hash !== null, 'receipt_reorg', 'claim block missing');
  const logs = await reader.client.getLogs({ address: source.registry, blockHash: claimBlock.hash });
  const events = parseEventLogs({ abi: sharedRegistryAbi, eventName: 'FreeNameClaimed', logs, strict: true })
    .filter(event => event.args.communityId === c.communityId && event.args.requestId === c.requestId);
  requireShared(events.length === 1, 'receipt_ambiguous', 'expected exactly one original claim event');
  const event = events[0];
  const e = event.args;
  requireShared(e.namespaceId === c.namespaceId && e.requestHash === operation.requestHash
    && e.nameKey === nameKey && e.tokenId === operation.expectedTokenId && e.generation === c.generation && e.label === c.label
    && e.expiry === claimBlock.timestamp + 365n * 24n * 60n * 60n
    && getAddress(e.recipient) === getAddress(c.recipient) && e.annualRenewalPrice === operation.annualRenewalPrice,
  'receipt_mismatch', 'claim event differs from original operation');
  requireShared(event.transactionHash !== null && (!expectedTransactionHash || event.transactionHash === expectedTransactionHash),
    'receipt_mismatch', 'unexpected transaction');
  const receipt = await reader.client.getTransactionReceipt({ hash: event.transactionHash });
  requireShared(receipt.status === 'success' && receipt.to !== null && getAddress(receipt.to) === source.registry
    && receipt.blockHash === claimBlock.hash && receipt.blockNumber === recorded.blockNumber,
  'receipt_reorg', 'claim transaction is not canonical and successful');
  const [current, holder, expiry] = await Promise.all([
    reader.read(source.registry, sharedRegistryAbi, 'currentToken', [c.namespaceId, c.label]),
    reader.read(source.registry, sharedRegistryAbi, 'effectiveOwner', [recorded.tokenId]),
    reader.read(source.registry, sharedRegistryAbi, 'expiresAt', [recorded.tokenId]),
  ]);
  const [tokenId, generation, status] = current as ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'currentToken'>;
  requireShared(tokenId === recorded.tokenId && generation === c.generation && status === 1
    && getAddress(holder as string) === getAddress(c.recipient) && (expiry as bigint) >= e.expiry,
  'receipt_state_changed', 'name generation, recipient or term changed');
  const canonical = await reader.client.getBlock({ blockNumber: recorded.blockNumber });
  requireShared(canonical.hash === claimBlock.hash, 'receipt_reorg', 'claim block changed during recovery');
  await verified.finish();
  requireShared((expiry as bigint) > BigInt(verified.checkTime()), 'not_active', 'claim expired during recovery');
  return { state: 'confirmed' as const, transactionHash: receipt.transactionHash, requestHash: recorded.requestHash,
    tokenId, generation, recipient: getAddress(c.recipient), expiry: expiry as bigint,
    claimBlock: { number: recorded.blockNumber, hash: claimBlock.hash }, observedBlock: reader.block,
    sourceSha256: verified.sourceSha256 };
}
