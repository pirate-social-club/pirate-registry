// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SLDRegistry} from "../../src/SLDRegistry.sol";
import {RecordKeys} from "../../src/RecordKeys.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Drives random sequences of registry actions against an independent
/// model of the lifecycle. The model's constants and status rules are written
/// here from SPEC section 6.5, not read from the contract. Before each action
/// the handler decides whether the model permits it; afterwards it records a
/// mismatch whenever the contract's outcome differs, in either direction.
contract RegistryHandler is Test {
    // Model constants (SPEC 6.5), deliberately not read from the registry.
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant GRACE = 30 days;
    uint256 internal constant MAX_REMAINING = 3650 days;
    // Sale policy model (SPEC 6.2), likewise written here.
    uint256 internal constant NOT_FOR_SALE = type(uint256).max;

    enum Mismatch {
        None,
        RegisterOutcome,
        RenewOutcome,
        TransferOutcome,
        OperatorTransferOutcome,
        RecordOutcome,
        ManagerOutcome,
        OperatorSeizure,
        ManagerSurvivedTransfer,
        PolicyOutcome
    }

    SLDRegistry public immutable registry;
    MockUSDC public immutable usdc;
    address public immutable operator;

    address[] internal _actors;
    address[] internal _treasuries;
    string[] internal _labels;
    uint256[] internal _tokens;

    // Independent model.
    mapping(uint256 tokenId => address) public ghostOwner;
    mapping(uint256 tokenId => address) public ghostManager;
    mapping(uint256 tokenId => uint256) public ghostLockedPrice;
    mapping(uint256 tokenId => uint256) public ghostExpiry;
    mapping(uint256 tokenId => uint64) public ghostTokenGeneration;
    mapping(uint256 tokenId => bytes32) public ghostLabelhash;
    mapping(bytes32 labelhash => uint64) public ghostGeneration;
    mapping(address owner => mapping(address operator => bool)) public ghostApprovedForAll;
    uint256[] internal _ghostLengthPrices;
    mapping(bytes32 labelhash => bool) public ghostPremiumSet;
    mapping(bytes32 labelhash => uint256) public ghostPremium;
    mapping(bytes32 labelhash => address) public ghostReservation;

    uint256 public paid;
    uint256 public deposits;
    uint256 public swept;

    // Mismatch accounting. `mismatches` must stay zero.
    uint256 public mismatches;
    Mismatch public firstMismatch;
    uint256 public forbiddenTransfers;

    // Coverage counters: how often each path actually succeeded.
    uint256 public registrations;
    uint256 public reRegistrations;
    uint256 public renewals;
    uint256 public graceRenewals;
    uint256 public transfers;
    uint256 public operatorTransfers;
    uint256 public rejectedTransfers;
    uint256 public managerRecordWrites;
    uint256 public sweepsSucceeded;
    uint256 public sweepsFailed;
    uint256 public premiumRegistrations;
    uint256 public reservedRegistrations;
    uint256 public reservationRefusals;
    uint256 public closedRefusals;
    uint256 public rejectedPriceTables;

    constructor(
        SLDRegistry registry_,
        MockUSDC usdc_,
        address operator_,
        address[] memory treasuries_,
        uint256 initialPrice
    ) {
        registry = registry_;
        usdc = usdc_;
        operator = operator_;
        _treasuries = treasuries_;
        _ghostLengthPrices.push(initialPrice);
        _actors.push(makeAddr("actor-0"));
        _actors.push(makeAddr("actor-1"));
        _actors.push(makeAddr("actor-2"));
        _actors.push(makeAddr("actor-3"));
        _labels.push("studio");
        _labels.push("alpha");
        _labels.push("beta");
        _labels.push("x");
        _labels.push("community");
        for (uint256 i; i < _actors.length; ++i) {
            usdc.mint(_actors[i], 1e15);
            vm.prank(_actors[i]);
            usdc.approve(address(registry_), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------
    // Model
    // ------------------------------------------------------------------

    function modelStatus(uint256 id) public view returns (SLDRegistry.Status) {
        if (ghostTokenGeneration[id] == 0) return SLDRegistry.Status.Unknown;
        if (ghostGeneration[ghostLabelhash[id]] != ghostTokenGeneration[id]) return SLDRegistry.Status.Superseded;
        if (block.timestamp < ghostExpiry[id]) return SLDRegistry.Status.Active;
        if (block.timestamp < ghostExpiry[id] + GRACE) return SLDRegistry.Status.Grace;
        return SLDRegistry.Status.Released;
    }

    function _modelLabelAvailable(bytes32 labelhash) internal view returns (bool) {
        uint64 generation = ghostGeneration[labelhash];
        if (generation == 0) return true;
        return modelStatus(registry.tokenIdFor(labelhash, generation)) == SLDRegistry.Status.Released;
    }

    /// Premium price if set, otherwise the length tier; the last tier covers
    /// every longer label.
    function modelPrice(bytes32 labelhash, uint256 length) public view returns (uint256) {
        if (ghostPremiumSet[labelhash]) return ghostPremium[labelhash];
        uint256 tiers = _ghostLengthPrices.length;
        return _ghostLengthPrices[length < tiers ? length - 1 : tiers - 1];
    }

    function _check(bool expected, bool actual, Mismatch kind) internal {
        if (expected == actual) return;
        if (mismatches == 0) firstMismatch = kind;
        ++mismatches;
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

    function actor(uint256 i) external view returns (address) {
        return _actors[i % _actors.length];
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function register(uint256 labelSeed, uint8 yearsSeed, uint256 buyerSeed, uint256 recipientSeed) public {
        string memory label = _labels[labelSeed % _labels.length];
        bytes32 labelhash = keccak256(bytes(label));
        uint8 years_ = uint8(bound(yearsSeed, 1, 5));
        address recipient = _actor(recipientSeed);
        uint256 price = modelPrice(labelhash, bytes(label).length);
        address claimant = ghostReservation[labelhash];
        bool available = _modelLabelAvailable(labelhash);
        bool reservedElsewhere = claimant != address(0) && claimant != recipient;
        bool allowed = available && !reservedElsewhere && price != NOT_FOR_SALE;
        uint64 previous = ghostGeneration[labelhash];

        vm.prank(_actor(buyerSeed));
        try registry.register(label, years_, recipient, type(uint256).max, block.timestamp) returns (uint256 id) {
            _check(allowed, true, Mismatch.RegisterOutcome);
            if (previous != 0) ghostManager[registry.tokenIdFor(labelhash, previous)] = address(0);
            uint64 generation = previous + 1;
            ghostGeneration[labelhash] = generation;
            ghostTokenGeneration[id] = generation;
            ghostLabelhash[id] = labelhash;
            ghostExpiry[id] = block.timestamp + uint256(years_) * YEAR;
            ghostOwner[id] = recipient;
            ghostLockedPrice[id] = price;
            ghostManager[id] = address(0);
            paid += price * years_;
            _tokens.push(id);
            ++registrations;
            if (generation > 1) ++reRegistrations;
            if (ghostPremiumSet[labelhash]) ++premiumRegistrations;
            if (claimant != address(0)) ++reservedRegistrations;
        } catch {
            _check(allowed, false, Mismatch.RegisterOutcome);
            if (available && reservedElsewhere) ++reservationRefusals;
            else if (available && price == NOT_FOR_SALE) ++closedRefusals;
        }
    }

    function renew(uint256 tokenSeed, uint8 yearsSeed, uint256 payerSeed) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        uint8 years_ = uint8(bound(yearsSeed, 1, 5));
        SLDRegistry.Status status_ = modelStatus(id);
        uint256 newExpiry = ghostExpiry[id] + uint256(years_) * YEAR;
        bool allowed = (status_ == SLDRegistry.Status.Active || status_ == SLDRegistry.Status.Grace)
            && newExpiry <= block.timestamp + MAX_REMAINING;

        vm.prank(_actor(payerSeed));
        try registry.renew(id, years_, type(uint256).max, block.timestamp) {
            _check(allowed, true, Mismatch.RenewOutcome);
            ghostExpiry[id] = newExpiry;
            paid += ghostLockedPrice[id] * years_;
            ++renewals;
            if (status_ == SLDRegistry.Status.Grace) ++graceRenewals;
        } catch {
            _check(allowed, false, Mismatch.RenewOutcome);
        }
    }

    /// The caller is either the modelled holder or a random actor.
    function transfer(uint256 tokenSeed, uint256 callerSeed, bool asHolder, uint256 toSeed) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address from = ghostOwner[id];
        address caller = asHolder ? from : _actor(callerSeed);
        _transferAs(id, caller, _actor(toSeed), Mismatch.TransferOutcome);
    }

    /// The holder approves an operator for the collection, then that operator
    /// transfers.
    function transferAsApprovedOperator(uint256 tokenSeed, uint256 operatorSeed, uint256 toSeed) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address from = ghostOwner[id];
        address approvedOperator = _actor(operatorSeed);
        if (approvedOperator == from) return;
        vm.prank(from);
        registry.setApprovalForAll(approvedOperator, true);
        ghostApprovedForAll[from][approvedOperator] = true;
        _transferAs(id, approvedOperator, _actor(toSeed), Mismatch.OperatorTransferOutcome);
    }

    function _transferAs(uint256 id, address caller, address to, Mismatch kind) internal {
        address from = ghostOwner[id];
        bool active = modelStatus(id) == SLDRegistry.Status.Active;
        bool authorized = caller == from || ghostApprovedForAll[from][caller];
        bool allowed = active && authorized;

        vm.prank(caller);
        try registry.transferFrom(from, to, id) {
            _check(allowed, true, kind);
            if (!active) ++forbiddenTransfers;
            ghostOwner[id] = to;
            ghostManager[id] = address(0);
            if (registry.recordManager(id) != address(0)) _check(true, false, Mismatch.ManagerSurvivedTransfer);
            ++transfers;
            if (caller != from) ++operatorTransfers;
        } catch {
            _check(allowed, false, kind);
            ++rejectedTransfers;
        }
    }

    function setApprovalForAll(uint256 ownerSeed, uint256 operatorSeed, bool approved) public {
        address owner = _actor(ownerSeed);
        address approvedOperator = _actor(operatorSeed);
        if (owner == approvedOperator) return;
        vm.prank(owner);
        registry.setApprovalForAll(approvedOperator, approved);
        ghostApprovedForAll[owner][approvedOperator] = approved;
    }

    function setRecordManager(uint256 tokenSeed, uint256 managerSeed) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address manager = _actor(managerSeed);
        bool allowed = modelStatus(id) == SLDRegistry.Status.Active;
        vm.prank(ghostOwner[id]);
        try registry.setRecordManager(id, manager) {
            _check(allowed, true, Mismatch.ManagerOutcome);
            ghostManager[id] = manager;
        } catch {
            _check(allowed, false, Mismatch.ManagerOutcome);
        }
    }

    function setRecord(uint256 tokenSeed, uint256 callerSeed, bytes32 key) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        _writeRecord(id, _actor(callerSeed), key);
    }

    /// The current record manager, if any, writes a record.
    function managerWrites(uint256 tokenSeed, bytes32 key) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address manager = ghostManager[id];
        if (manager == address(0) || manager == ghostOwner[id]) return;
        _writeRecord(id, manager, key);
    }

    function _writeRecord(uint256 id, address caller, bytes32 key) internal {
        bool authorized = caller == ghostOwner[id] || (ghostManager[id] != address(0) && caller == ghostManager[id]);
        bool allowed = authorized && modelStatus(id) == SLDRegistry.Status.Active;
        vm.prank(caller);
        try registry.setRecord(id, key, hex"01") {
            _check(allowed, true, Mismatch.RecordOutcome);
            if (caller != ghostOwner[id]) ++managerRecordWrites;
        } catch {
            _check(allowed, false, Mismatch.RecordOutcome);
        }
    }

    /// The operator, who is never an actor and never approved, tries to take
    /// or edit a name. Every attempt must fail.
    function operatorSeizes(uint256 tokenSeed) public {
        if (_tokens.length == 0) return;
        uint256 id = _tokens[tokenSeed % _tokens.length];
        address from = ghostOwner[id];
        vm.startPrank(operator);
        try registry.transferFrom(from, operator, id) {
            _check(false, true, Mismatch.OperatorSeizure);
        } catch {}
        try registry.setRecord(id, RecordKeys.text("url"), hex"ff") {
            _check(false, true, Mismatch.OperatorSeizure);
        } catch {}
        try registry.setRecordManager(id, operator) {
            _check(false, true, Mismatch.OperatorSeizure);
        } catch {}
        vm.stopPrank();
    }

    /// Mixed step sizes: fine steps near boundaries, medium steps, and jumps
    /// long enough for names to pass expiry and grace without renewal.
    function warp(uint32 secondsSeed, uint8 scale) public {
        uint256 maxStep = scale % 3 == 0 ? 31 days : scale % 3 == 1 ? 400 days : 4000 days;
        vm.warp(block.timestamp + bound(secondsSeed, 0, maxStep));
    }

    /// Jump to just before expiry, into grace, or just past grace for one
    /// token, using the model's expiry.
    function warpNearBoundary(uint256 tokenSeed, uint32 offsetSeed) public {
        if (_tokens.length == 0) return;
        uint256 expiry = ghostExpiry[_tokens[tokenSeed % _tokens.length]];
        uint256 target = expiry - 2 days + bound(offsetSeed, 0, GRACE + 4 days);
        if (target > block.timestamp) vm.warp(target);
    }

    function sweep() public {
        uint256 balance = usdc.balanceOf(address(registry));
        try registry.sweep() {
            swept += balance;
            ++sweepsSucceeded;
        } catch {
            ++sweepsFailed;
        }
    }

    function deposit(uint64 amountSeed) public {
        uint256 amount = bound(amountSeed, 0, 1_000e6);
        usdc.mint(address(registry), amount);
        deposits += amount;
    }

    function setPrice(uint64 priceSeed) public {
        uint256 price = bound(priceSeed, 0, 100e6);
        vm.prank(operator);
        registry.setPrice(price);
        delete _ghostLengthPrices;
        _ghostLengthPrices.push(price);
    }

    /// A non-increasing table of 1 to 4 tiers whose shortest lengths may be
    /// closed, or, when `rising`, a table whose last tier rises and must be
    /// refused.
    function setLengthPrices(uint8 tiersSeed, uint8 closedSeed, uint64 baseSeed, uint32 stepSeed, bool rising) public {
        uint256 tiers = bound(tiersSeed, 1, 4);
        uint256 closed = bound(closedSeed, 0, tiers - 1);
        uint256 base = bound(baseSeed, 0, 100e6);
        uint256 step = bound(stepSeed, 0, 10e6);
        uint256[] memory prices = new uint256[](tiers);
        for (uint256 i; i < tiers; ++i) {
            prices[i] = i < closed ? NOT_FOR_SALE : base + (tiers - 1 - i) * step;
        }
        bool valid = true;
        if (rising && tiers > 1 && prices[tiers - 2] != NOT_FOR_SALE) {
            prices[tiers - 1] = prices[tiers - 2] + 1;
            valid = false;
        }
        vm.prank(operator);
        try registry.setLengthPrices(prices) {
            _check(valid, true, Mismatch.PolicyOutcome);
            _ghostLengthPrices = prices;
        } catch {
            _check(valid, false, Mismatch.PolicyOutcome);
            ++rejectedPriceTables;
        }
    }

    function setPremium(uint256 labelSeed, uint64 priceSeed, bool closed, bool clear) public {
        string[] memory labels = new string[](1);
        labels[0] = _labels[labelSeed % _labels.length];
        bytes32 labelhash = keccak256(bytes(labels[0]));
        vm.startPrank(operator);
        if (clear) {
            try registry.clearPremiumPrices(labels) {
                ghostPremiumSet[labelhash] = false;
                ghostPremium[labelhash] = 0;
            } catch {
                _check(true, false, Mismatch.PolicyOutcome);
            }
        } else {
            uint256[] memory prices = new uint256[](1);
            prices[0] = closed ? NOT_FOR_SALE : bound(priceSeed, 0, 100e6);
            try registry.setPremiumPrices(labels, prices) {
                ghostPremiumSet[labelhash] = true;
                ghostPremium[labelhash] = prices[0];
            } catch {
                _check(true, false, Mismatch.PolicyOutcome);
            }
        }
        vm.stopPrank();
    }

    function setReservation(uint256 labelSeed, uint256 claimantSeed, bool clear) public {
        string[] memory labels = new string[](1);
        labels[0] = _labels[labelSeed % _labels.length];
        address[] memory claimants = new address[](1);
        claimants[0] = clear ? address(0) : _actor(claimantSeed);
        vm.prank(operator);
        try registry.setReservations(labels, claimants) {
            ghostReservation[keccak256(bytes(labels[0]))] = claimants[0];
        } catch {
            _check(true, false, Mismatch.PolicyOutcome);
        }
    }

    function setTreasury(uint256 treasurySeed) public {
        vm.prank(operator);
        registry.setTreasury(_treasuries[treasurySeed % _treasuries.length]);
    }

    function toggleTreasuryBlacklist(bool value) public {
        usdc.setBlacklisted(registry.treasury(), value);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }
}
