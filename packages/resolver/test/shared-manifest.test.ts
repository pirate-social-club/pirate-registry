import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSharedRegistrySource } from '../src/shared-manifest.ts';

const fixture = () => ({ schema: 'pirate.shared-registry-source/1', protocolVersion: 3,
  sourceCommit: '1'.repeat(40), abiSha256: '2'.repeat(64), chainId: 31337,
  registry: `0x${'1'.repeat(40)}`, runtimeCodeHash: `0x${'3'.repeat(64)}`,
  deployment: { blockNumber: '100', blockHash: `0x${'4'.repeat(64)}`, transactionHash: `0x${'5'.repeat(64)}` },
  constructor: { admin: `0x${'2'.repeat(40)}`, paymentToken: `0x${'3'.repeat(40)}`, treasury: `0x${'4'.repeat(40)}` },
  compiler: { version: '0.8.30', evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } });

test('source profile accepts exact local/testnet tuples with explicit constructor parameters', () => {
  assert.equal(parseSharedRegistrySource(fixture()).chainId, 31337);
  assert.equal(parseSharedRegistrySource({ ...fixture(), chainId: 6343 }).chainId, 6343);
});

test('source profile refuses unknown fields, missing pins, v2, mainnet and altered compiler settings', () => {
  for (const value of [null, {}, { ...fixture(), extra: true }, { ...fixture(), protocolVersion: 2 },
    { ...fixture(), chainId: 1 }, { ...fixture(), abiSha256: '' }, { ...fixture(), registry: `0x${'0'.repeat(40)}` },
    { ...fixture(), deployment: { ...fixture().deployment, blockNumber: '01' } },
    { ...fixture(), deployment: { ...fixture().deployment, blockNumber: (2n ** 64n).toString() } },
    { ...fixture(), compiler: { ...fixture().compiler, optimizerRuns: 201 } }]) assert.throws(() => parseSharedRegistrySource(value));
});
