import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addrKey,
  contenthashKey,
  decodeAAAA,
  decodeRdata,
  decodeRRset,
  dnsKey,
  encodeAAAA,
  encodeRdata,
  encodeRRset,
  isValidLabel,
  labelhash,
  ResolveError,
  textKey,
  tokenIdFor,
} from '../src/index.ts';

// The same vectors as SPEC 6.9 and test/Factory.t.sol.
test('spec encoding vectors', () => {
  assert.equal(labelhash('studio'), '0xdd292fbefea3905e7bcdbbf6b1b71e43455ffc2baf812c3f209b907c2002b33f');
  assert.equal(tokenIdFor('studio', 1n), 0x4275474407e1edb473bf05f2c2b128427959989ca62308b76b8fea2e16e1dc79n);
  assert.equal(tokenIdFor('studio', 2n), 0x696caabed877cd84b076736f07be1903028a162cca18ce89a79bd3b2894417fen);
  assert.equal(dnsKey('', 1), '0x868407eceda9379178752546a3cbf720eec2a28dd24895d6472c1c3e5a789f2d');
  assert.equal(dnsKey('www', 1), '0x3d0a36e80e3d0fd5cacdea6ed18096458be8598eabead84e9be8e161a4040cea');
  assert.equal(dnsKey('', 28), '0x2aaebcdd820b403c0bdeab8581b7bb7748995d4af0e62bb44a652699bb42f0d8');
  assert.equal(dnsKey('', 16), '0x8e349ea58a59204bb26cde0b4dbfcfff1733d3f5bf6b2c8a60fd843c8573e0ef');
  assert.equal(addrKey(60n), '0x16883e5e203b40982d5268a3d2640cd0f5e76abee54a43d0960297260cfd7d06');
  assert.equal(textKey('url'), '0x42eb28c344b8fb7b73f411db72dd268d347114a8ab737b15344b7378069e5cf6');
  assert.equal(contenthashKey(), '0xf2b1a06537f8716332f700b7ec22ba2b412a859bc77c6a2d36acf68a3cab1e0f');

  const a = (v: string) => encodeRdata('A', v);
  assert.equal(encodeRRset({ ttl: 300, rdatas: [a('192.0.2.1')] }), '0x0000012c0004c0000201');
  assert.equal(encodeRRset({ ttl: 300, rdatas: [a('192.0.2.1'), a('192.0.2.2')] }), '0x0000012c0004c00002010004c0000202');
  assert.equal(
    encodeRRset({ ttl: 300, rdatas: [encodeRdata('AAAA', '2001:db8::1')] }),
    '0x0000012c001020010db8000000000000000000000001',
  );
  assert.equal(encodeRRset({ ttl: 300, rdatas: [encodeRdata('TXT', 'hello')] }), '0x0000012c00060568656c6c6f');
});

test('RRset and RDATA round trips', () => {
  const set = decodeRRset('0x0000012c0004c00002010004c0000202');
  assert.equal(set.ttl, 300);
  assert.deepEqual(set.rdatas.map((r) => decodeRdata('A', r)), ['192.0.2.1', '192.0.2.2']);
  for (const v of ['2001:db8::1', '::1', '::', 'fe80::1:2', '2001:db8:0:1:1:1:1:1']) {
    assert.equal(decodeAAAA(encodeAAAA(v)), v);
  }
  assert.deepEqual(decodeRdata('TXT', encodeRdata('TXT', 'v=spf1 -all')), ['v=spf1 -all']);
  assert.equal(decodeRdata('CNAME', encodeRdata('CNAME', 'target.example.')), 'target.example.');
});

test('malformed RRsets are rejected with record_malformed', () => {
  for (const bad of ['0x', '0x0000012c', '0x0000012c0004c00002', '0x0000012c0005c0000201'] as const) {
    assert.throws(() => decodeRRset(bad), (e: unknown) => e instanceof ResolveError && e.code === 'record_malformed');
  }
  assert.throws(
    () => decodeRdata('A', Uint8Array.from([1, 2, 3])),
    (e: unknown) => e instanceof ResolveError && e.code === 'record_malformed',
  );
});

test('label rules match the contract', () => {
  for (const ok of ['a', '0', 'a-b', 'ab-c', 'studio', 'a'.repeat(63)]) assert.ok(isValidLabel(ok), ok);
  for (const bad of ['', '-ab', 'ab-', 'ab--c', 'xn--abc', 'Studio', 'stu_dio', 'stu.dio', 'stüdio', 'a'.repeat(64)]) {
    assert.ok(!isValidLabel(bad), bad);
  }
});
