// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SLDRegistry} from "../src/SLDRegistry.sol";
import {RecordKeys} from "../src/RecordKeys.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// SPEC 6.7 and D3: payments enter the registry; a separate permissionless
/// sweep forwards them to the current treasury.
contract PaymentsTest is RegistryTestBase {
    function test_SweepForwardsWholeBalanceToCurrentTreasury() public {
        _register(holderA, LABEL, 2, holderA);
        vm.prank(stranger); // anyone may sweep
        registry.sweep();
        assertEq(usdc.balanceOf(treasury), 2 * PRICE);
        assertEq(usdc.balanceOf(address(registry)), 0);
    }

    function test_TreasuryChangeRedirectsUnsweptRevenueWithoutMovingFunds() public {
        _register(holderA, LABEL);
        address newTreasury = makeAddr("new-treasury");
        vm.prank(operator);
        registry.setTreasury(newTreasury);
        assertEq(usdc.balanceOf(address(registry)), PRICE); // nothing moved yet
        registry.sweep();
        assertEq(usdc.balanceOf(newTreasury), PRICE);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_SetTreasuryRejectsZeroAndSelf() public {
        vm.startPrank(operator);
        vm.expectRevert(SLDRegistry.InvalidTreasury.selector);
        registry.setTreasury(address(0));
        vm.expectRevert(SLDRegistry.InvalidTreasury.selector);
        registry.setTreasury(address(registry));
        vm.stopPrank();
    }

    /// The confiscation path the sweep design closes: a blacklisted treasury
    /// must not block purchases or renewals.
    function test_BlacklistedTreasuryBlocksOnlySweep() public {
        usdc.setBlacklisted(treasury, true);
        uint256 tokenId = _register(holderA, LABEL);
        _renew(holderA, tokenId, 1);
        assertEq(usdc.balanceOf(address(registry)), 2 * PRICE);

        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        registry.sweep();

        address newTreasury = makeAddr("new-treasury");
        vm.prank(operator);
        registry.setTreasury(newTreasury);
        registry.sweep();
        assertEq(usdc.balanceOf(newTreasury), 2 * PRICE);
    }

    function test_BlacklistedRegistryBlocksOnlyUsdcMovement() public {
        uint256 tokenId = _register(holderA, LABEL);
        usdc.setBlacklisted(address(registry), true);

        vm.prank(holderB);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        registry.register("paid", 1, holderB, type(uint256).max, block.timestamp);

        vm.prank(holderA);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        registry.renew(tokenId, 1, type(uint256).max, block.timestamp);

        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        registry.sweep();

        _assertNonUsdcOperationsStillWork(tokenId);
    }

    function test_GlobalPauseBlocksOnlyUsdcMovement() public {
        uint256 tokenId = _register(holderA, LABEL);
        usdc.setPaused(true);

        vm.prank(holderB);
        vm.expectRevert(bytes("Pausable: paused"));
        registry.register("paid", 1, holderB, type(uint256).max, block.timestamp);

        vm.expectRevert(bytes("Pausable: paused"));
        registry.sweep();

        _assertNonUsdcOperationsStillWork(tokenId);
    }

    function _assertNonUsdcOperationsStillWork(uint256 tokenId) internal {
        vm.startPrank(holderA);
        registry.setRecord(tokenId, RecordKeys.text("url"), hex"01");
        registry.transferFrom(holderA, holderB, tokenId);
        vm.stopPrank();
        assertEq(registry.ownerOf(tokenId), holderB);

        vm.prank(operator);
        registry.setPrice(0);
        uint256 freeId = _register(stranger, "free");
        _renew(stranger, freeId, 1);
        assertEq(registry.ownerOf(freeId), stranger);
    }

    function test_BlacklistedHolderCanBeRenewedByAnotherPayer() public {
        uint256 tokenId = _register(holderA, LABEL);
        usdc.setBlacklisted(holderA, true);

        vm.prank(holderA);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        registry.renew(tokenId, 1, type(uint256).max, block.timestamp);

        _renew(payer, tokenId, 1);
        assertEq(registry.expiresAt(tokenId), block.timestamp + 2 * 365 days);
    }

    function test_BlacklistedPayerCannotRegister() public {
        usdc.setBlacklisted(payer, true);
        vm.prank(payer);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        registry.register(LABEL, 1, holderA, type(uint256).max, block.timestamp);
    }

    function test_UnsolicitedDepositIsSwept() public {
        usdc.mint(address(registry), 7e6);
        registry.sweep();
        assertEq(usdc.balanceOf(treasury), 7e6);
    }

    /// Accounting: registry balance = payments + unsolicited deposits - sweeps.
    function testFuzz_Accounting(uint8 years1, uint8 years2, uint96 deposit, bool sweepMidway) public {
        years1 = uint8(bound(years1, 1, 5));
        years2 = uint8(bound(years2, 1, 5));
        deposit = uint96(bound(deposit, 0, 1_000_000e6));

        uint256 paid;
        uint256 swept;
        uint256 tokenId = _register(holderA, LABEL, years1, holderA);
        paid += PRICE * years1;

        usdc.mint(address(registry), deposit);
        if (sweepMidway) {
            swept += usdc.balanceOf(address(registry));
            registry.sweep();
        }

        if (uint256(years1) + years2 <= 10) {
            _renew(payer, tokenId, years2);
            paid += PRICE * years2;
        }
        _register(holderB, "second", years2, holderB);
        paid += PRICE * years2;

        assertEq(usdc.balanceOf(address(registry)), paid + deposit - swept);
        assertEq(usdc.balanceOf(treasury), swept);

        registry.sweep();
        assertEq(usdc.balanceOf(address(registry)), 0);
        assertEq(usdc.balanceOf(treasury), paid + deposit);
    }
}
