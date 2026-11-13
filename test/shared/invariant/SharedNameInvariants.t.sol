// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SharedNameRegistryTestBase} from "../SharedNameRegistryTestBase.sol";
import {SharedNameHandler} from "./SharedNameHandler.sol";
import {ISharedNameRegistryV3 as IShared} from "../../../src/interfaces/ISharedNameRegistryV3.sol";

contract SharedNameInvariants is SharedNameRegistryTestBase {
    SharedNameHandler private handler;
    function setUp() public override {
        super.setUp();
        handler = new SharedNameHandler(registry, ns, COMMUNITY, submitter, admin, GRANT_KEY, HOLDER_KEY);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.issue.selector;
        selectors[1] = handler.rotateScope.selector;
        selectors[2] = handler.attemptUnauthorizedRecord.selector;
        selectors[3] = handler.advanceTime.selector;
        selectors[4] = handler.transfer.selector;
        selectors[5] = handler.renew.selector;
        selectors[6] = handler.reregister.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }
    function invariantCountersEqualSuccessfulClaimsAndNeverExceedLimits() public view {
        IShared.Policy memory p = registry.policy(ns);
        IShared.Scope memory s = registry.scope(ns, COMMUNITY);
        assertEq(p.totalClaims, handler.successfulClaims());
        assertEq(s.totalClaims, handler.successfulClaims());
        assertLe(p.totalClaims, p.totalClaimLimit);
        assertLe(s.totalClaims, s.totalClaimLimit);
        assertFalse(handler.unauthorizedMutation());
        assertFalse(handler.managerSurvivedTransfer());
        assertEq(token.balanceOf(address(registry)), handler.paidRenewals());
    }
    function invariantIssuedTokensRetainHolderAndIdentity() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokens(i);
            IShared.Status state = registry.status(id);
            if (state != IShared.Status.Superseded) assertEq(registry.ownerOf(id), handler.expectedHolder(id));
            assertEq(registry.namespaceOf(id), ns);
            assertEq(registry.lockedRenewalPrice(id), RENEWAL_PRICE);
            assertEq(registry.expiresAt(id), handler.expectedExpiry(id));
            assertEq(id, registry.tokenIdFor(registry.nameKeyOf(id), registry.generationOf(id)));
            if (state == IShared.Status.Active) assertEq(registry.effectiveOwner(id), handler.expectedHolder(id));
            else assertEq(registry.effectiveOwner(id), address(0));
        }
    }

    function testHandlerExercisesLifecycleAndReRegistration() public {
        handler.issue(0);
        handler.transfer(0);
        handler.renew(0, 1);
        handler.advanceTime(uint32(400 days));
        handler.advanceTime(uint32(400 days));
        handler.reregister(0);
        assertEq(handler.transfers(), 1);
        assertEq(handler.renewals(), 1);
        assertEq(handler.reregistrations(), 1);
        assertEq(handler.successfulClaims(), 2);
        invariantCountersEqualSuccessfulClaimsAndNeverExceedLimits();
        invariantIssuedTokensRetainHolderAndIdentity();
    }
}
