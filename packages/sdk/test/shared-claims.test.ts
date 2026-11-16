import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { hashTypedData, recoverTypedDataAddress, getAbiItem, keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sharedRegistryAbi, sharedRegistryAbiSha256 } from '../../resolver/src/shared-abi.ts';
import { sharedClaimTypedData, sharedAcceptanceTypedData, prepareSharedClaim, submitSharedClaim,
  persistSharedClaimJournal, requireSharedClaimWindow,
  type SharedFreeClaim, type SharedClaimTransaction } from '../src/shared-claims.ts';
import { promises as journalFs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sharedNamespaceIdFor } from '../../resolver/src/shared-keys.ts';
import { PinnedReader, type BlockTag } from '../../resolver/src/evm.ts';
import { parseSharedRegistrySource } from '../../resolver/src/shared-manifest.ts';
import { sharedSourceSha256 } from '../../resolver/src/shared-resolve.ts';
import { prepareSharedRenewal, type SharedNamingOptions } from '../src/shared-names.ts';

const registry = `0x${'1'.repeat(40)}` as const;
const recipient = privateKeyToAccount(`0x${'0'.repeat(60)}2345`);
const claim: SharedFreeClaim = { requestId: `0x${'1'.repeat(64)}`, communityId: `0x${'2'.repeat(64)}`,
  namespaceId: sharedNamespaceIdFor('testtld'), label: 'member001', recipient: recipient.address,
  generation: 1n, authorityRevision: 1n, policyRevision: 2n, scopeRevision: 3n,
  issuedAt: 1000n, deadline: 1600n, years_: 1, maxCost: 0n };

test('claim signing fields derive from the compiler interface', () => {
  const data = sharedClaimTypedData(31337, registry, claim);
  const item = getAbiItem({ abi: sharedRegistryAbi, name: 'claimFreeName' });
  assert.deepEqual(data.types.FreeClaim, item.inputs[0].components.map(({ name, type }) => ({ name, type })));
  const original = hashTypedData(data);
  for (const changed of [{ ...claim, recipient: registry }, { ...claim, label: 'member002' },
    { ...claim, generation: 2n }, { ...claim, authorityRevision: 2n }, { ...claim, policyRevision: 3n },
    { ...claim, scopeRevision: 4n }, { ...claim, deadline: 1601n }, { ...claim, maxCost: 1n }]) {
    assert.notEqual(hashTypedData(sharedClaimTypedData(31337, registry, changed)), original);
  }
  assert.notEqual(hashTypedData(sharedClaimTypedData(6343, registry, claim)), original);
  assert.notEqual(hashTypedData(sharedClaimTypedData(31337, recipient.address, claim)), original);
});

test('recipient consent binds the entire request and a distinct signing type', async () => {
  const digest = hashTypedData(sharedClaimTypedData(31337, registry, claim));
  const acceptance = sharedAcceptanceTypedData(31337, registry, claim);
  assert.equal(acceptance.message.claim.label, 'member001');
  assert.equal(acceptance.message.claim.namespaceId, claim.namespaceId);
  const signature = await recipient.signTypedData(acceptance);
  assert.equal(await recoverTypedDataAddress({ ...acceptance, signature }), recipient.address);
  assert.notEqual(hashTypedData(acceptance), digest);
  const changed = sharedAcceptanceTypedData(31337, registry, { ...claim, label: 'member002' });
  assert.notEqual(await recoverTypedDataAddress({ ...changed, signature }), recipient.address);
});

function callerFixture(t: TestContext) {
  const h = (digit: string) => `0x${digit.repeat(64)}` as Hex;
  const currency = `0x${'3'.repeat(40)}` as const;
  const submitter = privateKeyToAccount(`0x${'0'.repeat(60)}3456`);
  const state = { now: 1010, expiredAuthority: false, persistenceFails: false, unknownBroadcast: false,
    authorized: true, wrongTransaction: false, sequence: [] as string[], initialPrice: 0n, signingDelay: 0, storageDelay: 0 };
  const source = parseSharedRegistrySource({ schema: 'pirate.shared-registry-source/1', protocolVersion: 3,
    sourceCommit: '1'.repeat(40), abiSha256: sharedRegistryAbiSha256, chainId: 31337, registry,
    runtimeCodeHash: keccak256('0x60006000'), deployment: { blockNumber: '1', blockHash: h('4'), transactionHash: h('5') },
    constructor: { admin: recipient.address, paymentToken: currency, treasury: recipient.address },
    compiler: { version: '0.8.30', evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } });
  const reader = { block: { tag: 'safe', number: 10n, hash: h('6'), timestamp: 1000n }, getCode: async () => '0x60006000',
    read: async (_address: string, _abi: unknown, name: string, args: readonly unknown[] = []) => {
      switch (name) {
        case 'PROTOCOL_VERSION': return 3;
        case 'paymentToken': return currency;
        case 'authority': return { tld: 'testtld', evidenceHash: h('7'), observedAt: 900n,
          validUntil: state.expiredAuthority ? 999n : 2000n, revision: 1n, migrationRequired: false, issuanceEnabled: true };
        case 'quote': return { authorityRevision: 1n, policyRevision: 2n, scopeRevision: 3n, generation: 1n, status: 0,
          reservedFor: `0x${'0'.repeat(40)}`, initialPrice: state.initialPrice, renewalToken: currency,
          annualRenewalPrice: 5n, namespaceClaimsRemaining: 10n, scopeClaimsRemaining: 5n, issuanceEnabled: true };
        case 'requestHash': return hashTypedData(sharedClaimTypedData(31337, registry, args[0] as SharedFreeClaim));
        case 'namespaceOf': return claim.namespaceId;
        case 'status': return 1;
        case 'lockedRenewalPrice': return 5n;
        case 'expiresAt': return 2000n;
        default: throw new Error(`unexpected ${name}`);
      }
    }, client: {
      getBlock: async () => ({ number: 1n, hash: h('4') }),
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, blockHash: h('4'), contractAddress: registry }),
      request: async () => { state.sequence.push('simulated'); return '0x'; },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        state.sequence.push('broadcast');
        if (state.unknownBroadcast) throw new Error('connection lost after send');
        return keccak256(serializedTransaction);
      },
    } };
  t.mock.method(PinnedReader, 'open', async (_url: string, _tag: BlockTag, _chain: bigint) => reader as unknown as PinnedReader);
  const options: SharedNamingOptions = { source, expectedSourceSha256: sharedSourceSha256(source),
    rpcUrl: 'http://127.0.0.1:1', tld: 'testtld', now: () => state.now,
    handshake: { description: 'fixture', lookup: async () => ({ source: 'fixture', trust: 'local-full-node',
      nsTargets: [`${registry}.31337._evm.`] }) } };
  const controls = { grantSignature: '0x01' as Hex, recipientSignature: '0x02' as Hex, submitter: submitter.address,
    nonce: 7, gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxGasCost: 200_000n,
    authorizeOriginalOperation: async () => { assert.ok(state.authorized, 'authorization revoked'); },
    signTransaction: async (tx: SharedClaimTransaction) => {
      state.sequence.push('signed');
      state.now += state.signingDelay;
      return submitter.signTransaction(state.wrongTransaction ? { ...tx, nonce: tx.nonce + 1 } : tx);
    },
    persistSignedTransaction: async () => {
      state.sequence.push('persisted');
      state.now += state.storageDelay;
      if (state.persistenceFails) throw new Error('durable store failed');
    } };
  const prepare = () => prepareSharedClaim(options, { communityId: claim.communityId, requestId: claim.requestId,
    label: claim.label, recipient: recipient.address }, {
    collectionMarginSeconds: 60, signingMarginSeconds: 60, inclusionMarginSeconds: 60 });
  return { state, options, controls, prepare };
}

test('claim preparation uses the quoted block clock and refuses premiums or stale quotes', async t => {
  const f = callerFixture(t);
  const op = await f.prepare();
  assert.equal(op.claim.issuedAt, 1000n);
  assert.equal(op.claim.deadline, 1900n);
  assert.equal(op.schema, 'pirate.member-name-claim/3');
  assert.equal(op.submitBy, 1780n);
  f.state.initialPrice = 1n;
  await assert.rejects(f.prepare(), /not_free/);
  f.state.initialPrice = 0n;
  f.state.now = 1721;
  await assert.rejects(f.prepare(), /claim_window_insufficient/);
});

test('timing margins have exact inclusive boundary and survive signing delays', async t => {
  const timing = { collectionMarginSeconds: 60, signingMarginSeconds: 60, inclusionMarginSeconds: 60 };
  requireSharedClaimWindow(1900n, 1720, timing, 'prepare', 1000n);
  assert.throws(() => requireSharedClaimWindow(1900n, 1721, timing, 'prepare', 1000n), /claim_window_insufficient/);
  requireSharedClaimWindow(1900n, 1780, timing, 'submit', 1000n);
  assert.throws(() => requireSharedClaimWindow(1900n, 1781, timing, 'submit', 1000n), /claim_window_insufficient/);
  requireSharedClaimWindow(1900n, 1840, timing, 'broadcast', 1000n);
  assert.throws(() => requireSharedClaimWindow(1900n, 1841, timing, 'broadcast', 1000n), /claim_window_insufficient/);
  requireSharedClaimWindow(1900n, 1000, {
    collectionMarginSeconds: 300, signingMarginSeconds: 300, inclusionMarginSeconds: 300 }, 'prepare', 1000n);
  for (const invalid of [{ ...timing, collectionMarginSeconds: 0 }, { ...timing, signingMarginSeconds: 0 },
    { ...timing, inclusionMarginSeconds: 0 }, { ...timing, collectionMarginSeconds: -1 },
    { ...timing, collectionMarginSeconds: 1.5 }, { ...timing, signingMarginSeconds: Number.NaN },
    { ...timing, inclusionMarginSeconds: Number.POSITIVE_INFINITY },
    { collectionMarginSeconds: 301, signingMarginSeconds: 300, inclusionMarginSeconds: 300 }]) {
    assert.throws(() => requireSharedClaimWindow(1900n, 1000, invalid, 'prepare', 1000n), /timing_policy/);
  }
  const f = callerFixture(t);
  const op = await f.prepare();
  f.state.signingDelay = 831;
  await assert.rejects(submitSharedClaim(f.options, op, f.controls), /claim_window_insufficient/);
  assert.deepEqual(f.state.sequence, ['simulated', 'signed', 'persisted']);
});

test('consent collection can consume its full budget before signing and storage at submit-by', async t => {
  const f = callerFixture(t);
  f.state.now = 1720;
  const op = await f.prepare();
  const original = structuredClone(op);
  f.state.now += op.timing.collectionMarginSeconds;
  assert.equal(BigInt(f.state.now), op.submitBy);
  f.state.signingDelay = 30;
  f.state.storageDelay = op.timing.signingMarginSeconds - f.state.signingDelay;
  let persisted = false;
  const result = await submitSharedClaim(f.options, op, { ...f.controls,
    persistSignedTransaction: async (stored, raw, hash) => {
      assert.deepEqual(stored, original);
      assert.equal(parseTransaction(raw).nonce, f.controls.nonce);
      assert.equal(hash, keccak256(raw));
      await f.controls.persistSignedTransaction();
      persisted = true;
    } });
  assert.equal(result.broadcast, 'acknowledged');
  assert.equal(persisted, true);
  assert.deepEqual(op, original);
  assert.deepEqual(f.state.sequence, ['simulated', 'signed', 'persisted', 'broadcast']);
});

test('elapsed consent beyond submit-by refuses signing without reissuing the operation', async t => {
  const f = callerFixture(t);
  f.state.now = 1720;
  const op = await f.prepare();
  const original = structuredClone(op);
  f.state.now = Number(op.submitBy) + 1;
  await assert.rejects(submitSharedClaim(f.options, op, f.controls), /claim_window_insufficient/);
  assert.deepEqual(op, original);
  assert.deepEqual(f.state.sequence, []);
});

test('altered submit-by and obsolete envelope versions never reach signing', async t => {
  const f = callerFixture(t);
  const op = await f.prepare();
  await assert.rejects(submitSharedClaim(f.options, { ...op, submitBy: op.submitBy + 1n }, f.controls), /timing_policy/);
  Reflect.set(op, 'schema', 'pirate.member-name-claim/2');
  await assert.rejects(submitSharedClaim(f.options, op, f.controls), /operation_version/);
  assert.equal(op.schema, 'pirate.member-name-claim/2');
  assert.deepEqual(f.state.sequence, []);
});

test('journal synchronizes file and new directory links and refuses overwrite', async () => {
  const anchor = fileURLToPath(new URL('../../../', import.meta.url));
  const prefix = ['.ignore', 'shared-names-registry-20261113', 'journal-test-' + randomUUID()];
  const payload = JSON.stringify({ raw: '0x02abcd', requestHash: 'fixture' });
  const path = await persistSharedClaimJournal(anchor, prefix, 'operation.json', payload);
  assert.equal(await journalFs.readFile(path, 'utf8'), payload);
  assert.equal((await journalFs.stat(path)).mode & 0o777, 0o600);
  await assert.rejects(persistSharedClaimJournal(anchor, prefix, 'operation.json', 'replacement'), /EEXIST/);
  await assert.rejects(persistSharedClaimJournal(anchor, prefix, 'operation.json', payload), /EEXIST/);
  assert.equal(await journalFs.readFile(path, 'utf8'), payload);
  await assert.rejects(persistSharedClaimJournal(anchor, ['..'], 'operation.json', payload), /journal_path/);
});

test('file or required directory sync failure prevents broadcast', async t => {
  const f = callerFixture(t);
  const op = await f.prepare();
  const anchor = fileURLToPath(new URL('../../../', import.meta.url));
  const realOpen = journalFs.open.bind(journalFs);
  for (const failOn of ['file', 'directory', 'final-directory'] as const) {
    f.state.sequence = [];
    const opened: string[] = [];
    let fileSynced = false;
    const directories = ['.ignore', 'shared-names-registry-20261113', 'journal-fault-' + randomUUID()];
    const retainedPath = join(anchor, ...directories, 'operation.json');
    let originalPayload = '';
    const hook = t.mock.method(journalFs, 'open', async (...args: Parameters<typeof journalFs.open>) => {
      const handle = await realOpen(...args);
      const isFile = String(args[0]).endsWith('operation.json');
      opened.push(isFile ? 'file' : 'directory');
      const realSync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => {
        if ((isFile ? 'file' : 'directory') === failOn || (failOn === 'final-directory' && !isFile && fileSynced)) {
          throw new Error('injected ' + failOn + ' sync failure');
        }
        await realSync();
        if (isFile) fileSynced = true;
      });
      return handle;
    });
    await assert.rejects(submitSharedClaim(f.options, op, { ...f.controls,
      persistSignedTransaction: async (original, raw, hash) => {
        originalPayload = JSON.stringify({ requestHash: original.requestHash, requestId: original.claim.requestId,
          raw, hash, nonce: parseTransaction(raw).nonce });
        await persistSharedClaimJournal(anchor, directories, 'operation.json', originalPayload);
      } }), /sync failure/);
    assert.ok(opened.includes(failOn === 'final-directory' ? 'directory' : failOn));
    if (failOn === 'final-directory') assert.equal(fileSynced, true);
    assert.ok(!f.state.sequence.includes('broadcast'));
    hook.mock.restore();
    if (failOn === 'final-directory') {
      assert.equal(await journalFs.readFile(retainedPath, 'utf8'), originalPayload);
      await assert.rejects(persistSharedClaimJournal(anchor, directories, 'operation.json', originalPayload), /EEXIST/);
      await assert.rejects(persistSharedClaimJournal(anchor, directories, 'operation.json', 'replacement'), /EEXIST/);
      assert.equal(await journalFs.readFile(retainedPath, 'utf8'), originalPayload);
      assert.ok(!f.state.sequence.includes('broadcast'));
    }
  }
});

test('signed bytes persist before broadcast, including an unknown broadcast outcome', async t => {
  const f = callerFixture(t);
  const op = await f.prepare();
  f.state.unknownBroadcast = true;
  const result = await submitSharedClaim(f.options, op, f.controls);
  assert.equal(result.state, 'pending');
  assert.equal(result.broadcast, 'unknown');
  assert.match(result.transactionHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(f.state.sequence, ['simulated', 'signed', 'persisted', 'broadcast']);
});

test('failed persistence or changed signed nonce never broadcasts', async t => {
  const f = callerFixture(t);
  const op = await f.prepare();
  f.state.persistenceFails = true;
  await assert.rejects(submitSharedClaim(f.options, op, f.controls), /durable store failed/);
  assert.ok(!f.state.sequence.includes('broadcast'));
  f.state.sequence = [];
  f.state.persistenceFails = false;
  f.state.wrongTransaction = true;
  await assert.rejects(submitSharedClaim(f.options, op, f.controls), /transaction_mismatch/);
  assert.deepEqual(f.state.sequence, ['simulated', 'signed']);
});

test('explicit gas ceiling and current application authorization gate signing', async t => {
  const f = callerFixture(t);
  const op = await f.prepare();
  await assert.rejects(submitSharedClaim(f.options, op, { ...f.controls, maxGasCost: 1n }), /gas_limit/);
  f.state.authorized = false;
  await assert.rejects(submitSharedClaim(f.options, op, f.controls), /authorization revoked/);
  assert.deepEqual(f.state.sequence, []);
});

test('locked renewal preparation survives missing authority and repointed external delegation', async t => {
  const f = callerFixture(t);
  f.state.expiredAuthority = true;
  f.options.handshake = { description: 'lost authority', lookup: async () => { throw new Error('TLD lost'); } };
  const result = await prepareSharedRenewal(f.options, 1n, 1, 5n, 1500n);
  assert.equal(result.cost, 5n);
  assert.equal(result.previousExpiry, 2000n);
  await assert.rejects(prepareSharedRenewal(f.options, 1n, 1, 4n, 1500n), /renewal_terms/);
});
