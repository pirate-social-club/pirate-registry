import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedNamespaceIdFor, sharedNameKeyFor, sharedTokenIdFor, requireCanonicalSharedLabel, requireSharedKey } from '../src/shared-keys.ts';
import type { Hex } from 'viem';

// BEGIN ALLOCATED IDENTITY VECTORS
const literalVectors = [
  {
    "tld": "testtld",
    "label": "member001",
    "generation": "1",
    "namespaceId": "0x171a7715833c41caa33d3304096ea3f330e94e2b58eac1b29fc2fee99dd14f3d",
    "nameKey": "0x6d73822225a283039c5509f97306783e3479a0e37a5044f5cb52038f8b160856",
    "tokenId": "95165702007452585980891729623512171902651103434603173062025220274514321273488"
  },
  {
    "tld": "othertld",
    "label": "member001",
    "generation": "1",
    "namespaceId": "0xad1ddae470c5a78c4606195fc22c2052fc09d7e2961c8be5d63c353df8bfad9f",
    "nameKey": "0x17c1a7656712aeca2b7313821b02344431c180a32094aeb82e5984413fda1bb3",
    "tokenId": "106965765079036890316365061902104356189341292721360854213475389451124177547303"
  },
  {
    "tld": "testtld",
    "label": "member001",
    "generation": "2",
    "namespaceId": "0x171a7715833c41caa33d3304096ea3f330e94e2b58eac1b29fc2fee99dd14f3d",
    "nameKey": "0x6d73822225a283039c5509f97306783e3479a0e37a5044f5cb52038f8b160856",
    "tokenId": "108434146224625834091005199361104751209326105825392306275063521700134099266268"
  }
] as const;
// END ALLOCATED IDENTITY VECTORS

test('independently generated literal vectors match all three identity helpers', () => {
  assert.ok(literalVectors.length >= 3, 'UNGENERATED: Root must allocate independent literal vector computation');
  for (const v of literalVectors) {
    assert.equal(sharedNamespaceIdFor(v.tld), v.namespaceId);
    assert.equal(sharedNameKeyFor(v.namespaceId, v.label), v.nameKey);
    assert.equal(sharedTokenIdFor(v.nameKey, BigInt(v.generation)), BigInt(v.tokenId));
  }
});

test('canonical namespace and generation distinguish independent full names', () => {
  const a = sharedNameKeyFor(sharedNamespaceIdFor('testtld'), 'member001');
  const b = sharedNameKeyFor(sharedNamespaceIdFor('othertld'), 'member001');
  assert.notEqual(a, b);
  assert.notEqual(sharedTokenIdFor(a, 1n), sharedTokenIdFor(a, 2n));
  assert.notEqual(sharedTokenIdFor(a, 1n), sharedTokenIdFor(b, 1n));
  assert.throws(() => sharedTokenIdFor(a, 0n));
  assert.throws(() => sharedTokenIdFor(a, 2n ** 64n));
});

test('helpers reject transformations, IDN and malformed identities', () => {
  for (const value of ['', 'UPPER', 'name.', 'two.parts', '-name', 'name-', 'xn--test', 'ab--cd', 'é', 'a'.repeat(64)]) {
    assert.throws(() => requireCanonicalSharedLabel(value), /label_invalid/, value);
    assert.throws(() => sharedNamespaceIdFor(value), /label_invalid/, value);
  }
  for (const value of ['a', 'a-b', 'abcdefgh', 'a'.repeat(63)]) requireCanonicalSharedLabel(value);
  assert.throws(() => sharedNameKeyFor(`0x${'0'.repeat(64)}`, 'member001'));
  assert.throws(() => sharedNameKeyFor(`0x${'A'.repeat(64)}`, 'member001'));
});

test('canonical helpers reject LF, CRLF and Unicode terminators at every position', () => {
  for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
    for (const value of [`member001${suffix}`, `${suffix}member001`, `member${suffix}001`]) {
      assert.throws(() => requireCanonicalSharedLabel(value), /label_invalid/);
      assert.throws(() => sharedNamespaceIdFor(value), /label_invalid/);
    }
    assert.throws(() => requireSharedKey(`0x${'1'.repeat(64)}${suffix}`), /identity_invalid/);
  }
});
