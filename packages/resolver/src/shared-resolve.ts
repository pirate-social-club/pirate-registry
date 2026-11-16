import { createHash } from 'node:crypto';
import { getAddress, hexToBytes, keccak256, type ContractFunctionReturnType, type Hex } from 'viem';
import { sharedRegistryAbi, sharedRegistryAbiSha256 } from './shared-abi.ts';
import { PinnedReader, type BlockTag } from './evm.ts';
import { addrKey, decodeRdata, decodeRRset, dnsKey, DNS_TYPES, RRTYPE, textKey, type DnsType } from './encoding.ts';
import { isLoopback, type HandshakeSource } from './handshake.ts';
import { verifySharedDelegation } from './shared-delegation.ts';
import { requireCanonicalSharedLabel, sharedNameKeyFor, sharedTokenIdFor } from './shared-keys.ts';
import { parseSharedRegistrySource, type SharedRegistrySource } from './shared-manifest.ts';
import { requireShared } from './shared-errors.ts';

export type SharedAuthority = ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'authority'>;
export type SharedQuote = ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'quote'>;
export const SHARED_STATUS = ['Unknown', 'Active', 'Grace', 'Released', 'Superseded'] as const;

export interface SharedSourceOptions {
  source: SharedRegistrySource;
  /** Independently selected release pin, not learned from an untrusted response. */
  expectedSourceSha256: string;
  rpcUrl: string;
  blockTag?: BlockTag;
  maxAgeSeconds?: number;
  /** Test injection only; reported in returned provenance. */
  now?: () => number;
}

export function sharedSourceSha256(source: SharedRegistrySource): string {
  return createHash('sha256').update(JSON.stringify(parseSharedRegistrySource(source))).digest('hex');
}

export async function verifySharedSource(options: SharedSourceOptions) {
  const source = parseSharedRegistrySource(options.source);
  requireShared(sharedSourceSha256(source) === options.expectedSourceSha256, 'source_mismatch', 'release source pin differs');
  requireShared(source.abiSha256 === sharedRegistryAbiSha256, 'abi_mismatch', 'generated ABI differs from selected release');
  const tag = options.blockTag ?? 'safe';
  requireShared(tag === 'safe' || tag === 'finalized', 'source_invalid', 'unsupported block tag');
  const reader = await PinnedReader.open(options.rpcUrl, tag, BigInt(source.chainId));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const maxAge = options.maxAgeSeconds ?? (tag === 'safe' ? 900 : 5400);
  requireShared(Number.isFinite(maxAge) && maxAge > 0 && maxAge <= 5400, 'source_invalid', 'invalid freshness bound');
  const checkTime = () => {
    const current = now();
    requireShared(Number.isSafeInteger(current) && current >= 0, 'clock_skew', 'invalid clock');
    requireShared(reader.block.timestamp <= BigInt(current + 60), 'clock_skew', 'block is in the future');
    requireShared(BigInt(current) - reader.block.timestamp <= BigInt(Math.floor(maxAge)), 'stale_state', 'selected block is too old');
    return current;
  };
  checkTime();
  requireShared(reader.block.number >= BigInt(source.deployment.blockNumber), 'source_unconfirmed', 'deployment not yet in selected block');
  const [code, version, paymentToken, deploymentBlock, deploymentReceipt] = await Promise.all([
    reader.getCode(source.registry), reader.read(source.registry, sharedRegistryAbi, 'PROTOCOL_VERSION'),
    reader.read(source.registry, sharedRegistryAbi, 'paymentToken'),
    reader.client.getBlock({ blockNumber: BigInt(source.deployment.blockNumber) }),
    reader.client.getTransactionReceipt({ hash: source.deployment.transactionHash }),
  ]);
  requireShared(code !== '0x' && keccak256(code) === source.runtimeCodeHash, 'code_mismatch', 'shared registry runtime differs');
  requireShared(Number(version) === 3 && getAddress(paymentToken as string) === source.constructor.paymentToken,
    'source_mismatch', 'protocol or renewal currency differs');
  requireShared(deploymentBlock.hash === source.deployment.blockHash && deploymentReceipt.blockHash === deploymentBlock.hash
    && deploymentReceipt.blockNumber === BigInt(source.deployment.blockNumber)
    && deploymentReceipt.status === 'success' && typeof deploymentReceipt.contractAddress === 'string'
    && getAddress(deploymentReceipt.contractAddress) === source.registry, 'deployment_mismatch', 'deployment receipt is not canonical');
  const finish = async () => {
    checkTime();
    // A final canonical hash read also detects a reorg while other reads ran.
    requireShared(keccak256(await reader.getCode(source.registry)) === source.runtimeCodeHash, 'code_mismatch', 'code changed');
    checkTime();
  };
  await finish();
  return { source, sourceSha256: options.expectedSourceSha256, reader, now, checkTime, finish,
    clock: options.now ? 'test-override' as const : 'system' as const,
    evmTrust: isLoopback(new URL(options.rpcUrl).hostname) ? 'local-rpc' as const : 'remote-rpc' as const };
}

export async function verifySharedRegistry(tld: string, options: SharedSourceOptions & { handshake: HandshakeSource }) {
  requireCanonicalSharedLabel(tld);
  const verified = await verifySharedSource(options);
  const delegation = await verifySharedDelegation(tld, options.handshake, verified.source);
  const authority = await verified.reader.read(verified.source.registry, sharedRegistryAbi, 'authority',
    [delegation.namespaceId]) as SharedAuthority;
  requireShared(authority.tld === tld, 'namespace_mismatch', 'registry namespace differs');
  requireShared(!authority.migrationRequired, 'migration_required', 'namespace requires explicit migration');
  const now = verified.checkTime();
  requireShared(authority.evidenceHash !== `0x${'0'.repeat(64)}` && authority.observedAt <= verified.reader.block.timestamp
    && authority.validUntil > verified.reader.block.timestamp && authority.validUntil > BigInt(now),
  'authority_stale', 'namespace authority evidence expired');
  const finish = async () => {
    await verified.finish();
    requireShared(authority.validUntil > BigInt(verified.checkTime()), 'authority_stale', 'authority expired during verification');
  };
  await finish();
  return { ...verified, delegation, authority, finish };
}

export async function resolveSharedName(options: SharedSourceOptions & {
  name: string; handshake: HandshakeSource; dnsTypes?: DnsType[]; textKeys?: string[]; coinTypes?: bigint[];
}) {
  const labels = options.name.toLowerCase().replace(/\.$/, '').split('.');
  requireShared(labels.length >= 2, 'label_invalid', 'name requires label and TLD');
  labels.forEach(requireCanonicalSharedLabel);
  const tld = labels.at(-1)!;
  const label = labels.at(-2)!;
  const relative = labels.slice(0, -2).join('.');
  const verified = await verifySharedRegistry(tld, options);
  const { reader, source, authority } = verified;
  const ns = verified.delegation.namespaceId;
  const current = await reader.read(source.registry, sharedRegistryAbi, 'currentToken', [ns, label]) as
    ContractFunctionReturnType<typeof sharedRegistryAbi, 'view', 'currentToken'>;
  const [tokenId, generation, status] = current;
  requireShared(Number.isInteger(status) && status >= 0 && status < SHARED_STATUS.length, 'status_invalid', 'unknown name status');
  requireShared(status === 1 && generation > 0n, 'not_active', 'name is not active');
  requireShared(tokenId === sharedTokenIdFor(sharedNameKeyFor(ns, label), generation), 'identity_mismatch', 'token derivation differs');
  const [holder, expiryValue, actualNamespace] = await Promise.all([
    reader.read(source.registry, sharedRegistryAbi, 'effectiveOwner', [tokenId]),
    reader.read(source.registry, sharedRegistryAbi, 'expiresAt', [tokenId]),
    reader.read(source.registry, sharedRegistryAbi, 'namespaceOf', [tokenId]),
  ]);
  const expiry = expiryValue as bigint;
  requireShared(actualNamespace === ns && getAddress(holder as string) !== '0x0000000000000000000000000000000000000000',
    'identity_mismatch', 'namespace or owner differs');
  const readRecord = async (key: Hex) => await reader.read(source.registry, sharedRegistryAbi, 'record', [tokenId, key]) as Hex;
  const dns: Partial<Record<DnsType, { ttl: number; values: (string | string[])[] }>> = {};
  for (const type of options.dnsTypes ?? DNS_TYPES) {
    const raw = await readRecord(dnsKey(relative, RRTYPE[type]));
    if (raw === '0x') continue;
    const set = decodeRRset(raw);
    dns[type] = { ttl: set.ttl, values: set.rdatas.map(r => decodeRdata(type, r)) };
  }
  requireShared(!dns.CNAME || Object.keys(dns).length === 1, 'record_malformed', 'CNAME coexists with other records');
  const text: Record<string, string> = {};
  for (const key of options.textKeys ?? []) {
    const raw = await readRecord(textKey(key));
    if (raw !== '0x') text[key] = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(raw));
  }
  const addr: Record<string, string> = {};
  for (const coin of options.coinTypes ?? [60n]) {
    const raw = await readRecord(addrKey(coin));
    if (raw === '0x') continue;
    requireShared((coin === 60n || (coin & 0x80000000n) !== 0n) && hexToBytes(raw).length === 20,
      'record_malformed', 'unsupported or malformed address record');
    addr[coin.toString()] = getAddress(raw);
  }
  await verified.finish();
  const now = BigInt(verified.checkTime());
  const usableUntil = expiry < authority.validUntil ? expiry : authority.validUntil;
  requireShared(usableUntil > now, 'not_active', 'name or authority expired during resolution');
  for (const set of Object.values(dns)) if (set) set.ttl = Math.min(set.ttl, Number(usableUntil - now));
  return { name: labels.join('.'), usable: true as const, namespaceId: ns,
    token: { tokenId, generation, holder: getAddress(holder as string), expiry }, records: { dns, text, addr },
    source: verified.sourceSha256, registry: source.registry, chainId: source.chainId,
    block: reader.block, clock: verified.clock, hostTime: Number(now), evmTrust: verified.evmTrust,
    handshake: { ...verified.delegation.observation, record: verified.delegation.record }, authority };
}
