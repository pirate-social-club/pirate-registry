import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  zeroAddress,
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

/** SPEC 6.2: a price entry that closes new registrations. */
export const NOT_FOR_SALE = 2n ** 256n - 1n;

/** Chains this release supports, with names used in disclosures. */
export const CHAIN_NAMES: Record<number, string> = { 6343: 'MegaETH testnet', 31337: 'local anvil' };

export async function tokenInfo(client: PublicClient, token: Address) {
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
  ]);
  return { address: token, decimals, symbol };
}

// --- Operator ----------------------------------------------------------------

const FACTORY_ARTIFACT = new URL('../../../out/RegistryFactory.sol/RegistryFactory.json', import.meta.url);
const TEST_TOKEN_ARTIFACT = new URL('../../../out/PirateTestUSD.sol/PirateTestUSD.json', import.meta.url);

const testTokenAbi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [] },
] as const;

async function deployArtifact(signer: Signer, artifactUrl: URL, abi: readonly unknown[], args: readonly unknown[]) {
  const artifact = JSON.parse(readFileSync(artifactUrl, 'utf8')) as { bytecode: { object: Hex } };
  const hash = await signer.walletClient.deployContract({
    abi,
    bytecode: artifact.bytecode.object,
    args,
    account: signer.account,
    chain: signer.chain,
  } as never);
  const receipt = await confirm(signer, hash);
  return { address: receipt.contractAddress as Address, transaction: hash, gasUsed: receipt.gasUsed };
}

/** Deploys the factory from the solc release build in out/. */
export async function deployFactory(signer: Signer, paymentToken: Address) {
  const { address: factory, transaction, gasUsed } = await deployArtifact(signer, FACTORY_ARTIFACT, factoryAbi, [paymentToken]);
  const implementation = await signer.publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'implementation' });
  return { factory, implementation, transaction, gasUsed };
}

/** Deploys the valueless PirateTestUSD. Its constructor refuses chains other than MegaETH testnet and anvil. */
export async function deployTestToken(signer: Signer) {
  const { address, transaction, gasUsed } = await deployArtifact(signer, TEST_TOKEN_ARTIFACT, testTokenAbi, []);
  return { paymentToken: address, transaction, gasUsed };
}

export async function mintTestToken(signer: Signer, token: Address, to: Address, amount: bigint) {
  const { request } = await signer.publicClient.simulateContract({
    address: token,
    abi: testTokenAbi,
    functionName: 'mint',
    args: [to, amount],
    account: signer.account,
    chain: signer.chain,
  });
  return confirm(signer, await signer.walletClient.writeContract(request));
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
export const setLengthPrices = (s: Signer, registry: Address, prices: bigint[]) =>
  write(s, registry, 'setLengthPrices', [prices]);
export const setPremiumPrices = (s: Signer, registry: Address, labels: string[], prices: bigint[]) =>
  write(s, registry, 'setPremiumPrices', [labels, prices]);
export const clearPremiumPrices = (s: Signer, registry: Address, labels: string[]) =>
  write(s, registry, 'clearPremiumPrices', [labels]);
export const setReservations = (s: Signer, registry: Address, labels: string[], claimants: Address[]) =>
  write(s, registry, 'setReservations', [labels, claimants]);

/**
 * The table for an open-sale minimum length: lengths below `minLength` are
 * closed and every longer label costs `annualPrice` (the current app's 8+
 * band is `minLengthTable(8, price)`). Shorter labels sell only with a
 * premium price.
 */
export function minLengthTable(minLength: number, annualPrice: bigint): bigint[] {
  if (!Number.isInteger(minLength) || minLength < 1 || minLength > 10) throw new Error('minimum length must be 1 to 10');
  return [...Array.from({ length: minLength - 1 }, () => NOT_FOR_SALE), annualPrice];
}
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

/**
 * What a new registration of `label` would cost now. `forSale` is false when
 * the label's tier or premium price is NOT_FOR_SALE; `reservedFor` is the
 * only recipient allowed when it is not the zero address.
 */
export async function quote(client: PublicClient, registry: Address, label: string, years: number) {
  const [available, annualPrice, reservedFor, paymentToken, current] = await Promise.all([
    client.readContract({ address: registry, abi: registryAbi, functionName: 'available', args: [label] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'priceOf', args: [label] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'reservedFor', args: [label] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'paymentToken' }),
    client.readContract({ address: registry, abi: registryAbi, functionName: 'currentToken', args: [label] }),
  ]);
  const [tokenId, generation, status] = current;
  const forSale = annualPrice !== NOT_FOR_SALE;
  return {
    available,
    forSale,
    reservedFor: reservedFor === zeroAddress ? undefined : reservedFor,
    annualPrice: forSale ? annualPrice : undefined,
    cost: forSale ? annualPrice * BigInt(years) : undefined,
    paymentToken,
    current: { tokenId, generation, status: STATUS[Number(status)] },
  };
}

/** The registry's sale policy for a set of labels, for operators and storefronts. */
export async function policy(client: PublicClient, registry: Address, labels: string[] = []) {
  const lengthPrices = await client.readContract({ address: registry, abi: registryAbi, functionName: 'lengthPrices' });
  const entries = await Promise.all(
    labels.map(async (label) => {
      const [[premiumSet, premiumPrice], reservedFor, annualPrice] = await Promise.all([
        client.readContract({ address: registry, abi: registryAbi, functionName: 'premiumPriceOf', args: [label] }),
        client.readContract({ address: registry, abi: registryAbi, functionName: 'reservedFor', args: [label] }),
        client.readContract({ address: registry, abi: registryAbi, functionName: 'priceOf', args: [label] }),
      ]);
      return {
        label,
        annualPrice: annualPrice === NOT_FOR_SALE ? 'not for sale' : annualPrice,
        premium: premiumSet ? (premiumPrice === NOT_FOR_SALE ? 'not for sale' : premiumPrice) : undefined,
        reservedFor: reservedFor === zeroAddress ? undefined : reservedFor,
      };
    }),
  );
  return {
    lengthPrices: lengthPrices.map((price, i) => ({
      length: i === lengthPrices.length - 1 ? `${i + 1}+` : String(i + 1),
      annualPrice: price === NOT_FOR_SALE ? 'not for sale' : price,
    })),
    labels: entries,
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
  const recipient = options.recipient ?? signer.account.address;
  if (!q.available) throw new Error(`${options.label} is not available`);
  if (!q.forSale || q.cost === undefined) throw new Error(`${options.label} is not for sale`);
  if (q.reservedFor && q.reservedFor !== getAddress(recipient)) {
    throw new Error(`${options.label} is reserved for ${q.reservedFor}`);
  }
  const maxCost = options.maxCost ?? q.cost;
  await ensureAllowance(signer, q.paymentToken, registry, maxCost);
  const block = await signer.publicClient.getBlock();
  const deadline = block.timestamp + BigInt(options.deadlineSeconds ?? 600);
  const receipt = await write(signer, registry, 'register', [
    options.label,
    options.years,
    recipient,
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
export function disclosures(tld: string, renewal?: { daysUntilExpire: number }, chainId?: number): string[] {
  const chain = chainId === undefined ? 'its chain' : `chain ${chainId}${CHAIN_NAMES[chainId] ? ` (${CHAIN_NAMES[chainId]})` : ''}`;
  return [
    `The owner of .${tld} on Handshake can repoint its delegation or let it lapse, which ends resolution while the NFT survives.` +
      (renewal ? ` The TLD's Handshake registration expires in about ${renewal.daysUntilExpire.toFixed(1)} days unless renewed.` : ' Its Handshake renewal deadline is unknown from this source.'),
    `This registry runs on ${chain} and depends on its sequencer ordering, upgrade controls and finality.`,
    "The payment token's issuer may be able to pause it or block the payer or the registry; either would block paid registrations, paid renewals and sweeps.",
    "The operator can change prices and reservations for future registrations at any time. This registration's annual price stays locked through transfers, grace and renewals, but a reservation can stop anyone except its claimant from registering the name again after it is released.",
    'There is no commit-reveal: another buyer can win a race for the same label. The maximum cost and deadline protect only the payment terms.',
    "The operator's revenue sits in the registry contract until someone sweeps it to the treasury.",
    'Records are public.',
  ];
}
