// MegaETH testnet rehearsal: the real testnet factory from the bundled
// manifest, with a local hsd regtest TLD standing in for a Handshake TLD. The
// operator deploys a registry with the 8+ open-sale band, prices one short
// label as premium and reserves it for the buyer. The buyer is refused a
// closed label, buys an open and the reserved label through the verified CLI,
// and the name resolves through hnsd and the MegaETH RPC on the system clock.
// Records block-tag lag and gas for every transaction.
//
// Environment (.env): OPERATOR_PRIVATE_KEY, BUYER_PRIVATE_KEY and optionally
// REGISTRY_RPC_URL (default https://carrot.megaeth.com/rpc).
// Usage: node harness/testnet-rehearsal.ts [registry]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, erc20Abi, formatEther, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatDelegation, loadManifest } from '@pirate-registry/resolver';
import * as sdk from '@pirate-registry/sdk';
import { claimTld, fund, ns } from './lib/hsd.ts';
import { assertPortsFree, HNSD_NS, restartHnsd, startHsd, stopAll } from './lib/processes.ts';

const CHAIN_ID = 6343;
/** Bounded test spend: the buyer is topped up to at most this much test ETH. */
const BUYER_GAS_TOPUP = parseEther('0.005');
const ROOT = new URL('../', import.meta.url);
const RUN_DIR = new URL('./.run/', import.meta.url);
process.loadEnvFile(new URL('.env', ROOT).pathname);
const RPC = process.env.REGISTRY_RPC_URL ?? 'https://carrot.megaeth.com/rpc';
const client = createPublicClient({ transport: http(RPC) });
const log: Record<string, unknown> = { at: new Date().toISOString(), rpc: RPC, chainId: CHAIN_ID };
const gas: Array<{ step: string; transaction: Hex; gasUsed: string; effectiveGasPrice: string; feeWei: string }> = [];

function cli(args: string[]) {
  const run = spawnSync('node', ['packages/sdk/src/cli.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(run.stdout);
  } catch {}
  return { code: run.status ?? 1, json, stderr: run.stderr, stdout: run.stdout };
}

async function recordGas(step: string, transaction: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: transaction });
  gas.push({
    step,
    transaction,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
  });
  return receipt;
}

async function blockTags() {
  const [latest, safe, finalized] = await Promise.all(
    (['latest', 'safe', 'finalized'] as const).map((blockTag) => client.getBlock({ blockTag })),
  );
  return {
    latest: { number: latest.number.toString(), timestamp: latest.timestamp.toString() },
    safeLag: { blocks: (latest.number - safe.number).toString(), seconds: (latest.timestamp - safe.timestamp).toString() },
    finalizedLag: { blocks: (latest.number - finalized.number).toString(), seconds: (latest.timestamp - finalized.timestamp).toString() },
  };
}

async function waitForSafe(blockNumber: bigint, what: string) {
  for (let i = 0; i < 80; i++) {
    const safe = await client.getBlock({ blockTag: 'safe' });
    if (safe.number >= blockNumber) return;
    await sleep(15_000);
  }
  throw new Error(`${what} (block ${blockNumber}) did not reach the safe head in 20 minutes`);
}

/** Retries a CLI call while its safe block is stale; never relaxes the limit. */
async function cliUntilFresh(args: string[], label: string) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const result = cli(args);
    if (result.json?.error !== 'stale_state') return result;
    console.log(`${label}: safe block stale (${String(result.json?.message)}); waiting`);
    await sleep(30_000);
  }
  throw new Error(`${label}: safe block stayed stale`);
}

function ok(result: ReturnType<typeof cli>, what: string) {
  assert.equal(result.code, 0, `${what}: ${result.stdout}${result.stderr}`);
  return result.json ?? {};
}

async function main() {
  mkdirSync(RUN_DIR, { recursive: true });
  assert.equal(await client.getChainId(), CHAIN_ID, `${RPC} is not MegaETH testnet`);
  const manifest = loadManifest();
  const chain = manifest.chains[String(CHAIN_ID)];
  assert.ok(chain, 'bundled manifest has no MegaETH testnet entry');
  log.manifestRelease = manifest.release;
  log.blockTagsAtStart = await blockTags();

  const operator = await sdk.connect(RPC, process.env.OPERATOR_PRIVATE_KEY as Hex);
  const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as Hex).address;
  log.operator = operator.account.address;
  log.buyer = buyer;

  const buyerBalance = await client.getBalance({ address: buyer });
  if (buyerBalance < BUYER_GAS_TOPUP / 2n) {
    const hash = await operator.walletClient.sendTransaction({
      to: buyer,
      value: BUYER_GAS_TOPUP - buyerBalance,
      account: operator.account,
      chain: operator.chain,
    });
    await client.waitForTransactionReceipt({ hash });
    await recordGas('buyer gas top-up', hash);
  }
  const tokenBalance = await client.readContract({ address: chain.paymentToken, abi: erc20Abi, functionName: 'balanceOf', args: [buyer] });
  if (tokenBalance < 50_000_000n) {
    const receipt = await sdk.mintTestToken(operator, chain.paymentToken, buyer, 100_000_000n);
    await recordGas('mint test token to buyer', receipt.transactionHash);
  }

  const opKey = ['--rpc', RPC, '--key-env', 'OPERATOR_PRIVATE_KEY'];
  let registry = process.argv[2] as Address | undefined;
  if (!registry) {
    const deployed = ok(
      cli(['deploy-registry', ...opKey, '--factory', chain.factory, '--tld', 'testtld', '--treasury', operator.account.address,
        '--price', '1', '--min-length', '8']),
      'deploy-registry',
    );
    registry = deployed.registry as Address;
    const receipt = await recordGas('deploy registry (closed)', deployed.transaction as Hex);
    await recordGas('open the 8+ band', deployed.tableTransaction as Hex);
    log.registryDeployment = { registry, transaction: deployed.transaction, block: receipt.blockNumber.toString() };
    console.log(`registry ${registry} deployed in block ${receipt.blockNumber}`);
  }
  log.registry = registry;

  // Reserve before pricing: a premium on an unreserved label would open it to anyone first.
  const reserved = ok(cli(['reserve', ...opKey, '--registry', registry, '--label', 'ceo', '--to', buyer]), 'reserve');
  await recordGas('reserve ceo for the buyer', reserved.transaction as Hex);
  const premium = ok(cli(['set-premium', ...opKey, '--registry', registry, '--label', 'ceo', '--price', '2']), 'set-premium');
  const reservedReceipt = await recordGas('premium price for ceo', premium.transaction as Hex);
  log.policy = ok(cli(['policy', '--rpc', RPC, '--registry', registry, '--label', 'ceo']), 'policy');
  await waitForSafe(reservedReceipt.blockNumber, 'sale policy');

  await assertPortsFree([14037, 14038, 14039, 25349, 25350, 26349, 26350]);
  await startHsd(new URL('hsd-megaeth', RUN_DIR).pathname);
  await fund();
  await claimTld('testtld', [ns(formatDelegation(registry, CHAIN_ID))]);
  await restartHnsd();
  log.delegation = formatDelegation(registry, CHAIN_ID);

  const source = ['--hnsd', `${HNSD_NS.host}:${HNSD_NS.port}`];
  const chainRpc = ['--chain-rpc', `${CHAIN_ID}=${RPC}`];
  log.verifyRegistry = ok(await cliUntilFresh(['verify-registry', '--tld', 'testtld', ...source, ...chainRpc], 'verify'), 'verify-registry');

  const closed = ok(cli(['check', '--rpc', RPC, '--registry', registry, '--label', 'studio']), 'check closed label');
  assert.equal(closed.forSale, false, 'a six-letter label must be closed in the 8+ band');
  log.closedLabel = closed;

  const buyArgs = (label: string) =>
    ['register', '--rpc', RPC, '--key-env', 'BUYER_PRIVATE_KEY', '--registry', registry, '--label', label, '--years', '1',
      ...source, '--accept-disclosures'];
  const bought = ok(await cliUntilFresh(buyArgs('studiohq'), 'register studiohq'), 'register studiohq');
  await recordGas('register studiohq (approve included separately)', bought.transaction as Hex);
  log.register = bought;
  const ceo = ok(await cliUntilFresh(buyArgs('ceo'), 'register ceo'), 'register ceo');
  await recordGas('register reserved premium ceo', ceo.transaction as Hex);
  log.registerReserved = ceo;

  const record = ok(
    cli(['set-record', '--rpc', RPC, '--key-env', 'BUYER_PRIVATE_KEY', '--registry', registry, '--label', 'studiohq',
      '--type', 'A', '--value', '192.0.2.10']),
    'set-record',
  );
  const recordReceipt = await recordGas('set A record', record.transaction as Hex);
  log.setRecord = { transaction: record.transaction, block: recordReceipt.blockNumber.toString() };
  await waitForSafe(recordReceipt.blockNumber, 'record update');

  const resolved = ok(await cliUntilFresh(['resolve', '--name', 'studiohq.testtld', ...source, ...chainRpc], 'resolve'), 'resolve');
  const answer = resolved as { token: { holder: string }; records: { dns: { A?: { values: string[] } } }; observedAt: { clock: string } };
  assert.equal(answer.token.holder.toLowerCase(), buyer.toLowerCase());
  assert.deepEqual(answer.records.dns.A?.values, ['192.0.2.10']);
  assert.equal(answer.observedAt.clock, 'system');
  log.resolve = resolved;
  log.blockTagsAtEnd = await blockTags();
  log.operatorBalanceAfter = formatEther(await client.getBalance({ address: operator.account.address }));
  console.log('REHEARSAL OK');
}

main()
  .catch((error: unknown) => {
    log.error = (error as Error).stack ?? String(error);
    console.error(log.error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopAll();
    log.gas = gas;
    writeFileSync(new URL('testnet-rehearsal.json', RUN_DIR), JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  });
