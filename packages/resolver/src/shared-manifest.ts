import { readFileSync } from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';
import { requireShared } from './shared-errors.ts';

export interface SharedRegistrySource {
  schema: 'pirate.shared-registry-source/1';
  protocolVersion: 3;
  sourceCommit: string;
  abiSha256: string;
  chainId: 6343 | 31337;
  registry: Address;
  runtimeCodeHash: Hex;
  deployment: { blockNumber: string; blockHash: Hex; transactionHash: Hex };
  constructor: { admin: Address; paymentToken: Address; treasury: Address };
  compiler: { version: '0.8.30'; evmVersion: 'cancun'; optimizer: true; optimizerRuns: 200;
    bytecodeHash: 'none'; cborMetadata: false };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  requireShared(value !== null && typeof value === 'object' && !Array.isArray(value), 'source_invalid', 'expected object');
  const result = value as Record<string, unknown>;
  requireShared(Object.keys(result).sort().join('|') === [...keys].sort().join('|'), 'source_invalid', 'unexpected/missing fields');
  return result;
}

function hash(value: unknown, prefix = true): string {
  requireShared(typeof value === 'string' && value.length === (prefix ? 66 : 64)
    && (!prefix || value.startsWith('0x')) && !/[^0-9a-f]/.test(prefix ? value.slice(2) : value)
    && (prefix ? value.slice(2) : value) !== '0'.repeat(64), 'source_invalid', 'expected nonzero canonical digest');
  return value;
}

function address(value: unknown): Address {
  requireShared(typeof value === 'string' && value.length === 42 && value.startsWith('0x')
    && !/[^0-9a-fA-F]/.test(value.slice(2)) && value !== `0x${'0'.repeat(40)}`,
  'source_invalid', 'expected nonzero address');
  const canonical = getAddress(value);
  requireShared(value === value.toLowerCase() || value === canonical,
    'source_invalid', 'mixed-case address checksum differs');
  return canonical;
}

/** Validation is not trust: the caller must independently select this exact source. */
export function parseSharedRegistrySource(input: unknown): SharedRegistrySource {
  const o = object(input, ['schema', 'protocolVersion', 'sourceCommit', 'abiSha256', 'chainId', 'registry',
    'runtimeCodeHash', 'deployment', 'constructor', 'compiler']);
  requireShared(o.schema === 'pirate.shared-registry-source/1' && o.protocolVersion === 3,
    'source_invalid', 'unsupported source protocol');
  requireShared(o.chainId === 6343 || o.chainId === 31337, 'chain_not_allowed', 'only testnet/local sources are supported');
  requireShared(typeof o.sourceCommit === 'string' && o.sourceCommit.length === 40
    && !/[^0-9a-f]/.test(o.sourceCommit) && o.sourceCommit !== '0'.repeat(40), 'source_invalid', 'expected exact source commit');
  const d = object(o.deployment, ['blockNumber', 'blockHash', 'transactionHash']);
  requireShared(typeof d.blockNumber === 'string' && d.blockNumber.length >= 1 && d.blockNumber.length <= 20
    && !/[^0-9]/.test(d.blockNumber) && (d.blockNumber === '0' || d.blockNumber[0] !== '0')
    && BigInt(d.blockNumber) <= 0xffffffffffffffffn, 'source_invalid', 'invalid deployment block');
  const c = object(o.constructor, ['admin', 'paymentToken', 'treasury']);
  const compiler = object(o.compiler, ['version', 'evmVersion', 'optimizer', 'optimizerRuns', 'bytecodeHash', 'cborMetadata']);
  requireShared(compiler.version === '0.8.30' && compiler.evmVersion === 'cancun' && compiler.optimizer === true
    && compiler.optimizerRuns === 200 && compiler.bytecodeHash === 'none' && compiler.cborMetadata === false,
  'source_invalid', 'compiler profile differs from accepted release profile');
  return { schema: o.schema, protocolVersion: 3, sourceCommit: o.sourceCommit, abiSha256: hash(o.abiSha256, false),
    chainId: o.chainId, registry: address(o.registry), runtimeCodeHash: hash(o.runtimeCodeHash) as Hex,
    deployment: { blockNumber: d.blockNumber, blockHash: hash(d.blockHash) as Hex, transactionHash: hash(d.transactionHash) as Hex },
    constructor: { admin: address(c.admin), paymentToken: address(c.paymentToken), treasury: address(c.treasury) },
    compiler: { version: '0.8.30', evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } };
}

export function loadSharedRegistrySource(path: string | URL): SharedRegistrySource {
  return parseSharedRegistrySource(JSON.parse(readFileSync(path, 'utf8')));
}
