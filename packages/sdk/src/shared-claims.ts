import { encodeFunctionData, getAbiItem, getAddress, hashTypedData, keccak256, parseTransaction,
  recoverTransactionAddress, type Address, type ContractFunctionArgs, type Hex } from 'viem';
import { sharedRegistryAbi } from '../../resolver/src/shared-abi.ts';
import { requireShared } from '../../resolver/src/shared-errors.ts';
import { requireSharedKey, sharedNameKeyFor, sharedTokenIdFor } from '../../resolver/src/shared-keys.ts';
import { readSharedQuote, type SharedNamingOptions } from './shared-names.ts';

export type SharedFreeClaim = ContractFunctionArgs<typeof sharedRegistryAbi, 'nonpayable', 'claimFreeName'>[0];
export interface PreparedSharedClaim {
  schema: 'pirate.member-name-claim/1';
  sourceSha256: string;
  chainId: number;
  registry: Address;
  claim: SharedFreeClaim;
  requestHash: Hex;
  expectedTokenId: bigint;
  renewalToken: Address;
  annualRenewalPrice: bigint;
  quoteBlock: { number: bigint; hash: Hex; timestamp: bigint };
}

export function sharedClaimTypedData(chainId: number, registry: Address, claim: SharedFreeClaim) {
  // Derive the fields from the compiler output, not a second handwritten tuple.
  const item = getAbiItem({ abi: sharedRegistryAbi, name: 'claimFreeName' });
  const fields = item.inputs[0].components.map(field => ({ name: field.name, type: field.type }));
  return { domain: { name: 'PirateSharedNames', version: '3', chainId, verifyingContract: registry },
    primaryType: 'FreeClaim' as const, types: { FreeClaim: fields }, message: claim };
}

export function sharedAcceptanceTypedData(chainId: number, registry: Address, requestHash: Hex) {
  return { domain: { name: 'PirateSharedNames', version: '3', chainId, verifyingContract: registry },
    primaryType: 'ClaimAcceptance' as const,
    types: { ClaimAcceptance: [{ name: 'requestHash', type: 'bytes32' }] }, message: { requestHash } };
}

/** Application must allocate/persist requestId and verify membership before this call. */
export async function prepareSharedClaim(options: SharedNamingOptions, input: {
  communityId: Hex; requestId: Hex; label: string; recipient: Address;
}): Promise<PreparedSharedClaim> {
  requireSharedKey(input.communityId);
  requireSharedKey(input.requestId);
  const recipient = getAddress(input.recipient);
  requireShared(recipient !== '0x0000000000000000000000000000000000000000', 'recipient_invalid', 'zero recipient');
  const { verified, quote } = await readSharedQuote(options, input.communityId, input.label);
  requireShared(quote.issuanceEnabled && quote.initialPrice === 0n && input.label.length >= 8,
    'not_free', 'free issuance is unavailable under the current policy');
  requireShared(quote.reservedFor === '0x0000000000000000000000000000000000000000'
    || getAddress(quote.reservedFor) === recipient, 'reserved', 'label is reserved for another recipient');
  // Signing against wall time would make simulation at a lagging safe block
  // fail as a future-issued grant. Anchor lifetime to the quoted block instead.
  const issuedAt = verified.reader.block.timestamp;
  const deadline = issuedAt + 600n < verified.authority.validUntil ? issuedAt + 600n : verified.authority.validUntil - 1n;
  requireShared(deadline > BigInt(verified.checkTime()), 'authority_stale', 'insufficient quote/authority lifetime');
  const claim: SharedFreeClaim = { ...input, recipient, namespaceId: verified.delegation.namespaceId,
    generation: quote.generation, authorityRevision: quote.authorityRevision, policyRevision: quote.policyRevision,
    scopeRevision: quote.scopeRevision, issuedAt, deadline, years_: 1, maxCost: 0n };
  const requestHash = hashTypedData(sharedClaimTypedData(verified.source.chainId, verified.source.registry, claim));
  const actual = await verified.reader.read(verified.source.registry, sharedRegistryAbi, 'requestHash', [claim]);
  requireShared(actual === requestHash, 'digest_mismatch', 'contract and SDK request digests differ');
  await verified.finish();
  return { schema: 'pirate.member-name-claim/1', sourceSha256: verified.sourceSha256,
    chainId: verified.source.chainId, registry: verified.source.registry, claim, requestHash,
    expectedTokenId: sharedTokenIdFor(sharedNameKeyFor(claim.namespaceId, claim.label), claim.generation),
    renewalToken: getAddress(quote.renewalToken), annualRenewalPrice: quote.annualRenewalPrice,
    quoteBlock: verified.reader.block };
}

export interface SharedClaimTransaction {
  chainId: number; to: Address; data: Hex; value: 0n; nonce: number; gas: bigint;
  maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; type: 'eip1559';
}

/**
 * The caller must hold an exclusive durable operation lease and recheck current
 * membership/authorization. Persist the exact signed bytes before broadcasting.
 * Recovery uses those bytes/hash; it never calls this function for a new nonce.
 */
export async function submitSharedClaim(options: SharedNamingOptions, operation: PreparedSharedClaim, controls: {
  grantSignature: Hex; recipientSignature: Hex; submitter: Address; nonce: number;
  gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; maxGasCost: bigint;
  authorizeOriginalOperation: (operation: PreparedSharedClaim) => Promise<void>;
  signTransaction: (transaction: SharedClaimTransaction) => Promise<Hex>;
  persistSignedTransaction: (operation: PreparedSharedClaim, raw: Hex, hash: Hex) => Promise<void>;
}) {
  const { verified, quote } = await readSharedQuote(options, operation.claim.communityId, operation.claim.label);
  const c = operation.claim;
  requireShared(operation.schema === 'pirate.member-name-claim/1' && operation.sourceSha256 === verified.sourceSha256
    && operation.chainId === verified.source.chainId && getAddress(operation.registry) === verified.source.registry,
  'source_mismatch', 'operation belongs to another source');
  requireShared(c.namespaceId === verified.delegation.namespaceId && c.years_ === 1 && c.maxCost === 0n
    && quote.issuanceEnabled && quote.initialPrice === 0n && quote.generation === c.generation
    && quote.authorityRevision === c.authorityRevision && quote.policyRevision === c.policyRevision
    && quote.scopeRevision === c.scopeRevision && quote.annualRenewalPrice === operation.annualRenewalPrice
    && getAddress(quote.renewalToken) === operation.renewalToken
    && c.deadline >= BigInt(verified.checkTime()), 'quote_changed', 'original grant no longer matches current state');
  requireShared(operation.requestHash === hashTypedData(sharedClaimTypedData(operation.chainId, operation.registry, c)),
    'digest_mismatch', 'stored claim was changed');
  requireShared(operation.expectedTokenId === sharedTokenIdFor(sharedNameKeyFor(c.namespaceId, c.label), c.generation),
    'identity_mismatch', 'stored token identity was changed');
  requireShared(Number.isSafeInteger(controls.nonce) && controls.nonce >= 0 && controls.gas > 0n
    && controls.maxFeePerGas > 0n && controls.maxPriorityFeePerGas >= 0n
    && controls.maxPriorityFeePerGas <= controls.maxFeePerGas
    && controls.gas * controls.maxFeePerGas <= controls.maxGasCost, 'gas_limit', 'explicit gas budget exceeded');
  await controls.authorizeOriginalOperation(operation);
  const data = encodeFunctionData({ abi: sharedRegistryAbi, functionName: 'claimFreeName',
    args: [c, controls.grantSignature, controls.recipientSignature] });
  await verified.reader.client.request({ method: 'eth_call', params: [{ from: controls.submitter,
    to: operation.registry, data }, { blockHash: verified.reader.block.hash, requireCanonical: true }] } as never);
  await verified.finish();
  const transaction: SharedClaimTransaction = { chainId: operation.chainId, to: operation.registry, data,
    value: 0n, nonce: controls.nonce, gas: controls.gas, maxFeePerGas: controls.maxFeePerGas,
    maxPriorityFeePerGas: controls.maxPriorityFeePerGas, type: 'eip1559' };
  const raw = await controls.signTransaction(transaction);
  const parsed = parseTransaction(raw);
  requireShared(await recoverTransactionAddress({ serializedTransaction: raw }) === getAddress(controls.submitter)
    && parsed.chainId === transaction.chainId && parsed.to && getAddress(parsed.to) === transaction.to
    && parsed.data === transaction.data && (parsed.value ?? 0n) === 0n && parsed.nonce === transaction.nonce
    && parsed.gas === transaction.gas && parsed.maxFeePerGas === transaction.maxFeePerGas
    && parsed.maxPriorityFeePerGas === transaction.maxPriorityFeePerGas && parsed.type === 'eip1559',
  'transaction_mismatch', 'signer returned a different transaction');
  const transactionHash = keccak256(raw);
  await controls.persistSignedTransaction(operation, raw, transactionHash);
  // Signing/storage can take time. Recheck authorization and the bounded
  // lifetime before sending the already persisted original bytes.
  await controls.authorizeOriginalOperation(operation);
  await verified.finish();
  requireShared(c.deadline >= BigInt(verified.checkTime()), 'grant_expired', 'grant expired before broadcast');
  try {
    const returned = await verified.reader.client.sendRawTransaction({ serializedTransaction: raw });
    requireShared(returned === transactionHash, 'transaction_mismatch', 'provider returned another hash');
    return { state: 'pending' as const, transactionHash, broadcast: 'acknowledged' as const };
  } catch (error) {
    return { state: 'pending' as const, transactionHash, broadcast: 'unknown' as const,
      detail: error instanceof Error ? error.message : String(error) };
  }
}
