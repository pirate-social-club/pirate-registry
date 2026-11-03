import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ResolveError } from './errors.ts';

export type BlockTag = 'safe' | 'finalized';

export interface PinnedBlock {
  tag: BlockTag;
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/**
 * Resolves a block tag to one block once, then performs every code and state
 * read against that block's hash with `requireCanonical: true` (EIP-1898).
 * There is no fallback to `latest`.
 */
export class PinnedReader {
  readonly client: PublicClient;
  readonly block: PinnedBlock;
  readonly rpcUrl: string;

  private constructor(client: PublicClient, block: PinnedBlock, rpcUrl: string) {
    this.client = client;
    this.block = block;
    this.rpcUrl = rpcUrl;
  }

  static async open(rpcUrl: string, tag: BlockTag, expectedChainId: bigint): Promise<PinnedReader> {
    const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
    let chainId: number;
    let raw: { number: Hex; hash: Hex; timestamp: Hex } | null;
    try {
      chainId = await client.getChainId();
      raw = (await client.request({ method: 'eth_getBlockByNumber', params: [tag, false] } as never)) as typeof raw;
    } catch (error) {
      throw new ResolveError('rpc_error', `${rpcUrl}: ${(error as Error).message}`);
    }
    if (BigInt(chainId) !== expectedChainId) {
      throw new ResolveError('chain_mismatch', `RPC reports chain ${chainId}, delegation names ${expectedChainId}`);
    }
    if (!raw) throw new ResolveError('rpc_error', `${rpcUrl} returned no ${tag} block`);
    const block = { tag, number: BigInt(raw.number), hash: raw.hash, timestamp: BigInt(raw.timestamp) };
    return new PinnedReader(client, block, rpcUrl);
  }

  private get blockIdentifier() {
    return { blockHash: this.block.hash, requireCanonical: true };
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    try {
      return (await this.client.request({ method, params } as never)) as T;
    } catch (error) {
      const message = (error as Error).message;
      const code = (error as { code?: number }).code ?? (error as { cause?: { code?: number } }).cause?.code;
      if (code === -32602 || /requireCanonical|invalid (params|argument)/i.test(message)) {
        throw new ResolveError('rpc_unsupported', `${this.rpcUrl} rejected an EIP-1898 block hash read: ${message}`);
      }
      throw new ResolveError('rpc_error', `${method} at block ${this.block.hash}: ${message}`);
    }
  }

  getCode(address: Address): Promise<Hex> {
    return this.request<Hex>('eth_getCode', [address, this.blockIdentifier]);
  }

  async read<const TAbi extends Abi>(address: Address, abi: TAbi, functionName: string, args: readonly unknown[] = []) {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const result = await this.request<Hex>('eth_call', [{ to: address, data }, this.blockIdentifier]);
    return decodeFunctionResult({ abi, functionName, data: result } as never) as unknown;
  }
}
