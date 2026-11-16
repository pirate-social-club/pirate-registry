// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SharedNameRegistryV4TestBase} from "./SharedNameRegistryV4TestBase.sol";
import {ISharedNameRegistryV4 as IShared} from "../../src/interfaces/ISharedNameRegistryV4.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract SharedNameScopeValidityV4Test is SharedNameRegistryV4TestBase {
    bytes32 private constant OTHER = keccak256("fixture-other-community");

    event ScopeAuthorized(
        bytes32 indexed namespaceId,
        bytes32 indexed communityId,
        bytes32 indexed authorizationHash,
        IShared.ScopeAuthorization authorization,
        address submitter,
        uint64 totalClaimLimit,
        uint64 observedAt,
        uint64 validUntil,
        uint64 revision
    );
    event ScopeRefreshed(
        bytes32 indexed namespaceId,
        bytes32 indexed communityId,
        bytes32 indexed authorizationHash,
        uint64 observedAt,
        uint64 validUntil,
        uint64 revision
    );
    event ScopeRevoked(
        bytes32 indexed namespaceId, bytes32 indexed communityId, bytes32 indexed authorizationHash, uint64 revision
    );

    function testUnverifiedCommunityBCannotBorrowCommunityAScope() public {
        assertTrue(registry.quote(ns, COMMUNITY, "member001").issuanceEnabled);
        IShared.Scope memory b = registry.scope(ns, OTHER);
        assertFalse(b.enabled);
        assertEq(b.authorizationHash, bytes32(0));
        assertFalse(registry.quote(ns, OTHER, "member001").issuanceEnabled);
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.communityId = OTHER;
        _expectSubmit(IShared.ScopeUnavailable.selector, c);
        assertEq(registry.policy(ns).totalClaims, 0);
    }

    function testExpiredCommunityBCannotUseFreshGlobalNamespace() public {
        _authorize(_authorization(ns, OTHER), 2, uint64(vm.getBlockTimestamp() + 100));
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.communityId = OTHER;
        IShared.Scope memory b = registry.scope(ns, OTHER);
        c.scopeRevision = b.revision;
        c.scopeAuthorizationHash = b.authorizationHash;
        c.deadline = b.validUntil;
        vm.warp(b.validUntil);
        assertGt(registry.authority(ns).validUntil, vm.getBlockTimestamp());
        assertTrue(registry.quote(ns, COMMUNITY, "member002").issuanceEnabled);
        assertFalse(registry.quote(ns, OTHER, "member001").issuanceEnabled);
        _expectSubmit(IShared.ScopeUnavailable.selector, c);
    }

    function testDeadlineEqualScopeExpirySucceedsOnlyBeforeExpiry() public {
        _authorize(_authorization(ns, COMMUNITY), 50, uint64(vm.getBlockTimestamp() + 100));
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.deadline = registry.scope(ns, COMMUNITY).validUntil;
        vm.warp(c.deadline - 1);
        assertEq(registry.ownerOf(_submit(c)), holder);
    }

    function testExactScopeExpiryRefusesEvenInclusiveGrantDeadline() public {
        _authorize(_authorization(ns, COMMUNITY), 50, uint64(vm.getBlockTimestamp() + 100));
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.deadline = registry.scope(ns, COMMUNITY).validUntil;
        vm.warp(c.deadline);
        _expectSubmit(IShared.ScopeUnavailable.selector, c);
    }

    function testGrantDeadlineCannotExceedScopeValidity() public {
        _authorize(_authorization(ns, COMMUNITY), 50, uint64(vm.getBlockTimestamp() + 100));
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.deadline = registry.scope(ns, COMMUNITY).validUntil + 1;
        _expectSubmit(IShared.GrantExpired.selector, c);
    }

    function testGrantDeadlineRemainsInclusiveWithinLiveScope() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        vm.warp(c.deadline);
        assertEq(registry.ownerOf(_submit(c)), holder);
    }

    function testElapsedGrantRefusesEvenWhenScopeIsLive() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        vm.warp(c.deadline + 1);
        _expectSubmit(IShared.GrantExpired.selector, c);
    }

    function testWrongInstallationControllerOrEvidenceCannotRefreshBinding() public {
        IShared.ScopeAuthorization memory original = _authorization(ns, COMMUNITY);
        vm.warp(vm.getBlockTimestamp() + 1);
        for (uint256 field; field < 3; ++field) {
            IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
            if (field == 0) a.installationId = keccak256("other-installation");
            if (field == 1) a.controller = stranger;
            if (field == 2) a.evidenceHash = keccak256("other-authorization");
            vm.expectRevert(IShared.InvalidConfiguration.selector);
            vm.prank(admin);
            registry.refreshScope(a, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1);
        }
        assertEq(registry.scope(ns, COMMUNITY).authorizationHash, registry.scopeAuthorizationHash(original));
    }

    function testWrongNamespaceAuthorizationRefusesActivationAndRefresh() public {
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        a.namespaceAuthorizationHash = keccak256("wrong-namespace-authorization");
        _expectAuthorize(IShared.InvalidConfiguration.selector, a, 50, uint64(vm.getBlockTimestamp() + 1800));
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        vm.prank(admin);
        registry.refreshScope(a, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1);
    }

    function testZeroBindingFieldsRefuseActivation() public {
        for (uint256 field; field < 6; ++field) {
            IShared.ScopeAuthorization memory a = _authorization(ns, OTHER);
            if (field == 0) a.communityId = bytes32(0);
            if (field == 1) a.installationId = bytes32(0);
            if (field == 2) a.controller = address(0);
            if (field == 3) a.evidenceHash = bytes32(0);
            if (field == 4) a.namespaceAuthorizationHash = bytes32(0);
            if (field == 5) a.namespaceAuthorizationRevision = 0;
            _expectAuthorize(IShared.InvalidConfiguration.selector, a, 2, uint64(vm.getBlockTimestamp() + 100));
        }
    }

    function testWrongCommitmentRefusesOtherwiseSignedClaim() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.scopeAuthorizationHash = registry.scopeAuthorizationHash(_authorization(ns, OTHER));
        _expectSubmit(IShared.RevisionMismatch.selector, c);
    }

    function testRevocationEmitsAndInvalidatesCollectedSignatures() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory grant, bytes memory consent) = _signatures(c);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ScopeRevoked(ns, COMMUNITY, c.scopeAuthorizationHash, 2);
        vm.prank(admin);
        registry.revokeScope(ns, COMMUNITY, 1);
        assertFalse(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(submitter);
        registry.claimFreeName(c, grant, consent);
    }

    function testReactivationCannotReplayOldGrantEvenWithSameBinding() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory grant, bytes memory consent) = _signatures(c);
        vm.prank(admin);
        registry.revokeScope(ns, COMMUNITY, 1);
        _authorize(_authorization(ns, COMMUNITY), 50, uint64(vm.getBlockTimestamp() + 1800));
        vm.expectRevert(IShared.RevisionMismatch.selector);
        vm.prank(submitter);
        registry.claimFreeName(c, grant, consent);
    }

    function testExplicitBindingChangeRejectsOriginalGrant() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        a.controller = stranger;
        _authorize(a, 50, uint64(vm.getBlockTimestamp() + 1800));
        _expectSubmit(IShared.RevisionMismatch.selector, c);
    }

    function testRefreshPreservesBindingLimitsCountersRevisionAndOriginalGrant() public {
        _issue("member001");
        IShared.FreeClaim memory c = _claim(ns, "member002");
        (bytes memory grant, bytes memory consent) = _signatures(c);
        IShared.Scope memory before_ = registry.scope(ns, COMMUNITY);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ScopeRefreshed(
            ns,
            COMMUNITY,
            before_.authorizationHash,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 2000),
            before_.revision
        );
        vm.prank(admin);
        registry.refreshScope(
            _authorization(ns, COMMUNITY),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 2000),
            before_.revision
        );
        IShared.Scope memory after_ = registry.scope(ns, COMMUNITY);
        assertEq(after_.submitter, before_.submitter);
        assertEq(after_.totalClaimLimit, before_.totalClaimLimit);
        assertEq(after_.totalClaims, before_.totalClaims);
        assertEq(after_.revision, before_.revision);
        assertEq(after_.authorizationHash, before_.authorizationHash);
        vm.prank(submitter);
        assertEq(registry.ownerOf(registry.claimFreeName(c, grant, consent)), holder);
    }

    function testRefreshCannotReviveExpiredOrRevokedScope() public {
        IShared.Scope memory s = registry.scope(ns, COMMUNITY);
        vm.warp(s.validUntil);
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(admin);
        registry.refreshScope(
            _authorization(ns, COMMUNITY),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            s.revision
        );
        _authorize(_authorization(ns, COMMUNITY), 50, uint64(vm.getBlockTimestamp() + 100));
        uint64 rev = registry.scope(ns, COMMUNITY).revision;
        vm.prank(admin);
        registry.revokeScope(ns, COMMUNITY, rev);
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(admin);
        registry.refreshScope(
            _authorization(ns, COMMUNITY), uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 100), rev + 1
        );
    }

    function testRefreshRefusesStaleObservationShorteningAndStaleCAS() public {
        IShared.Scope memory s = registry.scope(ns, COMMUNITY);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        vm.prank(admin);
        registry.refreshScope(_authorization(ns, COMMUNITY), s.observedAt, s.validUntil, s.revision);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        vm.prank(admin);
        registry.refreshScope(
            _authorization(ns, COMMUNITY), uint64(vm.getBlockTimestamp()), s.validUntil - 1, s.revision
        );
        vm.expectRevert(IShared.RevisionMismatch.selector);
        vm.prank(admin);
        registry.refreshScope(_authorization(ns, COMMUNITY), uint64(vm.getBlockTimestamp()), s.validUntil, 0);
        vm.expectRevert(IShared.RevisionMismatch.selector);
        vm.prank(admin);
        registry.revokeScope(ns, COMMUNITY, 0);
    }

    function testValidityIsFiniteNonFutureAndBoundedByNamespace() public {
        IShared.ScopeAuthorization memory a = _authorization(ns, OTHER);
        vm.startPrank(admin);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.authorizeScope(
            a, submitter, 2, uint64(vm.getBlockTimestamp() + 1), uint64(vm.getBlockTimestamp() + 100), 0
        );
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.authorizeScope(a, submitter, 2, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp()), 0);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.authorizeScope(
            a, submitter, 2, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 days + 1), 0
        );
        registry.attestNamespace(
            ns,
            a.namespaceAuthorizationHash,
            keccak256("fixture-hns-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            true
        );
        a.namespaceAuthorizationRevision = 2;
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.authorizeScope(
            a, submitter, 2, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 101), 0
        );
        registry.authorizeScope(
            a, submitter, 2, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 100), 0
        );
        vm.stopPrank();
    }

    function testRegistrarSubmitterControllerAndSignerCannotAdministerScopes() public {
        address[4] memory callers = [stranger, submitter, holder, grantSigner];
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        for (uint256 index; index < callers.length; ++index) {
            vm.startPrank(callers[index]);
            vm.expectRevert(IShared.Unauthorized.selector);
            registry.authorizeScope(
                a, submitter, 50, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 100), 1
            );
            vm.expectRevert(IShared.Unauthorized.selector);
            registry.refreshScope(a, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1);
            vm.expectRevert(IShared.Unauthorized.selector);
            registry.revokeScope(ns, COMMUNITY, 1);
            vm.expectRevert(IShared.Unauthorized.selector);
            registry.transferAdmin(callers[index]);
            vm.expectRevert(IShared.Unauthorized.selector);
            registry.attestNamespace(
                ns,
                a.namespaceAuthorizationHash,
                keccak256("fixture-hns-proof"),
                uint64(vm.getBlockTimestamp()),
                uint64(vm.getBlockTimestamp() + 100),
                true
            );
            vm.expectRevert(IShared.Unauthorized.selector);
            registry.refreshNamespace(
                ns,
                a.namespaceAuthorizationHash,
                keccak256("next-proof"),
                uint64(vm.getBlockTimestamp()),
                uint64(vm.getBlockTimestamp() + 1 days),
                1,
                1
            );
            vm.stopPrank();
        }
    }

    function testSignerAndSubmitterMustRemainDifferent() public {
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        vm.prank(admin);
        registry.authorizeScope(
            _authorization(ns, COMMUNITY),
            grantSigner,
            50,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            1
        );
        vm.prank(admin);
        registry.configurePolicy(ns, submitter, RENEWAL_PRICE, 100);
        assertFalse(registry.quote(ns, COMMUNITY, "member001").issuanceEnabled);
        _expectSubmit(IShared.Unauthorized.selector, _claim(ns, "member001"));
    }

    function testNamespaceAuthorizationChangeClosesScopeUntilExplicitAdmission() public {
        vm.prank(admin);
        registry.attestNamespace(
            ns,
            keccak256("changed-hns-authorization"),
            keccak256("changed-hns-evidence"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            true
        );
        assertFalse(registry.quote(ns, COMMUNITY, "member001").issuanceEnabled);
        _expectSubmit(IShared.ScopeUnavailable.selector, _claim(ns, "member001"));
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        a.namespaceAuthorizationHash = keccak256("changed-hns-authorization");
        a.namespaceAuthorizationRevision = 2;
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(admin);
        registry.refreshScope(a, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1);
        _authorize(a, 50, uint64(vm.getBlockTimestamp() + 1800));
        assertEq(registry.ownerOf(_issue("member001")), holder);
    }

    function testFreshScopeCannotOverrideSuspendedNamespace() public {
        vm.prank(admin);
        registry.setNamespaceIssuance(ns, false);
        assertFalse(registry.quote(ns, COMMUNITY, "member001").issuanceEnabled);
        _expectSubmit(IShared.AuthorityUnavailable.selector, _claim(ns, "member001"));
    }

    function testScopeCannotBypassRequiredNamespaceMigration() public {
        bytes32 migrating = _namespace("migrating", true);
        _expectAuthorize(
            IShared.MigrationRequired.selector,
            _authorization(migrating, COMMUNITY),
            50,
            uint64(vm.getBlockTimestamp() + 100)
        );
        _expectSubmit(IShared.MigrationRequired.selector, _claim(migrating, "member001"));
        assertFalse(registry.quote(migrating, COMMUNITY, "member001").issuanceEnabled);
    }

    function testLifetimeCapsSurviveRefreshRevocationAndReauthorization() public {
        _authorize(_authorization(ns, COMMUNITY), 1, uint64(vm.getBlockTimestamp() + 1800));
        _issue("member001");
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 rev = registry.scope(ns, COMMUNITY).revision;
        vm.prank(admin);
        registry.refreshScope(
            _authorization(ns, COMMUNITY), uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), rev
        );
        vm.prank(admin);
        registry.revokeScope(ns, COMMUNITY, rev);
        _authorize(_authorization(ns, COMMUNITY), 1, uint64(vm.getBlockTimestamp() + 1800));
        assertEq(registry.scope(ns, COMMUNITY).totalClaims, 1);
        assertFalse(registry.quote(ns, COMMUNITY, "member002").issuanceEnabled);
        _expectSubmit(IShared.IssuanceLimit.selector, _claim(ns, "member002"));
        _expectAuthorize(
            IShared.InvalidConfiguration.selector,
            _authorization(ns, COMMUNITY),
            0,
            uint64(vm.getBlockTimestamp() + 1800)
        );
    }

    function testNamespaceCapRemainsSharedAcrossAuthorizedCommunities() public {
        vm.prank(admin);
        registry.configurePolicy(ns, grantSigner, RENEWAL_PRICE, 1);
        _authorize(_authorization(ns, OTHER), 2, uint64(vm.getBlockTimestamp() + 1800));
        _issue("member001");
        IShared.FreeClaim memory c = _claim(ns, "member002");
        c.communityId = OTHER;
        c.scopeAuthorizationHash = registry.scope(ns, OTHER).authorizationHash;
        c.scopeRevision = registry.scope(ns, OTHER).revision;
        _expectSubmit(IShared.IssuanceLimit.selector, c);
    }

    function testActivationEventAndStaleActivationRefusal() public {
        IShared.ScopeAuthorization memory a = _authorization(ns, OTHER);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ScopeAuthorized(
            ns,
            OTHER,
            registry.scopeAuthorizationHash(a),
            a,
            submitter,
            2,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            1
        );
        _authorize(a, 2, uint64(vm.getBlockTimestamp() + 100));
        vm.expectRevert(IShared.RevisionMismatch.selector);
        vm.prank(admin);
        registry.authorizeScope(
            a, submitter, 2, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 100), 0
        );
    }

    function testAuthorizationDigestBindsChainContractAndEveryField() public {
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        bytes32 expected = keccak256(
            abi.encodePacked(
                hex"1901",
                keccak256(
                    abi.encode(
                        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                        keccak256("PirateSharedNames"),
                        keccak256("4"),
                        block.chainid,
                        address(registry)
                    )
                ),
                keccak256(
                    abi.encode(
                        registry.SCOPE_AUTHORIZATION_TYPEHASH(),
                        a.namespaceId,
                        a.communityId,
                        a.installationId,
                        a.controller,
                        a.namespaceAuthorizationHash,
                        a.namespaceAuthorizationRevision,
                        a.evidenceHash
                    )
                )
            )
        );
        assertEq(registry.scopeAuthorizationHash(a), expected);
        for (uint256 field; field < 7; ++field) {
            IShared.ScopeAuthorization memory changed = _authorization(ns, COMMUNITY);
            if (field == 0) changed.namespaceId = bytes32(uint256(1));
            if (field == 1) changed.communityId = OTHER;
            if (field == 2) changed.installationId = bytes32(uint256(2));
            if (field == 3) changed.controller = stranger;
            if (field == 4) changed.namespaceAuthorizationHash = bytes32(uint256(3));
            if (field == 5) changed.evidenceHash = bytes32(uint256(4));
            if (field == 6) changed.namespaceAuthorizationRevision = 2;
            assertNotEq(registry.scopeAuthorizationHash(changed), expected);
        }
        vm.chainId(6343);
        assertNotEq(registry.scopeAuthorizationHash(a), expected);
    }

    function testIssuerAndNestedConsentHashMatchIndependentV4Encoding() public view {
        IShared.FreeClaim memory c = _claimView();
        bytes32 domainHash = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PirateSharedNames"),
                keccak256("4"),
                block.chainid,
                address(registry)
            )
        );
        bytes memory identity = abi.encode(
            registry.CLAIM_TYPEHASH(), c.requestId, c.communityId, c.namespaceId, keccak256(bytes(c.label)), c.recipient
        );
        bytes memory terms = abi.encode(
            c.generation,
            c.authorityRevision,
            c.policyRevision,
            c.scopeRevision,
            c.scopeAuthorizationHash,
            c.issuedAt,
            c.deadline,
            c.years_,
            c.maxCost
        );
        bytes32 structHash = keccak256(bytes.concat(identity, terms));
        assertEq(registry.requestHash(c), keccak256(abi.encodePacked(hex"1901", domainHash, structHash)));
        assertEq(
            registry.recipientAcceptanceHash(c),
            keccak256(
                abi.encodePacked(
                    hex"1901", domainHash, keccak256(abi.encode(registry.ACCEPTANCE_TYPEHASH(), structHash))
                )
            )
        );
        bytes32 otherDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PirateSharedNames"),
                keccak256("4"),
                block.chainid,
                stranger
            )
        );
        assertNotEq(registry.requestHash(c), keccak256(abi.encodePacked(hex"1901", otherDomain, structHash)));
    }

    function _claimView() private view returns (IShared.FreeClaim memory c) {
        IShared.NameQuote memory q = registry.quote(ns, COMMUNITY, "member001");
        c.requestId = bytes32(uint256(1));
        c.communityId = COMMUNITY;
        c.namespaceId = ns;
        c.label = "member001";
        c.recipient = holder;
        c.generation = q.generation;
        c.authorityRevision = q.authorityRevision;
        c.policyRevision = q.policyRevision;
        c.scopeRevision = q.scopeRevision;
        c.scopeAuthorizationHash = q.scopeAuthorizationHash;
        c.issuedAt = uint64(vm.getBlockTimestamp());
        c.deadline = uint64(vm.getBlockTimestamp() + 100);
        c.years_ = 1;
        c.maxCost = 0;
    }

    function testRevokedScopeRetainsNFTRecordsLockedRenewalAndReceipt() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        uint256 id = _submit(c);
        IShared.ClaimReceipt memory receipt = registry.claimReceipt(COMMUNITY, c.requestId);
        vm.prank(admin);
        registry.revokeScope(ns, COMMUNITY, c.scopeRevision);
        vm.prank(holder);
        registry.setRecord(id, bytes32(uint256(1)), hex"1234");
        vm.prank(holder);
        registry.transferFrom(holder, stranger, id);
        uint256 priorExpiry = registry.expiresAt(id);
        vm.prank(holder);
        registry.renew(id, 1, RENEWAL_PRICE, vm.getBlockTimestamp());
        assertEq(registry.ownerOf(id), stranger);
        assertEq(registry.record(id, bytes32(uint256(1))), hex"1234");
        assertEq(registry.lockedRenewalPrice(id), RENEWAL_PRICE);
        assertEq(registry.expiresAt(id), priorExpiry + 365 days);
        IShared.ClaimReceipt memory retained = registry.claimReceipt(COMMUNITY, c.requestId);
        assertEq(retained.requestHash, receipt.requestHash);
        assertEq(retained.tokenId, id);
        _expectSubmit(abi.encodeWithSelector(IShared.RequestAlreadyUsed.selector, receipt.requestHash, id), c);
    }

    function testAuthorizedCommunitiesShareUniquenessAndRetainOriginalReceiptAfterRelease() public {
        IShared.FreeClaim memory original = _claim(ns, "member001");
        uint256 oldId = _submit(original);
        _authorize(_authorization(ns, OTHER), 2, uint64(vm.getBlockTimestamp() + 1800));
        IShared.FreeClaim memory next = _claim(ns, "member001");
        next.communityId = OTHER;
        next.scopeRevision = registry.scope(ns, OTHER).revision;
        next.scopeAuthorizationHash = registry.scope(ns, OTHER).authorizationHash;
        _expectSubmit(IShared.Unavailable.selector, next);
        vm.warp(uint256(registry.expiresAt(oldId)) + 30 days);
        assertEq(uint256(registry.status(oldId)), uint256(IShared.Status.Released));
        vm.prank(admin);
        registry.attestNamespace(
            ns,
            keccak256("fixture-hns-authorization"),
            keccak256("fixture-hns-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            true
        );
        IShared.ScopeAuthorization memory readmitted = _authorization(ns, OTHER);
        readmitted.namespaceAuthorizationRevision = 2;
        _authorize(readmitted, 2, uint64(vm.getBlockTimestamp() + 1800));
        next = _claim(ns, "member001");
        next.communityId = OTHER;
        next.scopeRevision = registry.scope(ns, OTHER).revision;
        next.scopeAuthorizationHash = registry.scope(ns, OTHER).authorizationHash;
        uint256 nextId = _submit(next);
        assertNotEq(nextId, oldId);
        assertEq(registry.generationOf(nextId), 2);
        assertEq(uint256(registry.status(oldId)), uint256(IShared.Status.Superseded));
        assertEq(registry.claimReceipt(COMMUNITY, original.requestId).tokenId, oldId);
        assertEq(registry.policy(ns).totalClaims, 2);
        assertEq(registry.scope(ns, COMMUNITY).totalClaims, 1);
        assertEq(registry.scope(ns, OTHER).totalClaims, 1);
    }

    function testNamespaceObservationRefreshPreservesCollectedGrantAndCounters() public {
        _issue("member001");
        IShared.FreeClaim memory c = _claim(ns, "member002");
        (bytes memory grant, bytes memory consent) = _signatures(c);
        IShared.Authority memory before_ = registry.authority(ns);
        IShared.Scope memory scopeBefore = registry.scope(ns, COMMUNITY);
        vm.warp(vm.getBlockTimestamp() + 10);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IShared.AuthorityAttested(
            ns,
            before_.authorizationHash,
            keccak256("new-observation"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            before_.revision,
            before_.freshnessVersion + 1,
            true
        );
        vm.prank(admin);
        registry.refreshNamespace(
            ns,
            before_.authorizationHash,
            keccak256("new-observation"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            before_.revision,
            before_.freshnessVersion
        );
        IShared.Authority memory after_ = registry.authority(ns);
        assertEq(after_.revision, before_.revision);
        assertEq(after_.authorizationHash, before_.authorizationHash);
        assertEq(after_.freshnessVersion, before_.freshnessVersion + 1);
        assertEq(after_.evidenceHash, keccak256("new-observation"));
        assertEq(registry.scope(ns, COMMUNITY).authorizationHash, scopeBefore.authorizationHash);
        assertEq(registry.scope(ns, COMMUNITY).revision, scopeBefore.revision);
        assertEq(registry.scope(ns, COMMUNITY).validUntil, scopeBefore.validUntil);
        assertEq(registry.scope(ns, COMMUNITY).totalClaims, 1);
        assertEq(registry.scope(ns, COMMUNITY).totalClaimLimit, scopeBefore.totalClaimLimit);
        assertEq(registry.scope(ns, COMMUNITY).submitter, scopeBefore.submitter);
        assertEq(registry.policy(ns).totalClaims, 1);
        assertEq(registry.policy(ns).totalClaimLimit, 100);
        assertEq(registry.policy(ns).grantSigner, grantSigner);
        assertTrue(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        vm.prank(submitter);
        assertEq(registry.ownerOf(registry.claimFreeName(c, grant, consent)), holder);
    }

    function testNamespaceAndScopeRefreshCannotExtendOriginalSignedDeadline() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory grant, bytes memory consent) = _signatures(c);
        vm.warp(uint256(c.deadline) + 1);
        vm.startPrank(admin);
        registry.refreshNamespace(
            ns,
            keccak256("fixture-hns-authorization"),
            keccak256("next-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            1,
            1
        );
        registry.refreshScope(
            _authorization(ns, COMMUNITY), uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1
        );
        vm.stopPrank();
        assertTrue(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        vm.expectRevert(IShared.GrantExpired.selector);
        vm.prank(submitter);
        registry.claimFreeName(c, grant, consent);
        assertEq(registry.policy(ns).totalClaims, 0);
    }

    function testNamespaceRefreshCannotReviveExpiredCommunityScope() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        vm.warp(registry.scope(ns, COMMUNITY).validUntil);
        vm.prank(admin);
        registry.refreshNamespace(
            ns,
            keccak256("fixture-hns-authorization"),
            keccak256("next-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            1,
            1
        );
        assertFalse(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(admin);
        registry.refreshScope(
            _authorization(ns, COMMUNITY), uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1
        );
        _expectSubmit(IShared.ScopeUnavailable.selector, c);
    }

    function testExpiredNamespaceCannotRefreshAndReadmissionDoesNotReviveOldGrant() public {
        bytes32 binding = keccak256("fixture-hns-authorization");
        vm.prank(admin);
        registry.attestNamespace(
            ns,
            binding,
            keccak256("fixture-hns-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            true
        );
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        a.namespaceAuthorizationRevision = 2;
        _authorize(a, 50, uint64(vm.getBlockTimestamp() + 100));
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.deadline = uint64(vm.getBlockTimestamp() + 100);
        vm.warp(c.deadline);
        vm.expectRevert(IShared.AuthorityUnavailable.selector);
        vm.prank(admin);
        registry.refreshNamespace(
            ns,
            binding,
            keccak256("next-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            2,
            2
        );
        vm.prank(admin);
        registry.attestNamespace(
            ns,
            binding,
            keccak256("next-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            true
        );
        assertEq(registry.authority(ns).revision, 3);
        assertFalse(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        a.namespaceAuthorizationRevision = 3;
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(admin);
        registry.refreshScope(a, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 2);
        _authorize(a, 50, uint64(vm.getBlockTimestamp() + 1800));
        _expectSubmit(IShared.RevisionMismatch.selector, c);
    }

    function testNamespaceRevokeReenableCannotReuseOldScopeOrGrant() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        vm.prank(admin);
        registry.setNamespaceIssuance(ns, false);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(IShared.AuthorityUnavailable.selector);
        vm.prank(admin);
        registry.refreshNamespace(
            ns,
            keccak256("fixture-hns-authorization"),
            keccak256("next-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            2,
            1
        );
        vm.prank(admin);
        registry.setNamespaceIssuance(ns, true);
        assertEq(registry.authority(ns).revision, 3);
        assertFalse(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        a.namespaceAuthorizationRevision = 3;
        vm.expectRevert(IShared.ScopeUnavailable.selector);
        vm.prank(admin);
        registry.refreshScope(a, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1800), 1);
        _authorize(a, 50, uint64(vm.getBlockTimestamp() + 1800));
        _expectSubmit(IShared.RevisionMismatch.selector, c);
    }

    function testNamespaceOwnershipEpochReturningToSameHashCannotRestoreScope() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        vm.startPrank(admin);
        registry.attestNamespace(
            ns,
            keccak256("different-owner"),
            keccak256("proof-two"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            true
        );
        registry.attestNamespace(
            ns,
            keccak256("fixture-hns-authorization"),
            keccak256("proof-three"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            true
        );
        vm.stopPrank();
        assertEq(registry.authority(ns).revision, 3);
        assertEq(registry.scope(ns, COMMUNITY).namespaceAuthorizationRevision, 1);
        assertFalse(registry.quote(ns, COMMUNITY, c.label).issuanceEnabled);
        _expectSubmit(IShared.ScopeUnavailable.selector, c);
        IShared.ScopeAuthorization memory current = _authorization(ns, COMMUNITY);
        current.namespaceAuthorizationRevision = 3;
        _authorize(current, 50, uint64(vm.getBlockTimestamp() + 1800));
        _expectSubmit(IShared.RevisionMismatch.selector, c);
    }

    function testNamespaceRefreshRejectsChangedBindingInvalidEvidenceAndUnboundedTime() public {
        IShared.Authority memory a = registry.authority(ns);
        vm.startPrank(admin);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.refreshNamespace(ns, a.authorizationHash, a.evidenceHash, a.observedAt, a.validUntil, 1, 1);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.refreshNamespace(
            ns, keccak256("other-binding"), a.evidenceHash, uint64(vm.getBlockTimestamp()), a.validUntil, 1, 1
        );
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.refreshNamespace(
            ns, a.authorizationHash, bytes32(0), uint64(vm.getBlockTimestamp()), a.validUntil, 1, 1
        );
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.refreshNamespace(
            ns, a.authorizationHash, a.evidenceHash, uint64(vm.getBlockTimestamp() + 1), a.validUntil, 1, 1
        );
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.refreshNamespace(
            ns, a.authorizationHash, a.evidenceHash, uint64(vm.getBlockTimestamp()), a.validUntil - 1, 1, 1
        );
        vm.expectRevert(IShared.InvalidConfiguration.selector);
        registry.refreshNamespace(
            ns,
            a.authorizationHash,
            a.evidenceHash,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days + 1),
            1,
            1
        );
        registry.refreshNamespace(
            ns,
            a.authorizationHash,
            a.evidenceHash,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            1,
            1
        );
        vm.stopPrank();
        assertEq(registry.authority(ns).revision, 1);
        assertEq(registry.authority(ns).freshnessVersion, 2);
    }

    function testNamespaceRefreshCASRejectsStaleEpochAndObservationVersion() public {
        IShared.Authority memory a = registry.authority(ns);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.startPrank(admin);
        vm.expectRevert(IShared.RevisionMismatch.selector);
        registry.refreshNamespace(
            ns,
            a.authorizationHash,
            a.evidenceHash,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            0,
            1
        );
        registry.refreshNamespace(
            ns,
            a.authorizationHash,
            a.evidenceHash,
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            1,
            1
        );
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(IShared.RevisionMismatch.selector);
        registry.refreshNamespace(
            ns,
            a.authorizationHash,
            keccak256("newer-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            1,
            1
        );
        vm.stopPrank();
        assertEq(registry.authority(ns).freshnessVersion, 2);
        assertEq(registry.authority(ns).evidenceHash, a.evidenceHash);
    }

    function testNamespaceRefreshCannotInitializeOrBypassMigration() public {
        vm.prank(admin);
        bytes32 pending = registry.registerNamespace("pendingtld", false);
        vm.expectRevert(IShared.AuthorityUnavailable.selector);
        vm.prank(admin);
        registry.refreshNamespace(
            pending,
            keccak256("binding"),
            keccak256("proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            0,
            0
        );
        bytes32 migrating = _namespace("migrating", true);
        vm.expectRevert(IShared.MigrationRequired.selector);
        vm.prank(admin);
        registry.refreshNamespace(
            migrating,
            keccak256("fixture-hns-authorization"),
            keccak256("proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 100),
            1,
            1
        );
        assertFalse(registry.authority(pending).issuanceEnabled);
        assertEq(registry.authority(pending).revision, 0);
    }

    function testFixedCollectionMetadataRetainsERC721Surface() public view {
        assertEq(registry.name(), "Pirate Shared Names");
        assertEq(registry.symbol(), "PSN");
        assertTrue(registry.supportsInterface(0x80ac58cd));
        assertTrue(registry.supportsInterface(0x5b5e139f));
        assertTrue(registry.supportsInterface(0x01ffc9a7));
        assertFalse(registry.supportsInterface(0xffffffff));
    }

    function testFixedTokenURIKeepsExistenceReleasedAndSupersededBehavior() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 0));
        registry.tokenURI(0);
        uint256 oldId = _issue("member001");
        assertEq(registry.tokenURI(oldId), "");
        vm.warp(uint256(registry.expiresAt(oldId)) + 30 days);
        assertEq(uint256(registry.status(oldId)), uint256(IShared.Status.Released));
        assertEq(registry.tokenURI(oldId), "");
        vm.prank(admin);
        registry.attestNamespace(
            ns,
            keccak256("fixture-hns-authorization"),
            keccak256("fixture-hns-proof"),
            uint64(vm.getBlockTimestamp()),
            uint64(vm.getBlockTimestamp() + 1 days),
            true
        );
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        a.namespaceAuthorizationRevision = 2;
        _authorize(a, 50, uint64(vm.getBlockTimestamp() + 1800));
        uint256 currentId = _issue("member001");
        assertEq(registry.tokenURI(currentId), "");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, oldId));
        registry.tokenURI(oldId);
    }

    function testFixedDomainViewAndInheritedDigestTrackCurrentChain() public {
        IShared.ScopeAuthorization memory a = _authorization(ns, COMMUNITY);
        bytes32 original = registry.scopeAuthorizationHash(a);
        _assertCurrentDomainView();
        vm.chainId(6343);
        _assertCurrentDomainView();
        assertNotEq(registry.scopeAuthorizationHash(a), original);
        vm.chainId(31337);
        _assertCurrentDomainView();
        assertEq(registry.scopeAuthorizationHash(a), original);
    }

    function _assertCurrentDomainView() private view {
        (
            bytes1 fields,
            string memory domainName,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = registry.eip712Domain();
        assertEq(uint256(uint8(fields)), 15);
        assertEq(domainName, "PirateSharedNames");
        assertEq(version, "4");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(registry));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function testExpiredScopeDoesNotBlockZeroPriceThirdPartyRenewalInGrace() public {
        vm.prank(admin);
        registry.configurePolicy(ns, grantSigner, 0, 100);
        uint256 id = _issue("member001");
        vm.warp(registry.expiresAt(id) + 1);
        assertEq(uint256(registry.status(id)), uint256(IShared.Status.Grace));
        vm.prank(stranger);
        registry.renew(id, 1, 0, vm.getBlockTimestamp());
        assertEq(uint256(registry.status(id)), uint256(IShared.Status.Active));
        assertEq(registry.ownerOf(id), holder);
    }
}
