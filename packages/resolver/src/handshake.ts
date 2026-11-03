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
 */
export function rootDnsSource(
  host: string,
  port: number,
  options: { allowRemote?: boolean; timeoutMs?: number; label?: string } = {},
): HandshakeSource {
  const description = `${options.label ?? 'root'} dns://${host}:${port}`;
  const remote = requireTrust(host, options.allowRemote ?? false, description);
  return {
    description,
    async lookup(tld) {
      const response = await queryNs(host, port, tld, options.timeoutMs ?? 3000).catch((error: Error) => {
        throw new ResolveError('handshake_unavailable', `${description}: ${error.message}`);
      });
      const records = [...(response.answers ?? []), ...(response.authorities ?? [])];
      const nsTargets = records
        .filter((r) => r.type === 'NS' && r.name.toLowerCase() === tld.toLowerCase())
        .map((r) => `${String((r as { data: string }).data).replace(/\.$/, '')}.`);
      return { nsTargets, source: description, trust: remote ?? 'local-spv' };
    },
  };
}

function queryNs(host: string, port: number, name: string, timeoutMs: number): Promise<dnsPacket.Packet> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 0xffff);
    const socket = dgram.createSocket(isIP(host) === 6 ? 'udp6' : 'udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no DNS response within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on('message', (message) => {
      const packet = dnsPacket.decode(message);
      if (packet.id !== id) return;
      clearTimeout(timer);
      socket.close();
      resolve(packet);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    const query = dnsPacket.encode({
      type: 'query',
      id,
      flags: 0, // no recursion: ask the root for its referral
      questions: [{ type: 'NS', name }],
      additionals: [
        { type: 'OPT', name: '.', udpPayloadSize: 4096, extendedRcode: 0, ednsVersion: 0, flags: 0, flag_do: false, options: [] },
      ],
    });
    socket.send(query, port, host);
  });
}
