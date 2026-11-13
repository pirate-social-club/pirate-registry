import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSharedRegistrySource } from '../src/shared-manifest.ts';
import { getAddress, keccak256 } from 'viem';
import { readFileSync } from 'node:fs';
import { approvedReleaseEnvironment, verifyArchivedSourceClosure, requireSharedCompilerProfile } from '../../../scripts/verify-shared-release.ts';

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
  // Profile-only fixture version, not a claimed compiler binary pin.
  const compiler = { version: '0.8.30+fixture' };
  const settings = { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 },
    metadata: { bytecodeHash: 'none', appendCBOR: false } };
  requireSharedCompilerProfile({ compiler, settings }, compiler.version);
  requireSharedCompilerProfile({ compiler, settings: { ...settings, viaIR: false } }, compiler.version);
  for (const changed of [{ ...settings, viaIR: true }, { ...settings, evmVersion: 'prague' },
    { ...settings, optimizer: { enabled: true, runs: 201 } }, { ...settings, metadata: { bytecodeHash: 'ipfs', appendCBOR: true } }]) {
    assert.throws(() => requireSharedCompilerProfile({ compiler, settings: changed }), /release_compiler/);
  }
  assert.throws(() => requireSharedCompilerProfile({ compiler, settings }, '0.8.30+different'), /release_compiler/);
  assert.throws(() => requireSharedCompilerProfile({ compiler: { version: '0.8.30+fixture\n' }, settings }), /release_compiler/);
});

test('source profile refuses unknown fields, missing pins, v2, mainnet and altered compiler settings', () => {
  for (const value of [null, {}, { ...fixture(), extra: true }, { ...fixture(), protocolVersion: 2 },
    { ...fixture(), chainId: 1 }, { ...fixture(), abiSha256: '' }, { ...fixture(), registry: `0x${'0'.repeat(40)}` },
    { ...fixture(), deployment: { ...fixture().deployment, blockNumber: '01' } },
    { ...fixture(), deployment: { ...fixture().deployment, blockNumber: (2n ** 64n).toString() } },
    { ...fixture(), compiler: { ...fixture().compiler, optimizerRuns: 201 } }]) assert.throws(() => parseSharedRegistrySource(value));
});
