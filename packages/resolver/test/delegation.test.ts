import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedCloneRuntime, formatDelegation, parseDelegation, ResolveError } from '../src/index.ts';

const REGISTRY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const failsWith = (code: string) => (e: unknown) => e instanceof ResolveError && e.code === code;

test('parses one _evm record, any letter case, with or without the root dot', () => {
  for (const record of [
    '0x5fbdb2315678afecb367f032d93f642f64180aa3.6343._evm.',
    '0x5FBDB2315678AFECB367F032D93F642F64180AA3.6343._EVM',
  ]) {
    const d = parseDelegation(['ns1.example.', record]);
    assert.equal(d.registry, REGISTRY);
    assert.equal(d.chainId, 6343n);
  }
});

test('missing, ambiguous and malformed delegations fail with their codes', () => {
  assert.throws(() => parseDelegation([]), failsWith('delegation_missing'));
  assert.throws(() => parseDelegation(['ns1.example.']), failsWith('delegation_missing'));
  const one = '0x5fbdb2315678afecb367f032d93f642f64180aa3.6343._evm.';
  const two = '0x0000000000000000000000000000000000000001.31337._evm.';
  assert.throws(() => parseDelegation([one, two]), failsWith('delegation_ambiguous'));
  for (const bad of [
    '0x5fbdb2315678afecb367f032d93f642f64180aa.6343._evm.', // 39 hex digits
    '0x5fbdb2315678afecb367f032d93f642f64180aa3.06343._evm.', // leading zero
    '0x5fbdb2315678afecb367f032d93f642f64180aa3._evm.', // no chain id
    'extra.0x5fbdb2315678afecb367f032d93f642f64180aa3.6343._evm.', // four labels
    '5fbdb2315678afecb367f032d93f642f64180aa3.6343._evm.', // no 0x
    '0x5fbdb2315678afecb367f032d93f642f64180aa3.123456789012345678901._evm.', // 21 digits
  ]) {
    assert.throws(() => parseDelegation([bad]), failsWith('delegation_malformed'), bad);
  }
  // A malformed record is never skipped in favour of a valid one.
  assert.throws(() => parseDelegation(['0xzz.1._evm.', one]), failsWith('delegation_ambiguous'));
});

test('format and clone runtime helpers', () => {
  assert.equal(formatDelegation(REGISTRY, 6343n), '0x5fbdb2315678afecb367f032d93f642f64180aa3.6343._evm.');
  assert.equal(
    expectedCloneRuntime('0xCafac3dD18aC6c6e92c921884f9E4176737C052c'),
    '0x363d3d373d3d3d363d73cafac3dd18ac6c6e92c921884f9e4176737c052c5af43d82803e903d91602b57fd5bf3',
  );
});
