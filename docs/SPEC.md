# PIRATE Registry V1: normative specification

Status: implementation baseline, revision 2, 2026-11-03. The workspace_owner
gave the go-ahead to start implementation on 2026-11-03, which adopts D1 to
D3; D4 follows from spec 014. Implementation is in progress under the
control plane's `experiments/pirate-registry`; it is not yet a registered
repository.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Purpose and promise

The registry lets anyone who controls a Handshake TLD sell second-level names
(SLDs) as ERC-721 tokens on an EVM chain, with revenue held by that operator's
own registry contract, and lets anyone verify a name without PIRATE servers.

The product promise is independence from PIRATE custody and servers. It is not
independence from every party. A buyer still depends on the Handshake TLD
owner, who can repoint delegation or let the TLD lapse; on the chain, its
sequencer, its upgrade controls and its finality configuration; and on Circle,
which can pause USDC or blacklist the payer or the registry. Section 9 makes
these disclosures mandatory.

Milestone 1, the subject of this document, is independent ownership and record
lookup. Serving DNS answers to ordinary resolvers is a later deliverable.

## 2. Terms

A registry is one deployed clone of the published implementation, bound to one
TLD. The operator is the registry's admin. The holder is the current ERC-721
owner of a name token. A generation is one registration lifetime of a label;
every new registration of a released label starts a new generation with a new
token ID. Year means 365 days of block timestamps.

## 3. Decisions

| ID | Decision | Status |
|---|---|---|
| D1 | Chain is Base (8453), with Base Sepolia (84532) for testing. The chain ID is explicit in the delegation record. | Adopted 2026-11-03 |
| D2 | A registration's annual price is fixed for the life of its generation, through transfers and grace. | Adopted 2026-11-03 |
| D3 | The registry receives payments. A separate, permissionless `sweep()` forwards the balance to the treasury. | Adopted 2026-11-03 |
| D4 | `.pirate` is excluded until a separately ratified migration preserves existing persona ownership (spec 014, 2026-08-24 amendment). 8s28 and a18n are excluded because PIRATE renewal freezes their zones. | Required by spec 014 |

Shared OP Stack ancestry does not make Base's sequencing, upgrade controls or
finality configuration the same as Optimism's. They are Base-specific
dependencies.

## 4. Authority model

A registry is authoritative for TLD `T` exactly when all of these hold at the
time of resolution:

1. `T`'s current Handshake resource contains exactly one valid `_evm` record
   (section 5) naming chain `C` and address `R`;
2. `R` on chain `C` passes manifest verification (section 7); and
3. `R.tld()` equals `T`.

Deploying a registry confers no authority. The factory keeps no list of
official registries per TLD, any number of registries may exist for one TLD,
and the first deployer reserves nothing.

Registry contracts cannot observe Handshake. Payment and mint are atomic on the
chain, but the TLD owner can change delegation independently at any time. A
purchase client MUST verify delegation before submitting a purchase and SHOULD
verify it again after confirmation.

Selling the TLD on Handshake does not move the registry's admin. The new TLD
owner either receives admin through the two-step transfer, or points the TLD at
another registry. Repointing orphans every token of the old registry: they stay
valid NFTs of a contract that no longer has authority. Documentation MUST say
so. If the TLD lapses on Handshake, every name under it stops resolving.

## 5. Delegation record

This is a new HIP-5 extension with protocol label `_evm`. It is distinct from
HIP-5's `_eth` (ENS-compatible contracts on Ethereum) and from HNS.ID's
documented `_op`/`_optimism` convention. Whether other implementations of those
conventions exist was not established; this extension makes no compatibility
claim with them.

The record is a Handshake NS record whose target has exactly three labels:

```
<address>.<chainId>._evm.
```

Example: `0x5fbdb2315678afecb367f032d93f642f64180aa3.8453._evm.`

- `<address>` is `0x` followed by 40 hexadecimal digits. Parsers MUST accept
  any letter case, MUST NOT require an EIP-55 checksum, and MUST compare the
  value as 20 bytes.
- `<chainId>` is a positive decimal integer with no leading zeros and at most
  20 digits.
- A TLD resource with no `_evm` record is not delegated. A resource with more
  than one `_evm` record is ambiguous, and resolvers MUST fail instead of
  choosing. Other records in the resource are ignored for authority.
- A malformed `_evm` record MUST fail resolution. It is never skipped in
  favour of another record.

Publishing a lone `_evm` NS record means DNS resolvers without `_evm` support
cannot resolve names under the TLD. The repository MUST publish this format as
a HIP-5 extension document. The local harness MUST prove that hsd accepts the
record and that each supported Handshake source returns it.

## 6. Contracts

### 6.1 Factory

The factory MUST have no owner, fee, pause or upgrade path. Its constructor
deploys the implementation and stores it, together with the chain's payment
token, as immutables. The implementation's constructor disables initializers.

`deployRegistry(tld, admin, treasury, annualPrice)` validates `tld` with the
label rules (section 6.3), deploys an EIP-1167 clone of the implementation,
initializes it in the same call, records `isRegistry[clone] = true`, and emits
`RegistryDeployed(registry, tld, admin, deployer)`. Creation and initialization
MUST be atomic. Initialization MUST be single-use and MUST record
`msg.sender` as the registry's `factory`.

The implementation MUST NOT be a proxy and MUST NOT contain any upgrade
mechanism (UUPS, transparent, beacon or `delegatecall` to a mutable target).
Initializer-based base contracts are acceptable only because clones need them;
none may expose an upgrade function.

### 6.2 Configuration and operator powers

Each registry stores `tld`, `paymentToken`, `factory`, `admin`,
`pendingAdmin`, `treasury` and `annualPrice`, and exposes
`PROTOCOL_VERSION`. The operator has exactly these powers:

- `setPrice(annualPrice)` changes the price for future registrations only. Zero
  is allowed.
- `setTreasury(treasury)` changes the sweep destination. It MUST reject the
  zero address and the registry's own address, and MUST NOT move funds.
- `transferAdmin(newAdmin)` followed by `acceptAdmin()` from `newAdmin` hands
  off admin in two steps. V1 has no `renounceAdmin`.

There MUST be no pause, no public or administrator burn, no record override,
no token transfer power, no rescue function and no arbitrary call. The contract
MUST NOT accept ETH.

### 6.3 Labels

A label, and a TLD passed to the factory, MUST be 1 to 63 bytes from `a-z`,
`0-9` and `-`. It MUST NOT start or end with `-`, and MUST NOT have `-` at
both the third and fourth positions, which also excludes `xn--`. The contract
enforces this; clients MUST NOT normalize input silently. Internationalized
names are out of scope.

### 6.4 Token identity and generations

`labelhash = keccak256(bytes(label))`. The registry keeps each label's current
generation, starting at 1. A token ID is
`uint256(keccak256(abi.encode(bytes32 labelhash, uint64 generation)))`, so each generation
has its own token ID, and a retired token ID is never minted again.

Stale marketplace listings and bids name a token ID, so they can never fill
against a later registration of the same label. Every token-scoped call
(`renew`, `setRecord`, `setRecordManager`) is bound to its generation by the
token ID, and needs no separate generation parameter. Any future signed
registration-specific authorization MUST also bind the token ID.

### 6.5 Lifecycle

Let `e` be a token's expiry and `now` be `block.timestamp`. `GRACE` is 30
days.

| Status | Condition | Resolves | Renew | Transfer | Records writable | Label registrable |
|---|---|---|---|---|---|---|
| Active | `now < e` | yes | yes, locked price | yes | yes | no |
| Grace | `e <= now < e + GRACE` | no | yes, locked price | no | no | no |
| Released | `now >= e + GRACE` | no | no | no | no | yes |
| Superseded | a later generation exists | no | no | no (burned) | no | not applicable |

A purchase or renewal buys 1 to 5 years. A renewal extends from `e`, never from
`now`, in both Active and Grace. After any renewal, `e - now` MUST NOT exceed
3,650 days. Anyone may pay any renewal.

Registering a Released label internally retires the old token by burning it,
increments the generation, and mints the new token. This internal retirement is
the only burn. "No burn" in this specification means no discretionary public
or administrator burn.

### 6.6 Purchase and renewal

`register(label, years_, recipient, maxCost, deadline)` MUST revert unless
`block.timestamp <= deadline`, the label is valid, `years_` is 1 to 5,
`recipient` is not zero, and the label is unregistered or its current token is
Released. The cost is `annualPrice * years_`, and MUST NOT exceed `maxCost`.
The new token's locked price is the current `annualPrice`. The order is: write
all state, pull payment from `msg.sender` into the registry, then `_safeMint`
to `recipient`. The function is `nonReentrant` and returns the token ID.

`renew(tokenId, years_, maxCost, deadline)` MUST revert unless the deadline
holds, `years_` is 1 to 5, the token is Active or Grace, the term cap holds,
and `lockedPrice * years_ <= maxCost`. It writes the new expiry, then pulls
payment from `msg.sender`. It is `nonReentrant`.

A zero cost skips the payment pull. `maxCost` and `deadline` protect payment
terms only; they do not stop another buyer from winning a race for the same
label (section 13). If the recipient rejects `_safeMint`, the whole
transaction reverts and the payment is not taken, but the sender still pays
gas.

### 6.7 Payments and sweep

The payment token is native USDC with 6 decimals, pinned per chain in the
manifest. Base mainnet is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Base
Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. These were checked
against Circle's published address list on 2026-11-03.

Payments use SafeERC20 `safeTransferFrom(payer, registry, cost)`.
`register` and `renew` MUST NOT call `sweep()` or depend on its success, so a
blacklisted treasury blocks withdrawal of revenue but never purchases or
renewals.

`sweep()` is callable by anyone, transfers the registry's entire payment-token
balance to the current `treasury`, and emits `Swept(treasury, amount)`. All
unswept revenue therefore follows the treasury: changing the treasury redirects
everything not yet swept. Tokens other than the payment token sent to a
registry are unrecoverable.

USDC's `transferFrom` checks the caller, the sender and the recipient against
the blacklist. A blacklisted registry, or a global USDC pause, blocks every
operation that moves USDC: paid registrations, paid renewals and sweeps. It
does not block zero-cost registrations or renewals, NFT transfers or record
edits. Paying another holder's renewal works only when both the payer and the
registry can transact.

### 6.8 Transfers and approvals

OpenZeppelin v5 transfers pass through the internal `_update` and `_ownerOf`,
not the public `ownerOf`. The registry MUST therefore enforce status in its
`_update` override. A transfer (non-zero `from` and `to`) MUST revert unless
the token is Active. Minting and the internal retirement burn are the only
other `_update` paths. Every public transfer variant (`transferFrom` and both
`safeTransferFrom` overloads) MUST be tested in Grace, Released and
Superseded.

The public `ownerOf` MUST revert unless the token is Active, as ENS does, so
integrations cannot mistake an expired token for current authority. Two views
complement it: `effectiveOwner(tokenId)` returns the holder when Active and the
zero address otherwise, and `registrant(tokenId)` returns the holder when Active
or in Grace. `balanceOf` still counts Grace and Released tokens a wallet holds.

Per-token approvals and the record manager (section 6.9) clear on every
transfer and on retirement. `setApprovalForAll`
belongs to the wallet across the whole collection, so it also covers tokens
that wallet acquires later. That is an explicit wallet authorization and is not
reset by any lifecycle event.

`tokenURI` MUST NOT depend on any off-chain PIRATE service. V1 returns an
empty string.

### 6.9 Records

Records are stored per token ID, so a new generation starts with none.
`setRecord(tokenId, key, value)` MUST revert unless the token is Active and the
caller is the holder or the holder's record manager. `value` MUST be at most
1,024 bytes, and an empty value deletes the record. `record(tokenId, key)`
returns the stored bytes whatever the status; resolvers apply status rules.
NFT approvals, per-token or collection-wide, grant no record rights.

`setRecordManager(tokenId, manager)` is callable by the holder while the token
is Active, and stores one manager per token. The `_update` override MUST delete
it on every transfer and on retirement. Keying the manager by
`(tokenId, holder)` is not sufficient: if holder A appoints M, transfers to B,
and B transfers back, M would be authorized again.

Keys are derived with `keccak256(abi.encode(...))`:

| Record | Key | Value |
|---|---|---|
| DNS RRset | `(string "dns", string relativeName, uint16 rrtype)`, where `relativeName` is lowercase, relative to the SLD, without a trailing dot, and `""` for the apex | `uint32 ttl` followed by one or more `uint16 rdlength` plus RDATA in RFC 1035 wire format |
| Address | `(string "addr", uint256 coinType)`, with ENSIP-9 and ENSIP-11 coin types | ENSIP-9 binary encoding |
| Text | `(string "text", string key)` | UTF-8 |
| Content hash | `(string "contenthash")` | ENSIP-7 encoding |

The DNS value is a custom RRset envelope defined here. It is not the
EIP-1185 record format, and makes no EIP-1185 compatibility claim. All
integers are big-endian.

Encoding vectors, computed with viem 2.55.18 on 2026-11-03. Contract and SDK
tests MUST reproduce them.

| Input | Output |
|---|---|
| `labelhash("studio")` | `0xdd292fbefea3905e7bcdbbf6b1b71e43455ffc2baf812c3f209b907c2002b33f` |
| token ID, `studio`, generation 1 | `0x4275474407e1edb473bf05f2c2b128427959989ca62308b76b8fea2e16e1dc79` |
| token ID, `studio`, generation 2 | `0x696caabed877cd84b076736f07be1903028a162cca18ce89a79bd3b2894417fe` |
| key, DNS apex A | `0x868407eceda9379178752546a3cbf720eec2a28dd24895d6472c1c3e5a789f2d` |
| key, DNS `www` A | `0x3d0a36e80e3d0fd5cacdea6ed18096458be8598eabead84e9be8e161a4040cea` |
| key, DNS apex AAAA | `0x2aaebcdd820b403c0bdeab8581b7bb7748995d4af0e62bb44a652699bb42f0d8` |
| key, DNS apex TXT | `0x8e349ea58a59204bb26cde0b4dbfcfff1733d3f5bf6b2c8a60fd843c8573e0ef` |
| key, address, coin type 60 | `0x16883e5e203b40982d5268a3d2640cd0f5e76abee54a43d0960297260cfd7d06` |
| key, text `url` | `0x42eb28c344b8fb7b73f411db72dd268d347114a8ab737b15344b7378069e5cf6` |
| key, content hash | `0xf2b1a06537f8716332f700b7ec22ba2b412a859bc77c6a2d36acf68a3cab1e0f` |
| value, A `192.0.2.1`, TTL 300 | `0x0000012c0004c0000201` |
| value, A `192.0.2.1` and `192.0.2.2`, TTL 300 | `0x0000012c0004c00002010004c0000202` |
| value, AAAA `2001:db8::1`, TTL 300 | `0x0000012c001020010db8000000000000000000000001` |
| value, TXT `hello`, TTL 300 | `0x0000012c00060568656c6c6f` |

The contract does not parse values. Resolvers MUST reject malformed values.
For milestone 1 they interpret A, AAAA, TXT and CNAME RRsets, coin type 60 and
EVM ENSIP-11 coin types, text records and content hashes. A CNAME MUST NOT
coexist with any other type at the same name. NS and DS records may be stored
but are not followed in milestone 1.

### 6.10 Events

`Registered(labelhash, label, tokenId, generation, recipient, expiry,
lockedPrice)`, `Renewed(tokenId, expiry, payer, cost)`,
`RecordSet(tokenId, key, value)`, `RecordManagerSet(tokenId, manager)`,
`PriceChanged(annualPrice)`, `TreasuryChanged(treasury)`,
`Swept(treasury, amount)`, `AdminTransferStarted(pending)` and
`AdminTransferred(previous, next)`. `RecordSet` carries the full value, so
clients can list records from logs without an indexer.

### 6.11 Interface sketch

```solidity
enum Status { Unknown, Active, Grace, Released, Superseded }

interface ISLDRegistry {
    function register(string calldata label, uint8 years_, address recipient,
        uint256 maxCost, uint256 deadline) external returns (uint256 tokenId);
    function renew(uint256 tokenId, uint8 years_, uint256 maxCost,
        uint256 deadline) external;
    function setRecord(uint256 tokenId, bytes32 key, bytes calldata value) external;
    function setRecordManager(uint256 tokenId, address manager) external;
    function sweep() external;

    function setPrice(uint256 annualPrice) external;
    function setTreasury(address treasury) external;
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;

    function tld() external view returns (string memory);
    function paymentToken() external view returns (address);
    function factory() external view returns (address);
    function available(string calldata label) external view returns (bool);
    function currentToken(string calldata label)
        external view returns (uint256 tokenId, uint64 generation, Status status);
    function status(uint256 tokenId) external view returns (Status);
    function expiresAt(uint256 tokenId) external view returns (uint64);
    function lockedPrice(uint256 tokenId) external view returns (uint256);
    function labelOf(uint256 tokenId) external view returns (string memory);
    function effectiveOwner(uint256 tokenId) external view returns (address);
    function registrant(uint256 tokenId) external view returns (address);
    function record(uint256 tokenId, bytes32 key) external view returns (bytes memory);
}
```

## 7. Release manifest and reproducible build

Each release ships a JSON manifest inside the resolver and SDK packages. Per
chain it lists the chain ID, the factory address and runtime code hash, the
implementation address and runtime code hash, the exact expected EIP-1167 clone
runtime, the payment token address and decimals, the protocol version, the
compiler version and settings, and the source commit.

The build MUST be reproducible from the tagged source with the pinned compiler
and metadata settings, so anyone can rebuild and compare runtime code hashes
with the chain. Resolvers MUST NOT fetch the manifest from any network service.
A manifest change is a new resolver release.

Verifying a delegated registry means checking, at the selected block: the
registry's runtime equals the expected clone runtime; the implementation's
runtime code hash and the factory's runtime code hash match the manifest;
`factory.isRegistry(registry)` is true; and `registry.factory()`,
`registry.paymentToken()`, `registry.tld()` and `PROTOCOL_VERSION` match the
manifest and the queried TLD.

## 8. Resolver

The resolver is a TypeScript library and CLI. Its inputs are a name, a
Handshake source, an RPC URL for each chain the user allows, a block tag, and a
maximum state age.

Handshake sources:

1. A local hsd full node over RPC. This mode also reports the TLD's Handshake
   renewal deadline.
2. A local hnsd, queried at its root resolver. It verifies name proofs under
   its SPV model, with that model's consensus, peer-connectivity and checkpoint
   assumptions. The TLD renewal deadline is reported as unknown.
3. A remote Handshake service. It is allowed only with an explicit trust flag,
   and the answer is labelled as trusted.

EVM state from a remote RPC is trusted state, even at `safe`, and the output
says so. The resolver resolves the tag (`safe` by default, or `finalized`)
to one block once. It checks `eth_chainId`, and performs every code and state
read against that block's hash with `requireCanonical: true` (EIP-1898, whose
default is `false`). A provider that rejects the parameter fails resolution
with `rpc_unsupported`. The resolver fails with `stale_state` when the block is
older than the maximum age. Initial defaults are 15 minutes for `safe` and 90
minutes for `finalized`, to be tuned in the harness. It MUST NOT fall back to
`latest` silently or otherwise.

An answer has two parts. The observation is what the chain recorded as of the
selected block. Usability is judged against the resolver host's system clock
when the answer is returned: an answer is usable only if the token was Active
at the block and its expiry is later than the host's current time. A token
that expired between the block and the answer gives `not_active`. If the
block's timestamp is more than 60 seconds ahead of the host clock, the
resolver fails with `clock_skew`. No TTL the resolver reports, or that a
later DNS adapter serves, may extend past the token's expiry.

The steps are: validate the label; read the TLD resource; parse exactly one
`_evm` record; look up the chain in the manifest; select and check the block;
verify the registry (section 7); read `currentToken(label)`; require Active at
the block and expiry after the host clock; read the requested records;
validate and decode them.

The output is JSON with the answer and its provenance: the Handshake source
and height, the chain ID, the block number, hash and timestamp, the host time
of the answer, the registry, the manifest release, the trust labels, and the
token ID, generation, holder and expiry. Failures are distinct error codes:
`label_invalid`, `handshake_unavailable`, `delegation_missing`,
`delegation_ambiguous`, `delegation_malformed`, `chain_not_allowed`,
`chain_mismatch`, `rpc_unsupported`, `stale_state`, `clock_skew`,
`code_mismatch`, `config_mismatch`, `tld_mismatch`, `not_registered`,
`not_active`, `record_malformed` and `rpc_error`.

## 9. Disclosures

Before any purchase, every client, including the CLI, MUST show:

1. The TLD owner can repoint delegation or let the TLD lapse, which ends
   resolution while the NFT survives. Show the Handshake renewal deadline when
   known.
2. The chain dependency: Base's sequencer ordering, its upgrade controls and
   its finality.
3. Circle can pause USDC or blacklist the payer or the registry. Either blocks
   paid registrations, paid renewals and sweeps.
4. There is no commit-reveal. Another buyer can win a race for the same label.
   `maxCost` and `deadline` protect only the payment terms.
5. The operator's revenue sits in the registry until someone sweeps it.
6. Records are public.

## 10. Security requirements and tests

Foundry unit, fuzz and invariant tests MUST cover:

- every lifecycle boundary to the second, at `e - 1`, `e`, `e + GRACE - 1`
  and `e + GRACE`;
- every public transfer variant reverting in Grace, Released and Superseded;
- a renewal in Grace extending from `e`, and the 3,650-day cap;
- `renew` and `setRecord` against a Superseded token ID reverting;
- records and record managers absent in a new generation;
- a record manager M appointed by A staying unauthorized after A transfers to
  B and B transfers back to A;
- the locked price following transfers and Grace, and resetting on
  re-registration;
- `maxCost` and `deadline` on both paths;
- with a mock USDC: a blacklisted treasury (purchases and renewals succeed,
  `sweep` fails, a treasury change then lets `sweep` move the whole balance);
  a blacklisted payer; a blacklisted registry and a global pause (paid
  operations and sweeps fail; zero-cost operations, transfers and record edits
  succeed); and an unsolicited direct USDC deposit, which a sweep forwards;
- `setTreasury` rejecting the zero address and the registry itself;
- a reentrant receiver in `_safeMint` attempting `register`, `renew`,
  `transferFrom`, `setRecord` and `sweep`, with state already initialized
  when the callback runs;
- a contract recipient without `onERC721Received` causing the whole purchase,
  payment included, to revert;
- every admin function called by a non-admin, and the two-step admin handoff;
- invariants: no reachable path moves, burns or changes the records of an
  Active token without the holder's applicable authorization (the holder, a
  per-token approval or a collection operator for transfers; the holder or the
  current record manager for records), and the admin role grants none of
  these; the registry's payment-token balance equals payments received plus
  unsolicited deposits minus sweeps;
- the factory: atomic initialization, a second `initialize` reverting on clones
  and on the implementation, and invalid TLDs rejected.

## 11. Milestone 1 deliverables and acceptance

The proposed home is a new repository `pirate-registry` on the code drive,
registered with the workspace control plane before implementation. Its
contents are the contracts with tests and deploy scripts, `packages/sdk`
(viem), `packages/resolver` with the manifest, a CLI for operator and buyer
actions plus `resolve` and `verify-registry`, a local acceptance script, and
`docs/` with this specification, the `_evm` extension and the disclosures.
There is no web UI, indexer or DNS server in milestone 1.

### 11.1 Local acceptance

Local acceptance needs no purchased TLD and no funded wallet. One script runs
anvil with a mock USDC that supports blacklisting and pausing, hsd in regtest,
and hnsd built for regtest (`./configure --with-network=regtest`, as its
integration tests document). It generates a local manifest and then:

1. registers a TLD on regtest and publishes its `_evm` record;
2. deploys the factory and a registry;
3. buys a name from a second wallet, sets A, TXT and address records, and
   resolves it through each available Handshake source;
4. transfers it to a third wallet, then resolves the new holder with records
   retained and the old record manager invalid;
5. advances time to expiry and gets `not_active`; a transfer reverts; a fourth
   wallet pays a renewal in Grace that extends from the old expiry;
6. advances past Grace and re-registers from another wallet, getting a new
   token ID, no records, a Superseded old token, and a failing `renew` on the
   old token ID;
7. exercises the treasury and registry blacklist cases and the sweep;
8. repoints the TLD to a second registry, and the resolver follows it;
9. runs forged delegations (non-clone contract, unknown implementation, wrong
   TLD, wrong chain, two `_evm` records, a malformed record) and gets each
   specific error; and
10. runs the resolver with network access limited to the local hsd or hnsd and
    anvil endpoints.

### 11.2 Real-network ceremony

The ceremony runs after local acceptance passes, and needs owner actions: a
fresh Handshake TLD never used by PIRATE (not `.pirate`, 8s28 or a18n), a Bob
wallet, an operator wallet with a little Base ETH, and a buyer wallet with USDC
and ETH. Its network, Base Sepolia or Base mainnet, is owner-open.

The steps are: deploy the factory and a registry; publish the `_evm` record
from Bob and wait for it to reach the Handshake root, which commits name
updates every 36 blocks, about six hours; buy, set records and transfer from
separate wallets; and resolve with the operator's own hsd or hnsd and a
non-default RPC. Expiry is proven locally only.

## 12. Later milestones and exclusions

In order after milestone 1: a DNS-serving adapter, such as an hsd plugin on the
model of `handover`; resolver support in the Freedom browser; the four-screen
storefront as a static site; and a `.pirate` migration under a separately
ratified contract that preserves spec 014 ownership.

Excluded from V1: commit-reveal, price tiers, reserved-label lists,
internationalized names, on-chain metadata, an indexer, wallet creation, MPC,
passkeys, ZK personas, Spaces and governance.

## 13. Accepted risks

Registration ordering: without commit-reveal, the sequencer, a leaky RPC
provider or a faster buyer can win a label first. Parent control: the TLD owner
can repoint or lapse. Payment-token control: Circle can pause or blacklist.
Chain control: Base's operators and upgrade keys. Remote RPC trust whenever a
user does not run their own node. DNS reach: resolvers without `_evm` support
cannot resolve these names until the adapter ships.

## 14. Open items

The ceremony network is Base Sepolia. On 2026-11-03 two samples of Base
Sepolia's safe head showed lags of about 41 minutes (by block count) and 4
minutes (by timestamp), so the 15-minute `safe` freshness default may fail
intermittently and must be measured in the harness. The
harness must still prove that hsd accepts an `_evm` NS target and that hnsd,
built for regtest, returns it. Whether the chosen RPC providers honour
`requireCanonical` must be checked before the ceremony.
