#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from 'viem';
import {
  formatDelegation,
  hsdRpcSource,
  loadManifest,
  resolveName,
  ResolveError,
  rootDnsSource,
  verifyRegistry,
  DNS_TYPES,
  type DnsType,
  type HandshakeSource,
} from '@pirate-registry/resolver';
import * as sdk from './registry.ts';

const USAGE = `pirate-registry <command> [options]

Operator
  deploy-factory   --rpc URL --key-env VAR --payment-token ADDR
  deploy-registry  --rpc URL --key-env VAR --factory ADDR --tld TLD --treasury ADDR --price USDC [--admin ADDR]
  delegation-record --registry ADDR --chain-id ID
  set-price        --rpc URL --key-env VAR --registry ADDR --price USDC
  sweep            --rpc URL --key-env VAR --registry ADDR

Buyer
  check            --rpc URL --registry ADDR --label LABEL [--years N]
  register         --rpc URL --key-env VAR --registry ADDR --label LABEL --years N (--hsd URL | --hnsd HOST:PORT)
                   [--manifest FILE] [--recipient ADDR] [--max-cost USDC] --accept-disclosures
  renew            --rpc URL --key-env VAR --registry ADDR --label LABEL --years N (--hsd URL | --hnsd HOST:PORT)
                   [--manifest FILE] [--max-cost USDC]
  set-record       --rpc URL --key-env VAR --registry ADDR --label LABEL --type A|AAAA|TXT|CNAME --value V [--value V2] [--ttl S] [--sub NAME]
  set-text         --rpc URL --key-env VAR --registry ADDR --label LABEL --text-key K --value V
  set-addr         --rpc URL --key-env VAR --registry ADDR --label LABEL --address ADDR
  transfer         --rpc URL --key-env VAR --registry ADDR --label LABEL --to ADDR

Anyone
  resolve          --name NAME (--hsd URL | --hnsd HOST:PORT) --chain-rpc ID=URL [--manifest FILE] [--block-tag safe|finalized]
                   [--max-age S] [--type T] [--text-key K] [--remote-trust] [--now UNIX]
  verify-registry  --tld TLD (--hsd URL | --hnsd HOST:PORT) --chain-rpc ID=URL [--manifest FILE] [--block-tag ...] [--now UNIX]

register and renew first verify that the TLD's Handshake delegation names
this registry on this chain and that it passes manifest verification, and
check again after confirmation. Nothing is approved or paid otherwise.

Keys are read from the environment variable named by --key-env (a .env in the
current directory is loaded if present). --now overrides the host clock for
test networks only and is reported in the output.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: 'string' },
    'key-env': { type: 'string' },
    'payment-token': { type: 'string' },
    factory: { type: 'string' },
    registry: { type: 'string' },
    tld: { type: 'string' },
    treasury: { type: 'string' },
    admin: { type: 'string' },
    price: { type: 'string' },
    'chain-id': { type: 'string' },
    label: { type: 'string' },
    years: { type: 'string', default: '1' },
    recipient: { type: 'string' },
    'max-cost': { type: 'string' },
    'accept-disclosures': { type: 'boolean', default: false },
    type: { type: 'string', multiple: true },
    value: { type: 'string', multiple: true },
    ttl: { type: 'string', default: '300' },
    sub: { type: 'string', default: '' },
    'text-key': { type: 'string', multiple: true },
    address: { type: 'string' },
    to: { type: 'string' },
    name: { type: 'string' },
    hsd: { type: 'string' },
    hnsd: { type: 'string' },
    'chain-rpc': { type: 'string', multiple: true },
    manifest: { type: 'string' },
    'block-tag': { type: 'string', default: 'safe' },
    'max-age': { type: 'string' },
    'remote-trust': { type: 'boolean', default: false },
    now: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (existsSync('.env')) process.loadEnvFile('.env');

const USDC_DECIMALS = 6;
const required = (key: keyof typeof values): string => {
  const v = values[key];
  if (typeof v !== 'string' || v === '') throw new Error(`--${key} is required`);
  return v;
};
const address = (key: keyof typeof values): Address => getAddress(required(key));
const usdc = (amount: string) => parseUnits(amount, USDC_DECIMALS);
const print = (data: unknown) =>
  console.log(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

async function signer() {
  const variable = required('key-env');
  const key = process.env[variable];
  if (!key) throw new Error(`environment variable ${variable} is not set`);
  return sdk.connect(required('rpc'), key as Hex);
}

function handshakeSource(): HandshakeSource {
  const allowRemote = values['remote-trust'];
  if (values.hsd) return hsdRpcSource(values.hsd, { allowRemote });
  if (values.hnsd) {
    const [host, port] = values.hnsd.split(/:(?=\d+$)/);
    return rootDnsSource(host, Number(port), { allowRemote, label: 'hnsd' });
  }
  throw new Error('pass --hsd URL or --hnsd HOST:PORT');
}

/** Resolver options for verifying a purchase on the signer's own chain and RPC. */
function authorityOptions(chainId: number) {
  return { ...resolverOptions(), rpcUrls: { [String(chainId)]: required('rpc') } };
}

function resolverOptions() {
  const rpcUrls: Record<string, string> = {};
  for (const entry of values['chain-rpc'] ?? []) {
    const [id, ...rest] = entry.split('=');
    rpcUrls[id] = rest.join('=');
  }
  const tag = values['block-tag'];
  if (tag !== 'safe' && tag !== 'finalized') throw new Error('--block-tag must be safe or finalized');
  return {
    handshake: handshakeSource(),
    rpcUrls,
    manifest: loadManifest(values.manifest),
    blockTag: tag as 'safe' | 'finalized',
    maxAgeSeconds: values['max-age'] ? Number(values['max-age']) : undefined,
    now: values.now ? Number(values.now) : undefined,
  };
}

async function main() {
  const [command] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case 'deploy-factory': {
      const s = await signer();
      print(await sdk.deployFactory(s, address('payment-token')));
      return;
    }
    case 'deploy-registry': {
      const s = await signer();
      const result = await sdk.deployRegistry(s, address('factory'), {
        tld: required('tld'),
        admin: values.admin ? getAddress(values.admin) : s.account.address,
        treasury: address('treasury'),
        annualPrice: usdc(required('price')),
      });
      print({ ...result, delegationRecord: formatDelegation(result.registry, s.chain.id) });
      return;
    }
    case 'delegation-record':
      console.log(formatDelegation(address('registry'), BigInt(required('chain-id'))));
      return;
    case 'set-price': {
      const s = await signer();
      await sdk.setPrice(s, address('registry'), usdc(required('price')));
      print({ annualPrice: required('price') });
      return;
    }
    case 'sweep': {
      const s = await signer();
      const receipt = await sdk.sweep(s, address('registry'));
      print({ transaction: receipt.transactionHash });
      return;
    }
    case 'check': {
      const client = sdk.readOnly(required('rpc'));
      const registry = address('registry');
      const q = await sdk.quote(client, registry, required('label'), Number(values.years));
      const tld = (await client.readContract({ address: registry, abi: (await import('@pirate-registry/resolver')).registryAbi, functionName: 'tld' })) as string;
      print({
        label: `${required('label')}.${tld}`,
        available: q.available,
        annualPriceUsdc: formatUnits(q.annualPrice, USDC_DECIMALS),
        costUsdc: formatUnits(q.cost, USDC_DECIMALS),
        current: q.current,
        disclosures: sdk.disclosures(tld),
      });
      return;
    }
    case 'register': {
      const s = await signer();
      const registry = address('registry');
      const label = required('label');
      const years = Number(values.years);
      // Authority first: nothing is quoted, approved or paid for an undelegated registry.
      const authority = await sdk.verifyPurchaseAuthority(s.publicClient, registry, s.chain.id, authorityOptions(s.chain.id));
      const q = await sdk.quote(s.publicClient, registry, label, years);
      console.error(`Registering ${label}.${authority.tld} for ${years} year(s) at ${formatUnits(q.cost, USDC_DECIMALS)} USDC.`);
      console.error(`Delegation verified: ${authority.delegation.record} via ${authority.handshake.source}.`);
      for (const line of sdk.disclosures(authority.tld, authority.handshake.renewal)) console.error(`- ${line}`);
      if (!values['accept-disclosures']) throw new Error('re-run with --accept-disclosures after reading the disclosures above');
      const result = await sdk.register(s, registry, {
        label,
        years,
        recipient: values.recipient ? getAddress(values.recipient) : undefined,
        maxCost: values['max-cost'] ? usdc(values['max-cost']) : q.cost,
      });
      const after = await sdk
        .verifyPurchaseAuthority(s.publicClient, registry, s.chain.id, authorityOptions(s.chain.id))
        .then(() => 'verified')
        .catch((e: unknown) => (e instanceof ResolveError ? e.code : (e as Error).message));
      print({
        tokenId: result.tokenId,
        generation: result.generation,
        expiry: result.expiry,
        transaction: result.receipt.transactionHash,
        delegationBefore: authority.delegation.record,
        delegationAfter: after,
      });
      return;
    }
    case 'renew': {
      const s = await signer();
      const registry = address('registry');
      const authority = await sdk.verifyPurchaseAuthority(s.publicClient, registry, s.chain.id, authorityOptions(s.chain.id));
      const tokenId = await sdk.currentTokenId(s.publicClient, registry, required('label'));
      const receipt = await sdk.renew(s, registry, tokenId, Number(values.years), values['max-cost'] ? usdc(values['max-cost']) : undefined);
      print({ tokenId, transaction: receipt.transactionHash, delegation: authority.delegation.record });
      return;
    }
    case 'set-record': {
      const s = await signer();
      const registry = address('registry');
      const tokenId = await sdk.currentTokenId(s.publicClient, registry, required('label'));
      const [type] = values.type ?? [];
      if (!DNS_TYPES.includes(type as DnsType)) throw new Error(`--type must be one of ${DNS_TYPES.join(', ')}`);
      const receipt = await sdk.setDnsRecord(s, registry, tokenId, {
        relativeName: values.sub,
        type: type as DnsType,
        values: values.value ?? [],
        ttl: Number(values.ttl),
      });
      print({ tokenId, transaction: receipt.transactionHash });
      return;
    }
    case 'set-text': {
      const s = await signer();
      const registry = address('registry');
      const tokenId = await sdk.currentTokenId(s.publicClient, registry, required('label'));
      const [key] = values['text-key'] ?? [];
      const [value] = values.value ?? [];
      if (!key || value === undefined) throw new Error('--text-key and --value are required');
      print({ transaction: (await sdk.setText(s, registry, tokenId, key, value)).transactionHash });
      return;
    }
    case 'set-addr': {
      const s = await signer();
      const registry = address('registry');
      const tokenId = await sdk.currentTokenId(s.publicClient, registry, required('label'));
      print({ transaction: (await sdk.setAddr(s, registry, tokenId, address('address'))).transactionHash });
      return;
    }
    case 'transfer': {
      const s = await signer();
      const registry = address('registry');
      const tokenId = await sdk.currentTokenId(s.publicClient, registry, required('label'));
      print({ transaction: (await sdk.transfer(s, registry, tokenId, address('to'))).transactionHash });
      return;
    }
    case 'resolve': {
      const types = (values.type ?? []) as DnsType[];
      print(
        await resolveName({
          ...resolverOptions(),
          name: required('name'),
          dnsTypes: types.length ? types : undefined,
          textKeys: values['text-key'],
        }),
      );
      return;
    }
    case 'verify-registry': {
      const verified = await verifyRegistry(required('tld'), resolverOptions());
      print({
        tld: required('tld'),
        registry: verified.delegation.registry,
        chainId: verified.delegation.chainId,
        record: verified.delegation.record,
        manifestRelease: verified.manifestRelease,
        protocolVersion: verified.protocolVersion,
        handshake: verified.handshake,
        block: verified.reader.block,
        evmTrust: verified.evmTrust,
        clock: verified.clock,
      });
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ResolveError) {
    print({ error: error.code, message: error.message });
  } else {
    console.error((error as Error).message);
  }
  process.exitCode = 1;
});
