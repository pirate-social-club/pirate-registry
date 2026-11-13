// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {SharedNameRegistryV3} from "../../../src/SharedNameRegistryV3.sol";
import {ISharedNameRegistryV3 as IShared} from "../../../src/interfaces/ISharedNameRegistryV3.sol";

contract SharedNameHandler is Test {
    SharedNameRegistryV3 public immutable registry;
    bytes32 public immutable namespaceId;
    bytes32 public immutable communityId;
    address private immutable submitter;
    address private immutable admin;
    uint256 private immutable grantKey;
    uint256 private immutable holderKey;
    uint256 public successfulClaims;
    uint256 public attempts;
    bool public unauthorizedMutation;
    bool public managerSurvivedTransfer;
    uint256 public paidRenewals;
    uint256 public transfers;
    uint256 public renewals;
    uint256 public reregistrations;
    mapping(uint256 => address) public expectedHolder;
    mapping(uint256 => uint64) public expectedExpiry;
    uint256[] public tokens;

    constructor(
        SharedNameRegistryV3 registry_,
        bytes32 ns,
        bytes32 community,
        address submitter_,
        address admin_,
        uint256 grantKey_,
        uint256 holderKey_
    ) {
        registry = registry_;
        namespaceId = ns;
        communityId = community;
        submitter = submitter_;
        admin = admin_;
        grantKey = grantKey_;
        holderKey = holderKey_;
    }

    function issue(uint8 suffix) external {
        _issue(string.concat("member00", vm.toString(uint256(suffix % 4))));
    }

    function _issue(string memory label) private {
        attempts++;
        IShared.Authority memory a = registry.authority(namespaceId);
        if (block.timestamp >= a.validUntil) {
            vm.prank(admin);
            registry.attestNamespace(
                namespaceId,
                keccak256("invariant-fresh-evidence"),
                uint64(block.timestamp),
                uint64(block.timestamp + 1 days),
                true
            );
        }
        IShared.NameQuote memory q = registry.quote(namespaceId, communityId, label);
        IShared.FreeClaim memory c = IShared.FreeClaim({
            requestId: bytes32(attempts),
            communityId: communityId,
            namespaceId: namespaceId,
            label: label,
            recipient: vm.addr(holderKey),
            generation: q.generation,
            authorityRevision: q.authorityRevision,
            policyRevision: q.policyRevision,
            scopeRevision: q.scopeRevision,
            issuedAt: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 600),
            years_: 1,
            maxCost: 0
        });
        bytes32 digest = registry.requestHash(c);
        bytes memory grant = _sign(grantKey, digest);
        bytes memory consent = _sign(holderKey, registry.recipientAcceptanceHash(c));
        vm.prank(submitter);
        try registry.claimFreeName(c, grant, consent) returns (uint256 id) {
            successfulClaims++;
            tokens.push(id);
            expectedHolder[id] = c.recipient;
            expectedExpiry[id] = registry.expiresAt(id);
            if (c.generation > 1) reregistrations++;
        } catch {}
    }

    function advanceTime(uint32 delta) external {
        vm.warp(block.timestamp + bound(delta, 1, 400 days));
    }

    function transfer(uint256 seed) external {
        if (tokens.length == 0) return;
        uint256 id = tokens[seed % tokens.length];
        if (registry.status(id) != IShared.Status.Active) return;
        address from = registry.ownerOf(id);
        address to = from == vm.addr(holderKey) ? vm.addr(holderKey + 1) : vm.addr(holderKey);
        vm.startPrank(from);
        registry.setRecordManager(id, submitter);
        registry.transferFrom(from, to, id);
        vm.stopPrank();
        expectedHolder[id] = to;
        transfers++;
        if (registry.recordManager(id) != address(0)) managerSurvivedTransfer = true;
    }

    function renew(uint256 seed, uint8 years_) external {
        if (tokens.length == 0) return;
        uint256 id = tokens[seed % tokens.length];
        uint8 term = uint8(bound(years_, 1, 5));
        uint256 cost = registry.lockedRenewalPrice(id) * term;
        vm.prank(vm.addr(holderKey));
        try registry.renew(id, term, cost, block.timestamp) {
            paidRenewals += cost;
            renewals++;
            expectedExpiry[id] += uint64(uint256(term) * 365 days);
        } catch {}
    }

    function reregister(uint256 seed) external {
        if (tokens.length == 0) return;
        uint256 id = tokens[seed % tokens.length];
        if (registry.status(id) == IShared.Status.Released) _issue(registry.labelOf(id));
    }

    function rotateScope() external {
        IShared.Scope memory s = registry.scope(namespaceId, communityId);
        vm.prank(admin);
        registry.configureScope(namespaceId, communityId, submitter, s.totalClaimLimit, true);
    }

    function attemptUnauthorizedRecord(uint256 seed) external {
        if (tokens.length == 0) return;
        uint256 id = tokens[seed % tokens.length];
        vm.prank(submitter);
        try registry.setRecord(id, bytes32(uint256(1)), hex"01") {
            unauthorizedMutation = true;
        } catch {}
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
