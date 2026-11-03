// Base Sepolia rehearsal: the real testnet contracts from the bundled
// manifest, with a local hsd regtest TLD standing in for the Handshake TLD
// the operator has not bought yet. The buyer purchases through the verified
// CLI and the name is resolved through hnsd and the public Sepolia RPC with
// the system clock (no override). Uses OPERATOR_PRIVATE_KEY and
// BUYER_PRIVATE_KEY from .env. Usage: node harness/sepolia-rehearsal.ts [registry]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { formatDelegation, loadManifest } from '@pirate-registry/resolver';
import * as sdk from '@pirate-registry/sdk';
import { claimTld, fund, ns } from './lib/hsd.ts';
import { assertPortsFree, HNSD_NS, restartHnsd, startHsd, stopAll } from './lib/processes.ts';

const ROOT = new URL('../', import.meta.url);
const RUN_DIR = new URL('./.run/', import.meta.url);
process.loadEnvFile(new URL('.env', ROOT).pathname);
const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const client = createPublicClient({ transport: http(RPC) });
const log: Record<string, unknown> = { at: new Date().toISOString(), rpc: RPC };

function cli(args: string[]) {
  const run = spawnSync('node', ['packages/sdk/src/cli.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(run.stdout);
  } catch {}
  return { code: run.status ?? 1, json, stderr: run.stderr, stdout: run.stdout };
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

async function main() {
  mkdirSync(RUN_DIR, { recursive: true });
  const manifest = loadManifest();
  const chain = manifest.chains['84532'];
  assert.ok(chain, 'bundled manifest has no Base Sepolia entry');

  const operator = await sdk.connect(RPC, process.env.OPERATOR_PRIVATE_KEY as Hex);
  const buyerAddress = process.env.BUYER_ADDRESS as Address;

  let registry = process.argv[2] as Address | undefined;
  if (!registry) {
    const deployed = await sdk.deployRegistry(operator, chain.factory, {
      tld: 'testtld',
      admin: operator.account.address,
      treasury: operator.account.address,
      annualPrice: 1_000_000n,
    });
    registry = deployed.registry;
    const receipt = await client.getTransactionReceipt({ hash: deployed.transaction });
    log.registryDeployment = { registry, transaction: deployed.transaction, block: receipt.blockNumber.toString() };
    console.log(`registry ${registry} deployed in block ${receipt.blockNumber}`);
    await waitForSafe(receipt.blockNumber, 'registry deployment');
  }
  log.registry = registry;

  await assertPortsFree([14037, 14038, 14039, 25349, 25350, 26349, 26350]);
  await startHsd(new URL('hsd-sepolia', RUN_DIR).pathname);
  await fund();
  await claimTld('testtld', [ns(formatDelegation(registry, 84532))]);
  await restartHnsd();
  log.delegation = formatDelegation(registry, 84532);

  const source = ['--hnsd', `${HNSD_NS.host}:${HNSD_NS.port}`];
  const verified = await cliUntilFresh(['verify-registry', '--tld', 'testtld', ...source, '--chain-rpc', `84532=${RPC}`], 'verify');
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  log.verifyRegistry = verified.json;

  const bought = await cliUntilFresh(
    ['register', '--rpc', RPC, '--key-env', 'BUYER_PRIVATE_KEY', '--registry', registry, '--label', 'studio', '--years', '1',
      ...source, '--accept-disclosures'],
    'register',
  );
  assert.equal(bought.code, 0, bought.stdout + bought.stderr);
  log.register = bought.json;
  console.log(`bought studio.testtld: ${String(bought.json?.transaction)}`);

  const record = cli(['set-record', '--rpc', RPC, '--key-env', 'BUYER_PRIVATE_KEY', '--registry', registry, '--label', 'studio',
    '--type', 'A', '--value', '192.0.2.10']);
  assert.equal(record.code, 0, record.stdout + record.stderr);
  const recordReceipt = await client.getTransactionReceipt({ hash: record.json?.transaction as Hex });
  log.setRecord = { transaction: record.json?.transaction, block: recordReceipt.blockNumber.toString() };
  await waitForSafe(recordReceipt.blockNumber, 'record update');

  const resolved = await cliUntilFresh(['resolve', '--name', 'studio.testtld', ...source, '--chain-rpc', `84532=${RPC}`], 'resolve');
  assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);
  const answer = resolved.json as { token: { holder: string }; records: { dns: { A?: { values: string[] } } }; observedAt: { clock: string } };
  assert.equal(answer.token.holder.toLowerCase(), buyerAddress.toLowerCase());
  assert.deepEqual(answer.records.dns.A?.values, ['192.0.2.10']);
  assert.equal(answer.observedAt.clock, 'system');
  log.resolve = resolved.json;
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
    writeFileSync(new URL('sepolia-rehearsal.json', RUN_DIR), JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  });
