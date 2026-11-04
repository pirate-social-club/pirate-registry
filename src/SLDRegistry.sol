// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Labels} from "./Labels.sol";

/// @title SLDRegistry
/// @notice One registry of second-level names under one Handshake TLD. Each
/// deployment is an EIP-1167 clone of a single implementation with no upgrade
/// path. Deploying a registry confers no authority over the TLD; only the
/// TLD's Handshake `_evm` record does (SPEC section 4).
///
/// Sale policy (SPEC section 6.2) follows the model of HNS.ID's
/// DefaultRegistrationStrategy (namebasehq/handshake-contracts, MIT): an annual
/// price per label length, a premium price per label and a reservation per
/// label for one claimant. Policy is read only when a new generation is
/// registered; it never changes an existing generation's price, expiry, owner
/// or records.
contract SLDRegistry is ERC721Upgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Status {
        Unknown,
        Active,
        Grace,
        Released,
        Superseded
    }

    struct TokenState {
        bytes32 labelhash;
        uint64 generation;
        uint64 expiry;
        uint256 lockedPrice;
    }

    uint16 public constant PROTOCOL_VERSION = 2;
    uint256 public constant YEAR = 365 days;
    uint256 public constant GRACE = 30 days;
    uint256 public constant MAX_PURCHASE_YEARS = 5;
    uint256 public constant MAX_REMAINING = 3650 days;
    uint256 public constant MAX_RECORD_BYTES = 1024;
    /// @notice A price entry that closes new registrations for its labels.
    uint256 public constant NOT_FOR_SALE = type(uint256).max;
    /// @notice Length tiers: entry i prices labels of length i + 1, and the
    /// last entry prices every longer label.
    uint256 public constant MAX_LENGTH_TIERS = 10;

    string private _tld;
    IERC20 private _paymentToken;
    address private _factory;

    address public admin;
    address public pendingAdmin;
    address public treasury;
    uint256[] private _lengthPrices;

    mapping(bytes32 labelhash => uint64) private _currentGeneration;
    mapping(uint256 tokenId => TokenState) private _tokens;
    mapping(uint256 tokenId => string) private _labels;
    mapping(uint256 tokenId => address) private _recordManagers;
    mapping(uint256 tokenId => mapping(bytes32 key => bytes)) private _records;
    mapping(bytes32 labelhash => bool) private _premiumSet;
    mapping(bytes32 labelhash => uint256) private _premiumPrice;
    mapping(bytes32 labelhash => address) private _reservations;

    event Registered(
        bytes32 indexed labelhash,
        string label,
        uint256 indexed tokenId,
        uint64 generation,
        address indexed recipient,
        uint64 expiry,
        uint256 lockedPrice
    );
    event Renewed(uint256 indexed tokenId, uint64 expiry, address indexed payer, uint256 cost);
    event RecordSet(uint256 indexed tokenId, bytes32 indexed key, bytes value);
    event RecordManagerSet(uint256 indexed tokenId, address indexed manager);
    event LengthPricesChanged(uint256[] prices);
    event PremiumPriceSet(bytes32 indexed labelhash, string label, uint256 price);
    event PremiumPriceCleared(bytes32 indexed labelhash, string label);
    event ReservationSet(bytes32 indexed labelhash, string label, address indexed claimant);
    event TreasuryChanged(address indexed treasury);
    event Swept(address indexed treasury, uint256 amount);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error InvalidLabel();
    error InvalidYears();
    error ZeroAddress();
    error InvalidTreasury();
    error DeadlinePassed();
    error CostAboveMax(uint256 cost, uint256 maxCost);
    error Unavailable();
    error NotRenewable(Status status);
    error TermTooLong();
    error NotActive(uint256 tokenId);
    error NotAuthorized();
    error RecordTooLarge();
    error NotForSale();
    error Reserved(address claimant);
    error InvalidPrices();
    error LengthMismatch();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory in the same transaction that creates
    /// the clone. Records the caller as the registry's factory.
    function initialize(
        string calldata tld_,
        address paymentToken_,
        address admin_,
        address treasury_,
        uint256 annualPrice_
    ) external initializer {
        if (!Labels.isValid(bytes(tld_))) revert InvalidLabel();
        if (paymentToken_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        __ERC721_init(string.concat(".", tld_), tld_);
        _tld = tld_;
        _paymentToken = IERC20(paymentToken_);
        _factory = msg.sender;
        admin = admin_;
        _setTreasury(treasury_);
        _setLengthPrices(_single(annualPrice_));
        emit AdminTransferred(address(0), admin_);
    }

    // ---------------------------------------------------------------------
    // Buyer actions
    // ---------------------------------------------------------------------

    /// @notice Register an unregistered or Released label for 1 to 5 years.
    /// A reserved label goes only to its claimant as `recipient`; the payer may
    /// be anyone. State is written before payment and before the receiver
    /// callback.
    function register(string calldata label, uint8 years_, address recipient, uint256 maxCost, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (years_ == 0 || years_ > MAX_PURCHASE_YEARS) revert InvalidYears();
        if (recipient == address(0)) revert ZeroAddress();

        tokenId = _claim(label, years_, recipient);
        TokenState storage token = _tokens[tokenId];
        uint256 cost = token.lockedPrice * years_;
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);

        emit Registered(token.labelhash, label, tokenId, token.generation, recipient, token.expiry, token.lockedPrice);
        if (cost != 0) _paymentToken.safeTransferFrom(msg.sender, address(this), cost);
        _safeMint(recipient, tokenId);
    }

    /// @dev Validates the label, applies the sale policy, retires a Released
    /// previous generation, and writes the new generation's state at the
    /// current price for this label.
    function _claim(string calldata label, uint8 years_, address recipient) private returns (uint256 tokenId) {
        bytes memory labelBytes = bytes(label);
        if (!Labels.isValid(labelBytes)) revert InvalidLabel();
        bytes32 labelhash = keccak256(labelBytes);
        uint64 previousGeneration = _currentGeneration[labelhash];
        uint256 previousTokenId = 0;
        if (previousGeneration != 0) {
            previousTokenId = tokenIdFor(labelhash, previousGeneration);
            if (_status(previousTokenId) != Status.Released) revert Unavailable();
        }
        address claimant = _reservations[labelhash];
        if (claimant != address(0) && claimant != recipient) revert Reserved(claimant);
        uint256 price = _annualPriceFor(labelhash, labelBytes.length);
        if (price == NOT_FOR_SALE) revert NotForSale();

        uint64 generation = previousGeneration + 1;
        tokenId = tokenIdFor(labelhash, generation);
        _currentGeneration[labelhash] = generation;
        _tokens[tokenId] = TokenState({
            labelhash: labelhash,
            generation: generation,
            expiry: uint64(block.timestamp + uint256(years_) * YEAR),
            lockedPrice: price
        });
        _labels[tokenId] = label;
        if (previousGeneration != 0) _retire(previousTokenId);
    }

    /// @notice Extend an Active or Grace registration at its locked price.
    /// Anyone may pay. The new expiry extends from the old expiry.
    function renew(uint256 tokenId, uint8 years_, uint256 maxCost, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (years_ == 0 || years_ > MAX_PURCHASE_YEARS) revert InvalidYears();
        Status status_ = _status(tokenId);
        if (status_ != Status.Active && status_ != Status.Grace) revert NotRenewable(status_);

        TokenState storage token = _tokens[tokenId];
        uint256 newExpiry = uint256(token.expiry) + uint256(years_) * YEAR;
        if (newExpiry > block.timestamp + MAX_REMAINING) revert TermTooLong();
        uint256 cost = token.lockedPrice * years_;
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);

        token.expiry = uint64(newExpiry);
        emit Renewed(tokenId, uint64(newExpiry), msg.sender, cost);
        if (cost != 0) _paymentToken.safeTransferFrom(msg.sender, address(this), cost);
    }

    /// @notice Set or delete (empty value) a record. Holder or the token's
    /// current record manager only; NFT approvals grant no record rights.
    function setRecord(uint256 tokenId, bytes32 key, bytes calldata value) external {
        if (_status(tokenId) != Status.Active) revert NotActive(tokenId);
        if (msg.sender != _ownerOf(tokenId) && msg.sender != _recordManagers[tokenId]) revert NotAuthorized();
        if (value.length > MAX_RECORD_BYTES) revert RecordTooLarge();
        if (value.length == 0) {
            delete _records[tokenId][key];
        } else {
            _records[tokenId][key] = value;
        }
        emit RecordSet(tokenId, key, value);
    }

    /// @notice Appoint one record manager for this token. It is cleared on
    /// every transfer and on retirement.
    function setRecordManager(uint256 tokenId, address manager) external {
        if (_status(tokenId) != Status.Active) revert NotActive(tokenId);
        if (msg.sender != _ownerOf(tokenId)) revert NotAuthorized();
        _recordManagers[tokenId] = manager;
        emit RecordManagerSet(tokenId, manager);
    }

    /// @notice Forward the registry's whole payment-token balance to the
    /// current treasury. Callable by anyone. Purchases never depend on it.
    function sweep() external nonReentrant {
        uint256 amount = _paymentToken.balanceOf(address(this));
        address destination = treasury;
        emit Swept(destination, amount);
        if (amount != 0) _paymentToken.safeTransfer(destination, amount);
    }

    // ---------------------------------------------------------------------
    // Operator powers (SPEC section 6.2): sale policy for new registrations,
    // treasury and admin handoff.
    // ---------------------------------------------------------------------

    /// @notice One annual price for every label length. Shorthand for a
    /// one-entry `setLengthPrices`.
    function setPrice(uint256 annualPrice_) external onlyAdmin {
        _setLengthPrices(_single(annualPrice_));
    }

    /// @notice Annual price by label length: `prices[i]` applies to labels of
    /// length `i + 1` and the last entry to every longer label. 1 to 10
    /// entries, never rising with length. `NOT_FOR_SALE` closes a length.
    function setLengthPrices(uint256[] calldata prices) external onlyAdmin {
        _setLengthPrices(prices);
    }

    /// @notice Per-label annual prices that override the length table. Zero
    /// is a valid price; `NOT_FOR_SALE` closes the label.
    function setPremiumPrices(string[] calldata labels, uint256[] calldata prices) external onlyAdmin {
        if (labels.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < labels.length; ++i) {
            bytes32 labelhash = _validLabelhash(labels[i]);
            _premiumSet[labelhash] = true;
            _premiumPrice[labelhash] = prices[i];
            emit PremiumPriceSet(labelhash, labels[i], prices[i]);
        }
    }

    function clearPremiumPrices(string[] calldata labels) external onlyAdmin {
        for (uint256 i; i < labels.length; ++i) {
            bytes32 labelhash = _validLabelhash(labels[i]);
            delete _premiumSet[labelhash];
            delete _premiumPrice[labelhash];
            emit PremiumPriceCleared(labelhash, labels[i]);
        }
    }

    /// @notice Reserve labels for one claimant each, or release a reservation
    /// with the zero address. A reservation applies only when the label is
    /// next registered; it never affects a current Active or Grace name.
    function setReservations(string[] calldata labels, address[] calldata claimants) external onlyAdmin {
        if (labels.length != claimants.length) revert LengthMismatch();
        for (uint256 i; i < labels.length; ++i) {
            bytes32 labelhash = _validLabelhash(labels[i]);
            _reservations[labelhash] = claimants[i];
            emit ReservationSet(labelhash, labels[i], claimants[i]);
        }
    }

    function setTreasury(address treasury_) external onlyAdmin {
        _setTreasury(treasury_);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAuthorized();
        address previous = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function tld() external view returns (string memory) {
        return _tld;
    }

    function paymentToken() external view returns (address) {
        return address(_paymentToken);
    }

    function factory() external view returns (address) {
        return _factory;
    }

    function lengthPrices() external view returns (uint256[] memory) {
        return _lengthPrices;
    }

    /// @notice The annual price a new registration of `label` would lock now:
    /// its premium price if set, otherwise its length tier. `NOT_FOR_SALE`
    /// means closed. Ignores availability and reservations.
    function priceOf(string calldata label) external view returns (uint256) {
        bytes memory labelBytes = bytes(label);
        if (!Labels.isValid(labelBytes)) revert InvalidLabel();
        return _annualPriceFor(keccak256(labelBytes), labelBytes.length);
    }

    function premiumPriceOf(string calldata label) external view returns (bool set, uint256 price) {
        bytes32 labelhash = keccak256(bytes(label));
        return (_premiumSet[labelhash], _premiumPrice[labelhash]);
    }

    function reservedFor(string calldata label) external view returns (address) {
        return _reservations[keccak256(bytes(label))];
    }

    function tokenIdFor(bytes32 labelhash, uint64 generation) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(labelhash, generation)));
    }

    function available(string calldata label) external view returns (bool) {
        bytes memory labelBytes = bytes(label);
        if (!Labels.isValid(labelBytes)) return false;
        bytes32 labelhash = keccak256(labelBytes);
        uint64 generation = _currentGeneration[labelhash];
        return generation == 0 || _status(tokenIdFor(labelhash, generation)) == Status.Released;
    }

    function currentToken(string calldata label)
        external
        view
        returns (uint256 tokenId, uint64 generation, Status status_)
    {
        bytes32 labelhash = keccak256(bytes(label));
        generation = _currentGeneration[labelhash];
        if (generation == 0) return (0, 0, Status.Unknown);
        tokenId = tokenIdFor(labelhash, generation);
        status_ = _status(tokenId);
    }

    function status(uint256 tokenId) external view returns (Status) {
        return _status(tokenId);
    }

    function expiresAt(uint256 tokenId) external view returns (uint64) {
        return _tokens[tokenId].expiry;
    }

    function lockedPrice(uint256 tokenId) external view returns (uint256) {
        return _tokens[tokenId].lockedPrice;
    }

    function generationOf(uint256 tokenId) external view returns (uint64) {
        return _tokens[tokenId].generation;
    }

    function labelOf(uint256 tokenId) external view returns (string memory) {
        return _labels[tokenId];
    }

    /// @notice The holder while Active; the zero address otherwise.
    function effectiveOwner(uint256 tokenId) external view returns (address) {
        return _status(tokenId) == Status.Active ? _ownerOf(tokenId) : address(0);
    }

    /// @notice The holder while Active or in Grace; the zero address otherwise.
    function registrant(uint256 tokenId) external view returns (address) {
        Status status_ = _status(tokenId);
        return status_ == Status.Active || status_ == Status.Grace ? _ownerOf(tokenId) : address(0);
    }

    function recordManager(uint256 tokenId) external view returns (address) {
        return _recordManagers[tokenId];
    }

    /// @notice Raw stored bytes, whatever the status. Resolvers apply status.
    function record(uint256 tokenId, bytes32 key) external view returns (bytes memory) {
        return _records[tokenId][key];
    }

    /// @notice Reverts unless Active, so an expired token is never mistaken
    /// for current authority. Internal OpenZeppelin paths use `_ownerOf`.
    function ownerOf(uint256 tokenId) public view override returns (address) {
        if (_status(tokenId) != Status.Active) revert NotActive(tokenId);
        return super.ownerOf(tokenId);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _status(uint256 tokenId) internal view returns (Status) {
        TokenState storage token = _tokens[tokenId];
        if (token.generation == 0) return Status.Unknown;
        if (_currentGeneration[token.labelhash] != token.generation) return Status.Superseded;
        if (block.timestamp < token.expiry) return Status.Active;
        if (block.timestamp < uint256(token.expiry) + GRACE) return Status.Grace;
        return Status.Released;
    }

    function _annualPriceFor(bytes32 labelhash, uint256 length) internal view returns (uint256) {
        if (_premiumSet[labelhash]) return _premiumPrice[labelhash];
        uint256 tiers = _lengthPrices.length;
        return _lengthPrices[length < tiers ? length - 1 : tiers - 1];
    }

    function _setLengthPrices(uint256[] memory prices) internal {
        uint256 tiers = prices.length;
        if (tiers == 0 || tiers > MAX_LENGTH_TIERS) revert InvalidPrices();
        for (uint256 i = 1; i < tiers; ++i) {
            if (prices[i] > prices[i - 1]) revert InvalidPrices();
        }
        _lengthPrices = prices;
        emit LengthPricesChanged(prices);
    }

    function _single(uint256 price) private pure returns (uint256[] memory prices) {
        prices = new uint256[](1);
        prices[0] = price;
    }

    function _validLabelhash(string calldata label) private pure returns (bytes32) {
        bytes memory labelBytes = bytes(label);
        if (!Labels.isValid(labelBytes)) revert InvalidLabel();
        return keccak256(labelBytes);
    }

    function _setTreasury(address treasury_) internal {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    /// @dev The only burn: retiring a Released token when its label is
    /// registered again.
    function _retire(uint256 tokenId) internal {
        _burn(tokenId);
    }

    /// @dev Every OpenZeppelin v5 transfer, mint and burn passes through here.
    /// Transfers require Active status. Any ownership change clears the record
    /// manager, so it cannot revive if the token returns to an earlier holder.
    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _status(tokenId) != Status.Active) {
            revert NotActive(tokenId);
        }
        if (from != address(0) && _recordManagers[tokenId] != address(0)) {
            delete _recordManagers[tokenId];
            emit RecordManagerSet(tokenId, address(0));
        }
        return super._update(to, tokenId, auth);
    }
}
