// Allocated execution only: rebuild committed source, verify direct deployment
// input and normalized runtime, then bind actual runtime/ABI/deployment hashes.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, encodeDeployData, getAddress, http, keccak256, type Abi, type Hex } from 'viem';
import { loadSharedRegistrySource, parseSharedRegistrySource, type SharedRegistrySource } from '../packages/resolver/src/shared-manifest.ts';
import { requireShared } from '../packages/resolver/src/shared-errors.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIBRARIES = ['lib/forge-std', 'lib/openzeppelin-contracts', 'lib/openzeppelin-contracts-upgradeable'];
type Artifact = { abi: Abi; bytecode: { object: Hex }; deployedBytecode: {
  object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
  metadata: string | { compiler: { version: string }; settings: Record<string, unknown> } };

function run(command: string, args: string[], cwd = ROOT, input?: Buffer): Buffer {
  return execFileSync(command, args, { cwd, input, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    env: command === 'git' ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' } : process.env });
}

/** No manifest is written and no public transaction is submitted. */
export async function verifySharedRelease(sourceInput: SharedRegistrySource, rpcUrl: string) {
  const source = parseSharedRegistrySource(sourceInput);
  const git = (...args: string[]) => run('git', args).toString().trim();
  const commit = git('rev-parse', `${source.sourceCommit}^{commit}`);
  requireShared(commit === source.sourceCommit, 'release_source', 'commit does not resolve exactly');
  const scratchParent = join(ROOT, '.ignore/shared-names-registry-20261113/release-rebuilds');
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, 'rebuild-'));
  run('tar', ['-x', '-C', scratch], ROOT, run('git', ['archive', '--format=tar', commit]));
  const submodules: Record<string, string> = {};
  for (const library of LIBRARIES) {
    const pinned = git('ls-tree', commit, library).split(/\s+/)[2];
    const actual = run('git', ['-C', library, 'rev-parse', 'HEAD']).toString().trim();
    const dirty = run('git', ['-C', library, 'status', '--porcelain']).toString().trim();
    requireShared(/^[0-9a-f]{40}$/.test(pinned ?? '') && actual === pinned && dirty === '',
      'release_dependency', `dependency pin/cleanliness failed: ${library}`);
    cpSync(join(ROOT, library), join(scratch, library), { recursive: true, dereference: true,
      filter: path => !path.split('/').includes('.git') });
    submodules[library] = pinned;
  }
  const forge = process.env.PIRATE_FOUNDRY_FORGE ?? join(process.env.HOME ?? '', '.foundry/bin/forge');
  run(forge, ['build', '--offline', '--root', scratch, '--skip', 'test', 'script'], scratch);
  const artifact = JSON.parse(readFileSync(join(scratch, 'out/SharedNameRegistryV3.sol/SharedNameRegistryV3.json'), 'utf8')) as Artifact;
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const settings = metadata.settings as { evmVersion?: string; optimizer?: { enabled: boolean; runs: number };
    metadata?: { bytecodeHash: string; appendCBOR: boolean } };
  requireShared(metadata.compiler.version.startsWith('0.8.30+') && settings.evmVersion === 'cancun'
    && settings.optimizer?.enabled === true && settings.optimizer.runs === 200
    && settings.metadata?.bytecodeHash === 'none' && settings.metadata.appendCBOR === false,
  'release_compiler', 'rebuild compiler profile mismatch');
  const abiSha256 = createHash('sha256').update(JSON.stringify(artifact.abi)).digest('hex');
  requireShared(abiSha256 === source.abiSha256, 'release_abi', 'rebuilt ABI differs');
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  requireShared(await client.getChainId() === source.chainId, 'chain_mismatch', 'RPC chain differs');
  const [block, tx, receipt, head] = await Promise.all([
    client.getBlock({ blockNumber: BigInt(source.deployment.blockNumber) }),
    client.getTransaction({ hash: source.deployment.transactionHash }),
    client.getTransactionReceipt({ hash: source.deployment.transactionHash }), client.getBlock({ blockTag: 'safe' }),
  ]);
  requireShared(block.hash === source.deployment.blockHash && receipt.blockHash === block.hash && tx.blockHash === block.hash
    && receipt.blockNumber === BigInt(source.deployment.blockNumber) && receipt.status === 'success'
    && receipt.contractAddress !== null && getAddress(receipt.contractAddress) === source.registry
    && tx.to === null && head.number >= receipt.blockNumber, 'release_deployment', 'direct canonical deployment not established');
  const expectedInput = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [source.constructor.admin, source.constructor.paymentToken, source.constructor.treasury] });
  requireShared(tx.input.toLowerCase() === expectedInput.toLowerCase(), 'release_creation', 'creation bytecode/arguments differ');
  const codeAt = async (hash: Hex) => await client.request({ method: 'eth_getCode', params: [source.registry,
    { blockHash: hash, requireCanonical: true }] } as never) as Hex;
  requireShared(head.hash !== null && block.hash !== null, 'release_block', 'missing block hash');
  const [deployedCode, currentCode] = await Promise.all([codeAt(block.hash), codeAt(head.hash)]);
  requireShared(deployedCode !== '0x' && deployedCode === currentCode && keccak256(currentCode) === source.runtimeCodeHash,
    'release_code', 'runtime/deployment pin differs');
  const actualRuntime = Buffer.from(currentCode.slice(2), 'hex');
  const rebuiltRuntime = Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex');
  requireShared(actualRuntime.length === rebuiltRuntime.length, 'release_code', 'runtime lengths differ');
  for (const slots of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of slots) {
      requireShared(Number.isInteger(start) && Number.isInteger(length) && start >= 0 && length > 0
        && start + length <= actualRuntime.length, 'release_code', 'invalid immutable range');
      actualRuntime.fill(0, start, start + length);
      rebuiltRuntime.fill(0, start, start + length);
    }
  }
  requireShared(actualRuntime.equals(rebuiltRuntime), 'release_code', 'runtime differs outside compiler immutable ranges');
  requireShared((await client.getBlock({ blockNumber: block.number })).hash === block.hash,
    'release_reorg', 'deployment reorged during verification');
  await codeAt(head.hash);
  // Immutables are bound through the exact deterministic creation transaction,
  // not guessed, overwritten or treated as arbitrary acceptable values.
  return { schema: 'pirate.shared-registry-release-proof/1', commit, submodules, abiSha256,
    chainId: source.chainId, registry: source.registry, runtimeCodeHash: source.runtimeCodeHash,
    deploymentBlock: { number: block.number.toString(), hash: block.hash }, selectedBlock: head.hash,
    exactCreationInput: true, normalizedRuntimeMatches: true, deploymentRuntimeUnchanged: true,
    scratch, trust: 'RPC observations; committed-source rebuild independently checked', passed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, rpc: { type: 'string' } } });
  requireShared(values.source && values.rpc, 'arguments', '--source and --rpc required');
  verifySharedRelease(loadSharedRegistrySource(values.source), values.rpc)
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
