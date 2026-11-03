// Independent rebuild-and-hash check (SPEC section 7).
//
// Exports the committed source at a commit with `git archive`, adds the
// pinned Foundry submodules after checking each matches the commit's gitlink
// and is clean, rebuilds from scratch with the pinned solc settings in that
// tree, and compares the rebuilt runtime bytecode with the deployed contracts.
// The implementation must match byte for byte. The factory must match except
// at its immutable slots, which must hold exactly the implementation and
// payment-token addresses. Writes a manifest chain entry on success.
//
// Usage:
//   node scripts/verify-release.ts --rpc URL --factory ADDR [--commit SHA]
//     [--name base-sepolia] [--write-manifest FILE] [--block safe|latest]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, getAddress, http, keccak256, pad, type Address, type Hex } from 'viem';
import { factoryAbi, registryAbi } from '@pirate-registry/resolver';

const ROOT = new URL('../', import.meta.url).pathname;
const FORGE = `${process.env.HOME}/.foundry/bin/forge`;
const SUBMODULES = ['lib/forge-std', 'lib/openzeppelin-contracts', 'lib/openzeppelin-contracts-upgradeable'];

const { values } = parseArgs({
  options: {
    rpc: { type: 'string' },
    factory: { type: 'string' },
    commit: { type: 'string', default: 'HEAD' },
    name: { type: 'string', default: 'unnamed' },
    'write-manifest': { type: 'string' },
    block: { type: 'string', default: 'safe' },
  },
});

function run(cmd: string, args: string[], cwd = ROOT, input?: Buffer): Buffer {
  const result = spawnSync(cmd, args, { cwd, input, maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr?.toString()}`);
  return result.stdout;
}
const git = (...args: string[]) => run('git', args).toString().trim();

function hexToBuffer(hex: Hex): Buffer {
  return Buffer.from(hex.slice(2), 'hex');
}

async function main() {
  if (!values.rpc || !values.factory) throw new Error('--rpc and --factory are required');
  const commit = git('rev-parse', `${values.commit}^{commit}`);
  const factory = getAddress(values.factory);

  // 1. Committed source only, plus submodules pinned by the commit.
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'pirate-registry-release-'));
  try {
    run('tar', ['-x', '-C', work], ROOT, run('git', ['archive', '--format=tar', commit]));
    const submodules: Record<string, string> = {};
    for (const path of SUBMODULES) {
      const pinned = git('ls-tree', commit, path).split(/\s+/)[2];
      const local = run('git', ['-C', path, 'rev-parse', 'HEAD']).toString().trim();
      const dirty = run('git', ['-C', path, 'status', '--porcelain']).toString().trim();
      if (pinned !== local) throw new Error(`${path} is at ${local}, but ${commit} pins ${pinned}`);
      if (dirty) throw new Error(`${path} has local modifications`);
      cpSync(join(ROOT, path), join(work, path), { recursive: true, filter: (src) => !src.endsWith('/.git') });
      submodules[path] = pinned;
    }

    // 2. Clean rebuild of src/ with the commit's own foundry.toml.
    run(FORGE, ['build', '--root', work, '--force', '--skip', 'test', 'script'], work);
    const artifact = (path: string) =>
      JSON.parse(readFileSync(join(work, 'out', path), 'utf8')) as {
        deployedBytecode: { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
      };
    const rebuiltImplementation = artifact('SLDRegistry.sol/SLDRegistry.json').deployedBytecode;
    const rebuiltFactory = artifact('RegistryFactory.sol/RegistryFactory.json').deployedBytecode;
    const toml = readFileSync(join(work, 'foundry.toml'), 'utf8');
    const setting = (key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))?.[1].replace(/"/g, '').trim();

    // 3. Deployed code at one block.
    const client = createPublicClient({ transport: http(values.rpc) });
    const chainId = await client.getChainId();
    const block = await client.getBlock({ blockTag: values.block as 'safe' | 'latest' });
    const read = <T>(address: Address, abi: typeof factoryAbi | typeof registryAbi, functionName: string) =>
      client.readContract({ address, abi, functionName, blockNumber: block.number } as never) as Promise<T>;
    const implementation = getAddress(await read<Address>(factory, factoryAbi, 'implementation'));
    const paymentToken = getAddress(await read<Address>(factory, factoryAbi, 'paymentToken'));
    const onchainFactory = (await client.getCode({ address: factory, blockNumber: block.number })) as Hex;
    const onchainImplementation = (await client.getCode({ address: implementation, blockNumber: block.number })) as Hex;

    // 4. Compare. Implementation: exact. Factory: exact outside immutables;
    //    immutables must be the expected addresses.
    const implementationMatches = onchainImplementation.toLowerCase() === rebuiltImplementation.object.toLowerCase();
    const expectedImmutables = new Set([pad(implementation).toLowerCase(), pad(paymentToken).toLowerCase()]);
    const rebuilt = hexToBuffer(rebuiltFactory.object);
    const onchain = hexToBuffer(onchainFactory);
    let immutablesOk = rebuilt.length === onchain.length;
    const seen = new Set<string>();
    for (const ranges of Object.values(rebuiltFactory.immutableReferences ?? {})) {
      for (const { start, length } of ranges) {
        const slot = `0x${onchain.subarray(start, start + length).toString('hex')}`;
        if (!expectedImmutables.has(slot)) immutablesOk = false;
        seen.add(slot);
        onchain.copy(rebuilt, start, start, start + length);
      }
    }
    immutablesOk &&= seen.size === expectedImmutables.size;
    const factoryMatches = immutablesOk && rebuilt.equals(onchain);

    const report = {
      commit,
      submodules,
      compiler: {
        solc: setting('solc_version'),
        evmVersion: setting('evm_version'),
        optimizerRuns: Number(setting('optimizer_runs')),
        bytecodeHash: setting('bytecode_hash'),
        cborMetadata: setting('cbor_metadata') === 'true',
      },
      chainId,
      block: { tag: values.block, number: block.number.toString(), hash: block.hash },
      factory,
      implementation,
      paymentToken,
      implementationCodeHash: keccak256(onchainImplementation),
      rebuiltImplementationCodeHash: keccak256(rebuiltImplementation.object),
      factoryCodeHash: keccak256(onchainFactory),
      implementationMatches,
      factoryMatchesOutsideImmutables: factoryMatches,
      factoryImmutablesAreExpectedAddresses: immutablesOk,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!implementationMatches || !factoryMatches) {
      console.error('RELEASE VERIFICATION FAILED: deployed code does not match the rebuilt source');
      process.exitCode = 1;
      return;
    }
    if (values['write-manifest']) {
      const path = values['write-manifest'];
      let manifest: { release: string; protocolVersion: number; sourceCommit: string; compiler: unknown; chains: Record<string, unknown> };
      try {
        manifest = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        manifest = { release: 'unreleased', protocolVersion: 1, sourceCommit: commit, compiler: report.compiler, chains: {} };
      }
      if (manifest.sourceCommit && manifest.sourceCommit !== commit && Object.keys(manifest.chains).length > 0) {
        throw new Error(`manifest already describes commit ${manifest.sourceCommit}; refusing to mix commits`);
      }
      manifest.sourceCommit = commit;
      manifest.compiler = report.compiler;
      manifest.chains[String(chainId)] = {
        name: values.name,
        factory,
        factoryCodeHash: report.factoryCodeHash,
        implementation,
        implementationCodeHash: report.implementationCodeHash,
        paymentToken,
        paymentTokenDecimals: 6,
      };
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      console.error(`manifest entry for chain ${chainId} written to ${path}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
