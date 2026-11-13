import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sharedRegistryAbi, sharedRegistryAbiSha256, sharedIdentityVectors } from '../src/shared-abi.ts';
import { sharedNamespaceIdFor, sharedNameKeyFor, sharedTokenIdFor } from '../src/shared-keys.ts';

test('generated bundle equals actual compiled ABI and its digest', () => {
  const artifact = JSON.parse(readFileSync(new URL('../../../out/SharedNameRegistryV3.sol/SharedNameRegistryV3.json', import.meta.url), 'utf8'));
  const bundle = JSON.parse(readFileSync(new URL('../abi/shared-name-registry-v3.json', import.meta.url), 'utf8'));
  assert.deepEqual(sharedRegistryAbi, artifact.abi);
  assert.deepEqual(bundle.abi, artifact.abi);
  assert.equal(createHash('sha256').update(JSON.stringify(artifact.abi)).digest('hex'), sharedRegistryAbiSha256);
  assert.equal(bundle.abiSha256, sharedRegistryAbiSha256);
  assert.deepEqual(bundle.identityVectors, sharedIdentityVectors);
});

test('published identity vectors remain reproducible for callers', () => {
  assert.ok(sharedIdentityVectors.length >= 3);
  for (const v of sharedIdentityVectors) {
    assert.equal(sharedNamespaceIdFor(v.tld), v.namespaceId);
    assert.equal(sharedNameKeyFor(v.namespaceId, v.label), v.nameKey);
    assert.equal(sharedTokenIdFor(v.nameKey, BigInt(v.generation)).toString(), v.tokenId);
  }
});
