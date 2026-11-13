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
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.issue.selector;
        selectors[1] = handler.rotateScope.selector;
        selectors[2] = handler.attemptUnauthorizedRecord.selector;
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
        assertEq(token.balanceOf(address(registry)), 0);
    }
    function invariantIssuedTokensRetainHolderAndIdentity() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokens(i);
            assertEq(registry.ownerOf(id), holder);
            assertEq(registry.namespaceOf(id), ns);
            assertEq(registry.lockedRenewalPrice(id), RENEWAL_PRICE);
        }
    }
}
