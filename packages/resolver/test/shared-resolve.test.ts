import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { keccak256, type Hex } from 'viem';
import { PinnedReader, type BlockTag } from '../src/evm.ts';
import { sharedRegistryAbiSha256 } from '../src/shared-abi.ts';
import { parseSharedRegistrySource } from '../src/shared-manifest.ts';
import { resolveSharedName, sharedSourceSha256, verifySharedSource } from '../src/shared-resolve.ts';
import { sharedNamespaceIdFor, sharedNameKeyFor, sharedTokenIdFor } from '../src/shared-keys.ts';
import type { HandshakeSource } from '../src/handshake.ts';

const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const registry = `0x${'1'.repeat(40)}` as const;
const holder = `0x${'2'.repeat(40)}` as const;
const token = `0x${'3'.repeat(40)}` as const;

function fixture(t: TestContext) {
  const state = { code: '0x60006000' as Hex, now: 1000, expiry: 2000n, validUntil: 3000n,
    status: 1, migration: false, blockHash: hash('4'), deploymentHash: hash('5') };
  const source = parseSharedRegistrySource({ schema: 'pirate.shared-registry-source/1', protocolVersion: 3,
    sourceCommit: '1'.repeat(40), abiSha256: sharedRegistryAbiSha256, chainId: 31337, registry,
    runtimeCodeHash: keccak256(state.code), deployment: { blockNumber: '10', blockHash: hash('5'), transactionHash: hash('6') },
    constructor: { admin: holder, paymentToken: token, treasury: holder }, compiler: { version: '0.8.30', evmVersion: 'cancun',
      optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } });
  const namespaceId = sharedNamespaceIdFor('testtld');
  const id = sharedTokenIdFor(sharedNameKeyFor(namespaceId, 'member001'), 1n);
  const reader = { block: { tag: 'safe', number: 20n, hash: state.blockHash, timestamp: 990n },
    getCode: async () => state.code,
    read: async (_address: string, _abi: unknown, name: string) => {
      switch (name) {
        case 'PROTOCOL_VERSION': return 3;
        case 'paymentToken': return token;
        case 'authority': return { tld: 'testtld', evidenceHash: hash('7'), observedAt: 900n,
          validUntil: state.validUntil, revision: 1n, migrationRequired: state.migration, issuanceEnabled: true };
        case 'currentToken': return [id, 1n, state.status];
        case 'effectiveOwner': return holder;
        case 'expiresAt': return state.expiry;
        case 'namespaceOf': return namespaceId;
        case 'record': return '0x';
        default: throw new Error(`unexpected read ${name}`);
      }
    }, client: { getBlock: async () => ({ number: 10n, hash: state.deploymentHash }),
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 10n, blockHash: hash('5'), contractAddress: registry }) } };
  t.mock.method(PinnedReader, 'open', async (_url: string, tag: BlockTag, chainId: bigint) => {
    assert.equal(tag, 'safe'); assert.equal(chainId, 31337n);
    return reader as unknown as PinnedReader;
  });
  const handshake: HandshakeSource = { description: 'explicit test fixture', lookup: async () => ({
    nsTargets: [`${registry}.31337._evm.`], source: 'fixture', trust: 'local-full-node', height: 100 }) };
  const options = { source, expectedSourceSha256: sharedSourceSha256(source), rpcUrl: 'http://127.0.0.1:1',
    handshake, now: () => state.now, name: 'member001.testtld' };
  return { state, options, id };
}

test('resolver returns exact identity and separately labelled proof provenance', async t => {
  const { options, id } = fixture(t);
  const result = await resolveSharedName(options);
  assert.equal(result.token.tokenId, id);
  assert.equal(result.token.holder, holder);
  assert.equal(result.clock, 'test-override');
  assert.equal(result.evmTrust, 'local-rpc');
  assert.equal(result.handshake.source, 'fixture');
});

test('source pin, runtime code and deployment reorg failures refuse verification', async t => {
  const { state, options } = fixture(t);
  await assert.rejects(verifySharedSource({ ...options, expectedSourceSha256: '0'.repeat(64) }), /source_mismatch/);
  state.code = '0x6001';
  await assert.rejects(verifySharedSource(options), /code_mismatch/);
  state.code = '0x60006000';
  state.deploymentHash = hash('8');
  await assert.rejects(verifySharedSource(options), /deployment_mismatch/);
});

test('expired authority, migration and unknown statuses are never usable names', async t => {
  const { state, options } = fixture(t);
  state.validUntil = 999n;
  await assert.rejects(resolveSharedName(options), /authority_stale/);
  state.validUntil = 3000n;
  state.migration = true;
  await assert.rejects(resolveSharedName(options), /migration_required/);
  state.migration = false;
  state.status = 99;
  await assert.rejects(resolveSharedName(options), /status_invalid/);
  state.status = 1;
  state.expiry = 1000n;
  await assert.rejects(resolveSharedName(options), /not_active/);
});

test('ambiguous or repointed Handshake delegation refuses resolution', async t => {
  const { options } = fixture(t);
  const wrong: HandshakeSource = { description: 'fixture', lookup: async () => ({ source: 'fixture', trust: 'local-full-node',
    nsTargets: [`${holder}.31337._evm.`] }) };
  await assert.rejects(resolveSharedName({ ...options, handshake: wrong }), /source_mismatch/);
  const ambiguous: HandshakeSource = { description: 'fixture', lookup: async () => ({ source: 'fixture', trust: 'local-full-node',
    nsTargets: [`${registry}.31337._evm.`, `${holder}.31337._evm.`] }) };
  await assert.rejects(resolveSharedName({ ...options, handshake: ambiguous }), /delegation_ambiguous/);
});
