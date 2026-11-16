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
    eventRecipient: recipient as Address, transactionStatus: 'success', recoveryAuthorized: true,
    status: 1, currentGeneration: 1n, now: 1000, noReceiptLog: false, wrongEmitter: false,
    currentUnavailable: false, wrongNamespace: false, conflict: false, reorgDuringRead: false, claimBlockReads: 0 };
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
  const operation: PreparedSharedClaim = { schema: 'pirate.member-name-claim/3', sourceSha256: sharedSourceSha256(source),
    chainId: 31337, registry, claim, requestHash: hashTypedData(sharedClaimTypedData(31337, registry, claim)),
    expectedTokenId: tokenId, renewalToken: currency, annualRenewalPrice: 5n,
    quoteBlock: { number: 5n, hash: h('6'), timestamp: 900n },
    timing: { collectionMarginSeconds: 60, signingMarginSeconds: 60, inclusionMarginSeconds: 60 }, submitBy: 1380n };
  const event = getAbiItem({ abi: sharedRegistryAbi, name: 'FreeNameClaimed' });
  const logs = () => {
    const log = { address: state.wrongEmitter ? recipient : registry, blockHash: h('4'), blockNumber: 10n, transactionHash: h('7'),
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
        case 'claimReceipt': return { requestHash: state.conflict ? h('a') : state.consumed ? operation.requestHash : h('0'), tokenId, blockNumber: 10n };
        case 'namespaceOf': return state.wrongNamespace ? h('b') : claim.namespaceId;
        case 'currentToken': return [sharedTokenIdFor(key, state.currentGeneration), state.currentGeneration,
          state.currentGeneration === 1n ? state.status : 1];
        case 'registrant':
          if (state.currentUnavailable) throw new Error('current state unavailable');
          return state.holder;
        case 'status': return state.status;
        case 'expiresAt': return expiry;
        default: throw new Error(`unexpected ${name}`);
      }
    }, client: {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber !== 1n) state.claimBlockReads++;
        return { number: blockNumber, hash: blockNumber === 1n ? h('1')
          : state.reorgDuringRead && state.claimBlockReads > 1 ? h('b') : state.canonical,
        timestamp: blockNumber === 1n ? 800n : 950n };
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => hash === h('2')
        ? { status: 'success', blockNumber: 1n, blockHash: h('1'), contractAddress: registry }
        : { status: state.transactionStatus, to: recipient, blockNumber: 10n, blockHash: h('4'), transactionHash: h('7'),
          logs: state.noReceiptLog ? [] : logs() },
      getLogs: async () => logs(),
    } };
  t.mock.method(PinnedReader, 'open', async (_url: string, _tag: BlockTag, _chainId: bigint) => reader as unknown as PinnedReader);
  const options: SharedNamingOptions = { source, expectedSourceSha256: operation.sourceSha256, rpcUrl: 'http://127.0.0.1:1',
    tld: 'testtld', now: () => state.now, handshake: { description: 'unavailable',
      lookup: async () => { throw new Error('historical recovery must not query HNS'); } } };
  const authorize = async () => { assert.ok(state.recoveryAuthorized, 'recovery authorization revoked'); };
  return { state, operation, options, authorize, reader };
}

test('recovery retains obsolete envelopes and refuses silent version migration', async t => {
  const f = fixture(t);
  Reflect.set(f.operation, 'schema', 'pirate.member-name-claim/2');
  const original = structuredClone(f.operation);
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /operation_version/);
  assert.deepEqual(f.operation, original);
  assert.equal(f.state.claimBlockReads, 0);
});

test('original receipt proves consumption without HNS and absence remains pending', async t => {
  const f = fixture(t);
  const result = await reconcileSharedClaim(f.options, f.operation, f.authorize, h('7'));
  assert.equal(result.state, 'consumed');
  assert.ok(result.state === 'consumed');
  assert.equal(result.original.recipient, recipient);
  assert.equal(result.resolutionEligibility, 'not-checked');
  f.state.consumed = false;
  assert.equal((await reconcileSharedClaim(f.options, f.operation, f.authorize, h('7'))).state, 'pending');
});

test('recovery rejects changed original recipient, duplicate events, failed receipt and reorg', async t => {
  const f = fixture(t);
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

test('transferred, expired and superseded names remain consumed with separate current state', async t => {
  const f = fixture(t);
  f.state.holder = registry;
  let result = await reconcileSharedClaim(f.options, f.operation, f.authorize, h('a'));
  assert.ok(result.state === 'consumed' && result.current.state === 'observed');
  assert.equal(result.transactionHashChanged, true);
  assert.equal(result.original.recipient, recipient);
  assert.equal(result.current.registrant, registry);
  for (const status of [2, 3, 4]) {
    f.state.status = status;
    f.state.holder = `0x${'0'.repeat(40)}`;
    if (status === 4) f.state.currentGeneration = 2n;
    result = await reconcileSharedClaim(f.options, f.operation, f.authorize);
    assert.ok(result.state === 'consumed' && result.current.state === 'observed');
    assert.equal(result.current.status, status);
    assert.equal(result.original.generation, 1n);
    assert.equal(result.current.currentGeneration, f.state.currentGeneration);
    assert.equal(result.automaticReissueAllowed, false);
  }
  f.state.currentUnavailable = true;
  result = await reconcileSharedClaim(f.options, f.operation, f.authorize);
  assert.ok(result.state === 'consumed' && result.current.state === 'unavailable');
});

test('missing receipt is terminal only strictly past deadline at the canonical observed block', async t => {
  const f = fixture(t);
  f.state.consumed = false;
  f.state.now = 1600;
  f.reader.block.timestamp = 1500n;
  assert.equal((await reconcileSharedClaim(f.options, f.operation, f.authorize)).state, 'pending');
  f.reader.block.timestamp = 1501n;
  const result = await reconcileSharedClaim(f.options, f.operation, f.authorize);
  assert.equal(result.state, 'expired-unconsumed');
  assert.equal(result.observedBlock.hash, h('8'));
  assert.equal(result.automaticReissueAllowed, false);
});

test('receipt namespace, emitter, receipt inclusion and conflicting operation fail closed', async t => {
  const f = fixture(t);
  f.state.wrongNamespace = true;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_mismatch/);
  f.state.wrongNamespace = false;
  f.state.wrongEmitter = true;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_mismatch/);
  f.state.wrongEmitter = false;
  f.state.noReceiptLog = true;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_mismatch/);
  f.state.noReceiptLog = false;
  f.state.conflict = true;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_conflict/);
});

test('claim block changing during recovery invalidates consumption proof', async t => {
  const f = fixture(t);
  f.state.reorgDuringRead = true;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /receipt_reorg/);
  assert.equal(f.state.claimBlockReads, 2);
});

test('mutated original operation or revoked application authorization cannot recover success', async t => {
  const f = fixture(t);
  await assert.rejects(reconcileSharedClaim(f.options, { ...f.operation, claim: { ...f.operation.claim, deadline: 1501n } }, f.authorize), /digest_mismatch/);
  f.state.recoveryAuthorized = false;
  await assert.rejects(reconcileSharedClaim(f.options, f.operation, f.authorize), /recovery authorization revoked/);
});
