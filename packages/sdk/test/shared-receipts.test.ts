import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, getAbiItem, hashTypedData, keccak256, type Address, type Hex } from 'viem';
import { PinnedReader, type BlockTag } from '../../resolver/src/evm.ts';
import { sharedRegistryAbi, sharedRegistryAbiSha256 } from '../../resolver/src/shared-abi.ts';
import { sharedNamespaceIdFor, sharedNameKeyFor, sharedTokenIdFor } from '../../resolver/src/shared-keys.ts';
import { parseSharedRegistrySource } from '../../resolver/src/shared-manifest.ts';
import { sharedSourceSha256 } from '../../resolver/src/shared-resolve.ts';
import { sharedClaimTypedData, type PreparedSharedClaim, type SharedFreeClaim } from '../src/shared-claims.ts';
import { reconcileSharedClaim } from '../src/shared-receipts.ts';
import type { SharedNamingOptions } from '../src/shared-names.ts';

const h = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const registry = `0x${'1'.repeat(40)}` as const;
const recipient = `0x${'2'.repeat(40)}` as const;
const currency = `0x${'3'.repeat(40)}` as const;

function fixture(t: TestContext) {
  const state = { consumed: true, holder: recipient as string, canonical: h('4'), duplicate: false,
    eventRecipient: recipient as Address, transactionStatus: 'success', recoveryAuthorized: true };
  const source = parseSharedRegistrySource({ schema: 'pirate.shared-registry-source/1', protocolVersion: 3,
    sourceCommit: '1'.repeat(40), abiSha256: sharedRegistryAbiSha256, chainId: 31337,
    registry, runtimeCodeHash: keccak256('0x60006000'),
    deployment: { blockNumber: '1', blockHash: h('1'), transactionHash: h('2') },
    constructor: { admin: recipient, paymentToken: currency, treasury: recipient },
    compiler: { version: '0.8.30', evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } });
  const claim: SharedFreeClaim = { requestId: h('3'), communityId: h('5'), namespaceId: sharedNamespaceIdFor('testtld'),
    label: 'member001', recipient, generation: 1n, authorityRevision: 1n, policyRevision: 1n, scopeRevision: 1n,
    issuedAt: 900n, deadline: 1500n, years_: 1, maxCost: 0n };
  const key = sharedNameKeyFor(claim.namespaceId, claim.label);
  const tokenId = sharedTokenIdFor(key, 1n);
  const expiry = 950n + 365n * 86400n;
  const operation: PreparedSharedClaim = { schema: 'pirate.member-name-claim/1', sourceSha256: sharedSourceSha256(source),
    chainId: 31337, registry, claim, requestHash: hashTypedData(sharedClaimTypedData(31337, registry, claim)),
    expectedTokenId: tokenId, renewalToken: currency, annualRenewalPrice: 5n,
    quoteBlock: { number: 5n, hash: h('6'), timestamp: 900n } };
  const event = getAbiItem({ abi: sharedRegistryAbi, name: 'FreeNameClaimed' });
  const logs = () => {
    const log = { address: registry, blockHash: h('4'), blockNumber: 10n, transactionHash: h('7'),
      transactionIndex: 0, logIndex: 0, removed: false,
      topics: encodeEventTopics({ abi: sharedRegistryAbi, eventName: 'FreeNameClaimed', args: {
        namespaceId: claim.namespaceId, communityId: claim.communityId, requestId: claim.requestId } }),
      data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), [operation.requestHash, key, claim.label,
        tokenId, 1n, state.eventRecipient, expiry, 5n]) };
    return state.duplicate ? [log, { ...log, logIndex: 1 }] : [log];
  };
  const reader = { block: { tag: 'safe', number: 20n, hash: h('8'), timestamp: 990n }, getCode: async () => '0x60006000',
    read: async (_address: string, _abi: unknown, name: string) => {
      switch (name) {
        case 'PROTOCOL_VERSION': return 3;
        case 'paymentToken': return currency;
        case 'authority': return { tld: 'testtld', evidenceHash: h('9'), observedAt: 900n, validUntil: 2000n,
          revision: 1n, migrationRequired: false, issuanceEnabled: true };
        case 'claimReceipt': return { requestHash: state.consumed ? operation.requestHash : h('0'), tokenId, blockNumber: 10n };
        case 'currentToken': return [tokenId, 1n, 1];
        case 'effectiveOwner': return state.holder;
        case 'expiresAt': return expiry;
        default: throw new Error(`unexpected ${name}`);
      }
    }, client: {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber,
        hash: blockNumber === 1n ? h('1') : state.canonical, timestamp: blockNumber === 1n ? 800n : 950n }),
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => hash === h('2')
        ? { status: 'success', blockNumber: 1n, blockHash: h('1'), contractAddress: registry }
        : { status: state.transactionStatus, to: registry, blockNumber: 10n, blockHash: h('4'), transactionHash: h('7') },
      getLogs: async () => logs(),
    } };
  t.mock.method(PinnedReader, 'open', async (_url: string, _tag: BlockTag, _chainId: bigint) => reader as unknown as PinnedReader);
  const options: SharedNamingOptions = { source, expectedSourceSha256: operation.sourceSha256, rpcUrl: 'http://127.0.0.1:1',
    tld: 'testtld', now: () => 1000, handshake: { description: 'fixture', lookup: async () => ({
      source: 'fixture', trust: 'local-full-node', nsTargets: [`${registry}.31337._evm.`] }) } };
  const authorize = async () => { assert.ok(state.recoveryAuthorized, 'recovery authorization revoked'); };
  return { state, operation, options, authorize };
}

test('exact original receipt confirms and absence remains pending', async t => {
  const f = fixture(t);
  const result = await reconcileSharedClaim(f.options, f.operation, f.authorize, h('7'));
  assert.equal(result.state, 'confirmed');
  f.state.consumed = false;
  assert.equal((await reconcileSharedClaim(f.options, f.operation, f.authorize, h('7'))).state, 'pending');
});

test('recovery rejects changed recipient, duplicate events, failed receipt and reorg', async t => {
  const f = fixture(t);
  f.state.holder = registry;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_state_changed/);
  f.state.holder = recipient;
  f.state.eventRecipient = registry;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_mismatch/);
  f.state.eventRecipient = recipient;
  f.state.duplicate = true;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_ambiguous/);
  f.state.duplicate = false;
  f.state.transactionStatus = 'reverted';
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_reorg/);
  f.state.transactionStatus = 'success';
  f.state.canonical = h('a');
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_reorg/);
});

test('mutated original operation or revoked application authorization cannot recover success', async t => {
  const f = fixture(t);
  await assert.rejects(reconcileSharedClaim(f.options, { ...f.operation, claim: { ...f.operation.claim, deadline: 1501n } }, f.authorize), /digest_mismatch/);
  f.state.recoveryAuthorized = false;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /recovery authorization revoked/);
});
