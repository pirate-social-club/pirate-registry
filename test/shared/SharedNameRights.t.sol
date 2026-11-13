// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "./SharedNameRegistryTestBase.sol";
import {ISharedNameRegistryV3 as IShared} from "../../src/interfaces/ISharedNameRegistryV3.sol";

contract SharedNameRightsTest is SharedNameRegistryTestBase {
    function testRecordEventsAndSizeBoundary() public {
        uint256 id = _issue("member001");
        bytes32 key = bytes32(uint256(1));
        vm.startPrank(holder);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.RecordSet(id, key, hex"0102");
        registry.setRecord(id, key, hex"0102");
        registry.setRecord(id, key, new bytes(1024));
        vm.expectRevert(IShared.RecordTooLarge.selector);
        registry.setRecord(id, key, new bytes(1025));
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.RecordManagerSet(id, submitter);
        registry.setRecordManager(id, submitter);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.RecordManagerSet(id, address(0));
        registry.transferFrom(holder, stranger, id);
        vm.stopPrank();
        assertEq(registry.record(id, key).length, 1024);
    }

    function testAdminAndSubmitterCannotSeizeOrEdit() public {
        uint256 id = _issue("member001");
        vm.prank(admin);
        vm.expectRevert();
        registry.transferFrom(holder, admin, id);
        vm.prank(admin);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setRecord(id, bytes32(uint256(1)), hex"01");
        vm.prank(submitter);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setRecordManager(id, submitter);
        assertEq(registry.ownerOf(id), holder);
    }

    function testTransferKeepsTermAndRecordsButClearsManager() public {
        uint256 id = _issue("member001");
        uint64 expiry = registry.expiresAt(id);
        vm.startPrank(holder);
        registry.setRecord(id, bytes32(uint256(1)), hex"0102");
        registry.setRecordManager(id, submitter);
        registry.transferFrom(holder, stranger, id);
        vm.stopPrank();
        assertEq(registry.recordManager(id), address(0));
        assertEq(registry.record(id, bytes32(uint256(1))), hex"0102");
        assertEq(registry.expiresAt(id), expiry);
        assertEq(registry.lockedRenewalPrice(id), RENEWAL_PRICE);
        vm.prank(stranger);
        registry.transferFrom(stranger, holder, id);
        vm.prank(submitter);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setRecord(id, bytes32(uint256(1)), hex"03");
    }

    function testNftApprovalsDoNotGrantRecordRights() public {
        uint256 id = _issue("member001");
        vm.prank(holder);
        registry.approve(stranger, id);
        vm.prank(stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setRecord(id, bytes32(uint256(1)), hex"01");
        vm.prank(stranger);
        registry.transferFrom(holder, stranger, id);
        assertEq(registry.ownerOf(id), stranger);
        assertTrue(registry.supportsInterface(0x80ac58cd));
    }
}
