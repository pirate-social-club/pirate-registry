// Proves an `_evm` record survives publication through hsd regtest and comes
// back intact over RPC and the root name server. Needs a running hsd regtest.
// Usage: node harness/delegation-roundtrip.ts <tld> <registry> <chainId>
import { execFileSync } from 'node:child_process';
import { claimTld, fund, node, ns, REGTEST } from './lib/hsd.ts';

const [tld = 'roundtrip', registry = '0x5fbdb2315678afecb367f032d93f642f64180aa3', chainId = '31337'] = process.argv.slice(2);
const target = `${registry.toLowerCase()}.${chainId}._evm.`;
await fund();
await claimTld(tld, [ns(target)]);
const resource = await node<{ records?: Array<{ type: string; ns?: string }> }>('getnameresource', [tld]);
const rpcTargets = (resource.records ?? []).filter((r) => r.type === 'NS').map((r) => r.ns);
const dig = execFileSync('dig', ['@127.0.0.1', '-p', String(REGTEST.nsPort), `${tld}.`, 'NS', '+norecurse', '+noall', '+authority'], { encoding: 'utf8' });
const dnsTargets = dig.split('\n').filter((l) => /\sNS\s/.test(l)).map((l) => l.trim().split(/\s+/).pop());
const ok = rpcTargets.includes(target) && dnsTargets.includes(target);
console.log(JSON.stringify({ tld, published: target, rpcTargets, dnsTargets, ok }, null, 2));
process.exit(ok ? 0 : 1);
