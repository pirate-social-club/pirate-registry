// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SharedNameKeys} from "./SharedNameKeys.sol";
import {ISharedNameRegistryV3} from "./interfaces/ISharedNameRegistryV3.sol";

/// @notice Immutable shared testnet registry. See docs/SHARED-NAMES-V3.md.
/// Lifecycle and record-manager rules derive from this repository's protocol-2
/// SLDRegistry; its deployed source and terms remain unchanged.
contract SharedNameRegistryV3 is ERC721, EIP712, ReentrancyGuardTransient, ISharedNameRegistryV3 {
    using SafeERC20 for IERC20;

    uint16 public constant override PROTOCOL_VERSION = 3;
    uint256 public constant YEAR = 365 days;
    uint256 public constant GRACE = 30 days;
    uint256 public constant MAX_RENEWAL_YEARS = 5;
    uint256 public constant MAX_REMAINING = 3650 days;
    uint256 public constant MAX_RECORD_BYTES = 1024;
    uint256 public constant MAX_AUTHORITY_LIFETIME = 1 days;
    uint256 public constant MAX_GRANT_LIFETIME = 15 minutes;
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "FreeClaim(bytes32 requestId,bytes32 communityId,bytes32 namespaceId,string label,address recipient,uint64 generation,uint64 authorityRevision,uint64 policyRevision,uint64 scopeRevision,uint64 issuedAt,uint64 deadline,uint8 years_,uint256 maxCost)"
    );
    bytes32 public constant ACCEPTANCE_TYPEHASH = keccak256(
        "ClaimAcceptance(FreeClaim claim)FreeClaim(bytes32 requestId,bytes32 communityId,bytes32 namespaceId,string label,address recipient,uint64 generation,uint64 authorityRevision,uint64 policyRevision,uint64 scopeRevision,uint64 issuedAt,uint64 deadline,uint8 years_,uint256 maxCost)"
    );

    struct TokenState {
        bytes32 namespaceId;
        bytes32 nameKey;
        uint64 generation;
        uint64 expiry;
        uint256 annualRenewalPrice;
    }

    struct NamePolicy {
        uint256 initialPrice;
        address reservedFor;
    }

    address public admin;
    address public pendingAdmin;
    address public treasury;
    address public immutable override paymentToken;
    mapping(bytes32 => Authority) private _authorities;
    mapping(bytes32 => Policy) private _policies;
    mapping(bytes32 => mapping(bytes32 => Scope)) private _scopes;
    mapping(bytes32 => NamePolicy) private _namePolicies;
    mapping(bytes32 => uint64) private _generations;
    mapping(uint256 => TokenState) private _tokens;
    mapping(uint256 => string) private _labels;
    mapping(uint256 => address) private _managers;
    mapping(uint256 => mapping(bytes32 => bytes)) private _records;
    mapping(bytes32 => mapping(bytes32 => ClaimReceipt)) private _receipts;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(address admin_, address paymentToken_, address treasury_)
        ERC721("Pirate Shared Names", "PSN")
        EIP712("PirateSharedNames", "3")
    {
        if (block.chainid != 6343 && block.chainid != 31337) {
            revert UnsupportedChain();
        }
        if (admin_ == address(0) || paymentToken_.code.length == 0) revert InvalidConfiguration();
        admin = admin_;
        paymentToken = paymentToken_;
        _setTreasury(treasury_);
        emit AdminTransferred(address(0), admin_);
    }

    function namespaceIdFor(string memory tld) public pure returns (bytes32) {
        return SharedNameKeys.namespaceIdFor(tld);
    }

    function nameKeyFor(bytes32 namespaceId, string memory label) public pure returns (bytes32) {
        return SharedNameKeys.nameKeyFor(namespaceId, label);
    }

    function tokenIdFor(bytes32 nameKey, uint64 generation) public pure returns (uint256) {
        return SharedNameKeys.tokenIdFor(nameKey, generation);
    }

    function registerNamespace(string calldata tld, bool migrationRequired)
        external
        onlyAdmin
        returns (bytes32 namespaceId)
    {
        namespaceId = namespaceIdFor(tld);
        if (bytes(_authorities[namespaceId].tld).length != 0) revert InvalidConfiguration();
        _authorities[namespaceId].tld = tld;
        _authorities[namespaceId].migrationRequired = migrationRequired;
        emit NamespaceRegistered(namespaceId, tld, migrationRequired);
    }

    function attestNamespace(
        bytes32 namespaceId,
        bytes32 evidenceHash,
        uint64 observedAt,
        uint64 validUntil,
        bool issuanceEnabled
    ) external onlyAdmin {
        Authority storage a = _authority(namespaceId);
        if (
            evidenceHash == bytes32(0) || observedAt < a.observedAt || observedAt > block.timestamp
                || validUntil <= block.timestamp || validUntil <= observedAt
                || uint256(validUntil) - observedAt > MAX_AUTHORITY_LIFETIME
        ) {
            revert InvalidConfiguration();
        }
        if (issuanceEnabled && a.migrationRequired) revert MigrationRequired();
        a.evidenceHash = evidenceHash;
        a.observedAt = observedAt;
        a.validUntil = validUntil;
        a.issuanceEnabled = issuanceEnabled;
        a.revision++;
        _emitAuthority(namespaceId, a);
    }

    function setNamespaceIssuance(bytes32 namespaceId, bool enabled) external onlyAdmin {
        Authority storage a = _authority(namespaceId);
        if (enabled && a.migrationRequired) revert MigrationRequired();
        if (enabled && (a.evidenceHash == bytes32(0) || block.timestamp >= a.validUntil)) {
            revert AuthorityUnavailable();
        }
        a.issuanceEnabled = enabled;
        a.revision++;
        _emitAuthority(namespaceId, a);
    }

    function configurePolicy(
        bytes32 namespaceId,
        address grantSigner,
        uint256 annualRenewalPrice,
        uint64 totalClaimLimit
    ) external onlyAdmin {
        _authority(namespaceId);
        Policy storage p = _policies[namespaceId];
        if (
            grantSigner == address(0) || totalClaimLimit == 0 || totalClaimLimit < p.totalClaims
                || annualRenewalPrice > type(uint128).max
        ) revert InvalidConfiguration();
        p.grantSigner = grantSigner;
        p.annualRenewalPrice = annualRenewalPrice;
        p.totalClaimLimit = totalClaimLimit;
        p.configured = true;
        p.revision++;
        emit PolicyConfigured(namespaceId, grantSigner, annualRenewalPrice, totalClaimLimit, p.revision);
    }

    function configureScope(
        bytes32 namespaceId,
        bytes32 communityId,
        address submitter,
        uint64 totalClaimLimit,
        bool enabled
    ) external onlyAdmin {
        _authority(namespaceId);
        Scope storage s = _scopes[namespaceId][communityId];
        if (
            communityId == bytes32(0) || totalClaimLimit < s.totalClaims
                || (enabled
                    && (submitter == address(0)
                        || totalClaimLimit == 0
                        || submitter == _policies[namespaceId].grantSigner))
        ) revert InvalidConfiguration();
        s.submitter = submitter;
        s.totalClaimLimit = totalClaimLimit;
        s.enabled = enabled;
        s.revision++;
        emit ScopeConfigured(namespaceId, communityId, submitter, totalClaimLimit, s.revision, enabled);
    }

    function setNamePolicy(bytes32 namespaceId, string calldata label, uint256 initialPrice, address reservedFor)
        external
        onlyAdmin
    {
        _authority(namespaceId);
        bytes32 key = nameKeyFor(namespaceId, label);
        _namePolicies[key] = NamePolicy(initialPrice, reservedFor);
        uint64 revision = ++_policies[namespaceId].revision;
        emit NamePolicySet(namespaceId, key, label, initialPrice, reservedFor, revision);
    }

    function authority(bytes32 namespaceId) external view returns (Authority memory) {
        return _authority(namespaceId);
    }

    function policy(bytes32 namespaceId) external view returns (Policy memory) {
        _authority(namespaceId);
        return _policies[namespaceId];
    }

    function scope(bytes32 namespaceId, bytes32 communityId) external view returns (Scope memory) {
        _authority(namespaceId);
        return _scopes[namespaceId][communityId];
    }

    function quote(bytes32 namespaceId, bytes32 communityId, string calldata label)
        external
        view
        returns (NameQuote memory q)
    {
        Authority storage a = _authority(namespaceId);
        Policy storage p = _policies[namespaceId];
        Scope storage s = _scopes[namespaceId][communityId];
        bytes32 key = nameKeyFor(namespaceId, label);
        uint64 previous = _generations[key];
        q.status = previous == 0 ? Status.Unknown : _status(tokenIdFor(key, previous));
        q.generation = previous == type(uint64).max ? previous : previous + 1;
        q.authorityRevision = a.revision;
        q.policyRevision = p.revision;
        q.scopeRevision = s.revision;
        q.reservedFor = _namePolicies[key].reservedFor;
        q.initialPrice = _namePolicies[key].initialPrice;
        q.renewalToken = paymentToken;
        q.annualRenewalPrice = p.annualRenewalPrice;
        q.namespaceClaimsRemaining = p.totalClaimLimit - p.totalClaims;
        q.scopeClaimsRemaining = s.totalClaimLimit - s.totalClaims;
        q.issuanceEnabled = a.issuanceEnabled && !a.migrationRequired && block.timestamp < a.validUntil && p.configured
            && s.enabled && s.submitter != p.grantSigner && bytes(label).length >= 8 && q.initialPrice == 0
            && q.namespaceClaimsRemaining != 0 && q.scopeClaimsRemaining != 0 && previous != type(uint64).max
            && (q.status == Status.Unknown || q.status == Status.Released);
    }

    function requestHash(FreeClaim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(_claimStructHash(c));
    }

    function _claimStructHash(FreeClaim calldata c) private pure returns (bytes32) {
        // All concatenated words are static ABI words. This is exactly the
        // EIP-712 encoding and avoids an oversized compiler operand stack.
        bytes memory identity = abi.encode(
            CLAIM_TYPEHASH, c.requestId, c.communityId, c.namespaceId, keccak256(bytes(c.label)), c.recipient
        );
        bytes memory terms = abi.encode(
            c.generation,
            c.authorityRevision,
            c.policyRevision,
            c.scopeRevision,
            c.issuedAt,
            c.deadline,
            c.years_,
            c.maxCost
        );
        return keccak256(bytes.concat(identity, terms));
    }

    function recipientAcceptanceHash(FreeClaim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ACCEPTANCE_TYPEHASH, _claimStructHash(c))));
    }

    function claimFreeName(FreeClaim calldata c, bytes calldata grantSignature, bytes calldata recipientSignature)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        bytes32 digest = requestHash(c);
        ClaimReceipt storage oldReceipt = _receipts[c.communityId][c.requestId];
        if (oldReceipt.requestHash != bytes32(0)) {
            if (oldReceipt.requestHash != digest) revert RequestConflict();
            revert RequestAlreadyUsed(digest, oldReceipt.tokenId);
        }
        _validateClaim(c, digest, grantSignature, recipientSignature);
        bytes32 key = nameKeyFor(c.namespaceId, c.label);
        uint64 previous = _generations[key];
        if (previous == type(uint64).max || c.generation != previous + 1) revert RevisionMismatch();
        if (previous != 0 && _status(tokenIdFor(key, previous)) != Status.Released) revert Unavailable();
        NamePolicy storage np = _namePolicies[key];
        if (np.initialPrice != 0) revert NotFree();
        if (np.reservedFor != address(0) && np.reservedFor != c.recipient) revert Reserved(np.reservedFor);

        Policy storage p = _policies[c.namespaceId];
        Scope storage s = _scopes[c.namespaceId][c.communityId];
        if (p.totalClaims >= p.totalClaimLimit || s.totalClaims >= s.totalClaimLimit) revert IssuanceLimit();
        p.totalClaims++;
        s.totalClaims++;
        tokenId = tokenIdFor(key, c.generation);
        _generations[key] = c.generation;
        _tokens[tokenId] =
            TokenState(c.namespaceId, key, c.generation, uint64(block.timestamp + YEAR), p.annualRenewalPrice);
        _labels[tokenId] = c.label;
        _receipts[c.communityId][c.requestId] = ClaimReceipt(digest, tokenId, uint64(block.number));
        if (previous != 0) _burn(tokenIdFor(key, previous));
        _emitClaim(c, digest, key, tokenId);
        _safeMint(c.recipient, tokenId);
    }

    function _validateClaim(
        FreeClaim calldata c,
        bytes32 digest,
        bytes calldata grantSignature,
        bytes calldata recipientSignature
    ) private view {
        Authority storage a = _authority(c.namespaceId);
        Policy storage p = _policies[c.namespaceId];
        Scope storage s = _scopes[c.namespaceId][c.communityId];
        if (a.migrationRequired) revert MigrationRequired();
        if (!a.issuanceEnabled || block.timestamp >= a.validUntil) revert AuthorityUnavailable();
        if (!p.configured || !s.enabled || msg.sender != s.submitter || msg.sender == p.grantSigner) {
            revert Unauthorized();
        }
        if (c.authorityRevision != a.revision || c.policyRevision != p.revision || c.scopeRevision != s.revision) {
            revert RevisionMismatch();
        }
        if (
            c.requestId == bytes32(0) || c.communityId == bytes32(0) || c.recipient == address(0) || c.years_ != 1
                || c.maxCost != 0 || bytes(c.label).length < 8
        ) revert InvalidClaim();
        if (
            c.issuedAt > block.timestamp || c.deadline < block.timestamp || c.deadline < c.issuedAt
                || uint256(c.deadline) - c.issuedAt > MAX_GRANT_LIFETIME
        ) revert GrantExpired();
        // Validate canonical label before external signature callbacks.
        nameKeyFor(c.namespaceId, c.label);
        if (
            !SignatureChecker.isValidSignatureNow(p.grantSigner, digest, grantSignature)
                || !SignatureChecker.isValidSignatureNow(c.recipient, recipientAcceptanceHash(c), recipientSignature)
        ) {
            revert InvalidSignature();
        }
    }

    function claimReceipt(bytes32 communityId, bytes32 requestId) external view returns (ClaimReceipt memory) {
        return _receipts[communityId][requestId];
    }

    function renew(uint256 tokenId, uint8 years_, uint256 maxCost, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (years_ == 0 || years_ > MAX_RENEWAL_YEARS) revert InvalidYears();
        Status state = _status(tokenId);
        if (state != Status.Active && state != Status.Grace) revert NotRenewable(state);
        TokenState storage t = _tokens[tokenId];
        uint256 expiry = uint256(t.expiry) + uint256(years_) * YEAR;
        if (expiry > block.timestamp + MAX_REMAINING) revert TermTooLong();
        uint256 cost = t.annualRenewalPrice * years_;
        if (cost > maxCost) revert CostAboveMax(cost, maxCost);
        t.expiry = uint64(expiry);
        emit Renewed(tokenId, uint64(expiry), msg.sender, cost);
        if (cost != 0) IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), cost);
    }

    function setRecord(uint256 tokenId, bytes32 key, bytes calldata value) external {
        if (_status(tokenId) != Status.Active) revert NotActive(tokenId);
        if (msg.sender != _ownerOf(tokenId) && msg.sender != _managers[tokenId]) revert Unauthorized();
        if (value.length > MAX_RECORD_BYTES) revert RecordTooLarge();
        _records[tokenId][key] = value;
        emit RecordSet(tokenId, key, value);
    }

    function setRecordManager(uint256 tokenId, address manager) external {
        if (_status(tokenId) != Status.Active) revert NotActive(tokenId);
        if (msg.sender != _ownerOf(tokenId)) revert Unauthorized();
        _managers[tokenId] = manager;
        emit RecordManagerSet(tokenId, manager);
    }

    function currentToken(bytes32 namespaceId, string calldata label)
        external
        view
        returns (uint256 tokenId, uint64 generation, Status status_)
    {
        bytes32 key = nameKeyFor(namespaceId, label);
        generation = _generations[key];
        if (generation == 0) return (0, 0, Status.Unknown);
        tokenId = tokenIdFor(key, generation);
        status_ = _status(tokenId);
    }

    function status(uint256 tokenId) external view returns (Status) {
        return _status(tokenId);
    }

    function namespaceOf(uint256 tokenId) external view returns (bytes32) {
        return _tokens[tokenId].namespaceId;
    }

    function nameKeyOf(uint256 tokenId) external view returns (bytes32) {
        return _tokens[tokenId].nameKey;
    }

    function generationOf(uint256 tokenId) external view returns (uint64) {
        return _tokens[tokenId].generation;
    }

    function labelOf(uint256 tokenId) external view returns (string memory) {
        return _labels[tokenId];
    }

    function expiresAt(uint256 tokenId) external view returns (uint64) {
        return _tokens[tokenId].expiry;
    }

    function lockedRenewalPrice(uint256 tokenId) external view returns (uint256) {
        return _tokens[tokenId].annualRenewalPrice;
    }

    function record(uint256 tokenId, bytes32 key) external view returns (bytes memory) {
        return _records[tokenId][key];
    }

    function recordManager(uint256 tokenId) external view returns (address) {
        return _managers[tokenId];
    }

    function effectiveOwner(uint256 tokenId) external view returns (address) {
        return _status(tokenId) == Status.Active ? _ownerOf(tokenId) : address(0);
    }

    function registrant(uint256 tokenId) external view returns (address) {
        Status s = _status(tokenId);
        return s == Status.Active || s == Status.Grace ? _ownerOf(tokenId) : address(0);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidConfiguration();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert Unauthorized();
        address old = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(old, msg.sender);
    }

    function setTreasury(address treasury_) external onlyAdmin {
        _setTreasury(treasury_);
    }

    function sweep() external nonReentrant {
        uint256 amount = IERC20(paymentToken).balanceOf(address(this));
        address destination = treasury;
        emit Swept(destination, amount);
        if (amount != 0) IERC20(paymentToken).safeTransfer(destination, amount);
    }

    function _setTreasury(address destination) private {
        if (destination == address(0) || destination == address(this)) revert InvalidConfiguration();
        treasury = destination;
        emit TreasuryChanged(destination);
    }

    function _authority(bytes32 namespaceId) private view returns (Authority storage a) {
        a = _authorities[namespaceId];
        if (bytes(a.tld).length == 0) revert NamespaceUnknown();
    }

    function _status(uint256 tokenId) private view returns (Status) {
        TokenState storage t = _tokens[tokenId];
        if (t.generation == 0) return Status.Unknown;
        if (_generations[t.nameKey] != t.generation) return Status.Superseded;
        if (block.timestamp < t.expiry) return Status.Active;
        if (block.timestamp < uint256(t.expiry) + GRACE) return Status.Grace;
        return Status.Released;
    }

    function _emitAuthority(bytes32 namespaceId, Authority storage a) private {
        emit AuthorityAttested(namespaceId, a.evidenceHash, a.observedAt, a.validUntil, a.revision, a.issuanceEnabled);
    }

    function _emitClaim(FreeClaim calldata c, bytes32 digest, bytes32 key, uint256 tokenId) private {
        TokenState storage t = _tokens[tokenId];
        emit FreeNameClaimed(
            c.namespaceId,
            c.communityId,
            c.requestId,
            digest,
            key,
            c.label,
            tokenId,
            c.generation,
            c.recipient,
            t.expiry,
            t.annualRenewalPrice
        );
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _status(tokenId) != Status.Active) revert NotActive(tokenId);
        if (from != address(0) && _managers[tokenId] != address(0)) {
            delete _managers[tokenId];
            emit RecordManagerSet(tokenId, address(0));
        }
        return super._update(to, tokenId, auth);
    }
}
