// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SLDRegistry} from "../src/SLDRegistry.sol";
import {RecordKeys} from "../src/RecordKeys.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

contract LifecycleTest is RegistryTestBase {
    // ------------------------------------------------------------------
    // Registration
    // ------------------------------------------------------------------

    function test_RegisterMintsActiveTokenAtCurrentPrice() public {
        uint256 tokenId = _register(holderA, LABEL, 2, holderA);

        assertEq(tokenId, registry.tokenIdFor(keccak256(bytes(LABEL)), 1));
        assertEq(registry.ownerOf(tokenId), holderA);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Active));
        assertEq(registry.expiresAt(tokenId), block.timestamp + 2 * 365 days);
        assertEq(registry.lockedPrice(tokenId), PRICE);
        assertEq(registry.generationOf(tokenId), 1);
        assertEq(registry.labelOf(tokenId), LABEL);
        assertEq(usdc.balanceOf(address(registry)), 2 * PRICE);
        assertFalse(registry.available(LABEL));

        (uint256 current, uint64 generation, SLDRegistry.Status status_) = registry.currentToken(LABEL);
        assertEq(current, tokenId);
        assertEq(generation, 1);
        assertEq(uint8(status_), uint8(SLDRegistry.Status.Active));
    }

    function test_RegisterRejectsBadTerms() public {
        vm.startPrank(holderA);
        vm.expectRevert(SLDRegistry.DeadlinePassed.selector);
        registry.register(LABEL, 1, holderA, type(uint256).max, block.timestamp - 1);

        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.CostAboveMax.selector, PRICE, PRICE - 1));
        registry.register(LABEL, 1, holderA, PRICE - 1, block.timestamp);

        vm.expectRevert(SLDRegistry.InvalidYears.selector);
        registry.register(LABEL, 0, holderA, type(uint256).max, block.timestamp);

        vm.expectRevert(SLDRegistry.InvalidYears.selector);
        registry.register(LABEL, 6, holderA, type(uint256).max, block.timestamp);

        vm.expectRevert(SLDRegistry.ZeroAddress.selector);
        registry.register(LABEL, 1, address(0), type(uint256).max, block.timestamp);
        vm.stopPrank();
    }

    function test_RegisterRejectsTakenLabelInActiveAndGrace() public {
        uint256 tokenId = _register(holderA, LABEL);

        vm.prank(holderB);
        vm.expectRevert(SLDRegistry.Unavailable.selector);
        registry.register(LABEL, 1, holderB, type(uint256).max, block.timestamp);

        vm.warp(registry.expiresAt(tokenId));
        vm.prank(holderB);
        vm.expectRevert(SLDRegistry.Unavailable.selector);
        registry.register(LABEL, 1, holderB, type(uint256).max, block.timestamp);
    }

    function test_InvalidLabelsRejected() public {
        string[10] memory bad = [
            "",
            "-ab",
            "ab-",
            "ab--c",
            "xn--abc",
            "Studio",
            "stu_dio",
            "stu.dio",
            unicode"stüdio",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ];
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(registry.available(bad[i]), bad[i]);
            vm.prank(holderA);
            vm.expectRevert(SLDRegistry.InvalidLabel.selector);
            registry.register(bad[i], 1, holderA, type(uint256).max, block.timestamp);
        }
        string[5] memory good = ["a", "0", "a-b", "ab-c", "a1b2-c3"];
        for (uint256 i; i < good.length; ++i) {
            assertTrue(registry.available(good[i]), good[i]);
        }
        // 63 characters is the maximum.
        assertTrue(registry.available("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }

    // ------------------------------------------------------------------
    // Lifecycle boundaries (SPEC 6.5)
    // ------------------------------------------------------------------

    function test_StatusBoundariesToTheSecond() public {
        uint256 tokenId = _register(holderA, LABEL);
        uint256 expiry = registry.expiresAt(tokenId);
        uint256 grace = registry.GRACE();

        vm.warp(expiry - 1);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Active));
        assertEq(registry.effectiveOwner(tokenId), holderA);

        vm.warp(expiry);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Grace));
        assertEq(registry.effectiveOwner(tokenId), address(0));
        assertEq(registry.registrant(tokenId), holderA);
        vm.expectRevert(_notActive(tokenId));
        registry.ownerOf(tokenId);

        vm.warp(expiry + grace - 1);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Grace));
        assertFalse(registry.available(LABEL));

        vm.warp(expiry + grace);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Released));
        assertEq(registry.registrant(tokenId), address(0));
        assertTrue(registry.available(LABEL));
    }

    function testFuzz_StatusMatchesFormula(uint32 offset) public {
        uint256 tokenId = _register(holderA, LABEL);
        uint256 expiry = registry.expiresAt(tokenId);
        vm.warp(block.timestamp + offset);
        SLDRegistry.Status expected = block.timestamp < expiry
            ? SLDRegistry.Status.Active
            : block.timestamp < expiry + registry.GRACE() ? SLDRegistry.Status.Grace : SLDRegistry.Status.Released;
        assertEq(uint8(registry.status(tokenId)), uint8(expected));
    }

    // ------------------------------------------------------------------
    // Transfers (SPEC 6.8)
    // ------------------------------------------------------------------

    function test_TransfersAllowedWhileActive() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.prank(holderA);
        registry.transferFrom(holderA, holderB, tokenId);
        assertEq(registry.ownerOf(tokenId), holderB);
        vm.prank(holderB);
        registry.safeTransferFrom(holderB, holderA, tokenId);
        vm.prank(holderA);
        registry.safeTransferFrom(holderA, holderB, tokenId, "");
        assertEq(registry.ownerOf(tokenId), holderB);
    }

    function test_EveryTransferVariantRevertsInGraceAndReleased() public {
        uint256 tokenId = _register(holderA, LABEL);
        uint256 expiry = registry.expiresAt(tokenId);
        uint256[2] memory times = [expiry, expiry + registry.GRACE()];
        for (uint256 i; i < times.length; ++i) {
            vm.warp(times[i]);
            vm.startPrank(holderA);
            vm.expectRevert(_notActive(tokenId));
            registry.transferFrom(holderA, holderB, tokenId);
            vm.expectRevert(_notActive(tokenId));
            registry.safeTransferFrom(holderA, holderB, tokenId);
            vm.expectRevert(_notActive(tokenId));
            registry.safeTransferFrom(holderA, holderB, tokenId, "");
            vm.stopPrank();
        }
    }

    function test_SupersededTokenCannotBeTransferred() public {
        uint256 oldId = _register(holderA, LABEL);
        vm.warp(registry.expiresAt(oldId) + registry.GRACE());
        _register(holderB, LABEL);

        assertEq(uint8(registry.status(oldId)), uint8(SLDRegistry.Status.Superseded));
        vm.startPrank(holderA);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, oldId));
        registry.transferFrom(holderA, holderB, oldId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, oldId));
        registry.safeTransferFrom(holderA, holderB, oldId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, oldId));
        registry.safeTransferFrom(holderA, holderB, oldId, "");
        vm.stopPrank();
    }

    function test_ApprovedOperatorCanTransferButAdminCannot() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.prank(holderA);
        registry.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        registry.transferFrom(holderA, holderB, tokenId);
        assertEq(registry.ownerOf(tokenId), holderB);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, operator, tokenId));
        registry.transferFrom(holderB, operator, tokenId);
    }

    // ------------------------------------------------------------------
    // Renewal (SPEC 6.5, 6.6)
    // ------------------------------------------------------------------

    function test_RenewInGraceExtendsFromOldExpiryAndAnyoneMayPay() public {
        uint256 tokenId = _register(holderA, LABEL);
        uint256 expiry = registry.expiresAt(tokenId);
        vm.warp(expiry + 10 days);

        uint256 payerBefore = usdc.balanceOf(payer);
        _renew(payer, tokenId, 1);

        assertEq(registry.expiresAt(tokenId), expiry + 365 days);
        assertEq(uint8(registry.status(tokenId)), uint8(SLDRegistry.Status.Active));
        assertEq(registry.ownerOf(tokenId), holderA);
        assertEq(payerBefore - usdc.balanceOf(payer), PRICE);
    }

    function test_RenewTermCapIs3650Days() public {
        uint256 tokenId = _register(holderA, LABEL, 5, holderA);
        _renew(holderA, tokenId, 5); // exactly now + 3650 days
        assertEq(registry.expiresAt(tokenId), block.timestamp + 3650 days);

        vm.prank(holderA);
        vm.expectRevert(SLDRegistry.TermTooLong.selector);
        registry.renew(tokenId, 1, type(uint256).max, block.timestamp);
    }

    function test_RenewRejectsReleasedSupersededAndUnknown() public {
        uint256 oldId = _register(holderA, LABEL);
        vm.warp(registry.expiresAt(oldId) + registry.GRACE());

        vm.prank(holderA);
        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.NotRenewable.selector, SLDRegistry.Status.Released));
        registry.renew(oldId, 1, type(uint256).max, block.timestamp);

        _register(holderB, LABEL);
        vm.prank(holderA);
        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.NotRenewable.selector, SLDRegistry.Status.Superseded));
        registry.renew(oldId, 1, type(uint256).max, block.timestamp);

        vm.prank(holderA);
        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.NotRenewable.selector, SLDRegistry.Status.Unknown));
        registry.renew(12345, 1, type(uint256).max, block.timestamp);
    }

    function test_RenewRespectsMaxCostAndDeadline() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.startPrank(holderA);
        vm.expectRevert(abi.encodeWithSelector(SLDRegistry.CostAboveMax.selector, 2 * PRICE, 2 * PRICE - 1));
        registry.renew(tokenId, 2, 2 * PRICE - 1, block.timestamp);
        vm.expectRevert(SLDRegistry.DeadlinePassed.selector);
        registry.renew(tokenId, 1, type(uint256).max, block.timestamp - 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Locked price (D2)
    // ------------------------------------------------------------------

    function test_LockedPriceFollowsTransfersAndGraceThenResets() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.prank(operator);
        registry.setPrice(50e6);

        vm.prank(holderA);
        registry.transferFrom(holderA, holderB, tokenId);
        uint256 before = usdc.balanceOf(holderB);
        _renew(holderB, tokenId, 1);
        assertEq(before - usdc.balanceOf(holderB), PRICE);

        vm.warp(registry.expiresAt(tokenId) + 1 days); // Grace
        before = usdc.balanceOf(payer);
        _renew(payer, tokenId, 1);
        assertEq(before - usdc.balanceOf(payer), PRICE);

        vm.warp(registry.expiresAt(tokenId) + registry.GRACE()); // Released
        before = usdc.balanceOf(holderA);
        uint256 newId = _register(holderA, LABEL);
        assertEq(before - usdc.balanceOf(holderA), 50e6);
        assertEq(registry.lockedPrice(newId), 50e6);
    }

    // ------------------------------------------------------------------
    // Re-registration and generation isolation (SPEC 6.4)
    // ------------------------------------------------------------------

    function test_ReRegistrationStartsCleanGeneration() public {
        uint256 oldId = _register(holderA, LABEL);
        bytes32 key = RecordKeys.dns("", 1);
        vm.startPrank(holderA);
        registry.setRecord(oldId, key, hex"0000012c0004c0000201");
        registry.setRecordManager(oldId, manager);
        registry.approve(stranger, oldId);
        vm.stopPrank();

        vm.warp(registry.expiresAt(oldId) + registry.GRACE());
        uint256 newId = _register(holderA, LABEL); // same wallet re-registers

        assertTrue(newId != oldId);
        assertEq(newId, registry.tokenIdFor(keccak256(bytes(LABEL)), 2));
        assertEq(registry.generationOf(newId), 2);
        assertEq(uint8(registry.status(oldId)), uint8(SLDRegistry.Status.Superseded));
        assertEq(registry.balanceOf(holderA), 1);
        assertEq(registry.record(newId, key).length, 0);
        assertEq(registry.recordManager(newId), address(0));
        assertEq(registry.recordManager(oldId), address(0));
        assertEq(registry.getApproved(newId), address(0));

        vm.prank(manager);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecord(newId, key, hex"01");

        vm.prank(holderA);
        vm.expectRevert(_notActive(oldId));
        registry.setRecord(oldId, key, hex"01");
    }

    // ------------------------------------------------------------------
    // Records and record managers (SPEC 6.9)
    // ------------------------------------------------------------------

    function test_HolderSetsAndDeletesRecords() public {
        uint256 tokenId = _register(holderA, LABEL);
        bytes32 key = RecordKeys.text("url");
        vm.startPrank(holderA);
        registry.setRecord(tokenId, key, bytes("https://example.test"));
        assertEq(registry.record(tokenId, key), bytes("https://example.test"));
        registry.setRecord(tokenId, key, "");
        assertEq(registry.record(tokenId, key).length, 0);
        vm.stopPrank();
    }

    function test_RecordsRejectOversizeAndNonActive() public {
        uint256 tokenId = _register(holderA, LABEL);
        bytes32 key = RecordKeys.text("note");
        vm.prank(holderA);
        registry.setRecord(tokenId, key, new bytes(1024));

        vm.prank(holderA);
        vm.expectRevert(SLDRegistry.RecordTooLarge.selector);
        registry.setRecord(tokenId, key, new bytes(1025));

        vm.warp(registry.expiresAt(tokenId));
        vm.prank(holderA);
        vm.expectRevert(_notActive(tokenId));
        registry.setRecord(tokenId, key, hex"01");
    }

    function test_NftApprovalsGrantNoRecordRights() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.startPrank(holderA);
        registry.setApprovalForAll(stranger, true);
        registry.approve(payer, tokenId);
        vm.stopPrank();

        bytes32 key = RecordKeys.text("url");
        vm.prank(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecord(tokenId, key, hex"01");
        vm.prank(payer);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecord(tokenId, key, hex"01");
        vm.prank(operator);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecord(tokenId, key, hex"01");
    }

    function test_OnlyHolderAppointsManager() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.prank(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecordManager(tokenId, stranger);
    }

    /// The revision 1 bug: a manager keyed by (tokenId, holder) revived when
    /// the token returned to an earlier holder.
    function test_RecordManagerDoesNotReviveAfterRoundTrip() public {
        uint256 tokenId = _register(holderA, LABEL);
        bytes32 key = RecordKeys.text("url");

        vm.prank(holderA);
        registry.setRecordManager(tokenId, manager);
        vm.prank(manager);
        registry.setRecord(tokenId, key, hex"01");

        vm.prank(holderA);
        registry.transferFrom(holderA, holderB, tokenId);
        assertEq(registry.recordManager(tokenId), address(0));
        vm.prank(manager);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecord(tokenId, key, hex"02");

        vm.prank(holderB);
        registry.transferFrom(holderB, holderA, tokenId);
        assertEq(registry.recordManager(tokenId), address(0));
        vm.prank(manager);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setRecord(tokenId, key, hex"03");

        // Records themselves survive transfers.
        assertEq(registry.record(tokenId, key), hex"01");
    }

    // ------------------------------------------------------------------
    // Operator powers (SPEC 6.2)
    // ------------------------------------------------------------------

    function test_AdminFunctionsRejectNonAdmin() public {
        vm.startPrank(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setPrice(1);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setTreasury(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.transferAdmin(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.acceptAdmin();
        vm.stopPrank();
    }

    function test_TwoStepAdminHandoff() public {
        vm.prank(operator);
        registry.transferAdmin(holderB);
        assertEq(registry.admin(), operator);

        vm.prank(stranger);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.acceptAdmin();

        vm.prank(holderB);
        registry.acceptAdmin();
        assertEq(registry.admin(), holderB);
        assertEq(registry.pendingAdmin(), address(0));

        vm.prank(operator);
        vm.expectRevert(SLDRegistry.NotAuthorized.selector);
        registry.setPrice(1);
    }

    function test_SetPriceAffectsOnlyFutureRegistrations() public {
        uint256 tokenId = _register(holderA, LABEL);
        vm.prank(operator);
        registry.setPrice(0);
        assertEq(registry.lockedPrice(tokenId), PRICE);
        uint256 freeId = _register(holderB, "free");
        assertEq(registry.lockedPrice(freeId), 0);
    }

    function test_RejectsEther() public {
        vm.deal(holderA, 1 ether);
        vm.prank(holderA);
        (bool ok,) = address(registry).call{value: 1}("");
        assertFalse(ok);
    }
}
