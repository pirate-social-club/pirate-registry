// hsd regtest helpers over JSON-RPC. Local acceptance only.

export const REGTEST = {
  nodeRpc: 'http://127.0.0.1:14037/',
  walletRpc: 'http://127.0.0.1:14039/',
  nsPort: 25349,
  p2pPort: 14038,
  treeInterval: 5,
  biddingPeriod: 5,
  revealPeriod: 10,
} as const;

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const body = (await response.json()) as { result: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

export const node = <T>(method: string, params: unknown[] = []) => rpc<T>(REGTEST.nodeRpc, method, params);
export const wallet = <T>(method: string, params: unknown[] = []) => rpc<T>(REGTEST.walletRpc, method, params);

let miningAddress: string | undefined;
export async function mine(blocks: number): Promise<void> {
  miningAddress ??= await wallet<string>('getnewaddress');
  await node('generatetoaddress', [blocks, miningAddress]);
}

export const height = () => node<number>('getblockcount');

/** Mature enough coinbase to fund every auction in a run. */
export const fund = () => mine(120);

export type HnsRecord = { type: 'NS'; ns: string } | { type: 'TXT'; txt: string[] };
export const ns = (target: string): HnsRecord => ({ type: 'NS', ns: target });

/** Win a TLD through open, bid, reveal and register, publishing `records`. */
export async function claimTld(name: string, records: HnsRecord[]): Promise<void> {
  await wallet('sendopen', [name]);
  await mine(REGTEST.treeInterval + 1);
  await wallet('sendbid', [name, 1, 2]);
  await mine(REGTEST.biddingPeriod);
  await wallet('sendreveal', [name]);
  await mine(REGTEST.revealPeriod);
  await wallet('sendupdate', [name, { records }]);
  await commit();
}

export async function updateTld(name: string, records: HnsRecord[]): Promise<void> {
  await wallet('sendupdate', [name, { records }]);
  await commit();
}

/**
 * Mine until a full node serves the update (one tree interval) and until an
 * SPV resolver such as hnsd does: hnsd proves against the root at the last
 * interval boundary until 12 blocks pass, which on regtest (interval 5)
 * means waiting for a second boundary.
 */
export async function commit(): Promise<void> {
  await mine(REGTEST.treeInterval * 3);
}

/** Claim several TLDs in one set of auctions. */
export async function claimTlds(names: Record<string, HnsRecord[]>): Promise<void> {
  const tlds = Object.keys(names);
  for (const name of tlds) await wallet('sendopen', [name]);
  await mine(REGTEST.treeInterval + 1);
  for (const name of tlds) await wallet('sendbid', [name, 1, 2]);
  await mine(REGTEST.biddingPeriod);
  for (const name of tlds) await wallet('sendreveal', [name]);
  await mine(REGTEST.revealPeriod);
  for (const name of tlds) await wallet('sendupdate', [name, { records: names[name] }]);
  await commit();
}
