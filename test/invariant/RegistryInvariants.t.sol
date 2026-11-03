// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";
import {RegistryFactory} from "../../src/RegistryFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {RegistryHandler} from "./RegistryHandler.sol";

/// SPEC section 10 invariants, checked after every step of random action
/// sequences driven by RegistryHandler.
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
        handler = new RegistryHandler(registry, usdc, operator, treasuries);
        targetContract(address(handler));
    }

    /// Logged once per run so coverage can be inspected with -vv.
    function afterInvariant() public view {
        console.log("registrations", handler.registrations(), "re-registrations", handler.reRegistrations());
        console.log("renewals", handler.renewals(), "in grace", handler.graceRenewals());
        console.log("transfers", handler.transfers(), "by approved operator", handler.operatorTransfers());
        console.log("manager record writes", handler.managerRecordWrites());
        console.log("sweeps ok", handler.sweepsSucceeded(), "failed", handler.sweepsFailed());
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

    /// No transfer or record change without the holder's applicable
    /// authorization, and the operator never gains any.
    function invariant_NoUnauthorizedActions() public view {
        assertFalse(handler.unauthorizedSuccess());
    }

    function invariant_RecordManagerClearedOnTransfer() public view {
        assertFalse(handler.managerSurvivedTransfer());
    }

    /// Ownership, locked price and the term cap match the ghost model.
    function invariant_TokensMatchModel() public view {
        uint256 maxRemaining = registry.MAX_REMAINING();
        for (uint256 i; i < handler.tokenCount(); ++i) {
            uint256 id = handler.tokenAt(i);
            SLDRegistry.Status status_ = registry.status(id);
            assertEq(registry.lockedPrice(id), handler.ghostLockedPrice(id));
            if (status_ == SLDRegistry.Status.Active) {
                assertEq(registry.ownerOf(id), handler.ghostOwner(id));
                assertEq(registry.effectiveOwner(id), handler.ghostOwner(id));
                assertLe(registry.expiresAt(id), block.timestamp + maxRemaining);
            } else if (status_ == SLDRegistry.Status.Grace) {
                assertEq(registry.registrant(id), handler.ghostOwner(id));
                assertEq(registry.effectiveOwner(id), address(0));
            } else {
                assertEq(registry.effectiveOwner(id), address(0));
                assertEq(registry.registrant(id), address(0));
            }
            if (status_ == SLDRegistry.Status.Superseded) {
                assertEq(registry.recordManager(id), address(0));
            }
        }
    }

    /// Each label has at most one live token, and it is the current
    /// generation recorded by the model.
    function invariant_OneLiveTokenPerLabel() public view {
        for (uint256 l; l < handler.labelCount(); ++l) {
            string memory label = handler.labelAt(l);
            bytes32 labelhash = keccak256(bytes(label));
            (uint256 current, uint64 generation,) = registry.currentToken(label);
            assertEq(generation, handler.ghostGeneration(labelhash));
            uint256 live;
            for (uint256 i; i < handler.tokenCount(); ++i) {
                uint256 id = handler.tokenAt(i);
                if (registry.tokenIdFor(labelhash, registry.generationOf(id)) != id) continue;
                SLDRegistry.Status status_ = registry.status(id);
                if (status_ != SLDRegistry.Status.Superseded && status_ != SLDRegistry.Status.Unknown) {
                    ++live;
                    assertEq(id, current);
                }
            }
            assertLe(live, 1);
        }
    }
}
