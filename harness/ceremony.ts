// Real Handshake ceremony (SPEC 11.2): a mainnet TLD delegated to a testnet
// registry (MegaETH testnet, 6343, since release megaeth-testnet-1; the c22
// ceremony of 2026-11-03 used Base Sepolia). Runs only after the independent
// resolver verifies the delegation; it refuses to buy otherwise. Drives the
// user-facing CLI and writes an evidence file.
//
// Environment: BUYER_PRIVATE_KEY, BUYER_ADDRESS, OPERATOR_ADDRESS (transfer
// recipient), REGISTRY_RPC_URL and REGISTRY_CHAIN_ID.
// Usage: node harness/ceremony.ts --tld c22 --registry ADDR --hnsd HOST:PORT
//   --label studio --handshake-tx TXID --handshake-height N --handshake-block HASH
//   --registry-deploy-tx HASH --out FILE [--hnsd-container NAME]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createPublicClient, http, type Hex } from 'viem';
import { formatDelegation, loadManifest } from '@pirate-registry/resolver';

const ROOT = new URL('../', import.meta.url);
const { values } = parseArgs({
  options: {
    tld: { type: 'string' },
    registry: { type: 'string' },
    hnsd: { type: 'string' },
    label: { type: 'string', default: 'studio' },
    'handshake-tx': { type: 'string' },
    'handshake-height': { type: 'string' },
    'handshake-block': { type: 'string' },
    'registry-deploy-tx': { type: 'string' },
    'hnsd-container': { type: 'string', default: 'pirate-registry-hnsd-main' },
    out: { type: 'string' },
  },
});
for (const key of ['tld', 'registry', 'hnsd', 'handshake-tx', 'handshake-height', 'handshake-block', 'registry-deploy-tx', 'out'] as const) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
for (const key of ['BUYER_PRIVATE_KEY', 'BUYER_ADDRESS', 'OPERATOR_ADDRESS', 'REGISTRY_RPC_URL', 'REGISTRY_CHAIN_ID']) {
  if (!process.env[key]) throw new Error(`${key} must be set`);
}

const RPC = process.env.REGISTRY_RPC_URL as string;
const CHAIN_ID = Number(process.env.REGISTRY_CHAIN_ID);
const client = createPublicClient({ transport: http(RPC) });
const tld = values.tld as string;
const registry = values.registry as `0x${string}`;
const name = `${values.label}.${tld}`;
const source = ['--hnsd', values.hnsd as string, '--dns-timeout', '15000'];
const evidence: Record<string, unknown> = {
  ceremony: tld,
  startedAt: new Date().toISOString(),
  manifestRelease: loadManifest().release,
  handshake: {
    network: 'main',
    delegationRecord: formatDelegation(registry, CHAIN_ID),
    updateTransaction: values['handshake-tx'],
    updateBlock: { height: Number(values['handshake-height']), hash: values['handshake-block'] },
  },
  evm: { chainId: CHAIN_ID, rpc: RPC, registry, registryDeployTransaction: values['registry-deploy-tx'] },
};

function cli(args: string[]) {
  const run = spawnSync('node', ['packages/sdk/src/cli.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(run.stdout);
  } catch {}
  return { code: run.status ?? 1, json, stderr: run.stderr, stdout: run.stdout };
}

/** Retries only transient conditions; never relaxes a limit. */
async function cliRetrying(args: string[], label: string) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const result = cli(args);
    const error = result.json?.error;
    if (error !== 'stale_state' && error !== 'handshake_unavailable') return result;
    console.log(`${label}: ${String(error)} (${String(result.json?.message)}); retrying`);
    await sleep(30_000);
  }
  throw new Error(`${label}: stayed unavailable`);
}

async function waitForSafe(hash: Hex, what: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${what} reverted`);
  for (let i = 0; i < 80; i++) {
    if ((await client.getBlock({ blockTag: 'safe' })).number >= receipt.blockNumber) return receipt.blockNumber;
    await sleep(15_000);
  }
  throw new Error(`${what} did not reach the safe head in 20 minutes`);
}

/** hnsd's latest height from its log tail; null (kept in the evidence) if unreadable. */
function hnsdHeight(): number | null {
  try {
    const logs = execFileSync('docker', ['logs', '--tail', '5000', values['hnsd-container'] as string], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const heights = [...logs.matchAll(/new height: (\d+)/g)];
    return heights.length ? Number(heights[heights.length - 1][1]) : null;
  } catch (error) {
    console.error(`hnsd height unreadable: ${(error as Error).message}`);
    return null;
  }
}

const resolveSummary = (r: Record<string, unknown>) => {
  const answer = r as {
    observedAt: Record<string, unknown>;
    handshake: Record<string, unknown>;
    token: Record<string, unknown>;
    records: Record<string, unknown>;
    registry: Record<string, unknown>;
  };
  return {
    observedAt: answer.observedAt,
    handshake: answer.handshake,
    registry: answer.registry,
    token: answer.token,
    records: answer.records,
    hnsdHeight: hnsdHeight(),
  };
};

async function main() {
  // Gate 2: the independent resolver must verify the delegation first.
  const verified = await cliRetrying(['verify-registry', '--tld', tld, ...source, '--chain-rpc', `${CHAIN_ID}=${RPC}`], 'verify');
  assert.equal(verified.code, 0, `delegation not verified: ${verified.stdout}${verified.stderr}`);
  evidence.verifyRegistry = { ...verified.json, hnsdHeight: hnsdHeight() };
  console.log(`verified ${tld} -> ${registry}`);

  const keyed = ['--rpc', RPC, '--key-env', 'BUYER_PRIVATE_KEY', '--registry', registry, '--label', values.label as string];
  const bought = await cliRetrying(['register', ...keyed, '--years', '1', ...source, '--accept-disclosures'], 'register');
  assert.equal(bought.code, 0, bought.stdout + bought.stderr);
  assert.equal(bought.json?.delegationAfter, 'verified');
  evidence.purchase = { ...bought.json, disclosures: bought.stderr.split('\n').filter((l) => l.startsWith('- ')) };
  console.log(`bought ${name}: ${String(bought.json?.transaction)}`);

  const a = cli(['set-record', ...keyed, '--type', 'A', '--value', '192.0.2.22']);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  const txtValue = `pirate-registry ceremony ${new Date().toISOString().slice(0, 10)}`;
  const txt = cli(['set-record', ...keyed, '--type', 'TXT', '--value', txtValue]);
  assert.equal(txt.code, 0, txt.stdout + txt.stderr);
  evidence.records = { aTransaction: a.json?.transaction, txtTransaction: txt.json?.transaction };
  await waitForSafe(txt.json?.transaction as Hex, 'record update');

  const first = await cliRetrying(['resolve', '--name', name, ...source, '--chain-rpc', `${CHAIN_ID}=${RPC}`], 'resolve');
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const firstAnswer = first.json as { token: { holder: string }; records: { dns: Record<string, { values: unknown[] }> }; observedAt: { clock: string } };
  assert.equal(firstAnswer.token.holder.toLowerCase(), (process.env.BUYER_ADDRESS as string).toLowerCase());
  assert.deepEqual(firstAnswer.records.dns.A?.values, ['192.0.2.22']);
  assert.deepEqual(firstAnswer.records.dns.TXT?.values, [[txtValue]]);
  assert.equal(firstAnswer.observedAt.clock, 'system');
  evidence.resolveAfterPurchase = resolveSummary(first.json as Record<string, unknown>);

  const moved = cli(['transfer', ...keyed, '--to', process.env.OPERATOR_ADDRESS as string]);
  assert.equal(moved.code, 0, moved.stdout + moved.stderr);
  evidence.transfer = { transaction: moved.json?.transaction, to: process.env.OPERATOR_ADDRESS };
  await waitForSafe(moved.json?.transaction as Hex, 'transfer');

  const second = await cliRetrying(['resolve', '--name', name, ...source, '--chain-rpc', `${CHAIN_ID}=${RPC}`], 'resolve');
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const secondAnswer = second.json as { token: { holder: string }; records: { dns: Record<string, { values: unknown[] }> } };
  assert.equal(secondAnswer.token.holder.toLowerCase(), (process.env.OPERATOR_ADDRESS as string).toLowerCase());
  assert.deepEqual(secondAnswer.records.dns.A?.values, ['192.0.2.22']);
  evidence.resolveAfterTransfer = resolveSummary(second.json as Record<string, unknown>);
  evidence.result = 'passed';
  console.log('CEREMONY PASSED');
}

main()
  .catch((error: unknown) => {
    evidence.result = 'failed';
    evidence.error = (error as Error).message;
    console.error((error as Error).stack ?? error);
    process.exitCode = 1;
  })
  .finally(() => {
    evidence.finishedAt = new Date().toISOString();
    const out = new URL(values.out as string, ROOT);
    mkdirSync(dirname(out.pathname), { recursive: true });
    writeFileSync(out, `${JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  });
