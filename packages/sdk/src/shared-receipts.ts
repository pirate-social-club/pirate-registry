import { getAddress, hashTypedData, parseEventLogs, type ContractFunctionReturnType, type Hex } from 'viem';
import { sharedRegistryAbi } from '../../resolver/src/shared-abi.ts';
import { requireShared } from '../../resolver/src/shared-errors.ts';
import { verifySharedSource, SHARED_STATUS } from '../../resolver/src/shared-resolve.ts';
import { sharedClaimTypedData, type PreparedSharedClaim } from './shared-claims.ts';
import { sharedNamespaceIdFor, sharedNameKeyFor, sharedTokenIdFor } from '../../resolver/src/shared-keys.ts';
import type { SharedNamingOptions } from './shared-names.ts';

/** Original operation only. Errors NEVER mean unused; this function never sends or allocates an ID. */
export async function reconcileSharedClaim(options: SharedNamingOptions, operation: PreparedSharedClaim,
  authorizeRecovery: (operation: PreparedSharedClaim) => Promise<void>, expectedTransactionHash?: Hex) {
  await authorizeRecovery(operation);
  requireShared(operation.schema === 'pirate.member-name-claim/3',
    'operation_version', 'unsupported prepared claim envelope; retain it for matching-version recovery');
  // Historical consumption survives loss of external delegation/issuance authority.
  const verified = await verifySharedSource(options);
  const { source, reader } = verified;
  const c = operation.claim;
  const nameKey = sharedNameKeyFor(c.namespaceId, c.label);
  requireShared(operation.requestHash === hashTypedData(sharedClaimTypedData(operation.chainId, operation.registry, c))
    && operation.expectedTokenId === sharedTokenIdFor(nameKey, c.generation),
  'digest_mismatch', 'stored original operation was changed');
  requireShared(operation.sourceSha256 === verified.sourceSha256
    && operation.chainId === source.chainId && getAddress(operation.registry) === source.registry
    && getAddress(operation.renewalToken) === source.constructor.paymentToken && c.namespaceId === sharedNamespaceIdFor(options.tld),
  'source_mismatch', 'recovery source differs');
  const recorded = await reader.read(source.registry, sharedRegistryAbi, 'claimReceipt', [c.communityId, c.requestId]) as
    ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'claimReceipt'>;
  const provenance = { observedBlock: reader.block, sourceSha256: verified.sourceSha256,
    registry: source.registry, chainId: source.chainId, requestHash: operation.requestHash };
  if (recorded.requestHash === `0x${'0'.repeat(64)}`) {
    await verified.finish();
    return { ...provenance, state: reader.block.timestamp > c.deadline ? 'expired-unconsumed' as const : 'pending' as const,
      reason: 'no_canonical_claim_receipt', expectedTransactionHash, automaticReissueAllowed: false as const };
  }
  requireShared(recorded.requestHash === operation.requestHash && recorded.tokenId === operation.expectedTokenId,
    'receipt_conflict', 'request ID was consumed by another operation');
  requireShared(recorded.blockNumber <= reader.block.number, 'receipt_unconfirmed', 'claim not yet confirmed');
  requireShared(await reader.read(source.registry, sharedRegistryAbi, 'namespaceOf', [recorded.tokenId]) === c.namespaceId,
    'receipt_mismatch', 'original token namespace differs');
  const claimBlock = await reader.client.getBlock({ blockNumber: recorded.blockNumber });
  requireShared(claimBlock.hash !== null, 'receipt_reorg', 'claim block missing');
  const logs = await reader.client.getLogs({ address: source.registry, blockHash: claimBlock.hash });
  const events = parseEventLogs({ abi: sharedRegistryAbi, eventName: 'FreeNameClaimed', logs, strict: true })
    .filter(event => event.args.communityId === c.communityId && event.args.requestId === c.requestId);
  requireShared(events.length === 1, 'receipt_ambiguous', 'expected exactly one original claim event');
  const event = events[0];
  const e = event.args;
  requireShared(!event.removed && event.blockHash === claimBlock.hash && event.blockNumber === recorded.blockNumber,
    'receipt_reorg', 'claim event is not in the canonical claim block');
  requireShared(getAddress(event.address) === source.registry && !event.removed
    && event.blockHash === claimBlock.hash && event.blockNumber === recorded.blockNumber
    && e.namespaceId === c.namespaceId && e.requestHash === operation.requestHash
    && e.nameKey === nameKey && e.tokenId === operation.expectedTokenId && e.generation === c.generation && e.label === c.label
    && e.expiry === claimBlock.timestamp + 365n * 24n * 60n * 60n
    && getAddress(e.recipient) === getAddress(c.recipient) && e.annualRenewalPrice === operation.annualRenewalPrice,
  'receipt_mismatch', 'claim event differs from original operation');
  requireShared(event.transactionHash !== null, 'receipt_mismatch', 'missing claim transaction');
  const receipt = await reader.client.getTransactionReceipt({ hash: event.transactionHash });
  requireShared(receipt.status === 'success' && receipt.transactionHash === event.transactionHash
    && receipt.blockHash === claimBlock.hash && receipt.blockNumber === recorded.blockNumber,
  'receipt_reorg', 'claim transaction is not canonical and successful');
  // A contract submitter is legitimate: receipt.to is not the event emitter.
  const matching = receipt.logs.filter(log => getAddress(log.address) === source.registry
    && log.transactionHash === event.transactionHash && log.blockHash === claimBlock.hash
    && log.blockNumber === recorded.blockNumber && log.logIndex === event.logIndex
    && !log.removed && log.data === event.data && log.topics.length === event.topics.length
    && log.topics.every((topic, i) => topic === event.topics[i]));
  requireShared(matching.length === 1, 'receipt_mismatch', 'claim event is absent from successful receipt');
  type Current = { state: 'observed'; tokenId: bigint; generation: bigint; status: number; registrant: string;
    expiry: bigint; currentTokenId: bigint; currentGeneration: bigint; currentNameStatus: number }
    | { state: 'unavailable'; detail: string };
  let current: Current;
  try {
    const [name, holder, expiry, status] = await Promise.all([
      reader.read(source.registry, sharedRegistryAbi, 'currentToken', [c.namespaceId, c.label]),
      reader.read(source.registry, sharedRegistryAbi, 'registrant', [recorded.tokenId]),
      reader.read(source.registry, sharedRegistryAbi, 'expiresAt', [recorded.tokenId]),
      reader.read(source.registry, sharedRegistryAbi, 'status', [recorded.tokenId]),
    ]);
    const [currentTokenId, currentGeneration, currentNameStatus] = name as
      ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'currentToken'>;
    requireShared(Number.isInteger(status) && Number(status) >= 0 && Number(status) < SHARED_STATUS.length
      && Number.isInteger(currentNameStatus) && currentNameStatus >= 0 && currentNameStatus < SHARED_STATUS.length
      && currentTokenId === sharedTokenIdFor(nameKey, currentGeneration),
    'status_invalid', 'invalid current name state');
    current = { state: 'observed', tokenId: recorded.tokenId, generation: c.generation, status: Number(status),
      registrant: getAddress(holder as string), expiry: expiry as bigint,
      currentTokenId, currentGeneration, currentNameStatus };
  } catch (error) {
    current = { state: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  const canonical = await reader.client.getBlock({ blockNumber: recorded.blockNumber });
  requireShared(canonical.hash === claimBlock.hash, 'receipt_reorg', 'claim block changed during recovery');
  await verified.finish();
  return { ...provenance, state: 'consumed' as const, transactionHash: receipt.transactionHash,
    expectedTransactionHash, transactionHashChanged: expectedTransactionHash !== undefined
      && expectedTransactionHash !== receipt.transactionHash,
    original: { tokenId: recorded.tokenId, generation: c.generation, recipient: getAddress(c.recipient),
      expiry: e.expiry, annualRenewalPrice: e.annualRenewalPrice, renewalToken: operation.renewalToken },
    current, resolutionEligibility: 'not-checked' as const, automaticReissueAllowed: false as const,
    claimBlock: { number: recorded.blockNumber, hash: claimBlock.hash } };
}
