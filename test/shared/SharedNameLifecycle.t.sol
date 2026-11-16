// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "./SharedNameRegistryTestBase.sol";
import {ISharedNameRegistryV3 as IShared} from "../../src/interfaces/ISharedNameRegistryV3.sol";

contract SharedNameLifecycleTest is SharedNameRegistryTestBase {
    function testRenewalRejectsInvalidYearsAndPassedDeadline() public {
        uint256 id = _issue("member001");
        vm.expectRevert(IShared.InvalidYears.selector);
        registry.renew(id, 0, 0, block.timestamp);
        vm.expectRevert(IShared.InvalidYears.selector);
        registry.renew(id, 6, 0, block.timestamp);
        vm.expectRevert(IShared.DeadlinePassed.selector);
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp - 1);
    }

    function testThirdPartyGraceRenewalAndRevenueEvents() public {
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        vm.warp(expiry);
        token.mint(stranger, RENEWAL_PRICE);
        vm.startPrank(stranger);
        token.approve(address(registry), RENEWAL_PRICE);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.Renewed(id, uint64(uint256(expiry) + 365 days), stranger, RENEWAL_PRICE);
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp);
        vm.stopPrank();
        assertEq(registry.ownerOf(id), holder);
        assertEq(registry.policy(ns).totalClaims, 1);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.Swept(treasury, RENEWAL_PRICE);
        registry.sweep();
        assertEq(token.balanceOf(treasury), RENEWAL_PRICE);
    }

    function testZeroRenewalSponsorshipDuringGraceDoesNotRefillCounters() public {
        vm.prank(admin);
        registry.configurePolicy(ns, grantSigner, 0, 100);
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        vm.warp(uint256(expiry) + 29 days);
        vm.prank(stranger);
        registry.renew(id, 1, 0, block.timestamp);
        assertEq(registry.expiresAt(id), uint256(expiry) + 365 days);
        assertEq(registry.ownerOf(id), holder);
        assertEq(registry.policy(ns).totalClaims, 1);
        vm.warp(uint256(registry.expiresAt(id)) + 30 days);
        assertEq(uint8(registry.status(id)), uint8(IShared.Status.Released));
        assertEq(registry.policy(ns).totalClaims, 1);
    }

    function testBoundariesAndFreshGenerationRecords() public {
        uint256 id = _issue("member001");
        vm.prank(holder);
        registry.setRecord(id, bytes32(uint256(1)), hex"0102");
        uint64 expiry = registry.expiresAt(id);
        vm.warp(expiry - 1);
        assertEq(uint8(registry.status(id)), uint8(IShared.Status.Active));
        vm.warp(expiry);
        assertEq(uint8(registry.status(id)), uint8(IShared.Status.Grace));
        assertEq(registry.ownerOf(id), holder);
        assertEq(registry.effectiveOwner(id), address(0));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(IShared.NotActive.selector, id));
        registry.transferFrom(holder, stranger, id);
        vm.warp(uint256(expiry) + 30 days - 1);
        assertEq(uint8(registry.status(id)), uint8(IShared.Status.Grace));
        vm.warp(uint256(expiry) + 30 days);
        assertEq(uint8(registry.status(id)), uint8(IShared.Status.Released));
        _refresh(ns);
        uint256 next = _issue("member001");
        assertNotEq(next, id);
        assertEq(registry.generationOf(next), 2);
        assertEq(registry.record(next, bytes32(uint256(1))), hex"");
        assertEq(uint8(registry.status(id)), uint8(IShared.Status.Superseded));
        vm.expectRevert(abi.encodeWithSelector(IShared.NotRenewable.selector, IShared.Status.Superseded));
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp);
    }

    function testRenewalTermsSurvivePolicyChangesAndSuspension() public {
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        vm.startPrank(admin);
        registry.configurePolicy(ns, grantSigner, 10 * RENEWAL_PRICE, 100);
        registry.setNamespaceIssuance(ns, false);
        vm.stopPrank();
        vm.warp(uint256(expiry) + 1 days);
        uint256 balance = token.balanceOf(holder);
        vm.prank(holder);
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp);
        assertEq(registry.expiresAt(id), uint256(expiry) + 365 days);
        assertEq(token.balanceOf(holder), balance - RENEWAL_PRICE);
        assertEq(registry.lockedRenewalPrice(id), RENEWAL_PRICE);
    }

    function testRenewalFailureIsAtomicAndPriceBounded() public {
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(IShared.CostAboveMax.selector, RENEWAL_PRICE, RENEWAL_PRICE - 1));
        registry.renew(id, 1, RENEWAL_PRICE - 1, block.timestamp);
        vm.prank(stranger);
        vm.expectRevert();
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp);
        assertEq(registry.expiresAt(id), expiry);
        vm.prank(holder);
        registry.renew(id, 5, RENEWAL_PRICE * 5, block.timestamp);
        vm.prank(holder);
        vm.expectRevert(IShared.TermTooLong.selector);
        registry.renew(id, 5, RENEWAL_PRICE * 5, block.timestamp);
    }

    function testFuzzActiveBoundary(uint32 offset) public {
        uint256 id = _issue("member001");
        uint256 expiry = registry.expiresAt(id);
        uint256 elapsed = bound(offset, 0, 400 days);
        vm.warp(block.timestamp + elapsed);
        IShared.Status expected = block.timestamp < expiry
            ? IShared.Status.Active
            : block.timestamp < expiry + 30 days ? IShared.Status.Grace : IShared.Status.Released;
        assertEq(uint8(registry.status(id)), uint8(expected));
    }

    function testTokenPauseDoesNotAffectFreeClaimsOrLockedZeroRenewals() public {
        vm.prank(admin);
        registry.configurePolicy(ns, grantSigner, 0, 100);
        token.setPaused(true);
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        vm.prank(stranger);
        registry.renew(id, 1, 0, block.timestamp);
        assertEq(registry.expiresAt(id), uint256(expiry) + 365 days);
        assertEq(token.balanceOf(address(registry)), 0);
    }

    function testPaidRenewalPauseRollsBackAndBlockedTreasuryDoesNotBlockRenewal() public {
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        token.setPaused(true);
        vm.prank(holder);
        vm.expectRevert();
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp);
        assertEq(registry.expiresAt(id), expiry);
        token.setPaused(false);
        token.setBlacklisted(treasury, true);
        vm.prank(holder);
        registry.renew(id, 1, RENEWAL_PRICE, block.timestamp);
        assertEq(token.balanceOf(address(registry)), RENEWAL_PRICE);
        vm.expectRevert();
        registry.sweep();
        assertEq(token.balanceOf(address(registry)), RENEWAL_PRICE);
    }
}
