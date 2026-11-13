// Allocated execution only. No deployment, manifest write or public transaction.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, encodeDeployData, getAddress, http, keccak256, type Abi, type Hex } from 'viem';
import { loadSharedRegistrySource, parseSharedRegistrySource, type SharedRegistrySource } from '../packages/resolver/src/shared-manifest.ts';
import { requireShared } from '../packages/resolver/src/shared-errors.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIBRARIES = ['lib/forge-std', 'lib/openzeppelin-contracts', 'lib/openzeppelin-contracts-upgradeable'];
export interface SharedReleaseBuildTools {
  forgePath: string; forgeSha256: string; solcPath: string; solcSha256: string;
  /** Exact long compiler version from the approved binary, never inferred. */
  solcVersion: string;
}
type Artifact = { abi: Abi; bytecode: { object: Hex }; deployedBytecode: {
  object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
  metadata: string | { compiler: { version: string }; settings: Record<string, unknown>;
    sources: Record<string, { keccak256: Hex }> } };

export function requireSharedCompilerProfile(metadata: { compiler?: { version?: string }; settings?: {
  evmVersion?: string; viaIR?: boolean; optimizer?: { enabled?: boolean; runs?: number };
  metadata?: { bytecodeHash?: string; appendCBOR?: boolean } } }, exactVersion?: string): void {
  const settings = metadata.settings;
  requireShared(typeof metadata.compiler?.version === 'string'
    && /^0\.8\.30\+[A-Za-z0-9.+-]+(?![\s\S])/.test(metadata.compiler.version)
    && (exactVersion === undefined || metadata.compiler.version === exactVersion)
    && settings?.evmVersion === 'cancun' && (settings.viaIR === undefined || settings.viaIR === false)
    && settings.optimizer?.enabled === true && settings.optimizer.runs === 200
    && settings.metadata?.bytecodeHash === 'none' && settings.metadata.appendCBOR === false,
  'release_compiler', 'rebuild compiler profile mismatch');
}

export function approvedReleaseEnvironment(home: string, inherited: NodeJS.ProcessEnv = process.env) {
  const forbidden = Object.keys(inherited).filter(key =>
    /^(GIT_|FOUNDRY_|DAPP_|SOLC_|SVM_|LD_|DYLD_)/.test(key) || key === 'NODE_OPTIONS');
  requireShared(forbidden.length === 0, 'release_environment',
    `remove ambient build overrides: ${forbidden.sort().join(',')}`);
  // No inherited PATH, HOME, credentials, Git redirection or loader variables.
  return { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    FOUNDRY_PROFILE: 'default' };
}

function canonicalPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(path) && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}

export function verifyArchivedSourceClosure(sources: Record<string, { keccak256: Hex }>,
  closure: ReadonlyMap<string, Hex>): void {
  requireShared(Object.hasOwn(sources, 'src/SharedNameRegistryV3.sol'), 'release_closure', 'target source absent');
  for (const [path, source] of Object.entries(sources)) {
    requireShared(canonicalPath(path) && closure.has(path) && closure.get(path) === source.keccak256,
      'release_closure', `compiler source is not the archived committed input: ${path}`);
  }
}

function pinnedBinary(path: string, expected: string): string {
  requireShared(isAbsolute(path) && expected.length === 64 && !/[^0-9a-f]/.test(expected),
    'release_tool', 'absolute tool path and exact approved SHA-256 required');
  const actual = realpathSync(path);
  requireShared(lstatSync(actual).isFile()
    && createHash('sha256').update(readFileSync(actual)).digest('hex') === expected,
  'release_tool', 'approved tool bytes differ');
  return actual;
}

/** Rebuilds only archived Git objects, never the mutable dependency worktrees. */
export async function verifySharedRelease(sourceInput: SharedRegistrySource, rpcUrl: string,
  tools: SharedReleaseBuildTools) {
  const source = parseSharedRegistrySource(sourceInput);
  // Refuse overrides before allocating scratch or executing any child.
  approvedReleaseEnvironment(ROOT);
  const forge = pinnedBinary(tools.forgePath, tools.forgeSha256);
  const solc = pinnedBinary(tools.solcPath, tools.solcSha256);
  requireShared(/^0\.8\.30\+[A-Za-z0-9.+-]+(?![\s\S])/.test(tools.solcVersion),
    'release_tool', 'exact approved solc long version required');
  const scratchParent = join(ROOT, '.ignore/shared-names-registry-20261113/release-rebuilds');
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, 'rebuild-'));
  const home = join(scratch, '.approved-home');
  mkdirSync(home);
  const env = approvedReleaseEnvironment(home);
  const run = (command: string, args: string[], cwd = ROOT, input?: Buffer): Buffer =>
    execFileSync(command, args, { cwd, input, maxBuffer: 128 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], env });
  const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', [
    '--no-replace-objects', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args], cwd);
  requireShared(run(forge, ['--version']).toString().split('\n')[0].trim() === 'forge Version: 1.9.0',
    'release_tool', 'approved Forge 1.9.0 required');
  requireShared(run(solc, ['--version']).toString().includes(`Version: ${tools.solcVersion}`),
    'release_tool', 'approved solc version differs');
  const commit = git(ROOT, 'rev-parse', `${source.sourceCommit}^{commit}`).toString().trim();
  requireShared(commit === source.sourceCommit, 'release_source', 'commit does not resolve exactly');

  const closure = new Map<string, Hex>();
  const submodules: Record<string, string> = {};
  let archives = 0;
  function archive(repo: string, revision: string, prefix: string, depth: number) {
    requireShared(depth <= 8 && ++archives <= 128, 'release_dependency', 'dependency closure exceeds bound');
    const target = prefix ? join(scratch, prefix) : scratch;
    mkdirSync(target, { recursive: true });
    const tree = git(repo, 'ls-tree', '-r', '-z', revision).toString().split('\0').filter(Boolean);
    const blobs = new Map<string, string>();
    const links: { path: string; oid: string }[] = [];
    for (const entry of tree) {
      const tab = entry.indexOf('\t');
      const [mode, kind, oid] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      requireShared(canonicalPath(path) && /^[0-9a-f]{40}(?![\s\S])/.test(oid),
        'release_dependency', 'noncanonical committed tree entry');
      if (mode === '160000' && kind === 'commit') {
        if (depth === 0) requireShared(LIBRARIES.includes(path), 'release_dependency', 'unapproved root gitlink');
        links.push({ path, oid });
      } else {
        requireShared(kind === 'blob' && (mode === '100644' || mode === '100755'),
          'release_dependency', 'symlinks and special source files are unsupported');
        blobs.set(path, oid);
      }
    }
    run('/usr/bin/tar', ['-x', '--no-same-owner', '-C', target], ROOT,
      git(repo, 'archive', '--format=tar', revision));
    // export-ignore may omit files; every extracted input must still match its Git blob.
    function inspect(directory: string, relative: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (depth === 0 && path === '.approved-home') continue;
        const absolute = join(directory, entry.name);
        requireShared(!lstatSync(absolute).isSymbolicLink(), 'release_dependency', 'archived symlink');
        if (entry.isDirectory()) { inspect(absolute, path); continue; }
        requireShared(entry.isFile() && blobs.has(path), 'release_dependency', 'untracked archive content');
        const bytes = readFileSync(absolute);
        const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        requireShared(oid === blobs.get(path), 'release_dependency', 'archive bytes differ from committed blob');
        closure.set(prefix ? `${prefix}/${path}` : path, keccak256(bytes));
      }
    }
    inspect(target, '');
    for (const link of links) {
      const path = prefix ? `${prefix}/${link.path}` : link.path;
      submodules[path] = link.oid;
      archive(join(repo, link.path), link.oid, path, depth + 1);
    }
  }
  archive(ROOT, commit, '', 0);
  requireShared(LIBRARIES.every(path => submodules[path]), 'release_dependency', 'required dependency gitlink absent');
  run(forge, ['build', '--offline', '--use', solc, '--root', scratch,
    '--out', join(scratch, 'out'), '--cache-path', join(scratch, 'cache'), '--skip', 'test', 'script'], scratch);
  // A compiler/build must not modify any of the archived inputs.
  for (const [path, digest] of closure) {
    requireShared(!lstatSync(join(scratch, path)).isSymbolicLink()
      && keccak256(readFileSync(join(scratch, path))) === digest, 'release_closure', 'archived input changed during build');
  }
  const artifact = JSON.parse(readFileSync(join(scratch, 'out/SharedNameRegistryV3.sol/SharedNameRegistryV3.json'), 'utf8')) as Artifact;
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  verifyArchivedSourceClosure(metadata.sources, closure);
  requireSharedCompilerProfile(metadata, tools.solcVersion);
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
    && typeof receipt.contractAddress === 'string' && getAddress(receipt.contractAddress) === source.registry
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
  return { schema: 'pirate.shared-registry-release-proof/2', commit, submodules, abiSha256,
    tools: { ...tools, forgePath: forge, solcPath: solc }, compilerSourceCount: Object.keys(metadata.sources).length,
    archivedInputCount: closure.size, archivedSourceClosureVerified: true,
    chainId: source.chainId, registry: source.registry, runtimeCodeHash: source.runtimeCodeHash,
    deploymentBlock: { number: block.number.toString(), hash: block.hash }, selectedBlock: head.hash,
    exactCreationInput: true, normalizedRuntimeMatches: true, deploymentRuntimeUnchanged: true,
    scratch, trust: 'RPC observations; committed-source rebuild independently checked', passed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, rpc: { type: 'string' }, tools: { type: 'string' } } });
  requireShared(values.source && values.rpc && values.tools, 'arguments', '--source, --rpc and --tools required');
  verifySharedRelease(loadSharedRegistrySource(values.source), values.rpc,
    JSON.parse(readFileSync(values.tools, 'utf8')) as SharedReleaseBuildTools)
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
