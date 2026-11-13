// Run ONLY with a fresh Root allocation of disposable local Anvil, hsd and hnsd.
// --start-local is reserved for an isolated CI runner; local Root runs use owned services.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, keccak256, stringToHex, hashTypedData,
  type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { sharedRegistryAbi, sharedRegistryAbiSha256, sharedIdentityVectors } from '../packages/resolver/src/shared-abi.ts';
import { sharedNamespaceIdFor } from '../packages/resolver/src/shared-keys.ts';
import { parseSharedRegistrySource } from '../packages/resolver/src/shared-manifest.ts';
import { resolveSharedName, sharedSourceSha256 } from '../packages/resolver/src/shared-resolve.ts';
import { hsdRpcSource, rootDnsSource } from '../packages/resolver/src/handshake.ts';
import { formatDelegation } from '../packages/resolver/src/delegation.ts';
import { textKey } from '../packages/resolver/src/encoding.ts';
import { prepareSharedClaim, sharedClaimTypedData, sharedAcceptanceTypedData, submitSharedClaim,
  persistSharedClaimJournal, type PreparedSharedClaim } from '../packages/sdk/src/shared-claims.ts';
import { reconcileSharedClaim } from '../packages/sdk/src/shared-receipts.ts';
import { prepareSharedRenewal } from '../packages/sdk/src/shared-names.ts';
import { verifySharedRelease, approvedReleaseEnvironment, type SharedReleaseBuildTools } from '../scripts/verify-shared-release.ts';
import { claimTlds, fund, node, ns as hnsRecord, REGTEST } from './lib/hsd.ts';
import { assertPortsFree, startAnvil, startHsd, restartHnsd, stopAll } from './lib/processes.ts';

const { values } = parseArgs({ options: { 'execute-local': { type: 'boolean', default: false },
  'start-local': { type: 'boolean', default: false }, tools: { type: 'string' } } });
const ROOT = new URL('../', import.meta.url);
const RPC = 'http://127.0.0.1:18545';
const MNEMONIC = 'test test test test test test test test test test test junk';
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

async function main() {
  assert.equal(values['execute-local'], true, 'requires --execute-local and fresh Root runtime allocation');
  assert.ok(values.tools, 'requires --tools FILE with approved Forge/solc byte pins');
  const buildTools = JSON.parse(readFileSync(values.tools, 'utf8')) as SharedReleaseBuildTools;
  const publicClient = createPublicClient({ transport: http(RPC, { retryCount: 0 }) });
  assert.equal(await publicClient.getChainId(), 31337, 'public chains forbidden');
  const hnsInfo = await node<{ network: string }>('getinfo');
  assert.equal(hnsInfo.network, 'regtest', 'only disposable Handshake regtest allowed');
  const chain = defineChain({ id: 31337, name: 'disposable shared-names acceptance',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
  // Fail before deployments/funding if Anvil does not provide the intended safe/finalized behavior.
  await testClient.mine({ blocks: 3 });
  const [latest, safe, finalized] = await Promise.all(['latest', 'safe', 'finalized'].map(blockTag =>
    publicClient.getBlock({ blockTag: blockTag as 'latest' | 'safe' | 'finalized' })));
  assert.equal(latest.number - safe.number, 1n, 'Anvil requires --slots-in-an-epoch 1');
  assert.equal(latest.number - finalized.number, 2n, 'Anvil finality preflight failed');
  const accounts = [0, 1, 2, 3, 4].map(addressIndex => mnemonicToAccount(MNEMONIC, { addressIndex }));
  const [admin, issuer, member, submitter, nextHolder] = accounts;
  const wallet = (index: number) => createWalletClient({ chain, account: accounts[index], transport: http(RPC) });
  const artifact = (name: string) => JSON.parse(readFileSync(new URL(`out/${name}.sol/${name}.json`, ROOT), 'utf8')) as
    { abi: Abi; bytecode: { object: Hex } };
  const mock = artifact('MockUSDC');
  const registryArtifact = artifact('SharedNameRegistryV3');
  assert.deepEqual(registryArtifact.abi, sharedRegistryAbi, 'generated ABI is stale');
  const deploy = async (a: typeof mock, args: readonly unknown[]) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet(0).deployContract({
      abi: a.abi, bytecode: a.bytecode.object, args }) });
    assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress);
    return receipt;
  };
  const mockReceipt = await deploy(mock, []);
  const paymentToken = mockReceipt.contractAddress!;
  const deployment = await deploy(registryArtifact, [admin.address, paymentToken, admin.address]);
  const registry = deployment.contractAddress!;
  for (const vector of sharedIdentityVectors) {
    assert.equal(await publicClient.readContract({ address: registry, abi: sharedRegistryAbi,
      functionName: 'namespaceIdFor', args: [vector.tld] }), vector.namespaceId);
    assert.equal(await publicClient.readContract({ address: registry, abi: sharedRegistryAbi,
      functionName: 'nameKeyFor', args: [vector.namespaceId, vector.label] }), vector.nameKey);
    assert.equal(await publicClient.readContract({ address: registry, abi: sharedRegistryAbi,
      functionName: 'tokenIdFor', args: [vector.nameKey, BigInt(vector.generation)] }), BigInt(vector.tokenId));
  }
  const settle = () => testClient.mine({ blocks: 2 });
  await settle();
  const sourceCommit = execFileSync('/usr/bin/git', ['--no-replace-objects', '--no-optional-locks', 'rev-parse', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8', env: approvedReleaseEnvironment(fileURLToPath(ROOT)) }).trim();
  const source = parseSharedRegistrySource({ schema: 'pirate.shared-registry-source/1', protocolVersion: 3,
    sourceCommit, abiSha256: sharedRegistryAbiSha256, chainId: 31337, registry,
    runtimeCodeHash: keccak256((await publicClient.getCode({ address: registry }))!),
    deployment: { blockNumber: deployment.blockNumber.toString(), blockHash: deployment.blockHash,
      transactionHash: deployment.transactionHash },
    constructor: { admin: admin.address, paymentToken, treasury: admin.address },
    compiler: { version: '0.8.30', evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } });
  const metadataParent = new URL('.ignore/shared-names-registry-20261113/local-acceptance/', ROOT);
  mkdirSync(metadataParent, { recursive: true });
  const run = mkdtempSync(`${metadataParent.pathname}run-`);
  writeFileSync(`${run}/source.json`, `${json(source)}\n`, { flag: 'wx' });
  // Independent rebuild precedes issuance. A dirty/uncommitted contract change
  // cannot pass by merely hashing the code it just deployed.
  const releaseProof = await verifySharedRelease(source, RPC, buildTools);
  writeFileSync(`${run}/release-proof.json`, `${json(releaseProof)}\n`, { flag: 'wx' });
  const suffix = randomBytes(4).toString('hex');
  const tld = `shared${suffix}`;
  const otherTld = `other${suffix}`;
  await fund();
  await claimTlds({ [tld]: [hnsRecord(formatDelegation(registry, 31337))],
    [otherTld]: [hnsRecord(formatDelegation(registry, 31337))] });
  if (values['start-local']) await restartHnsd();
  const handshake = hsdRpcSource(REGTEST.nodeRpc);
  const spv = rootDnsSource('127.0.0.1', 26349, { label: 'allocated hnsd regtest' });
  const communityId = keccak256(stringToHex(`fixture-community-${suffix}`));
  const write = async (index: number, functionName: string, args: readonly unknown[]) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet(index).writeContract({
      address: registry, abi: sharedRegistryAbi, functionName, args } as never) });
    assert.equal(receipt.status, 'success');
    return receipt;
  };
  const refresh = async (name: string) => {
    const now = (await publicClient.getBlock()).timestamp;
    const observation = await handshake.lookup(name);
    await write(0, 'attestNamespace', [sharedNamespaceIdFor(name), keccak256(stringToHex(json(observation))), now, now + 86400n, true]);
  };
  for (const name of [tld, otherTld]) {
    const namespaceId = sharedNamespaceIdFor(name);
    await write(0, 'registerNamespace', [name, false]);
    await refresh(name);
    // Explicit disposable fixture values only, never a live pricing decision.
    await write(0, 'configurePolicy', [namespaceId, issuer.address, 5_000_000n, 10n]);
    await write(0, 'configureScope', [namespaceId, communityId, submitter.address, 3n, true]);
  }
  await settle();
  let localClock = Number((await publicClient.getBlock()).timestamp);
  const options = { source, expectedSourceSha256: sharedSourceSha256(source), rpcUrl: RPC, handshake, tld, now: () => localClock };
  const timing = { signingMarginSeconds: 60, inclusionMarginSeconds: 60 }; // Disposable fixture policy only.
  const operation = await prepareSharedClaim(options, { requestId: keccak256(stringToHex(`request-${suffix}`)),
    communityId, label: 'member001', recipient: member.address }, timing);
  writeFileSync(`${run}/original-operation.json`, `${json(operation)}\n`, { flag: 'wx' });
  const grantSignature = await issuer.signTypedData(sharedClaimTypedData(31337, registry, operation.claim));
  assert.equal(await publicClient.readContract({ address: registry, abi: sharedRegistryAbi,
    functionName: 'recipientAcceptanceHash', args: [operation.claim] }),
  hashTypedData(sharedAcceptanceTypedData(31337, registry, operation.claim)));
  const recipientSignature = await member.signTypedData(sharedAcceptanceTypedData(31337, registry, operation.claim));
  let journalPath: string | undefined;
  let persistedHash: Hex | undefined;
  const submitted = await submitSharedClaim(options, operation, { grantSignature, recipientSignature,
    submitter: submitter.address, nonce: await publicClient.getTransactionCount({ address: submitter.address }),
    gas: 1_500_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    maxGasCost: 15_000_000_000_000_000n,
    // Membership here is an explicit fixture grant, not service integration.
    authorizeOriginalOperation: async original => { assert.equal(original.requestHash, operation.requestHash); },
    signTransaction: transaction => submitter.signTransaction(transaction),
    persistSignedTransaction: async (original, raw, hash) => {
      assert.equal(original.requestHash, operation.requestHash);
      journalPath = await persistSharedClaimJournal(fileURLToPath(ROOT),
        ['.ignore', 'shared-names-registry-20261113', 'local-journals', suffix], 'signed-operation.json',
        JSON.stringify({ original, raw, hash }, (_, v) => typeof v === 'bigint' ? { bigint: v.toString() } : v));
      persistedHash = hash;
    } });
  assert.equal(submitted.transactionHash, persistedHash);
  await publicClient.waitForTransactionReceipt({ hash: submitted.transactionHash });
  await settle(); localClock = Number((await publicClient.getBlock()).timestamp);
  const authorizeRecovery = async () => { assert.ok(persistedHash); };
  assert.ok(journalPath);
  const recovered = JSON.parse(readFileSync(journalPath, 'utf8'), (_, v) => v && typeof v === 'object'
    && Object.keys(v).length === 1 && typeof v.bigint === 'string' && /^(0|[1-9][0-9]*)(?![\s\S])/.test(v.bigint)
    ? BigInt(v.bigint) : v) as { original: PreparedSharedClaim; raw: Hex; hash: Hex };
  assert.equal(keccak256(recovered.raw), recovered.hash);
  assert.deepEqual(recovered.original, operation);
  const results = await Promise.all([1, 2].map(() => reconcileSharedClaim(options, recovered.original, authorizeRecovery, recovered.hash)));
  assert.equal(results[0].state, 'consumed'); assert.deepEqual(results[0], results[1]);
  await write(2, 'setRecord', [operation.expectedTokenId, textKey('url'), stringToHex('https://example.invalid/member')]);
  await write(2, 'setRecordManager', [operation.expectedTokenId, submitter.address]);
  await settle(); localClock = Number((await publicClient.getBlock()).timestamp);
  const resolved = await resolveSharedName({ ...options, name: `member001.${tld}`, textKeys: ['url'] });
  assert.equal(resolved.token.holder, member.address);
  assert.equal(resolved.records.text.url, 'https://example.invalid/member');
  const spvDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      const answer = await resolveSharedName({ ...options, handshake: spv, name: `member001.${tld}` });
      assert.equal(answer.token.tokenId, operation.expectedTokenId); break;
    } catch (error) { if (Date.now() >= spvDeadline) throw error; await sleep(250); }
  }
  await assert.rejects(prepareSharedClaim(options, { communityId, requestId: keccak256(stringToHex('short-fixture')),
    label: 'short', recipient: member.address }, timing));
  const independent = await prepareSharedClaim({ ...options, tld: otherTld }, {
    communityId, requestId: keccak256(stringToHex('other-fixture')), label: 'member001', recipient: member.address }, timing);
  assert.notEqual(independent.expectedTokenId, operation.expectedTokenId);
  await write(2, 'transferFrom', [member.address, nextHolder.address, operation.expectedTokenId]);
  await write(0, 'configurePolicy', [sharedNamespaceIdFor(tld), issuer.address, 9_000_000n, 10n]);
  await settle(); localClock = Number((await publicClient.getBlock()).timestamp);
  const afterTransfer = await reconcileSharedClaim({ ...options, handshake: { description: 'unavailable',
    lookup: async () => { throw new Error('historical recovery must not use HNS'); } } }, operation, authorizeRecovery, persistedHash);
  assert.equal(afterTransfer.state, 'consumed');
  assert.ok(afterTransfer.state === 'consumed' && afterTransfer.current.state === 'observed');
  assert.equal(afterTransfer.current.registrant, nextHolder.address);
  assert.equal(afterTransfer.original.recipient, member.address);
  assert.equal(await publicClient.readContract({ address: registry, abi: sharedRegistryAbi,
    functionName: 'recordManager', args: [operation.expectedTokenId] }), '0x0000000000000000000000000000000000000000');
  const renewal = await prepareSharedRenewal(options, operation.expectedTokenId, 1, 5_000_000n, BigInt(localClock + 600));
  assert.equal(renewal.cost, 5_000_000n, 'new policy must not reprice existing generation');
  for (const [functionName, args] of [['mint', [member.address, 5_000_000n]], ['approve', [registry, 5_000_000n]]] as const) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet(2).writeContract({
      address: paymentToken, abi: mock.abi, functionName, args } as never) });
    assert.equal(receipt.status, 'success');
  }
  const renewed = await publicClient.waitForTransactionReceipt({ hash: await wallet(2).sendTransaction({ to: registry, data: renewal.data }) });
  assert.equal(renewed.status, 'success');
  const report = { schema: 'pirate.shared-names-local-acceptance/1', passed: true, sourceCommit, source,
    sourceSha256: options.expectedSourceSha256, requestHash: operation.requestHash, transactionHash: persistedHash,
    tokenId: operation.expectedTokenId, namespaces: [tld, otherTld], proofs: ['committed-source rebuild', 'full-node HNS',
      'SPV HNS', 'separate signatures', 'durable original transaction', 'concurrent receipt reads', 'records', 'transfer', 'locked renewal'],
    serviceIntegration: 'UNRUN: membership/grant persistence is fixture-only; no application/operator/backend acceptance', run };
  writeFileSync(`${run}/report.json`, `${json(report)}\n`, { flag: 'wx' });
  console.log(json(report));
}

async function runAllocated() {
  if (!values['start-local']) return main();
  assert.equal(process.env.CI, 'true', '--start-local requires an isolated CI runner; Root owns local services');
  assert.equal(values['execute-local'], true);
  assert.ok(values.tools);
  await assertPortsFree([18545, 14037, 14038, 14039, 26349, 26350]);
  const parent = new URL('.ignore/shared-names-registry-20261113/ci-services/', ROOT);
  mkdirSync(parent, { recursive: true });
  const prefix = mkdtempSync(`${parent.pathname}run-`);
  try { await startAnvil(); await startHsd(prefix); await main(); }
  finally { await stopAll(); }
}

runAllocated().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
