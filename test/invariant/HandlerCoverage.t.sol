// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";
import {RegistryFactory} from "../../src/RegistryFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MutantRegistryNoTransferGuard} from "../mocks/MutantRegistry.sol";
import {RegistryHandler} from "./RegistryHandler.sol";

/// Deterministic checks on the invariant handler itself: one fixed scenario
/// must reach every required path with zero model mismatches, and a mutant
/// registry without the expiry guard must be caught.
contract HandlerCoverageTest is Test {
    uint32 internal constant INTO_GRACE = 12 days; // expiry - 2 days + 12 days
    uint32 internal constant PAST_GRACE = 34 days; // expiry - 2 days + 34 days

    MockUSDC internal usdc;
    address internal operator = makeAddr("operator");
    address[] internal treasuries;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        treasuries.push(makeAddr("treasury-0"));
        treasuries.push(makeAddr("treasury-1"));
    }

    function _handlerFor(SLDRegistry registry) internal returns (RegistryHandler) {
        return new RegistryHandler(registry, usdc, operator, treasuries, 5e6);
    }

    function test_FixedScenarioReachesEveryRequiredPath() public {
        RegistryFactory factory = new RegistryFactory(address(usdc));
        SLDRegistry registry = SLDRegistry(factory.deployRegistry("testtld", operator, treasuries[0], 5e6));
        RegistryHandler h = _handlerFor(registry);
        bytes32 key = bytes32(uint256(7));

        h.register(0, 1, 0, 0); // actor-0 buys "studio"
        h.setRecordManager(0, 1); // actor-1 manages records
        h.managerWrites(0, key);
        h.transferAsApprovedOperator(0, 2, 1); // actor-2, approved by actor-0, moves it to actor-1
        h.transfer(0, 0, true, 3); // holder actor-1 moves it to actor-3
        h.transfer(0, 2, false, 0); // actor-2 has no approval from actor-3: rejected
        h.operatorSeizes(0);

        h.warpNearBoundary(0, INTO_GRACE);
        assertEq(uint8(h.modelStatus(h.tokenAt(0))), uint8(SLDRegistry.Status.Grace));
        h.transfer(0, 0, true, 1); // forbidden in grace: rejected
        h.renew(0, 1, 2); // actor-2 pays the grace renewal

        h.warpNearBoundary(0, PAST_GRACE);
        assertEq(uint8(h.modelStatus(h.tokenAt(0))), uint8(SLDRegistry.Status.Released));
        h.register(0, 1, 1, 1); // actor-1 re-registers "studio"

        h.deposit(5e6);
        h.sweep();
        h.toggleTreasuryBlacklist(true);
        h.register(1, 1, 0, 0); // "alpha" still sells with a blacklisted treasury
        h.sweep(); // fails
        h.setTreasury(1);
        h.sweep(); // succeeds to the new treasury

        assertEq(h.mismatches(), 0, "model mismatch in fixed scenario");
        assertEq(h.registrations(), 3);
        assertEq(h.reRegistrations(), 1);
        assertEq(h.graceRenewals(), 1);
        assertEq(h.operatorTransfers(), 1);
        assertEq(h.transfers(), 2);
        assertEq(h.rejectedTransfers(), 2);
        assertEq(h.managerRecordWrites(), 1);
        assertEq(h.sweepsSucceeded(), 2);
        assertEq(h.sweepsFailed(), 1);
        assertEq(h.forbiddenTransfers(), 0);
    }

    function test_FixedPolicyScenarioReachesEveryPolicyPath() public {
        RegistryFactory factory = new RegistryFactory(address(usdc));
        SLDRegistry registry = SLDRegistry(factory.deployRegistry("testtld", operator, treasuries[0], 5e6));
        RegistryHandler h = _handlerFor(registry);

        h.setLengthPrices(4, 3, 5e6, 0, false); // lengths 1 to 3 closed, 4 and longer at 5 USDC
        h.register(3, 1, 0, 0); // "x" is closed: refused
        h.setPremium(3, 2e6, false, false); // premium price opens "x"
        h.setReservation(3, 1, false); // and reserves it for actor-1
        h.register(3, 1, 0, 0); // actor-0 for itself: refused
        h.register(3, 1, 2, 1); // actor-2 pays for actor-1
        h.setLengthPrices(2, 0, 1e6, 0, true); // a rising table is refused
        h.register(4, 1, 0, 0); // "community" sells at the last tier
        h.setPremium(4, 0, true, false); // premium closes "community" for its next registration
        h.renew(1, 1, 3); // the existing "community" still renews at its locked price

        assertEq(h.mismatches(), 0, "model mismatch in policy scenario");
        assertEq(h.closedRefusals(), 1);
        assertEq(h.reservationRefusals(), 1);
        assertEq(h.premiumRegistrations(), 1);
        assertEq(h.reservedRegistrations(), 1);
        assertEq(h.rejectedPriceTables(), 1);
        assertEq(h.registrations(), 2);
        assertEq(h.renewals(), 1);
        assertEq(registry.lockedPrice(h.tokenAt(0)), 2e6);
        assertEq(registry.lockedPrice(h.tokenAt(1)), 5e6);
    }

    function test_HandlerCatchesRegistryWithoutExpiryGuard() public {
        address implementation = address(new MutantRegistryNoTransferGuard());
        SLDRegistry mutant = SLDRegistry(Clones.clone(implementation));
        mutant.initialize("testtld", address(usdc), operator, treasuries[0], 5e6);
        RegistryHandler h = _handlerFor(mutant);

        h.register(0, 1, 0, 0);
        h.warpNearBoundary(0, INTO_GRACE);
        h.transfer(0, 0, true, 1); // the mutant lets an expired name move

        assertEq(h.forbiddenTransfers(), 1);
        assertGt(h.mismatches(), 0);
        assertEq(uint8(h.firstMismatch()), uint8(RegistryHandler.Mismatch.TransferOutcome));
    }
}
