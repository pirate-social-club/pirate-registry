import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedNamespaceIdFor, sharedNameKeyFor, sharedTokenIdFor, requireCanonicalSharedLabel } from '../src/shared-keys.ts';

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
    assert.throws(() => requireCanonicalSharedLabel(value), undefined, value);
    assert.throws(() => sharedNamespaceIdFor(value), undefined, value);
  }
  for (const value of ['a', 'a-b', 'abcdefgh', 'a'.repeat(63)]) requireCanonicalSharedLabel(value);
  assert.throws(() => sharedNameKeyFor(`0x${'0'.repeat(64)}`, 'member001'));
  assert.throws(() => sharedNameKeyFor(`0x${'A'.repeat(64)}`, 'member001'));
});
