// Local acceptance (SPEC section 11.1). Starts anvil, hsd regtest and hnsd,
// then runs the ten steps against the independent resolver. Needs free ports
// 18545, 14037-14039, 25349-25350, 26349-26350 and the hnsd image
// (docker build -t pirate-registry-hnsd:v2.0.0-regtest harness/hnsd).
// Usage: node harness/acceptance.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  bytesToHex,
  createPublicClient,
  erc20Abi,
  createTestClient,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  formatDelegation,
  hsdRpcSource,
  loadManifest,
  registryAbi,
  resolveName,
  ResolveError,
  rootDnsSource,
  type HandshakeSource,
  type ReleaseManifest,
  type ResolveResult,
} from '@pirate-registry/resolver';
import * as sdk from '@pirate-registry/sdk';
import { claimTld, claimTlds, fund, ns, REGTEST, updateTld } from './lib/hsd.ts';
import { ANVIL_URL, assertPortsFree, HNSD_NS, restartHnsd, startAnvil, startHsd, stopAll } from './lib/processes.ts';

const RUN_DIR = new URL('./.run/', import.meta.url);
const ROOT = new URL('../', import.meta.url);
const MNEMONIC = 'test test test test test test test test test test test junk';
const keyOf = (index: number): Hex => bytesToHex(mnemonicToAccount(MNEMONIC, { addressIndex: index }).getHdKey().privateKey!);
const USDC = (n: number) => parseUnits(String(n), 6);
const YEAR = 365 * 24 * 60 * 60;
const GRACE = 30 * 24 * 60 * 60;
const mockUsdcAbi = parseAbi([
  'function mint(address,uint256)',
  'function setBlacklisted(address,bool)',
  'function balanceOf(address) view returns (uint256)',
]);

const publicClient = createPublicClient({ transport: http(ANVIL_URL) });
const testClient = createTestClient({ mode: 'anvil', transport: http(ANVIL_URL) });
const results: Array<{ step: string; ok: boolean; detail?: string }> = [];

async function step(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.push({ step: name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ step: name, ok: false, detail: (error as Error).stack ?? String(error) });
    console.log(`FAIL ${name}\n${(error as Error).stack ?? error}`);
    throw error;
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ResolveError, `expected ResolveError ${code}, got ${(error as Error).message}`);
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail(`expected ${code}, but resolution succeeded`);
}

async function expectRevert(promise: Promise<unknown>, what: string): Promise<void> {
  await assert.rejects(promise, Error, `${what} should revert`);
}

/** Runs the CLI as a buyer would, with the key passed through the environment. */
function cli(args: string[], key?: Hex): { code: number; json: Record<string, unknown> | undefined; stderr: string } {
  const run = spawnSync('node', ['packages/sdk/src/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ACCEPTANCE_KEY: key ?? '' },
  });
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(run.stdout);
  } catch {}
  return { code: run.status ?? 1, json, stderr: run.stderr };
}

/** Two blocks so `safe` (latest - 1) includes the last transaction. */
const settle = () => testClient.mine({ blocks: 2 });
const chainNow = async () => Number((await publicClient.getBlock()).timestamp);
async function warpTo(timestamp: number) {
  const now = await chainNow();
  if (timestamp > now) await testClient.increaseTime({ seconds: timestamp - now });
  await settle();
}

async function main() {
  mkdirSync(RUN_DIR, { recursive: true });
  await assertPortsFree([18545, 14037, 14038, 14039, 25349, 25350, 26349, 26350]);
  await startAnvil();
  await startHsd(new URL('hsd', RUN_DIR).pathname);
  await fund();

  const [operator, buyer, holderB, payer, rebuyer, manager] = await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) => sdk.connect(ANVIL_URL, keyOf(i))),
  );
  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 6 }).address;
  const newTreasury = mnemonicToAccount(MNEMONIC, { addressIndex: 7 }).address;

  // Mock USDC with blacklist and pause, from the solc build.
  const mock = JSON.parse(readFileSync(new URL('out/MockUSDC.sol/MockUSDC.json', ROOT), 'utf8')) as { bytecode: { object: Hex } };
  const usdcReceipt = await publicClient.waitForTransactionReceipt({
    hash: await operator.walletClient.deployContract({
      abi: mockUsdcAbi,
      bytecode: mock.bytecode.object,
      account: operator.account,
      chain: operator.chain,
    }),
  });
  const usdc = usdcReceipt.contractAddress as Address;
  const usdcWrite = async (functionName: 'mint' | 'setBlacklisted', args: readonly unknown[]) =>
    publicClient.waitForTransactionReceipt({
      hash: await operator.walletClient.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName,
        args,
        account: operator.account,
        chain: operator.chain,
      } as never),
    });
  for (const s of [buyer, holderB, payer, rebuyer]) await usdcWrite('mint', [s.account.address, USDC(1000)]);

  let manifest!: ReleaseManifest;
  let factory!: Address;
  let registry!: Address;
  let studioId!: bigint;
  const hsd: HandshakeSource = hsdRpcSource(REGTEST.nodeRpc);
  const hnsd: HandshakeSource = rootDnsSource(HNSD_NS.host, HNSD_NS.port, { label: 'hnsd' });
  const resolve = async (name: string, handshake: HandshakeSource, extra: Partial<Parameters<typeof resolveName>[0]> = {}) =>
    resolveName({ name, handshake, rpcUrls: { '31337': ANVIL_URL }, manifest, now: await chainNow(), textKeys: ['url'], ...extra });

  await step('1-2 deploy factory and registry, delegate testtld on Handshake', async () => {
    const deployed = await sdk.deployFactory(operator, usdc);
    factory = deployed.factory;
    await settle();
    // The manifest comes from an independent rebuild of the committed source,
    // compared byte for byte with what was just deployed, not from the
    // deployed code itself. Uncommitted source changes make this fail.
    const manifestPath = new URL('manifest.local.json', RUN_DIR);
    rmSync(manifestPath, { force: true });
    const verified = spawnSync(
      'node',
      ['scripts/verify-release.ts', '--rpc', ANVIL_URL, '--factory', factory, '--name', 'anvil', '--block', 'safe',
        '--write-manifest', manifestPath.pathname],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(verified.status, 0, `release verification failed: ${verified.stdout}${verified.stderr}`);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.implementationMatches, true);
    assert.equal(report.factoryMatchesOutsideImmutables, true);
    manifest = loadManifest(manifestPath);
    assert.equal(manifest.chains['31337'].implementation, deployed.implementation);
    ({ registry } = await sdk.deployRegistry(operator, factory, {
      tld: 'testtld',
      admin: operator.account.address,
      treasury,
      annualPrice: USDC(5),
    }));
    await claimTld('testtld', [ns(formatDelegation(registry, 31337))]);
    await settle();
  });

  const manifestFile = () => new URL('manifest.local.json', RUN_DIR).pathname;
  const purchaseArgs = async (target: Address, label: string) => [
    'register', '--rpc', ANVIL_URL, '--key-env', 'ACCEPTANCE_KEY', '--registry', target, '--label', label, '--years', '1',
    '--hnsd', `${HNSD_NS.host}:${HNSD_NS.port}`, '--manifest', manifestFile(), '--now', String(await chainNow()),
    '--accept-disclosures',
  ];

  await step('3 buy studio.testtld through the verified CLI, set records, resolve through hsd and hnsd', async () => {
    await restartHnsd();
    const bought = cli(await purchaseArgs(registry, 'studio'), keyOf(1));
    assert.equal(bought.code, 0, bought.stderr);
    assert.equal(bought.json?.delegationBefore, formatDelegation(registry, 31337));
    assert.equal(bought.json?.delegationAfter, 'verified');
    assert.match(bought.stderr, /Delegation verified/);
    assert.match(bought.stderr, /no commit-reveal/);
    studioId = BigInt(bought.json?.tokenId as string);
    await sdk.setDnsRecord(buyer, registry, studioId, { type: 'A', values: ['192.0.2.1'] });
    await sdk.setDnsRecord(buyer, registry, studioId, { type: 'TXT', values: ['hello'] });
    await sdk.setDnsRecord(buyer, registry, studioId, { relativeName: 'www', type: 'A', values: ['192.0.2.2'] });
    await sdk.setText(buyer, registry, studioId, 'url', 'https://studio.example');
    await sdk.setAddr(buyer, registry, studioId, buyer.account.address);
    await settle();

    const check = (r: ResolveResult) => {
      assert.equal(r.token.holder, buyer.account.address);
      assert.equal(r.registry.address, registry);
      assert.deepEqual(r.records.dns.A?.values, ['192.0.2.1']);
      assert.deepEqual(r.records.dns.TXT?.values, [['hello']]);
      assert.equal(r.records.text.url, 'https://studio.example');
      assert.equal(r.records.addr['60'], buyer.account.address);
      assert.equal(r.evm.trust, 'local-rpc');
    };
    const viaHsd = await resolve('studio.testtld', hsd);
    check(viaHsd);
    assert.equal(viaHsd.handshake.trust, 'local-full-node');
    assert.ok(viaHsd.handshake.tldRenewal && viaHsd.handshake.tldRenewal.blocksUntilExpire > 0);
    const www = await resolve('www.studio.testtld', hsd, { dnsTypes: ['A'] });
    assert.deepEqual(www.records.dns.A?.values, ['192.0.2.2']);

    const viaHnsd = await resolve('studio.testtld', hnsd);
    check(viaHnsd);
    assert.equal(viaHnsd.handshake.trust, 'local-spv');

    // The CLI path, as an operator or third party would run it.
    const resolveOut = execFileSync(
      'node',
      ['packages/sdk/src/cli.ts', 'resolve', '--name', 'studio.testtld', '--hnsd', `${HNSD_NS.host}:${HNSD_NS.port}`,
        '--chain-rpc', `31337=${ANVIL_URL}`, '--manifest', new URL('manifest.local.json', RUN_DIR).pathname,
        '--now', String(await chainNow())],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(JSON.parse(resolveOut).token.holder, buyer.account.address);
    writeFileSync(new URL('resolve-hnsd.json', RUN_DIR), JSON.stringify(viaHnsd, null, 2));
  });

  await step('4 transfer to a new holder: records kept, record manager cleared', async () => {
    await sdk.setRecordManager(buyer, registry, studioId, manager.account.address);
    await sdk.setText(manager, registry, studioId, 'url', 'https://managed.example');
    await sdk.transfer(buyer, registry, studioId, holderB.account.address);
    await settle();
    const r = await resolve('studio.testtld', hsd);
    assert.equal(r.token.holder, holderB.account.address);
    assert.deepEqual(r.records.dns.A?.values, ['192.0.2.1']);
    assert.equal(r.records.text.url, 'https://managed.example');
    const recordManager = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'recordManager', args: [studioId] });
    assert.equal(recordManager, '0x0000000000000000000000000000000000000000');
    await expectRevert(sdk.setText(manager, registry, studioId, 'url', 'https://stale.example'), 'old manager write');
  });

  let renewedExpiry = 0;
  await step('5 expiry stops resolution; a third party renews in grace from the old expiry', async () => {
    const expiry = Number(await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'expiresAt', args: [studioId] }));
    await warpTo(expiry + 60);
    await expectCode(resolve('studio.testtld', hsd), 'not_active');
    await expectRevert(sdk.transfer(holderB, registry, studioId, buyer.account.address), 'transfer in grace');
    await sdk.renew(payer, registry, studioId, 1);
    await settle();
    renewedExpiry = Number(await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'expiresAt', args: [studioId] }));
    assert.equal(renewedExpiry, expiry + YEAR);
    const r = await resolve('studio.testtld', hsd);
    assert.equal(r.token.holder, holderB.account.address);
  });

  await step('6 after grace a new buyer re-registers: new token, no records, old token superseded', async () => {
    await warpTo(renewedExpiry + GRACE + 60);
    await expectCode(resolve('studio.testtld', hsd), 'not_active');
    const again = await sdk.register(rebuyer, registry, { label: 'studio', years: 1 });
    await settle();
    assert.notEqual(again.tokenId, studioId);
    assert.equal(again.generation, 2n);
    const r = await resolve('studio.testtld', hsd);
    assert.equal(r.token.holder, rebuyer.account.address);
    assert.equal(r.token.generation, '2');
    assert.deepEqual(r.records.dns, {});
    assert.deepEqual(r.records.text, {});
    const oldStatus = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'status', args: [studioId] });
    assert.equal(oldStatus, 4); // Superseded
    await expectRevert(sdk.renew(payer, registry, studioId, 1), 'renewing the superseded token');
    studioId = again.tokenId;
  });

  await step('7 blacklisted treasury blocks only sweeps; blacklisted registry blocks paid operations', async () => {
    await usdcWrite('setBlacklisted', [treasury, true]);
    await sdk.register(buyer, registry, { label: 'paid', years: 1 });
    await expectRevert(sdk.sweep(payer, registry), 'sweep to a blacklisted treasury');
    const held = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: 'balanceOf', args: [registry] });
    await sdk.setTreasury(operator, registry, newTreasury);
    await sdk.sweep(payer, registry);
    assert.equal(await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: 'balanceOf', args: [newTreasury] }), held);
    await usdcWrite('setBlacklisted', [registry, true]);
    await expectRevert(sdk.register(buyer, registry, { label: 'blocked', years: 1 }), 'paid registration into a blacklisted registry');
    await usdcWrite('setBlacklisted', [registry, false]);
    await settle();
  });

  await step('8 repointing testtld to a second registry: the resolver follows it', async () => {
    const { registry: second } = await sdk.deployRegistry(operator, factory, {
      tld: 'testtld',
      admin: operator.account.address,
      treasury,
      annualPrice: USDC(1),
    });
    await sdk.register(holderB, second, { label: 'studio', years: 1 });
    await updateTld('testtld', [ns(formatDelegation(second, 31337))]);
    await settle();
    const r = await resolve('studio.testtld', hsd);
    assert.equal(r.registry.address, second);
    assert.equal(r.token.holder, holderB.account.address);
    // hnsd caches the old referral for its TTL; a fresh cache sees the new one.
    await restartHnsd();
    const viaHnsd = await resolve('studio.testtld', hnsd);
    assert.equal(viaHnsd.registry.address, second);
  });

  await step('9 forged and malformed delegations fail with their specific codes', async () => {
    const { factory: otherFactory } = await sdk.deployFactory(operator, usdc);
    const { registry: unknownImplementation } = await sdk.deployRegistry(operator, otherFactory, {
      tld: 'forged-impl',
      admin: operator.account.address,
      treasury,
      annualPrice: USDC(1),
    });
    const { registry: otherTld } = await sdk.deployRegistry(operator, factory, {
      tld: 'othertld',
      admin: operator.account.address,
      treasury,
      annualPrice: USDC(1),
    });
    await claimTlds({
      'forged-nonclone': [ns(formatDelegation(usdc, 31337))],
      'forged-impl': [ns(formatDelegation(unknownImplementation, 31337))],
      'forged-tld': [ns(formatDelegation(otherTld, 31337))],
      'forged-chain': [ns(formatDelegation(registry, 1))],
      'forged-two': [ns(formatDelegation(registry, 31337)), ns(formatDelegation(otherTld, 31337))],
      'forged-bad': [ns('0x1234.31337._evm.')],
      'forged-none': [ns('ns1.example.')],
    });
    await settle();
    await expectCode(resolve('a.forged-nonclone', hsd), 'code_mismatch');
    await expectCode(resolve('a.forged-impl', hsd), 'code_mismatch');
    await expectCode(resolve('a.forged-tld', hsd), 'tld_mismatch');
    await expectCode(resolve('a.forged-chain', hsd), 'chain_not_allowed');
    // A manifest that lists chain 1 and an RPC that is really anvil (31337).
    const lying = { ...manifest, chains: { ...manifest.chains, '1': manifest.chains['31337'] } };
    await expectCode(resolve('a.forged-chain', hsd, { manifest: lying, rpcUrls: { '1': ANVIL_URL } }), 'chain_mismatch');
    await expectCode(resolve('a.forged-two', hsd), 'delegation_ambiguous');
    await expectCode(resolve('a.forged-bad', hsd), 'delegation_malformed');
    await expectCode(resolve('a.forged-none', hsd), 'delegation_missing');
    await expectCode(resolve('a.unclaimedtld', hsd), 'delegation_missing');
    await expectCode(resolve('nobody.testtld', hsd), 'not_registered');

    // Purchases from registries the Handshake delegation does not name fail
    // before any USDC is approved: one for an unclaimed TLD, and the original
    // testtld registry, which step 8 left undelegated.
    await restartHnsd();
    for (const [target, code] of [
      [otherTld, 'delegation_missing'],
      [registry, 'config_mismatch'],
    ] as const) {
      const allowance = () =>
        publicClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [buyer.account.address, target],
        });
      const before = await allowance();
      const balanceBefore = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [buyer.account.address] });
      const attempt = cli(await purchaseArgs(target, 'stray'), keyOf(1));
      assert.notEqual(attempt.code, 0, `purchase from ${target} should be refused`);
      assert.equal(attempt.json?.error, code, attempt.stderr);
      assert.equal(await allowance(), before, 'a refused purchase must not change the USDC approval');
      assert.equal(
        await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [buyer.account.address] }),
        balanceBefore,
        'a refused purchase must not move USDC',
      );
    }
  });

  await step('10 local-only trust, remote guard, freshness and clock checks', async () => {
    const r = await resolve('studio.testtld', hnsd);
    assert.equal(r.handshake.trust, 'local-spv');
    assert.equal(r.evm.trust, 'local-rpc');
    assert.throws(() => rootDnsSource('192.0.2.53', 53), (e: unknown) => e instanceof ResolveError && e.code === 'handshake_unavailable');
    assert.throws(() => hsdRpcSource('http://192.0.2.53:12037/'), (e: unknown) => e instanceof ResolveError && e.code === 'handshake_unavailable');
    const now = await chainNow();
    await expectCode(resolve('studio.testtld', hsd, { now: now + 3600 }), 'stale_state');
    await expectCode(resolve('studio.testtld', hsd, { now: now - 3600 }), 'clock_skew');

    // The clock is read again before returning: a name that expires while
    // records are read is refused, and TTLs count down from the final reading.
    const expiry = r.token.expiry;
    let reads = 0;
    await expectCode(resolve('studio.testtld', hsd, { now: () => (reads++ === 0 ? now : expiry + 1) }), 'not_active');
    // The block's age is rechecked too.
    reads = 0;
    await expectCode(resolve('studio.testtld', hsd, { now: () => (reads++ === 0 ? now : now + 2000) }), 'stale_state');
    // With the age limit raised, the TTL counts down from the final reading.
    await sdk.setDnsRecord(holderB, r.registry.address, BigInt(r.token.tokenId), { type: 'A', values: ['192.0.2.9'] });
    await settle();
    const t0 = await chainNow();
    reads = 0;
    const late = await resolve('studio.testtld', hsd, {
      now: () => (reads++ === 0 ? t0 : expiry - 100),
      maxAgeSeconds: 10 * YEAR,
      dnsTypes: ['A'],
    });
    assert.equal(late.observedAt.hostTime, expiry - 100);
    assert.equal(late.records.dns.A?.ttl, 100);
  });
}

main()
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopAll();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(new URL('acceptance-report.json', RUN_DIR), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} steps passed${failed || results.length < 9 ? ' (incomplete)' : ''}`);
  });
