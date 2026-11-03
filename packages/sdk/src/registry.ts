import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  addrKey,
  dnsKey,
  encodeRdata,
  encodeRRset,
  factoryAbi,
  registryAbi,
  ResolveError,
  RRTYPE,
  STATUS,
  textKey,
  tokenIdFor,
  verifyRegistry,
  type DnsType,
  type ResolveOptions,
  type VerifiedRegistry,
} from '@pirate-registry/resolver';

export interface Signer {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
}

export async function connect(rpcUrl: string, privateKey: Hex): Promise<Signer> {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const id = await probe.getChainId();
  const chain = defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  return {
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
    walletClient: createWalletClient({ chain, account, transport: http(rpcUrl) }),
    account,
    chain,
  };
}

export function readOnly(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

async function confirm(signer: Signer, hash: Hex): Promise<TransactionReceipt> {
  const receipt = await signer.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/** Simulates first so reverts surface with their decoded error, then sends. */
async function write(signer: Signer, address: Address, functionName: string, args: readonly unknown[]) {
  const { request } = await signer.publicClient.simulateContract({
    address,
    abi: registryAbi,
    functionName,
    args,
    account: signer.account,
    chain: signer.chain,
  } as never);
  return confirm(signer, await signer.walletClient.writeContract(request as never));
}

// --- Operator ----------------------------------------------------------------

const FACTORY_ARTIFACT = new URL('../../../out/RegistryFactory.sol/RegistryFactory.json', import.meta.url);

/** Deploys the factory from the solc release build in out/. */
export async function deployFactory(signer: Signer, paymentToken: Address) {
  const artifact = JSON.parse(readFileSync(FACTORY_ARTIFACT, 'utf8')) as { bytecode: { object: Hex } };
  const hash = await signer.walletClient.deployContract({
    abi: factoryAbi,
    bytecode: artifact.bytecode.object,
    args: [paymentToken],
    account: signer.account,
    chain: signer.chain,
  });
  const receipt = await confirm(signer, hash);
  const factory = receipt.contractAddress as Address;
  const implementation = await signer.publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'implementation' });
  return { factory, implementation, transaction: hash };
}

export async function deployRegistry(
  signer: Signer,
  factory: Address,
  config: { tld: string; admin: Address; treasury: Address; annualPrice: bigint },
) {
  const { request } = await signer.publicClient.simulateContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'deployRegistry',
    args: [config.tld, config.admin, config.treasury, config.annualPrice],
    account: signer.account,
    chain: signer.chain,
  });
  const receipt = await confirm(signer, await signer.walletClient.writeContract(request));
  const [event] = parseEventLogs({ abi: factoryAbi, eventName: 'RegistryDeployed', logs: receipt.logs });
  return { registry: event.args.registry, transaction: receipt.transactionHash };
}

export const setPrice = (s: Signer, registry: Address, annualPrice: bigint) => write(s, registry, 'setPrice', [annualPrice]);
export const setTreasury = (s: Signer, registry: Address, treasury: Address) => write(s, registry, 'setTreasury', [treasury]);
export const sweep = (s: Signer, registry: Address) => write(s, registry, 'sweep', []);

// --- Buyer -------------------------------------------------------------------

export type AuthorityOptions = Omit<ResolveOptions, 'name' | 'dnsTypes' | 'textKeys' | 'coinTypes'>;

/**
 * SPEC section 4: before any purchase, the registry must be the one the TLD's
 * current Handshake delegation names, on this chain, and must pass manifest
 * verification. Deploying a registry confers no authority, so a registry
 * address alone is never trusted.
 */
export async function verifyPurchaseAuthority(
  client: PublicClient,
  registry: Address,
  chainId: number,
  options: AuthorityOptions,
): Promise<VerifiedRegistry & { tld: string }> {
  const tld = await client.readContract({ address: registry, abi: registryAbi, functionName: 'tld' });
  const verified = await verifyRegistry(tld, options);
  if (verified.delegation.chainId !== BigInt(chainId)) {
    throw new ResolveError('chain_mismatch', `.${tld} is delegated to chain ${verified.delegation.chainId}, not ${chainId}`);
  }
  if (verified.delegation.registry !== getAddress(registry)) {
    throw new ResolveError('config_mismatch', `.${tld} is delegated to ${verified.delegation.registry}, not ${registry}`);
  }
  return Object.assign(verified, { tld });
}

export async function quote(client: PublicClient, registry: Address, label: string, years: number) {
  const [available, annualPrice, paymentToken, current] = await Promise.all([
    client.readContract({ address: registry, abi: registryAbi, functionName: 'available', args: [label] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'annualPrice' }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'paymentToken' }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'currentToken', args: [label] }),
  ]);
  const [tokenId, generation, status] = current;
  return {
    available,
    annualPrice,
    cost: annualPrice * BigInt(years),
    paymentToken,
    current: { tokenId, generation, status: STATUS[Number(status)] },
  };
}

export async function ensureAllowance(signer: Signer, token: Address, spender: Address, amount: bigint) {
  const allowance = await signer.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [signer.account.address, spender],
  });
  if (allowance >= amount) return undefined;
  const hash = await signer.walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
    account: signer.account,
    chain: signer.chain,
  });
  return confirm(signer, hash);
}

export async function register(
  signer: Signer,
  registry: Address,
  options: { label: string; years: number; recipient?: Address; maxCost?: bigint; deadlineSeconds?: number },
) {
  const q = await quote(signer.publicClient, registry, options.label, options.years);
  const maxCost = options.maxCost ?? q.cost;
  await ensureAllowance(signer, q.paymentToken, registry, maxCost);
  const block = await signer.publicClient.getBlock();
  const deadline = block.timestamp + BigInt(options.deadlineSeconds ?? 600);
  const receipt = await write(signer, registry, 'register', [
    options.label,
    options.years,
    options.recipient ?? signer.account.address,
    maxCost,
    deadline,
  ]);
  const [event] = parseEventLogs({ abi: registryAbi, eventName: 'Registered', logs: receipt.logs });
  return { tokenId: event.args.tokenId, generation: event.args.generation, expiry: event.args.expiry, receipt };
}

export async function currentTokenId(client: PublicClient, registry: Address, label: string): Promise<bigint> {
  const [tokenId, generation] = await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'currentToken',
    args: [label],
  });
  if (generation === 0n) throw new Error(`${label} has never been registered`);
  if (tokenId !== tokenIdFor(label, generation)) throw new Error('token ID derivation mismatch');
  return tokenId;
}

export async function renew(signer: Signer, registry: Address, tokenId: bigint, years: number, maxCost?: bigint) {
  const [price, paymentToken] = await Promise.all([
    signer.publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'lockedPrice', args: [tokenId] }),
    signer.publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'paymentToken' }),
  ]);
  const cost = maxCost ?? price * BigInt(years);
  await ensureAllowance(signer, paymentToken, registry, cost);
  const block = await signer.publicClient.getBlock();
  return write(signer, registry, 'renew', [tokenId, years, cost, block.timestamp + 600n]);
}

export function setDnsRecord(
  signer: Signer,
  registry: Address,
  tokenId: bigint,
  record: { relativeName?: string; type: DnsType; values: string[]; ttl?: number },
) {
  const value = encodeRRset({ ttl: record.ttl ?? 300, rdatas: record.values.map((v) => encodeRdata(record.type, v)) });
  return write(signer, registry, 'setRecord', [tokenId, dnsKey(record.relativeName ?? '', RRTYPE[record.type]), value]);
}

export const deleteDnsRecord = (s: Signer, registry: Address, tokenId: bigint, type: DnsType, relativeName = '') =>
  write(s, registry, 'setRecord', [tokenId, dnsKey(relativeName, RRTYPE[type]), '0x']);

export const setText = (s: Signer, registry: Address, tokenId: bigint, key: string, value: string) =>
  write(s, registry, 'setRecord', [tokenId, textKey(key), `0x${Buffer.from(value, 'utf8').toString('hex')}`]);

export const setAddr = (s: Signer, registry: Address, tokenId: bigint, address: Address, coinType = 60n) =>
  write(s, registry, 'setRecord', [tokenId, addrKey(coinType), address]);

export const setRecordManager = (s: Signer, registry: Address, tokenId: bigint, manager: Address) =>
  write(s, registry, 'setRecordManager', [tokenId, manager]);

export const transfer = (s: Signer, registry: Address, tokenId: bigint, to: Address) =>
  write(s, registry, 'transferFrom', [s.account.address, to, tokenId]);

/** SPEC section 9: shown before every purchase. */
export function disclosures(tld: string, renewal?: { daysUntilExpire: number }): string[] {
  return [
    `The owner of .${tld} on Handshake can repoint its delegation or let it lapse, which ends resolution while the NFT survives.` +
      (renewal ? ` The TLD's Handshake registration expires in about ${renewal.daysUntilExpire.toFixed(1)} days unless renewed.` : ' Its Handshake renewal deadline is unknown from this source.'),
    'This registry runs on Base and depends on its sequencer ordering, upgrade controls and finality.',
    'Circle can pause USDC or blacklist the payer or the registry; either blocks paid registrations, paid renewals and sweeps.',
    'There is no commit-reveal: another buyer can win a race for the same label. The maximum cost and deadline protect only the payment terms.',
    "The operator's revenue sits in the registry contract until someone sweeps it to the treasury.",
    'Records are public.',
  ];
}
