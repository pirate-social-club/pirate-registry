// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "./SharedNameRegistryTestBase.sol";
import {ISharedNameRegistryV3 as IShared} from "../../src/interfaces/ISharedNameRegistryV3.sol";

contract SharedNameAuthorityTest is SharedNameRegistryTestBase {
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
    }

    function testTwoStepAdminHandover() public {
        vm.prank(stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.transferAdmin(stranger);
        vm.prank(admin);
        registry.transferAdmin(stranger);
        assertEq(registry.admin(), admin);
        vm.prank(submitter);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.acceptAdmin();
        vm.prank(stranger);
        registry.acceptAdmin();
        assertEq(registry.admin(), stranger);
    }
}
