import { getAddress, type Address } from 'viem';
import { ResolveError } from './errors.ts';

export interface Delegation {
  registry: Address;
  chainId: bigint;
  record: string;
}

const PROTOCOL = /(^|\.)_evm\.?$/i;
const RECORD = /^0x([0-9a-f]{40})\.([1-9][0-9]{0,19})\._evm\.?$/i;

/**
 * SPEC section 5: a TLD is delegated by exactly one NS target of the form
 * `<address>.<chainId>._evm.`. No `_evm` target means not delegated; more
 * than one is ambiguous; a malformed one fails rather than being skipped.
 */
export function parseDelegation(nsTargets: string[]): Delegation {
  const candidates = nsTargets.filter((t) => PROTOCOL.test(t));
  if (candidates.length === 0) throw new ResolveError('delegation_missing', 'TLD has no _evm NS record');
  if (candidates.length > 1) {
    throw new ResolveError('delegation_ambiguous', `TLD has ${candidates.length} _evm NS records`, candidates);
  }
  const record = candidates[0];
  const match = RECORD.exec(record);
  if (!match) throw new ResolveError('delegation_malformed', `cannot parse _evm record ${record}`);
  return { registry: getAddress(`0x${match[1].toLowerCase()}`), chainId: BigInt(match[2]), record };
}

export function formatDelegation(registry: Address, chainId: bigint | number): string {
  return `${registry.toLowerCase()}.${chainId.toString()}._evm.`;
}
