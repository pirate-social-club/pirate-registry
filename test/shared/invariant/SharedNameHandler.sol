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
    uint256[] public tokens;

    constructor(SharedNameRegistryV3 registry_, bytes32 ns, bytes32 community, address submitter_, address admin_,
        uint256 grantKey_, uint256 holderKey_) {
        registry = registry_; namespaceId = ns; communityId = community; submitter = submitter_;
        admin = admin_; grantKey = grantKey_; holderKey = holderKey_;
    }

    function issue(uint8 suffix) external {
        attempts++;
        string memory label = string.concat("member00", vm.toString(uint256(suffix)));
        IShared.NameQuote memory q = registry.quote(namespaceId, communityId, label);
        IShared.FreeClaim memory c = IShared.FreeClaim({requestId: bytes32(attempts), communityId: communityId,
            namespaceId: namespaceId, label: label, recipient: vm.addr(holderKey), generation: q.generation,
            authorityRevision: q.authorityRevision, policyRevision: q.policyRevision, scopeRevision: q.scopeRevision,
            issuedAt: uint64(block.timestamp), deadline: uint64(block.timestamp + 600), years_: 1, maxCost: 0});
        bytes32 digest = registry.requestHash(c);
        bytes memory grant = _sign(grantKey, digest);
        bytes memory consent = _sign(holderKey, registry.recipientAcceptanceHash(digest));
        vm.prank(submitter);
        try registry.claimFreeName(c, grant, consent) returns (uint256 id) {
            successfulClaims++; tokens.push(id);
        } catch {}
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
        try registry.setRecord(id, bytes32(uint256(1)), hex"01") { unauthorizedMutation = true; } catch {}
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
