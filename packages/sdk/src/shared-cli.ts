// Read-only V3 CLI. Transaction signing/submission belongs to the admitted service.
import { parseArgs } from 'node:util';
import { loadSharedRegistrySource } from '../../resolver/src/shared-manifest.ts';
import { hsdRpcSource } from '../../resolver/src/handshake.ts';
import { resolveSharedName, verifySharedRegistry } from '../../resolver/src/shared-resolve.ts';
import { readSharedQuote } from './shared-names.ts';
import { prepareSharedClaim } from './shared-claims.ts';
import { requireShared } from '../../resolver/src/shared-errors.ts';
import { getAddress, type Hex } from 'viem';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, 'source-sha256': { type: 'string' }, rpc: { type: 'string' },
  hsd: { type: 'string' }, tld: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' },
  community: { type: 'string' }, request: { type: 'string' }, recipient: { type: 'string' },
  'collection-margin': { type: 'string' }, 'signing-margin': { type: 'string' }, 'inclusion-margin': { type: 'string' },
  'trust-remote-hsd': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });

async function main() {
  if (values.help) {
    console.log('verify | resolve --name NAME | quote --community ID --label LABEL | prepare-claim --community ID --label LABEL --request ID --recipient ADDRESS\n'
      + 'Required: --source FILE --source-sha256 SHA256 --rpc URL --hsd URL --tld TLD\n'
      + 'prepare-claim requires --collection-margin SECONDS --signing-margin SECONDS --inclusion-margin SECONDS.\n'
      + 'Budgets must be positive integers totaling at most 900; output includes inclusive submitBy in Unix seconds.\n'
      + 'Remote Handshake nodes require --trust-remote-hsd. Read-only: no signing, submission or token approvals.');
    return;
  }
  requireShared(values.source && values['source-sha256'] && values.rpc && values.hsd && values.tld,
    'arguments', '--source, --source-sha256, --rpc, --hsd and --tld are required');
  const options = { source: loadSharedRegistrySource(values.source), expectedSourceSha256: values['source-sha256'],
    rpcUrl: values.rpc, handshake: hsdRpcSource(values.hsd, { allowRemote: values['trust-remote-hsd'] }), tld: values.tld };
  let result: unknown;
  switch (positionals[0]) {
    case 'verify': {
      const v = await verifySharedRegistry(options.tld, options);
      result = { sourceSha256: v.sourceSha256, source: v.source, authority: v.authority,
        namespaceId: v.delegation.namespaceId, block: v.reader.block, evmTrust: v.evmTrust,
        handshake: v.delegation.observation };
      break;
    }
    case 'resolve':
      requireShared(values.name, 'arguments', '--name is required');
      result = await resolveSharedName({ ...options, name: values.name });
      break;
    case 'quote': {
      requireShared(values.community && values.label, 'arguments', '--community and --label are required');
      const { quote, verified } = await readSharedQuote(options, values.community as Hex, values.label);
      result = { quote, block: verified.reader.block, sourceSha256: verified.sourceSha256 };
      break;
    }
    case 'prepare-claim':
      requireShared(values.community && values.request && values.label && values.recipient, 'arguments',
        '--community, --request, --label and --recipient are required');
      requireShared(values['collection-margin'] && values['signing-margin'] && values['inclusion-margin'],
        'arguments', 'explicit collection, signing/storage and inclusion budgets required');
      result = await prepareSharedClaim(options, { communityId: values.community as Hex, requestId: values.request as Hex,
        label: values.label, recipient: getAddress(values.recipient) }, {
        collectionMarginSeconds: Number(values['collection-margin']), signingMarginSeconds: Number(values['signing-margin']),
        inclusionMarginSeconds: Number(values['inclusion-margin']) });
      break;
    default: throw new Error('command must be verify, resolve, quote or prepare-claim');
  }
  console.log(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
