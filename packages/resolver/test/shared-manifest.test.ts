import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireRegtestNode, REGTEST } from '../../../harness/lib/hsd.ts';
import { parseSharedRegistrySource } from '../src/shared-manifest.ts';
import { getAddress, keccak256 } from 'viem';
import { readFileSync, mkdirSync, writeFileSync, realpathSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { approvedReleaseEnvironment, verifyArchivedSourceClosure, requireSharedCompilerProfile,
  requireSharedSolcVersion, canonicalSharedSolcVersion, findInstalledSharedSolc,
  verifySharedRelease } from '../../../scripts/verify-shared-release.ts';

const fixture = () => ({ schema: 'pirate.shared-registry-source/1', protocolVersion: 3,
  sourceCommit: '1'.repeat(40), abiSha256: '2'.repeat(64), chainId: 31337,
  registry: `0x${'1'.repeat(40)}`, runtimeCodeHash: `0x${'3'.repeat(64)}`,
  deployment: { blockNumber: '100', blockHash: `0x${'4'.repeat(64)}`, transactionHash: `0x${'5'.repeat(64)}` },
  constructor: { admin: `0x${'2'.repeat(40)}`, paymentToken: `0x${'3'.repeat(40)}`, treasury: `0x${'4'.repeat(40)}` },
  compiler: { version: '0.8.30', evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, bytecodeHash: 'none', cborMetadata: false } });

test('source profile accepts exact local/testnet tuples with explicit constructor parameters', () => {
  assert.equal(parseSharedRegistrySource(fixture()).chainId, 31337);
  assert.equal(parseSharedRegistrySource({ ...fixture(), chainId: 6343 }).chainId, 6343);
});

test('descriptor and schema reject whole-string canonical suffix attacks', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../docs/shared-registry-source-v1.schema.json', import.meta.url), 'utf8'));
  for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
    for (const field of ['sourceCommit', 'abiSha256', 'runtimeCodeHash', 'registry'] as const) {
      const f = fixture();
      assert.throws(() => parseSharedRegistrySource({ ...f, [field]: f[field] + suffix }), /source_invalid/);
      const shape = field === 'registry' ? schema.$defs.address : field === 'runtimeCodeHash' ? schema.$defs.hash : schema.properties[field];
      assert.equal(new RegExp(shape.pattern).test(f[field] + suffix), false);
    }
    for (const field of ['blockNumber', 'blockHash', 'transactionHash'] as const) {
      const f = fixture();
      assert.throws(() => parseSharedRegistrySource({ ...f, deployment: { ...f.deployment, [field]: f.deployment[field] + suffix } }), /source_invalid/);
      const shape = field === 'blockNumber' ? schema.properties.deployment.properties.blockNumber : schema.$defs.hash;
      assert.equal(new RegExp(shape.pattern).test(f.deployment[field] + suffix), false);
    }
  }
});

test('descriptor accepts lowercase/checksummed addresses and rejects bad mixed case', () => {
  const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const checksummed = getAddress(lower);
  assert.equal(parseSharedRegistrySource({ ...fixture(), registry: lower }).registry, checksummed);
  assert.equal(parseSharedRegistrySource({ ...fixture(), registry: checksummed }).registry, checksummed);
  const flipped = checksummed.slice(0, 2) + [...checksummed.slice(2)].map((c, i) => i === 0 ? c.toLowerCase() === c ? c.toUpperCase() : c.toLowerCase() : c).join('');
  assert.notEqual(flipped, checksummed);
  assert.throws(() => parseSharedRegistrySource({ ...fixture(), registry: flipped }), /source_invalid/);
});

test('rebuild children refuse ambient Git/compiler/loader redirection and inherit no credentials', () => {
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_REPLACE_REF_BASE',
    'FOUNDRY_CONFIG', 'FOUNDRY_REMAPPINGS', 'FOUNDRY_PROFILE', 'DAPP_LIBRARIES', 'SOLC_PATH', 'SVM_HOME', 'LD_PRELOAD', 'NODE_OPTIONS']) {
    assert.throws(() => approvedReleaseEnvironment('/approved/home', { [key]: '/attacker' }), /release_environment/);
  }
  const env = approvedReleaseEnvironment('/approved/home', { HOME: '/attacker', PATH: '/attacker', SECRET: 'fixture' });
  assert.equal(env.HOME, '/approved/home');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(Object.hasOwn(env, 'SECRET'), false);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
});

test('compiler closure rejects external, untracked, redirected and changed source inputs', () => {
  const path = 'src/SharedNameRegistryV3.sol';
  const digest = keccak256('0x6000');
  const closure = new Map([[path, digest], ['lib/pinned/Dependency.sol', digest]]);
  verifyArchivedSourceClosure({ [path]: { keccak256: digest }, 'lib/pinned/Dependency.sol': { keccak256: digest } }, closure);
  for (const foreign of ['/outside/Evil.sol', '../Evil.sol', 'src/../Evil.sol', 'src/Untracked.sol', 'src\\Evil.sol']) {
    assert.throws(() => verifyArchivedSourceClosure({ [path]: { keccak256: digest }, [foreign]: { keccak256: digest } }, closure), /release_closure/);
  }
  assert.throws(() => verifyArchivedSourceClosure({ [path]: { keccak256: keccak256('0x6001') } }, closure), /release_closure/);
  assert.throws(() => verifyArchivedSourceClosure({}, closure), /release_closure/);
});

test('compiler profile accepts explicit or omitted non-IR and rejects changed build settings', () => {
  // Format fixture only; no tool bytes or execution are attested by this test.
  const compiler = { version: '0.8.30+commit.73712a01' };
  const settings = { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 },
    metadata: { bytecodeHash: 'none', appendCBOR: false } };
  requireSharedCompilerProfile({ compiler, settings }, compiler.version);
  requireSharedCompilerProfile({ compiler, settings: { ...settings, viaIR: false } }, compiler.version);
  for (const changed of [{ ...settings, viaIR: true }, { ...settings, evmVersion: 'prague' },
    { ...settings, optimizer: { enabled: true, runs: 201 } }, { ...settings, metadata: { bytecodeHash: 'ipfs', appendCBOR: true } }]) {
    assert.throws(() => requireSharedCompilerProfile({ compiler, settings: changed }), /release_compiler/);
  }
  assert.throws(() => requireSharedCompilerProfile({ compiler, settings }, '0.8.30+commit.00000000'), /release_compiler/);
  for (const suffix of ['.Linux.g++', '\n', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => requireSharedCompilerProfile({ compiler: { version: compiler.version + suffix }, settings }), /release_compiler/);
    assert.throws(() => requireSharedCompilerProfile({ compiler, settings }, compiler.version + suffix), /release_compiler/);
  }
});

test('approved compiler version refuses noncanonical input', () => {
  const version = '0.8.30+commit.73712a01';
  requireSharedSolcVersion(version);
  for (const value of [undefined, null, 30, '0.8.30', '0.8.30+fixture', '0.8.30+commit.73712A01',
    '0.8.30+commit.73712a010', '0.8.30+commit.73712a0', ...['.Linux.g++', '\n', '\r\n', '\u2028', '\u2029', ' '].map(suffix => version + suffix)]) {
    assert.throws(() => requireSharedSolcVersion(value), /release_tool/);
  }
});

test('release verification rejects platform-suffixed approval before scratch or tool access', async () => {
  const scratch = fileURLToPath(new URL('../../../.ignore/shared-names-registry-20261113/release-rebuilds', import.meta.url));
  const inventory = () => existsSync(scratch) ? readdirSync(scratch).sort() : null;
  const before = inventory();
  for (const suffix of ['.Linux.g++', '\n', '\r\n']) {
    await assert.rejects(verifySharedRelease(parseSharedRegistrySource(fixture()), 'http://127.0.0.1:1', {
      forgePath: '/not-a-tool/forge', forgeSha256: '0'.repeat(64), solcPath: '/not-a-tool/solc',
      solcSha256: '0'.repeat(64), solcVersion: '0.8.30+commit.73712a01' + suffix,
    }), /approved solcVersion must be exactly/);
  }
  assert.deepEqual(inventory(), before);
});

test('full compiler version output is compared by exact canonical commit', () => {
  const version = '0.8.30+commit.73712a01';
  const output = `solc, the solidity compiler commandline interface\nVersion: ${version}.Linux.g++\n`;
  assert.equal(canonicalSharedSolcVersion(output, version), version);
  assert.equal(canonicalSharedSolcVersion(output.replaceAll('\n', '\r\n'), version), version);
  assert.equal(canonicalSharedSolcVersion(`Version: ${version}\n`), version);
  assert.throws(() => canonicalSharedSolcVersion(output, '0.8.30+commit.00000000'), /release_tool/);
  assert.throws(() => canonicalSharedSolcVersion(output, version + '.Linux.g++'), /release_tool/);
  for (const malformed of ['Version: 0.8.31+commit.73712a01.Linux.g++\n',
    `Version: ${version}0.Linux.g++\n`, `Version: ${version} .Linux.g++\n`,
    `Version: ${version}.Linux.g++\u2028`, output + `Version: ${version}\n`, 'no version']) {
    assert.throws(() => canonicalSharedSolcVersion(malformed), /release_tool/);
  }
});

function compilerHome() {
  const home = join(fileURLToPath(new URL('../../../', import.meta.url)),
    '.ignore/shared-names-registry-20261113', 'compiler-discovery-' + randomUUID());
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function installedFixture(home: string, location: '.svm' | '.local/share/svm', mode = 0o700) {
  const path = join(home, location, '0.8.30/solc-0.8.30');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Discovery checks bytes only as a file; this fixture is never executed.
  writeFileSync(path, 'discovery fixture, not a compiler\n', { flag: 'wx', mode });
  return path;
}

test('compiler lookup selects the sole executable in the legacy SVM location', () => {
  const home = compilerHome();
  const expected = installedFixture(home, '.svm');
  assert.equal(findInstalledSharedSolc(home), realpathSync(expected));
});

test('compiler lookup selects the sole executable in the XDG SVM location', () => {
  const home = compilerHome();
  const expected = installedFixture(home, '.local/share/svm');
  assert.equal(findInstalledSharedSolc(home), realpathSync(expected));
});

test('compiler lookup refuses missing, ambiguous, non-executable and non-file candidates', () => {
  const missing = compilerHome();
  assert.throws(() => findInstalledSharedSolc(missing), /release_tool/);
  assert.throws(() => findInstalledSharedSolc('relative-home'), /release_tool/);
  const ambiguous = compilerHome();
  installedFixture(ambiguous, '.svm');
  installedFixture(ambiguous, '.local/share/svm');
  assert.throws(() => findInstalledSharedSolc(ambiguous), /release_tool/);
  const aliases = compilerHome();
  const original = installedFixture(aliases, '.svm');
  const alias = join(aliases, '.local/share/svm/0.8.30/solc-0.8.30');
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(original, alias);
  assert.throws(() => findInstalledSharedSolc(aliases), /release_tool/);
  const noExec = compilerHome();
  installedFixture(noExec, '.svm', 0o600);
  assert.throws(() => findInstalledSharedSolc(noExec), /EACCES/);
  const directory = compilerHome();
  mkdirSync(join(directory, '.svm/0.8.30/solc-0.8.30'), { recursive: true });
  assert.throws(() => findInstalledSharedSolc(directory), /release_tool/);
});

test('source profile refuses unknown fields, missing pins, v2, mainnet and altered compiler settings', () => {
  for (const value of [null, {}, { ...fixture(), extra: true }, { ...fixture(), protocolVersion: 2 },
    { ...fixture(), chainId: 1 }, { ...fixture(), abiSha256: '' }, { ...fixture(), registry: `0x${'0'.repeat(40)}` },
    { ...fixture(), deployment: { ...fixture().deployment, blockNumber: '01' } },
    { ...fixture(), deployment: { ...fixture().deployment, blockNumber: (2n ** 64n).toString() } },
    { ...fixture(), compiler: { ...fixture().compiler, optimizerRuns: 201 } }]) assert.throws(() => parseSharedRegistrySource(value));
});

test('Handshake guard queries getblockchaininfo on the configured local node', async t => {
  const request = t.mock.method(globalThis, 'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      assert.equal(input, REGTEST.nodeRpc);
      assert.equal(init?.method, 'POST');
      assert.deepEqual(init?.headers, { 'content-type': 'application/json' });
      assert.equal(init?.body, JSON.stringify({ method: 'getblockchaininfo', params: [] }));
      return Response.json({ result: { chain: 'regtest', blocks: 0, headers: 0 }, error: null, id: 1 });
    });
  await requireRegtestNode();
  assert.equal(request.mock.callCount(), 1);
});

test('Handshake guard refuses missing, network-only, non-regtest and malformed chain replies', async t => {
  let result: unknown;
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ result, error: null }));
  const invalid: unknown[] = [
    undefined, null, {}, { network: 'regtest' }, { testnet: true, blocks: 0 },
    [], [{ chain: 'regtest' }], 'regtest', 0, false,
    ...[undefined, null, false, 1, [], {}, '', 'main', 'test', 'testnet', 'simnet',
      'REGTEST', ' regtest', 'regtest ', 'regtest\n', 'regtest\r\n', 'regtest\u2028',
      'regtest\u2029', 'regtest\0', 'regtestx'].map(chain => ({ chain })),
  ];
  for (const value of invalid) {
    result = value;
    const before = request.mock.callCount();
    await assert.rejects(requireRegtestNode(), /only disposable Handshake regtest allowed/,
      'unexpected acceptance of ' + JSON.stringify(value));
    assert.equal(request.mock.callCount(), before + 1, 'no retry or alternate-node fallback');
  }
});

test('Handshake guard preserves RPC failure without trying another method or node', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ result: { chain: 'regtest' }, error: { code: -1, message: 'fixture RPC failure' } }));
  await assert.rejects(requireRegtestNode(), { message: 'getblockchaininfo: fixture RPC failure' });
  assert.equal(request.mock.callCount(), 1);
});

test('Handshake guard preserves transport failure without fallback', async t => {
  const failure = new Error('fixture transport failure');
  const request = t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(requireRegtestNode(), error => error === failure);
  assert.equal(request.mock.callCount(), 1);
});

test('Handshake guard refuses malformed JSON without fallback', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('{'));
  await assert.rejects(requireRegtestNode(), SyntaxError);
  assert.equal(request.mock.callCount(), 1);
});
