import { encodeFunctionData, type Hex } from 'viem';
import { sharedRegistryAbi } from '../../resolver/src/shared-abi.ts';
import { requireShared } from '../../resolver/src/shared-errors.ts';
import { verifySharedRegistry, verifySharedSource, type SharedQuote, type SharedSourceOptions } from '../../resolver/src/shared-resolve.ts';
import { requireCanonicalSharedLabel, requireSharedKey, sharedNamespaceIdFor } from '../../resolver/src/shared-keys.ts';
import type { HandshakeSource } from '../../resolver/src/handshake.ts';

export type SharedNamingOptions = SharedSourceOptions & { handshake: HandshakeSource; tld: string };

export async function readSharedQuote(options: SharedNamingOptions, communityId: Hex, label: string) {
  requireSharedKey(communityId);
  requireCanonicalSharedLabel(label);
  const verified = await verifySharedRegistry(options.tld, options);
  const quote = await verified.reader.read(verified.source.registry, sharedRegistryAbi, 'quote',
    [verified.delegation.namespaceId, communityId, label]) as SharedQuote;
  await verified.finish();
  return { verified, quote };
}

/** Explicit paid renewal preparation. It never submits or approves tokens. */
export async function prepareSharedRenewal(options: SharedSourceOptions & { tld: string }, tokenId: bigint, years: number,
  maxCost: bigint, deadline: bigint) {
  requireShared(Number.isInteger(years) && years >= 1 && years <= 5, 'invalid_years', 'renewal years must be 1 through 5');
  const namespaceId = sharedNamespaceIdFor(options.tld);
  // Explicit original-source renewal survives external TLD repointing/lapse.
  const verified = await verifySharedSource(options);
  const { reader, source } = verified;
  const [namespace, status, price, expiry] = await Promise.all([
    reader.read(source.registry, sharedRegistryAbi, 'namespaceOf', [tokenId]),
    reader.read(source.registry, sharedRegistryAbi, 'status', [tokenId]),
    reader.read(source.registry, sharedRegistryAbi, 'lockedRenewalPrice', [tokenId]),
    reader.read(source.registry, sharedRegistryAbi, 'expiresAt', [tokenId]),
  ]);
  requireShared(namespace === namespaceId && (Number(status) === 1 || Number(status) === 2),
    'not_renewable', 'wrong namespace or expired generation');
  const cost = (price as bigint) * BigInt(years);
  const nextExpiry = (expiry as bigint) + BigInt(years) * 365n * 86400n;
  const now = BigInt(verified.checkTime());
  requireShared((expiry as bigint) + 30n * 86400n > now && nextExpiry <= reader.block.timestamp + 3650n * 86400n,
    'renewal_terms', 'renewal is released or exceeds the term ceiling');
  requireShared(maxCost >= cost && deadline >= now, 'renewal_terms', 'cost/deadline refuses renewal');
  await verified.finish();
  return { to: source.registry, data: encodeFunctionData({ abi: sharedRegistryAbi, functionName: 'renew',
    args: [tokenId, years, maxCost, deadline] }), cost, paymentToken: source.constructor.paymentToken,
  previousExpiry: expiry as bigint, sourceSha256: verified.sourceSha256, block: reader.block };
}
