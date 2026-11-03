import { getAddress, hexToBytes, keccak256, type Address, type Hex } from 'viem';
import { factoryAbi, registryAbi } from './abi.ts';
import { parseDelegation, type Delegation } from './delegation.ts';
import {
  addrKey,
  decodeRdata,
  decodeRRset,
  dnsKey,
  DNS_TYPES,
  isValidLabel,
  RRTYPE,
  textKey,
  type DnsType,
} from './encoding.ts';
import { ResolveError } from './errors.ts';
import type { HandshakeSource, TldLookup } from './handshake.ts';
import { expectedCloneRuntime, type ReleaseManifest } from './manifest.ts';
import { PinnedReader, type BlockTag } from './evm.ts';
import { isLoopback } from './handshake.ts';

export const STATUS = ['Unknown', 'Active', 'Grace', 'Released', 'Superseded'] as const;
export type Status = (typeof STATUS)[number];

const DEFAULT_MAX_AGE: Record<BlockTag, number> = { safe: 15 * 60, finalized: 90 * 60 };
const MAX_CLOCK_AHEAD = 60;

export interface ResolveOptions {
  /** `label.tld`, or a deeper name such as `www.label.tld` for its records. */
  name: string;
  handshake: HandshakeSource;
  /** RPC URL per allowed chain ID. Chains without an entry are not allowed. */
  rpcUrls: Record<string, string>;
  manifest: ReleaseManifest;
  blockTag?: BlockTag;
  maxAgeSeconds?: number;
  /** Host clock in seconds. Override only for test networks; reported in output. */
  now?: number;
  dnsTypes?: DnsType[];
  textKeys?: string[];
  coinTypes?: bigint[];
}

export interface VerifiedRegistry {
  delegation: Delegation;
  handshake: Omit<TldLookup, 'nsTargets'>;
  reader: PinnedReader;
  manifestRelease: string;
  factory: Address;
  protocolVersion: number;
  hostTime: number;
  clock: 'system' | 'override';
  evmTrust: 'local-rpc' | 'remote-rpc';
}

export interface ResolveResult {
  name: string;
  usable: true;
  observedAt: {
    chainId: string;
    blockTag: BlockTag;
    blockNumber: string;
    blockHash: Hex;
    blockTimestamp: number;
    hostTime: number;
    clock: 'system' | 'override';
  };
  handshake: { source: string; trust: string; height?: number; tldRenewal?: TldLookup['renewal']; record: string };
  evm: { rpc: string; trust: 'local-rpc' | 'remote-rpc' };
  registry: { address: Address; factory: Address; manifestRelease: string; protocolVersion: number };
  token: { label: string; tokenId: string; generation: string; holder: Address; expiry: number };
  records: {
    dns: Partial<Record<DnsType, { ttl: number; values: Array<string | string[]> }>>;
    text: Record<string, string>;
    addr: Record<string, Address>;
  };
}

function splitName(name: string): { tld: string; label: string; relativeName: string } {
  const labels = name.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) throw new ResolveError('label_invalid', `${name} needs at least a label and a TLD`);
  const tld = labels[labels.length - 1];
  const label = labels[labels.length - 2];
  if (!isValidLabel(tld) || !isValidLabel(label)) throw new ResolveError('label_invalid', `${name} is not lowercase LDH`);
  return { tld, label, relativeName: labels.slice(0, -2).join('.') };
}

/**
 * Steps 1 to 6 of SPEC section 8: read the TLD's delegation, select and check
 * the block, and verify the registry against the manifest at that block.
 */
export async function verifyRegistry(
  tld: string,
  options: Omit<ResolveOptions, 'name' | 'dnsTypes' | 'textKeys' | 'coinTypes'>,
): Promise<VerifiedRegistry> {
  const lookup = await options.handshake.lookup(tld);
  const delegation = parseDelegation(lookup.nsTargets);
  const chainKey = delegation.chainId.toString();
  const chain = options.manifest.chains[chainKey];
  const rpcUrl = options.rpcUrls[chainKey];
  if (!chain || !rpcUrl) {
    throw new ResolveError('chain_not_allowed', `chain ${chainKey} is not in the manifest or has no allowed RPC`);
  }

  const tag = options.blockTag ?? 'safe';
  const reader = await PinnedReader.open(rpcUrl, tag, delegation.chainId);
  const clock = options.now === undefined ? 'system' : 'override';
  const hostTime = options.now ?? Math.floor(Date.now() / 1000);
  const blockTime = Number(reader.block.timestamp);
  if (blockTime - hostTime > MAX_CLOCK_AHEAD) {
    throw new ResolveError('clock_skew', `block ${reader.block.number} is ${blockTime - hostTime}s ahead of the host clock`);
  }
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE[tag];
  if (hostTime - blockTime > maxAge) {
    throw new ResolveError('stale_state', `${tag} block ${reader.block.number} is ${hostTime - blockTime}s old (limit ${maxAge}s)`);
  }

  const [registryCode, implementationCode, factoryCode] = await Promise.all([
    reader.getCode(delegation.registry),
    reader.getCode(chain.implementation),
    reader.getCode(chain.factory),
  ]);
  if (registryCode.toLowerCase() !== expectedCloneRuntime(chain.implementation)) {
    throw new ResolveError('code_mismatch', `${delegation.registry} is not a clone of the manifest implementation`);
  }
  if (keccak256(implementationCode) !== chain.implementationCodeHash.toLowerCase()) {
    throw new ResolveError('code_mismatch', 'implementation runtime code hash differs from the manifest');
  }
  if (keccak256(factoryCode) !== chain.factoryCodeHash.toLowerCase()) {
    throw new ResolveError('code_mismatch', 'factory runtime code hash differs from the manifest');
  }

  const [isRegistry, factory, paymentToken, registryTld, protocolVersion] = (await Promise.all([
    reader.read(chain.factory, factoryAbi, 'isRegistry', [delegation.registry]),
    reader.read(delegation.registry, registryAbi, 'factory'),
    reader.read(delegation.registry, registryAbi, 'paymentToken'),
    reader.read(delegation.registry, registryAbi, 'tld'),
    reader.read(delegation.registry, registryAbi, 'PROTOCOL_VERSION'),
  ])) as [boolean, Address, Address, string, number];
  if (!isRegistry || getAddress(factory) !== chain.factory) {
    throw new ResolveError('config_mismatch', 'registry was not deployed by the manifest factory');
  }
  if (getAddress(paymentToken) !== chain.paymentToken) {
    throw new ResolveError('config_mismatch', `registry payment token ${paymentToken} differs from the manifest`);
  }
  if (Number(protocolVersion) !== options.manifest.protocolVersion) {
    throw new ResolveError('config_mismatch', `protocol version ${protocolVersion} differs from the manifest`);
  }
  if (registryTld !== tld) {
    throw new ResolveError('tld_mismatch', `registry serves .${registryTld}, not .${tld}`);
  }

  const { nsTargets: _ignored, ...handshake } = lookup;
  return {
    delegation,
    handshake,
    reader,
    manifestRelease: options.manifest.release,
    factory: chain.factory,
    protocolVersion: Number(protocolVersion),
    hostTime,
    clock,
    evmTrust: isLoopback(new URL(rpcUrl).hostname) ? 'local-rpc' : 'remote-rpc',
  };
}

/** SPEC section 8, all steps: an answer usable now, with its provenance. */
export async function resolveName(options: ResolveOptions): Promise<ResolveResult> {
  const { tld, label, relativeName } = splitName(options.name);
  const verified = await verifyRegistry(tld, options);
  const { reader, delegation, hostTime } = verified;
  const registry = delegation.registry;

  const [tokenId, generation, statusIndex] = (await reader.read(registry, registryAbi, 'currentToken', [label])) as [
    bigint,
    bigint,
    number,
  ];
  const status = STATUS[Number(statusIndex)];
  if (status === 'Unknown') throw new ResolveError('not_registered', `${label}.${tld} has never been registered`);
  if (status !== 'Active') throw new ResolveError('not_active', `${label}.${tld} is ${status} at block ${reader.block.number}`);

  const [expiry, holder] = (await Promise.all([
    reader.read(registry, registryAbi, 'expiresAt', [tokenId]),
    reader.read(registry, registryAbi, 'effectiveOwner', [tokenId]),
  ])) as [bigint, Address];
  const expirySeconds = Number(expiry);
  if (expirySeconds <= hostTime) {
    throw new ResolveError('not_active', `${label}.${tld} expired at ${expirySeconds}, after the selected block`);
  }
  const remaining = expirySeconds - hostTime;

  const readRecord = async (key: Hex) => (await reader.read(registry, registryAbi, 'record', [tokenId, key])) as Hex;

  const dns: ResolveResult['records']['dns'] = {};
  for (const type of options.dnsTypes ?? DNS_TYPES) {
    const value = await readRecord(dnsKey(relativeName, RRTYPE[type]));
    if (value === '0x') continue;
    const set = decodeRRset(value);
    dns[type] = { ttl: Math.min(set.ttl, remaining), values: set.rdatas.map((r) => decodeRdata(type, r)) };
  }
  if (dns.CNAME && Object.keys(dns).length > 1) {
    throw new ResolveError('record_malformed', 'CNAME coexists with other types at the same name');
  }

  const text: Record<string, string> = {};
  for (const key of options.textKeys ?? []) {
    const value = await readRecord(textKey(key));
    if (value === '0x') continue;
    try {
      text[key] = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(value));
    } catch {
      throw new ResolveError('record_malformed', `text record ${key} is not UTF-8`);
    }
  }

  const addr: Record<string, Address> = {};
  for (const coinType of options.coinTypes ?? [60n]) {
    const value = await readRecord(addrKey(coinType));
    if (value === '0x') continue;
    const isEvm = coinType === 60n || (coinType & 0x80000000n) !== 0n;
    if (!isEvm || hexToBytes(value).length !== 20) {
      throw new ResolveError('record_malformed', `address record for coin type ${coinType} is not a 20-byte EVM address`);
    }
    addr[coinType.toString()] = getAddress(value);
  }

  return {
    name: options.name.toLowerCase().replace(/\.$/, ''),
    usable: true,
    observedAt: {
      chainId: delegation.chainId.toString(),
      blockTag: reader.block.tag,
      blockNumber: reader.block.number.toString(),
      blockHash: reader.block.hash,
      blockTimestamp: Number(reader.block.timestamp),
      hostTime,
      clock: verified.clock,
    },
    handshake: { ...verified.handshake, tldRenewal: verified.handshake.renewal, record: delegation.record },
    evm: { rpc: reader.rpcUrl, trust: verified.evmTrust },
    registry: {
      address: registry,
      factory: verified.factory,
      manifestRelease: verified.manifestRelease,
      protocolVersion: verified.protocolVersion,
    },
    token: { label, tokenId: tokenId.toString(), generation: generation.toString(), holder, expiry: expirySeconds },
    records: { dns, text, addr },
  };
}
