// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "./SharedNameRegistryTestBase.sol";
import {ISharedNameRegistryV3 as IShared} from "../../src/interfaces/ISharedNameRegistryV3.sol";

contract SharedNameAuthorityTest is SharedNameRegistryTestBase {
    function testEveryAdminConfigurationRejectsUnprivilegedCaller() public {
        vm.startPrank(stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.registerNamespace("foreign", false);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.attestNamespace(ns, bytes32(uint256(1)), uint64(block.timestamp), uint64(block.timestamp + 100), true);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setNamespaceIssuance(ns, false);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.configurePolicy(ns, stranger, 0, 1000);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.configureScope(ns, COMMUNITY, stranger, 1000, true);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setNamePolicy(ns, "member001", 0, stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.setTreasury(stranger);
        vm.stopPrank();
        assertEq(registry.treasury(), treasury);
        assertEq(registry.policy(ns).grantSigner, grantSigner);
        assertEq(registry.scope(ns, COMMUNITY).submitter, submitter);
    }

    function testConfigurationEventsAndMonotonicAttestation() public {
        bytes32 other = registry.namespaceIdFor("newnamespace");
        vm.startPrank(admin);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.NamespaceRegistered(other, "newnamespace", false);
        registry.registerNamespace("newnamespace", false);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.AuthorityAttested(other, bytes32(uint256(9)), uint64(block.timestamp), uint64(block.timestamp + 100), 1, true);
        registry.attestNamespace(other, bytes32(uint256(9)), uint64(block.timestamp), uint64(block.timestamp + 100), true);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.PolicyConfigured(other, grantSigner, RENEWAL_PRICE, 10, 1);
        registry.configurePolicy(other, grantSigner, RENEWAL_PRICE, 10);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.ScopeConfigured(other, COMMUNITY, submitter, 5, 1, true);
        registry.configureScope(other, COMMUNITY, submitter, 5, true);
        bytes32 nameKey = registry.nameKeyFor(other, "member001");
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.NamePolicySet(other, nameKey, "member001", 1, holder, 2);
        registry.setNamePolicy(other, "member001", 1, holder);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.attestNamespace(other, bytes32(uint256(10)), uint64(block.timestamp - 1), uint64(block.timestamp + 100), true);
        // Equal-time corrected evidence remains possible and advances revision.
        registry.attestNamespace(other, bytes32(uint256(10)), uint64(block.timestamp), uint64(block.timestamp + 100), true);
        assertEq(registry.authority(other).revision, 2);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.TreasuryChanged(stranger);
        registry.setTreasury(stranger);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.setTreasury(address(0));
        vm.stopPrank();
        assertEq(registry.treasury(), stranger);
    }

    function testUnknownNamespaceRefusesConfigurationAndReads() public {
        bytes32 unknown = keccak256("unknown-namespace");
        vm.expectRevert(IShared.NamespaceUnknown.selector);
        registry.authority(unknown);
        vm.prank(admin);
        vm.expectRevert(IShared.NamespaceUnknown.selector);
        registry.configurePolicy(unknown, grantSigner, 0, 1);
    }

    function testAdminCanReplacePendingNomineeWithoutGivingUpCustody() public {
        vm.startPrank(admin);
        registry.transferAdmin(stranger);
        registry.transferAdmin(admin);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.acceptAdmin();
        vm.prank(admin);
        registry.acceptAdmin();
        assertEq(registry.admin(), admin);
        assertEq(registry.pendingAdmin(), address(0));
    }
    function testExpiredAuthorityAndMigrationStayClosed() public {
        bytes32 migrating = _namespace("migrating", true);
        vm.prank(admin);
        vm.expectRevert(IShared.MigrationRequired.selector);
        registry.setNamespaceIssuance(migrating, true);
        vm.warp(block.timestamp + 1 days);
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.AuthorityUnavailable.selector);
        registry.claimFreeName(c, g, s);
    }

    function testRefreshInvalidatesOldGrant() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory g, bytes memory s) = _signatures(c);
        _refresh(ns);
        vm.prank(submitter);
        vm.expectRevert(IShared.RevisionMismatch.selector);
        registry.claimFreeName(c, g, s);
    }

    function testRejectLongOrFutureEvidence() public {
        vm.startPrank(admin);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.attestNamespace(ns, bytes32(uint256(1)), uint64(block.timestamp + 1), uint64(block.timestamp + 100), true);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.attestNamespace(ns, bytes32(uint256(1)), uint64(block.timestamp), uint64(block.timestamp + 1 days + 1), true);
        vm.stopPrank();
    }

    function testPolicyAndScopeChangesInvalidatePreviouslySignedTerms() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(admin);
        registry.configurePolicy(ns, grantSigner, RENEWAL_PRICE + 1, 100);
        vm.prank(submitter);
        vm.expectRevert(IShared.RevisionMismatch.selector);
        registry.claimFreeName(c, g, s);
        c = _claim(ns, "member001");
        (g, s) = _signatures(c);
        vm.prank(admin);
        registry.configureScope(ns, COMMUNITY, submitter, 50, true);
        vm.prank(submitter);
        vm.expectRevert(IShared.RevisionMismatch.selector);
        registry.claimFreeName(c, g, s);
        assertEq(registry.policy(ns).totalClaims, 0);
    }

    function testScopeAndNamespaceCapsPersistAcrossRotation() public {
        vm.prank(admin);
        registry.configureScope(ns, COMMUNITY, submitter, 1, true);
        _issue("member001");
        address next = makeAddr("next-submitter");
        vm.prank(admin);
        registry.configureScope(ns, COMMUNITY, next, 1, true);
        submitter = next;
        IShared.FreeClaim memory c = _claim(ns, "member002");
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(next);
        vm.expectRevert(IShared.IssuanceLimit.selector);
        registry.claimFreeName(c, g, s);
        vm.startPrank(admin);
        registry.configureScope(ns, COMMUNITY, next, 2, true);
        registry.configurePolicy(ns, grantSigner, RENEWAL_PRICE, 1);
        vm.stopPrank();
        c = _claim(ns, "member002");
        (g, s) = _signatures(c);
        vm.prank(next);
        vm.expectRevert(IShared.IssuanceLimit.selector);
        registry.claimFreeName(c, g, s);
        assertEq(registry.policy(ns).totalClaims, 1);
    }

    function testSignerCannotAlsoSubmit() public {
        vm.prank(admin);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.configureScope(ns, COMMUNITY, grantSigner, 5, true);
        vm.prank(admin);
        registry.configurePolicy(ns, submitter, RENEWAL_PRICE, 100);
        assertFalse(registry.quote(ns, COMMUNITY, "member001").issuanceEnabled);
        IShared.FreeClaim memory c = _claim(ns, "member001");
        vm.prank(submitter);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.claimFreeName(c, hex"01", hex"02");
        assertEq(registry.policy(ns).totalClaims, 0);
    }

    function testTwoStepAdminHandover() public {
        vm.prank(stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.transferAdmin(stranger);
        vm.prank(admin);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.AdminTransferStarted(stranger);
        registry.transferAdmin(stranger);
        assertEq(registry.admin(), admin);
        vm.prank(submitter);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.acceptAdmin();
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IShared.AdminTransferred(admin, stranger);
        registry.acceptAdmin();
        assertEq(registry.admin(), stranger);
    }
}
