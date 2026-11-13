// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "./SharedNameRegistryTestBase.sol";
import {ISharedNameRegistryV3 as IShared} from "../../src/interfaces/ISharedNameRegistryV3.sol";
import {SharedNameRegistryV3} from "../../src/SharedNameRegistryV3.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract SignatureOnlyRecipient {
    bytes32 public accepted;
    function setAccepted(bytes32 value) external { accepted = value; }
    function isValidSignature(bytes32 value, bytes calldata) external view returns (bytes4) {
        return value == accepted ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract ProbingSharedRecipient is SignatureOnlyRecipient, IERC721Receiver {
    SharedNameRegistryV3 private immutable registry;
    bool public initialized;
    bool public renewalBlocked;
    constructor(SharedNameRegistryV3 registry_) { registry = registry_; }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        initialized = registry.effectiveOwner(id) == address(this) && registry.expiresAt(id) > block.timestamp;
        try registry.renew(id, 1, 0, block.timestamp) {} catch (bytes memory reason) {
            renewalBlocked = bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract SharedNameClaimsTest is SharedNameRegistryTestBase {
    function testReceiptAndReplayStayBoundToOriginalOperation() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        uint256 id = _submit(c);
        IShared.ClaimReceipt memory r = registry.claimReceipt(COMMUNITY, c.requestId);
        assertEq(r.requestHash, registry.requestHash(c));
        assertEq(r.tokenId, id);
        assertEq(r.blockNumber, block.number);
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(IShared.RequestAlreadyUsed.selector, r.requestHash, id));
        registry.claimFreeName(c, g, s);
        c.label = "member002";
        (g, s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.RequestConflict.selector);
        registry.claimFreeName(c, g, s);
        assertEq(registry.policy(ns).totalClaims, 1);
    }

    function testBothSignaturesAndScopeRequired() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.InvalidSignature.selector);
        registry.claimFreeName(c, g, hex"");
        vm.prank(submitter);
        vm.expectRevert(IShared.InvalidSignature.selector);
        registry.claimFreeName(c, hex"", s);
        vm.prank(stranger);
        vm.expectRevert(IShared.Unauthorized.selector);
        registry.claimFreeName(c, g, s);
        c.recipient = stranger;
        vm.prank(submitter);
        vm.expectRevert(IShared.InvalidSignature.selector);
        registry.claimFreeName(c, g, s);
    }

    function testDomainSeparatesChainsAndContracts() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        bytes32 original = registry.requestHash(c);
        vm.chainId(6343);
        assertNotEq(original, registry.requestHash(c));
        vm.chainId(31337);
        SharedNameRegistryV3 other = new SharedNameRegistryV3(admin, address(token), treasury);
        assertNotEq(original, other.requestHash(c));
    }

    function testOriginalSignaturesCannotBeReusedForAnotherBoundField() public {
        bytes32 otherNamespace = _namespace("othertld", false);
        bytes32 otherCommunity = keccak256("other-community");
        vm.prank(admin);
        registry.configureScope(ns, otherCommunity, submitter, 10, true);
        IShared.FreeClaim memory c = _claim(ns, "member001");
        (bytes memory g, bytes memory s) = _signatures(c);
        bytes32 originalRequest = c.requestId;
        c.requestId = bytes32(uint256(999));
        _rejectChangedClaim(c, g, s);
        c.requestId = originalRequest;
        c.communityId = otherCommunity;
        _rejectChangedClaim(c, g, s);
        c.communityId = COMMUNITY;
        c.namespaceId = otherNamespace;
        _rejectChangedClaim(c, g, s);
        c.namespaceId = ns;
        c.label = "member002";
        _rejectChangedClaim(c, g, s);
        c.label = "member001";
        c.generation = 2;
        _rejectChangedClaim(c, g, s);
        c.generation = 1;
        c.deadline--;
        _rejectChangedClaim(c, g, s);
        assertEq(registry.policy(ns).totalClaims, 0);
    }

    function _rejectChangedClaim(IShared.FreeClaim memory c, bytes memory grant, bytes memory consent) private {
        vm.prank(submitter);
        vm.expectRevert(IShared.InvalidSignature.selector);
        registry.claimFreeName(c, grant, consent);
    }

    function testDeadlineAndTermRestrictions() public {
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.deadline = c.issuedAt + 901;
        (bytes memory g, bytes memory s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.GrantExpired.selector);
        registry.claimFreeName(c, g, s);
        c.deadline = c.issuedAt + 600;
        c.maxCost = 1;
        (g, s) = _signatures(c);
        vm.prank(submitter);
        vm.expectRevert(IShared.InvalidClaim.selector);
        registry.claimFreeName(c, g, s);
    }

    function testReceiverFailureRollsBackReceiptAndBudgets() public {
        SignatureOnlyRecipient recipient = new SignatureOnlyRecipient();
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.recipient = address(recipient);
        bytes32 digest = registry.requestHash(c);
        recipient.setAccepted(registry.recipientAcceptanceHash(digest));
        bytes memory grant = _signature(GRANT_KEY, digest);
        vm.prank(submitter);
        vm.expectRevert();
        registry.claimFreeName(c, grant, hex"01");
        assertEq(registry.policy(ns).totalClaims, 0);
        assertEq(registry.claimReceipt(COMMUNITY, c.requestId).requestHash, bytes32(0));
    }

    function testERC1271AndReceiverObserveInitializedState() public {
        ProbingSharedRecipient recipient = new ProbingSharedRecipient(registry);
        IShared.FreeClaim memory c = _claim(ns, "member001");
        c.recipient = address(recipient);
        bytes32 digest = registry.requestHash(c);
        recipient.setAccepted(registry.recipientAcceptanceHash(digest));
        bytes memory grant = _signature(GRANT_KEY, digest);
        vm.prank(submitter);
        registry.claimFreeName(c, grant, hex"01");
        assertTrue(recipient.initialized());
        assertTrue(recipient.renewalBlocked());
    }
}
