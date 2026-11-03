import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import dnsPacket from 'dns-packet';
import { ResolveError, rootDnsSource } from '../src/index.ts';

const TARGET = '0x5fbdb2315678afecb367f032d93f642f64180aa3.31337._evm';

type Behaviour = (query: dnsPacket.Packet, client: { address: string; port: number }, server: dgram.Socket) => void;

function referral(query: dnsPacket.Packet, overrides: Partial<dnsPacket.Packet> = {}, target = TARGET): Buffer {
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: 0,
    questions: query.questions,
    authorities: [{ type: 'NS', name: query.questions![0].name, ttl: 21600, data: target }],
    ...overrides,
  });
}

/** A fake root server on 127.0.0.1 that runs `behaviour` for each query. */
async function fakeRoot(behaviour: Behaviour): Promise<{ port: number; close: () => void }> {
  const server = dgram.createSocket('udp4');
  server.on('message', (message, client) => behaviour(dnsPacket.decode(message), client, server));
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

function sendFromOtherPort(message: Buffer, client: { address: string; port: number }) {
  const spoof = dgram.createSocket('udp4');
  spoof.send(message, client.port, client.address, () => spoof.close());
}

const failsWith = (code: string, pattern?: RegExp) => (e: unknown) =>
  e instanceof ResolveError && e.code === code && (!pattern || pattern.test(e.message));

test('ignores spoofed, malformed and mismatched datagrams, then accepts the real referral', async () => {
  const root = await fakeRoot((query, client, server) => {
    // Matching ID but from a different UDP port: must be ignored.
    sendFromOtherPort(referral(query, {}, '0x0000000000000000000000000000000000000bad.1._evm'), client);
    // Malformed bytes from the right endpoint: must not crash or end the wait.
    server.send(Buffer.from([1, 2, 3]), client.port, client.address);
    // Right endpoint and ID, wrong question.
    server.send(
      referral({ ...query, questions: [{ type: 'NS', name: 'othertld' }] }),
      client.port,
      client.address,
    );
    // The genuine answer, slightly later.
    setTimeout(() => server.send(referral(query), client.port, client.address), 50);
  });
  try {
    const lookup = await rootDnsSource('127.0.0.1', root.port, { timeoutMs: 1000 }).lookup('testtld');
    assert.deepEqual(lookup.nsTargets, [`${TARGET}.`]);
    assert.equal(lookup.trust, 'local-spv');
  } finally {
    root.close();
  }
});

test('only invalid datagrams: a resolver error that names what was ignored', async () => {
  const root = await fakeRoot((query, client, server) => {
    sendFromOtherPort(referral(query), client);
    server.send(Buffer.from([0xff]), client.port, client.address);
  });
  try {
    await assert.rejects(
      rootDnsSource('127.0.0.1', root.port, { timeoutMs: 300 }).lookup('testtld'),
      (e: unknown) =>
        failsWith('handshake_unavailable', /ignored 2 datagram\(s\)/)(e) &&
        /not the queried server/.test((e as Error).message) &&
        /undecodable/.test((e as Error).message),
    );
  } finally {
    root.close();
  }
});

test('a truncated or failing answer fails closed', async () => {
  const truncated = await fakeRoot((query, client, server) =>
    server.send(referral(query, { flags: dnsPacket.TRUNCATED_RESPONSE }), client.port, client.address),
  );
  const servfail = await fakeRoot((query, client, server) =>
    server.send(referral(query, { flags: 2 /* SERVFAIL */ }), client.port, client.address),
  );
  try {
    await assert.rejects(
      rootDnsSource('127.0.0.1', truncated.port, { timeoutMs: 500 }).lookup('testtld'),
      failsWith('handshake_unavailable', /truncated/),
    );
    await assert.rejects(
      rootDnsSource('127.0.0.1', servfail.port, { timeoutMs: 500 }).lookup('testtld'),
      failsWith('handshake_unavailable', /SERVFAIL/),
    );
  } finally {
    truncated.close();
    servfail.close();
  }
});

test('host names and remote servers are refused up front', () => {
  assert.throws(() => rootDnsSource('hnsd.example', 53), failsWith('handshake_unavailable', /IP address/));
  assert.throws(() => rootDnsSource('192.0.2.53', 53), failsWith('handshake_unavailable', /remote-trust/));
});
