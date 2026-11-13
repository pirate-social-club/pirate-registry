import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';
import { requireShared } from './shared-errors.ts';

export const SHARED_IDENTITY_DOMAINS = {
  namespace: keccak256(stringToHex('pirate.namespace/1')),
  name: keccak256(stringToHex('pirate.name/1')),
  token: keccak256(stringToHex('pirate.name-token/1')),
} as const;

export function requireCanonicalSharedLabel(label: string): void {
  requireShared(typeof label === 'string' && /^[a-z0-9-]{1,63}$/.test(label)
    && !label.startsWith('-') && !label.endsWith('-') && label.slice(2, 4) !== '--',
  'label_invalid', 'expected canonical lowercase ASCII LDH, without the position-3/4 hyphen pair');
}

export function requireSharedKey(key: string): asserts key is Hex {
  requireShared(/^0x[0-9a-f]{64}$/.test(key) && !/^0x0{64}$/.test(key), 'identity_invalid', 'expected canonical nonzero bytes32');
}

export function sharedNamespaceIdFor(tld: string): Hex {
  requireCanonicalSharedLabel(tld);
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }],
    [SHARED_IDENTITY_DOMAINS.namespace, keccak256(stringToHex(tld))]));
}

export function sharedNameKeyFor(namespaceId: Hex, label: string): Hex {
  requireSharedKey(namespaceId);
  requireCanonicalSharedLabel(label);
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [SHARED_IDENTITY_DOMAINS.name, namespaceId, keccak256(stringToHex(label))]));
}

export function sharedTokenIdFor(nameKey: Hex, generation: bigint): bigint {
  requireSharedKey(nameKey);
  requireShared(typeof generation === 'bigint' && generation > 0n && generation <= 0xffffffffffffffffn,
    'identity_invalid', 'generation must be a nonzero uint64');
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }],
    [SHARED_IDENTITY_DOMAINS.token, nameKey, generation])));
}
