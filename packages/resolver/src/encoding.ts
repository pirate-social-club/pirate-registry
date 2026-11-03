import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, stringToBytes, type Hex } from 'viem';
import { ResolveError } from './errors.ts';

/** SPEC 6.3: lowercase LDH, 1 to 63 characters, no edge hyphens, no `--` at 3-4. */
export function isValidLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false;
  if (!/^[a-z0-9-]+$/.test(label)) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;
  if (label.length >= 4 && label[2] === '-' && label[3] === '-') return false;
  return true;
}

export const labelhash = (label: string): Hex => keccak256(stringToBytes(label));

/** SPEC 6.4: token ID = keccak256(abi.encode(bytes32 labelhash, uint64 generation)). */
export function tokenIdFor(label: string, generation: bigint): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [labelhash(label), generation])));
}

// SPEC 6.9 record keys.
export const dnsKey = (relativeName: string, rrtype: number): Hex =>
  keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'uint16' }], ['dns', relativeName, rrtype]));
export const addrKey = (coinType: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['addr', coinType]));
export const textKey = (key: string): Hex =>
  keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['text', key]));
export const contenthashKey = (): Hex => keccak256(encodeAbiParameters([{ type: 'string' }], ['contenthash']));

export const RRTYPE = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 } as const;
export type DnsType = keyof typeof RRTYPE;
export const DNS_TYPES = Object.keys(RRTYPE) as DnsType[];

export interface RRset {
  ttl: number;
  rdatas: Uint8Array[];
}

/** Custom RRset envelope (SPEC 6.9): uint32 ttl, then repeated uint16 rdlength + RDATA, big-endian. */
export function encodeRRset(set: RRset): Hex {
  if (set.rdatas.length === 0) throw new Error('RRset needs at least one RDATA');
  const total = 4 + set.rdatas.reduce((n, r) => n + 2 + r.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, set.ttl);
  let offset = 4;
  for (const rdata of set.rdatas) {
    if (rdata.length > 0xffff) throw new Error('RDATA too long');
    view.setUint16(offset, rdata.length);
    out.set(rdata, offset + 2);
    offset += 2 + rdata.length;
  }
  return bytesToHex(out);
}

export function decodeRRset(value: Hex): RRset {
  const bytes = hexToBytes(value);
  if (bytes.length < 6) throw new ResolveError('record_malformed', 'RRset shorter than ttl plus one RDATA header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ttl = view.getUint32(0);
  const rdatas: Uint8Array[] = [];
  let offset = 4;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw new ResolveError('record_malformed', 'truncated RDATA length');
    const length = view.getUint16(offset);
    if (offset + 2 + length > bytes.length) throw new ResolveError('record_malformed', 'truncated RDATA');
    rdatas.push(bytes.slice(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return { ttl, rdatas };
}

// --- RDATA codecs for the milestone-1 types ---------------------------------

export function encodeA(address: string): Uint8Array {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) {
    throw new Error(`invalid IPv4 address: ${address}`);
  }
  return Uint8Array.from(parts.map(Number));
}

export function decodeA(rdata: Uint8Array): string {
  if (rdata.length !== 4) throw new ResolveError('record_malformed', 'A RDATA must be 4 bytes');
  return Array.from(rdata).join('.');
}

export function encodeAAAA(address: string): Uint8Array {
  const halves = address.split('::');
  if (halves.length > 2) throw new Error(`invalid IPv6 address: ${address}`);
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) throw new Error(`invalid IPv6 address: ${address}`);
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error(`invalid IPv6 address: ${address}`);
    const value = parseInt(g, 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  });
  return out;
}

export function decodeAAAA(rdata: Uint8Array): string {
  if (rdata.length !== 16) throw new ResolveError('record_malformed', 'AAAA RDATA must be 16 bytes');
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((rdata[i] << 8) | rdata[i + 1]);
  // Compress the longest run of zero groups (RFC 5952).
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength && j - i > 1) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

export function encodeTXT(strings: string[]): Uint8Array {
  const chunks = strings.map((s) => {
    const bytes = stringToBytes(s);
    if (bytes.length > 255) throw new Error('TXT character-string longer than 255 bytes');
    return Uint8Array.from([bytes.length, ...bytes]);
  });
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function decodeTXT(rdata: Uint8Array): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const out: string[] = [];
  let offset = 0;
  if (rdata.length === 0) throw new ResolveError('record_malformed', 'empty TXT RDATA');
  while (offset < rdata.length) {
    const length = rdata[offset];
    if (offset + 1 + length > rdata.length) throw new ResolveError('record_malformed', 'truncated TXT string');
    try {
      out.push(decoder.decode(rdata.slice(offset + 1, offset + 1 + length)));
    } catch {
      throw new ResolveError('record_malformed', 'TXT string is not UTF-8');
    }
    offset += 1 + length;
  }
  return out;
}

/** Uncompressed DNS wire-format name, e.g. "target.example." */
export function encodeName(name: string): Uint8Array {
  const labels = name.replace(/\.$/, '').split('.').filter((l) => l.length > 0);
  const parts: number[] = [];
  for (const label of labels) {
    const bytes = stringToBytes(label);
    if (bytes.length > 63) throw new Error('DNS label longer than 63 bytes');
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  if (parts.length > 255) throw new Error('DNS name longer than 255 bytes');
  return Uint8Array.from(parts);
}

export function decodeName(rdata: Uint8Array): string {
  const labels: string[] = [];
  let offset = 0;
  while (true) {
    if (offset >= rdata.length) throw new ResolveError('record_malformed', 'unterminated DNS name');
    const length = rdata[offset];
    if (length === 0) {
      if (offset + 1 !== rdata.length) throw new ResolveError('record_malformed', 'trailing bytes after DNS name');
      break;
    }
    if (length > 63) throw new ResolveError('record_malformed', 'compressed or oversized label in DNS name');
    if (offset + 1 + length > rdata.length) throw new ResolveError('record_malformed', 'truncated DNS label');
    labels.push(new TextDecoder().decode(rdata.slice(offset + 1, offset + 1 + length)));
    offset += 1 + length;
  }
  return `${labels.join('.')}.`;
}

export function encodeRdata(type: DnsType, value: string): Uint8Array {
  switch (type) {
    case 'A':
      return encodeA(value);
    case 'AAAA':
      return encodeAAAA(value);
    case 'TXT':
      return encodeTXT([value]);
    case 'CNAME':
      return encodeName(value);
  }
}

export function decodeRdata(type: DnsType, rdata: Uint8Array): string | string[] {
  switch (type) {
    case 'A':
      return decodeA(rdata);
    case 'AAAA':
      return decodeAAAA(rdata);
    case 'TXT':
      return decodeTXT(rdata);
    case 'CNAME':
      return decodeName(rdata);
  }
}
