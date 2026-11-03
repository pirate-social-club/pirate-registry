import { readFileSync } from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';

/** SPEC section 7: one entry per chain, shipped inside the package. */
export interface ChainManifest {
  name: string;
  factory: Address;
  factoryCodeHash: Hex;
  implementation: Address;
  implementationCodeHash: Hex;
  paymentToken: Address;
  paymentTokenDecimals: number;
}

export interface ReleaseManifest {
  release: string;
  protocolVersion: number;
  sourceCommit: string;
  compiler: Record<string, string | number | boolean>;
  chains: Record<string, ChainManifest>;
}

export const BUNDLED_MANIFEST = new URL('../manifest/manifest.json', import.meta.url);

/** Reads a manifest from a local file. Never fetched from a network service. */
export function loadManifest(path: string | URL = BUNDLED_MANIFEST): ReleaseManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
  if (typeof manifest.release !== 'string' || typeof manifest.chains !== 'object') {
    throw new Error(`invalid manifest at ${String(path)}`);
  }
  for (const [chainId, chain] of Object.entries(manifest.chains)) {
    if (!/^[1-9][0-9]*$/.test(chainId)) throw new Error(`invalid chain id ${chainId} in manifest`);
    for (const key of ['factory', 'implementation', 'paymentToken'] as const) chain[key] = getAddress(chain[key]);
  }
  return manifest;
}

/** Exact EIP-1167 runtime of a clone pointing at `implementation`. */
export function expectedCloneRuntime(implementation: Address): Hex {
  return `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}
