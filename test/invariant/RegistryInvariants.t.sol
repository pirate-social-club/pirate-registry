// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";
import {RegistryFactory} from "../../src/RegistryFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {RegistryHandler} from "./RegistryHandler.sol";

/// SPEC section 10 invariants, checked after every step of random action
/// sequences driven by RegistryHandler against its independent model.
contract RegistryInvariants is Test {
    SLDRegistry internal registry;
    MockUSDC internal usdc;
    RegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        RegistryFactory factory = new RegistryFactory(address(usdc));
        address operator = makeAddr("operator");
        address[] memory treasuries = new address[](3);
        treasuries[0] = makeAddr("treasury-0");
        treasuries[1] = makeAddr("treasury-1");
        treasuries[2] = makeAddr("treasury-2");
        registry = SLDRegistry(factory.deployRegistry("testtld", operator, treasuries[0], 5e6));
        handler = new RegistryHandler(registry, usdc, operator, treasuries, 5e6);
        targetContract(address(handler));
    }

    /// Logged once per run so coverage can be inspected with -vv. Required
    /// coverage is asserted deterministically in HandlerCoverage.t.sol.
    function afterInvariant() public view {
        console.log("registrations", handler.registrations(), "re-registrations", handler.reRegistrations());
        console.log("renewals", handler.renewals(), "in grace", handler.graceRenewals());
        console.log("transfers", handler.transfers(), "by approved operator", handler.operatorTransfers());
        console.log("rejected transfers", handler.rejectedTransfers());
        console.log("manager record writes", handler.managerRecordWrites());
        console.log("sweeps ok", handler.sweepsSucceeded(), "failed", handler.sweepsFailed());
        console.log("premium", handler.premiumRegistrations(), "reserved", handler.reservedRegistrations());
        console.log("refused: reserved", handler.reservationRefusals(), "closed", handler.closedRefusals());
    }

    /// Every contract outcome (success or revert) matched the model's
    /// permission for that action.
    function invariant_OutcomesMatchModel() public view {
        assertEq(handler.mismatches(), 0, "contract outcome differed from model");
    }

    /// Status and expiry match the independent model for every token.
    function invariant_LifecycleMatchesModel() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokenAt(i);
            assertEq(uint8(registry.status(id)), uint8(handler.modelStatus(id)), "status");
            assertEq(registry.expiresAt(id), handler.ghostExpiry(id), "expiry");
            assertEq(registry.lockedPrice(id), handler.ghostLockedPrice(id), "locked price");
        }
    }

    /// Quoted prices and reservations match the model's policy for every label.
    function invariant_PolicyMatchesModel() public view {
        for (uint256 l; l < handler.labelCount(); ++l) {
            string memory label = handler.labelAt(l);
            bytes32 labelhash = keccak256(bytes(label));
            assertEq(registry.priceOf(label), handler.modelPrice(labelhash, bytes(label).length), "price");
            assertEq(registry.reservedFor(label), handler.ghostReservation(labelhash), "reservation");
        }
    }

    /// Registry balance = payments + unsolicited deposits - sweeps.
    function invariant_BalanceAccounting() public view {
        assertEq(usdc.balanceOf(address(registry)), handler.paid() + handler.deposits() - handler.swept());
    }

    /// Everything swept reached a treasury.
    function invariant_SweptReachedTreasuries() public view {
        uint256 total;
        for (uint256 i; i < handler.treasuryCount(); ++i) {
            total += usdc.balanceOf(handler.treasuryAt(i));
        }
        assertEq(total, handler.swept());
    }

    /// Ownership views and the term cap agree with the model.
    function invariant_OwnershipMatchesModel() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokenAt(i);
            SLDRegistry.Status status_ = handler.modelStatus(id);
            if (status_ == SLDRegistry.Status.Active) {
                assertEq(registry.ownerOf(id), handler.ghostOwner(id));
                assertEq(registry.effectiveOwner(id), handler.ghostOwner(id));
                assertEq(registry.recordManager(id), handler.ghostManager(id));
                assertLe(registry.expiresAt(id), block.timestamp + 3650 days);
            } else if (status_ == SLDRegistry.Status.Grace) {
                assertEq(registry.registrant(id), handler.ghostOwner(id));
                assertEq(registry.effectiveOwner(id), address(0));
            } else {
                assertEq(registry.effectiveOwner(id), address(0));
                assertEq(registry.registrant(id), address(0));
            }
        }
    }

    /// Each label's current generation matches the model, and at most one
    /// token per label is not Superseded.
    function invariant_OneLiveTokenPerLabel() public view {
        for (uint256 l; l < handler.labelCount(); ++l) {
            string memory label = handler.labelAt(l);
            bytes32 labelhash = keccak256(bytes(label));
            (uint256 current, uint64 generation,) = registry.currentToken(label);
            assertEq(generation, handler.ghostGeneration(labelhash));
            uint256 live;
            for (uint256 i; i < handler.tokenCount(); ++i) {
                uint256 id = handler.tokenAt(i);
                if (handler.ghostLabelhash(id) != labelhash) continue;
                if (handler.modelStatus(id) != SLDRegistry.Status.Superseded) {
                    ++live;
                    assertEq(id, current);
                }
            }
            assertLe(live, 1);
        }
    }
}
