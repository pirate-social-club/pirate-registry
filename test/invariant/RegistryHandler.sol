// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";
import {RecordKeys} from "../../src/RecordKeys.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Drives random sequences of registry actions and keeps ghost state.
/// Ghosts change only when the registry call succeeds.
contract RegistryHandler is Test {
    SLDRegistry public immutable registry;
    MockUSDC public immutable usdc;
    address public immutable operator;

    address[] internal _actors;
    address[] internal _treasuries;
    string[] internal _labels;
    uint256[] internal _tokens;

    mapping(uint256 tokenId => address) public ghostOwner;
    mapping(uint256 tokenId => address) public ghostManager;
    mapping(uint256 tokenId => uint256) public ghostLockedPrice;
    mapping(bytes32 labelhash => uint64) public ghostGeneration;
    mapping(address owner => mapping(address operator => bool)) public ghostApprovedForAll;

    uint256 public paid;
    uint256 public deposits;
    uint256 public swept;

    bool public unauthorizedSuccess;
    bool public managerSurvivedTransfer;

    // Coverage counters: how often each path actually succeeded.
    uint256 public registrations;
    uint256 public reRegistrations;
    uint256 public renewals;
    uint256 public graceRenewals;
    uint256 public transfers;
    uint256 public operatorTransfers;
    uint256 public managerRecordWrites;
    uint256 public sweepsSucceeded;
    uint256 public sweepsFailed;

    constructor(SLDRegistry registry_, MockUSDC usdc_, address operator_, address[] memory treasuries_) {
        registry = registry_;
        usdc = usdc_;
        operator = operator_;
        _treasuries = treasuries_;
        _actors.push(makeAddr("actor-0"));
        _actors.push(makeAddr("actor-1"));
        _actors.push(makeAddr("actor-2"));
        _actors.push(makeAddr("actor-3"));
        _labels.push("studio");
        _labels.push("alpha");
        _labels.push("beta");
        for (uint256 i; i < _actors.length; ++i) {
            usdc.mint(_actors[i], 1e15);
            vm.prank(_actors[i]);
            usdc.approve(address(registry_), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------
    // Accessors for invariants
    // ------------------------------------------------------------------

    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    function tokenAt(uint256 i) external view returns (uint256) {
        return _tokens[i];
    }

    function labelCount() external view returns (uint256) {
        return _labels.length;
    }

    function labelAt(uint256 i) external view returns (string memory) {
        return _labels[i];
    }

    function treasuryCount() external view returns (uint256) {
        return _treasuries.length;
    }

    function treasuryAt(uint256 i) external view returns (address) {
        return _treasuries[i];
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function register(uint256 labelSeed, uint8 yearsSeed, uint256 buyerSeed, uint256 recipientSeed) external {
        string memory label = _labels[labelSeed % _labels.length];
        uint8 years_ = uint8(bound(yearsSeed, 1, 5));
        address buyer = _actor(buyerSeed);
        address recipient = _actor(recipientSeed);
        uint256 price = registry.annualPrice();
        vm.prank(buyer);
        try registry.register(label, years_, recipient, type(uint256).max, block.timestamp) returns (uint256 id) {
            paid += price * years_;
            _tokens.push(id);
            ghostOwner[id] = recipient;
            ghostLockedPrice[id] = price;
            ghostGeneration[keccak256(bytes(label))] += 1;
            ++registrations;
            if (ghostGeneration[keccak256(bytes(label))] > 1) ++reRegistrations;
        } catch {}
    }

    function renew(uint256 tokenSeed, uint8 yearsSeed, uint256 payerSeed) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        uint8 years_ = uint8(bound(yearsSeed, 1, 5));
        bool inGrace = registry.status(id) == SLDRegistry.Status.Grace;
        vm.prank(_actor(payerSeed));
        try registry.renew(id, years_, type(uint256).max, block.timestamp) {
            paid += ghostLockedPrice[id] * years_;
            ++renewals;
            if (inGrace) ++graceRenewals;
        } catch {}
    }

    function transfer(uint256 tokenSeed, uint256 callerSeed, bool asHolder, uint256 toSeed) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address from = ghostOwner[id];
        address caller = asHolder ? from : _actor(callerSeed);
        address to = _actor(toSeed);
        bool authorized = caller == from || ghostApprovedForAll[from][caller];
        vm.prank(caller);
        try registry.transferFrom(from, to, id) {
            if (!authorized) unauthorizedSuccess = true;
            ++transfers;
            if (caller != from) ++operatorTransfers;
            ghostOwner[id] = to;
            ghostManager[id] = address(0);
            if (registry.recordManager(id) != address(0)) managerSurvivedTransfer = true;
        } catch {}
    }

    /// The holder approves an operator for the collection, then that operator
    /// transfers. Succeeds whenever the token is Active.
    function transferAsApprovedOperator(uint256 tokenSeed, uint256 operatorSeed, uint256 toSeed) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address from = ghostOwner[id];
        address approvedOperator = _actor(operatorSeed);
        if (approvedOperator == from) return;
        vm.prank(from);
        registry.setApprovalForAll(approvedOperator, true);
        ghostApprovedForAll[from][approvedOperator] = true;
        address to = _actor(toSeed);
        vm.prank(approvedOperator);
        try registry.transferFrom(from, to, id) {
            ++transfers;
            ++operatorTransfers;
            ghostOwner[id] = to;
            ghostManager[id] = address(0);
            if (registry.recordManager(id) != address(0)) managerSurvivedTransfer = true;
        } catch {}
    }

    function setApprovalForAll(uint256 ownerSeed, uint256 operatorSeed, bool approved) external {
        address owner = _actor(ownerSeed);
        address approvedOperator = _actor(operatorSeed);
        if (owner == approvedOperator) return;
        vm.prank(owner);
        registry.setApprovalForAll(approvedOperator, approved);
        ghostApprovedForAll[owner][approvedOperator] = approved;
    }

    function setRecordManager(uint256 tokenSeed, uint256 managerSeed) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address manager = _actor(managerSeed);
        vm.prank(ghostOwner[id]);
        try registry.setRecordManager(id, manager) {
            ghostManager[id] = manager;
        } catch {}
    }

    function setRecord(uint256 tokenSeed, uint256 callerSeed, bytes32 key) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address caller = _actor(callerSeed);
        bool authorized = caller == ghostOwner[id] || (ghostManager[id] != address(0) && caller == ghostManager[id]);
        vm.prank(caller);
        try registry.setRecord(id, key, hex"01") {
            if (!authorized) unauthorizedSuccess = true;
            if (caller != ghostOwner[id]) ++managerRecordWrites;
        } catch {}
    }

    /// The operator, who is never an actor and never approved, tries to take
    /// or edit a name.
    function operatorSeizes(uint256 tokenSeed) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address from = ghostOwner[id];
        vm.startPrank(operator);
        try registry.transferFrom(from, operator, id) {
            unauthorizedSuccess = true;
        } catch {}
        try registry.setRecord(id, RecordKeys.text("url"), hex"ff") {
            unauthorizedSuccess = true;
        } catch {}
        try registry.setRecordManager(id, operator) {
            unauthorizedSuccess = true;
        } catch {}
        vm.stopPrank();
    }

    /// Jump to just before expiry, into grace, or just past grace for one
    /// token, so boundary states are explored often.
    function warpNearBoundary(uint256 tokenSeed, uint32 offsetSeed) external {
        if (_tokens.length == 0) return;
        uint256 expiry = registry.expiresAt(_tokens[tokenSeed % _tokens.length]);
        uint256 target = expiry - 2 days + bound(offsetSeed, 0, registry.GRACE() + 4 days);
        if (target > block.timestamp) vm.warp(target);
    }

    /// The current record manager, if any, writes a record.
    function managerWrites(uint256 tokenSeed, bytes32 key) external {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address manager = ghostManager[id];
        if (manager == address(0) || manager == ghostOwner[id]) return;
        vm.prank(manager);
        try registry.setRecord(id, key, hex"02") {
            ++managerRecordWrites;
        } catch {}
    }

    /// Mixed step sizes: fine steps near boundaries, medium steps, and jumps
    /// long enough for names to pass expiry and grace without renewal.
    function warp(uint32 secondsSeed, uint8 scale) external {
        uint256 maxStep = scale % 3 == 0 ? 31 days : scale % 3 == 1 ? 400 days : 4000 days;
        vm.warp(block.timestamp + bound(secondsSeed, 0, maxStep));
    }

    function sweep() external {
        uint256 balance = usdc.balanceOf(address(registry));
        try registry.sweep() {
            swept += balance;
            ++sweepsSucceeded;
        } catch {
            ++sweepsFailed;
        }
    }

    function deposit(uint64 amountSeed) external {
        uint256 amount = bound(amountSeed, 0, 1_000e6);
        usdc.mint(address(registry), amount);
        deposits += amount;
    }

    function setPrice(uint64 priceSeed) external {
        vm.prank(operator);
        registry.setPrice(bound(priceSeed, 0, 100e6));
    }

    function setTreasury(uint256 treasurySeed) external {
        vm.prank(operator);
        registry.setTreasury(_treasuries[treasurySeed % _treasuries.length]);
    }

    function toggleTreasuryBlacklist(bool value) external {
        usdc.setBlacklisted(registry.treasury(), value);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }
}
