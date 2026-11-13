// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "./SharedNameRegistryTestBase.sol";
import {ISharedNameRegistryV3 as IShared} from "../../src/interfaces/ISharedNameRegistryV3.sol";
import {SharedNameRegistryV3} from "../../src/SharedNameRegistryV3.sol";

contract SharedNameRegistryTest is SharedNameRegistryTestBase {
    function testUnsupportedChainCannotDeploy() public {
        vm.chainId(1);
        vm.expectRevert(IShared.UnsupportedChain.selector);
        new SharedNameRegistryV3(admin, address(token), treasury);
    }
    function testFreeFirstYearAndSeparateLockedRenewal() public {
        uint256 balance = token.balanceOf(holder);
        uint256 id = _issue("member001");
        assertEq(registry.ownerOf(id), holder);
        assertEq(registry.expiresAt(id), block.timestamp + 365 days);
        assertEq(registry.lockedRenewalPrice(id), RENEWAL_PRICE);
        assertEq(token.balanceOf(holder), balance);
        assertEq(registry.policy(ns).totalClaims, 1);
        assertEq(registry.scope(ns, COMMUNITY).totalClaims, 1);
    }

    function testSameLabelDifferentNamespacesDoesNotCollide() public {
        bytes32 other = _namespace("othertld", false);
        uint256 first = _issue("member001");
        uint256 second = _submit(_claim(other, "member001"));
        assertNotEq(first, second);
        assertEq(registry.namespaceOf(first), ns);
        assertEq(registry.namespaceOf(second), other);
    }

    function testSameNamespaceDifferentCommunitiesStillCollides() public {
        _issue("member001");
        bytes32 other = keccak256("other-community");
        vm.prank(admin);
        registry.configureScope(ns, other, submitter, 10, true);
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.communityId = other;
        c.scopeRevision = registry.scope(ns, other).revision;
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.Unavailable.selector);
        registry.claimFreeName(c, g, s);
    }

    function testSevenEightNineCharacterBoundary() public {
        IShared.FreeClaim memory c = _claim(ns, "abcdefg");
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.InvalidClaim.selector);
        registry.claimFreeName(c, g, s);
        _issue("abcdefgh");
        _issue("abcdefghi");
    }

    function testReservationAndNonzeroPremiumRefuseFreeClaim() public {
        vm.prank(admin);
        registry.setNamePolicy(ns, "member001", 1, address(0));
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.NotFree.selector);
        registry.claimFreeName(c, g, s);
        vm.prank(admin);
        registry.setNamePolicy(ns, "member001", 0, stranger);
        c = _claim(ns, "member001");
        (g, s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IShared.Reserved.selector, stranger));
        registry.claimFreeName(c, g, s);
        vm.prank(admin);
        registry.setNamePolicy(ns, "member001", 0, holder);
        _issue("member001");
    }

    function testUnconfiguredNamespaceCannotIssue() public {
        vm.prank(admin);
        bytes32 unopened = registry.registerNamespace("unopened", false);
        assertFalse(registry.quote(unopened, COMMUNITY, "member001").issuanceEnabled);
    }
}
