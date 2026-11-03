import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import { isIP } from 'node:net';
import dnsPacket from 'dns-packet';
import { ResolveError } from './errors.ts';

export type HandshakeTrust = 'local-full-node' | 'local-spv' | 'remote-trusted';

export interface TldRenewal {
  renewalPeriodEnd: number;
  blocksUntilExpire: number;
  daysUntilExpire: number;
}

export interface TldLookup {
  nsTargets: string[];
  source: string;
  trust: HandshakeTrust;
  height?: number;
  renewal?: TldRenewal;
}

export interface HandshakeSource {
  readonly description: string;
  lookup(tld: string): Promise<TldLookup>;
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'));
}

function requireTrust(host: string, allowRemote: boolean, description: string): HandshakeTrust | undefined {
  if (isLoopback(host)) return undefined;
  if (!allowRemote) {
    throw new ResolveError(
      'handshake_unavailable',
      `${description} is not on this machine; pass the remote-trust flag to accept its answers as trusted`,
    );
  }
  return 'remote-trusted';
}

/** A full hsd node over JSON-RPC (SPEC 8, source 1). Reports the TLD renewal deadline. */
export function hsdRpcSource(url: string, options: { allowRemote?: boolean } = {}): HandshakeSource {
  const description = `hsd ${url}`;
  const remote = requireTrust(new URL(url).hostname, options.allowRemote ?? false, description);
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    let body: { result?: T; error?: { message?: string } };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw new ResolveError('handshake_unavailable', `${description}: ${(error as Error).message}`);
    }
    if (body.error) throw new ResolveError('handshake_unavailable', `${description} ${method}: ${body.error.message}`);
    return body.result as T;
  }
  return {
    description,
    async lookup(tld) {
      const resource = await rpc<{ records?: Array<{ type: string; ns?: string }> } | null>('getnameresource', [tld]);
      const info = await rpc<{ info?: { stats?: Partial<TldRenewal> } | null } | null>('getnameinfo', [tld]);
      const height = await rpc<number>('getblockcount', []);
      const nsTargets = (resource?.records ?? []).filter((r) => r.type === 'NS' && r.ns).map((r) => r.ns as string);
      const stats = info?.info?.stats;
      const renewal =
        stats && typeof stats.renewalPeriodEnd === 'number'
          ? {
              renewalPeriodEnd: stats.renewalPeriodEnd,
              blocksUntilExpire: stats.blocksUntilExpire ?? 0,
              daysUntilExpire: stats.daysUntilExpire ?? 0,
            }
          : undefined;
      return { nsTargets, source: description, trust: remote ?? 'local-full-node', height, renewal };
    },
  };
}

/**
 * A Handshake root name server reached over DNS (SPEC 8, source 2), normally a
 * local hnsd that verifies name proofs itself. The delegation arrives as a
 * referral in the authority section, which ordinary stub resolvers discard.
 * `host` must be an IP literal (or `localhost`) so replies can be matched to
 * the exact endpoint queried.
 */
export function rootDnsSource(
  host: string,
  port: number,
  options: { allowRemote?: boolean; timeoutMs?: number; label?: string } = {},
): HandshakeSource {
  const address = host === 'localhost' ? '127.0.0.1' : host.replace(/^\[|\]$/g, '');
  if (isIP(address) === 0) throw new ResolveError('handshake_unavailable', `root DNS host must be an IP address, got ${host}`);
  const description = `${options.label ?? 'root'} dns://${host}:${port}`;
  const remote = requireTrust(address, options.allowRemote ?? false, description);
  return {
    description,
    async lookup(tld) {
      const response = await queryNs(address, port, tld, options.timeoutMs ?? 3000).catch((error: Error) => {
        throw new ResolveError('handshake_unavailable', `${description}: ${error.message}`);
      });
      const rcode = (response as { rcode?: string }).rcode ?? 'NOERROR';
      if (rcode !== 'NOERROR' && rcode !== 'NXDOMAIN') {
        throw new ResolveError('handshake_unavailable', `${description} answered ${rcode}`);
      }
      const records = [...(response.answers ?? []), ...(response.authorities ?? [])];
      const nsTargets = records
        .filter((r) => r.type === 'NS' && r.name.toLowerCase() === tld.toLowerCase())
        .map((r) => `${String((r as { data: string }).data).replace(/\.$/, '')}.`);
      return { nsTargets, source: description, trust: remote ?? 'local-spv' };
    },
  };
}

type DecodedResponse = dnsPacket.Packet & {
  flag_qr?: boolean;
  flag_tc?: boolean;
  opcode?: string;
  rcode?: string;
};

/**
 * Why a datagram is not the answer to our query, or undefined if it is.
 * Exported for tests.
 */
export function rejectReason(
  message: Buffer,
  from: { address: string; port: number },
  expected: { address: string; port: number; id: number; name: string },
): string | undefined {
  if (from.address !== expected.address || from.port !== expected.port) {
    return `datagram from ${from.address}:${from.port}, not the queried server`;
  }
  let packet: DecodedResponse;
  try {
    packet = dnsPacket.decode(message) as DecodedResponse;
  } catch (error) {
    return `undecodable datagram (${(error as Error).message})`;
  }
  if (packet.id !== expected.id) return 'response ID does not match the query';
  if (!packet.flag_qr) return 'datagram is not a response';
  if ((packet.opcode ?? 'QUERY') !== 'QUERY') return `unexpected opcode ${packet.opcode}`;
  const questions = packet.questions ?? [];
  const question = questions[0];
  if (
    questions.length !== 1 ||
    question.type !== 'NS' ||
    (question.class ?? 'IN') !== 'IN' ||
    question.name.toLowerCase() !== expected.name.toLowerCase()
  ) {
    return 'response question does not match the query';
  }
  return undefined;
}

/**
 * One NS query over UDP. Datagrams from any other endpoint, with another ID,
 * that fail to decode, or that answer a different question are ignored, so an
 * injected packet cannot end the wait early; their reasons are reported if no
 * valid answer arrives. A truncated valid answer fails closed (no TCP fallback).
 */
function queryNs(address: string, port: number, name: string, timeoutMs: number): Promise<DecodedResponse> {
  return new Promise((resolve, reject) => {
    const id = randomInt(0, 0x10000);
    const socket = dgram.createSocket(isIP(address) === 6 ? 'udp6' : 'udp4');
    const ignored: string[] = [];
    const finish = (error?: Error, packet?: DecodedResponse) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(packet as DecodedResponse);
    };
    const timer = setTimeout(() => {
      const why = ignored.length ? `; ignored ${ignored.length} datagram(s): ${ignored.slice(-3).join('; ')}` : '';
      finish(new Error(`no valid DNS response within ${timeoutMs} ms${why}`));
    }, timeoutMs);
    socket.on('message', (message, from) => {
      const reason = rejectReason(message, from, { address, port, id, name });
      if (reason) {
        ignored.push(reason);
        return;
      }
      const packet = dnsPacket.decode(message) as DecodedResponse;
      if (packet.flag_tc) {
        finish(new Error('response truncated; TCP fallback is not implemented'));
        return;
      }
      finish(undefined, packet);
    });
    socket.on('error', (error) => finish(error));
    const query = dnsPacket.encode({
      type: 'query',
      id,
      flags: 0, // no recursion: ask the root for its referral
      questions: [{ type: 'NS', name }],
      additionals: [
        { type: 'OPT', name: '.', udpPayloadSize: 4096, extendedRcode: 0, ednsVersion: 0, flags: 0, flag_do: false, options: [] },
      ],
    });
    socket.send(query, port, address);
  });
}
