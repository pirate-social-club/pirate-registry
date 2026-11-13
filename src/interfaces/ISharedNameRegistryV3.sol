// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Normative core interface; generated implementation ABI also includes ERC-721.
interface ISharedNameRegistryV3 {
    enum Status {
        Unknown,
        Active,
        Grace,
        Released,
        Superseded
    }

    struct Authority {
        string tld;
        bytes32 evidenceHash;
        uint64 observedAt;
        uint64 validUntil;
        uint64 revision;
        bool migrationRequired;
        bool issuanceEnabled;
    }

    struct Policy {
        address grantSigner;
        uint256 annualRenewalPrice;
        uint64 totalClaimLimit;
        uint64 totalClaims;
        uint64 revision;
        bool configured;
    }

    struct Scope {
        address submitter;
        uint64 totalClaimLimit;
        uint64 totalClaims;
        uint64 revision;
        bool enabled;
    }

    struct FreeClaim {
        bytes32 requestId;
        bytes32 communityId;
        bytes32 namespaceId;
        string label;
        address recipient;
        uint64 generation;
        uint64 authorityRevision;
        uint64 policyRevision;
        uint64 scopeRevision;
        uint64 issuedAt;
        uint64 deadline;
        uint8 years_;
        uint256 maxCost;
    }

    struct NameQuote {
        uint64 authorityRevision;
        uint64 policyRevision;
        uint64 scopeRevision;
        uint64 generation;
        Status status;
        address reservedFor;
        uint256 initialPrice;
        address renewalToken;
        uint256 annualRenewalPrice;
        uint64 namespaceClaimsRemaining;
        uint64 scopeClaimsRemaining;
        bool issuanceEnabled;
    }

    struct ClaimReceipt {
        bytes32 requestHash;
        uint256 tokenId;
        uint64 blockNumber;
    }

    event NamespaceRegistered(bytes32 indexed namespaceId, string tld, bool migrationRequired);
    event AuthorityAttested(
        bytes32 indexed namespaceId,
        bytes32 evidenceHash,
        uint64 observedAt,
        uint64 validUntil,
        uint64 revision,
        bool issuanceEnabled
    );
    event PolicyConfigured(
        bytes32 indexed namespaceId,
        address grantSigner,
        uint256 annualRenewalPrice,
        uint64 totalClaimLimit,
        uint64 revision
    );
    event ScopeConfigured(
        bytes32 indexed namespaceId,
        bytes32 indexed communityId,
        address submitter,
        uint64 totalClaimLimit,
        uint64 revision,
        bool enabled
    );
    event NamePolicySet(
        bytes32 indexed namespaceId,
        bytes32 indexed nameKey,
        string label,
        uint256 initialPrice,
        address reservedFor,
        uint64 policyRevision
    );
    event FreeNameClaimed(
        bytes32 indexed namespaceId,
        bytes32 indexed communityId,
        bytes32 indexed requestId,
        bytes32 requestHash,
        bytes32 nameKey,
        string label,
        uint256 tokenId,
        uint64 generation,
        address recipient,
        uint64 expiry,
        uint256 annualRenewalPrice
    );
    event Renewed(uint256 indexed tokenId, uint64 expiry, address indexed payer, uint256 cost);
    event RecordSet(uint256 indexed tokenId, bytes32 indexed key, bytes value);
    event RecordManagerSet(uint256 indexed tokenId, address indexed manager);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event TreasuryChanged(address indexed treasury);
    event Swept(address indexed treasury, uint256 amount);

    error Unauthorized();
    error InvalidConfiguration();
    error UnsupportedChain();
    error NamespaceUnknown();
    error AuthorityUnavailable();
    error MigrationRequired();
    error RevisionMismatch();
    error InvalidClaim();
    error GrantExpired();
    error InvalidSignature();
    error IssuanceLimit();
    error Unavailable();
    error NotFree();
    error Reserved(address recipient);
    error RequestAlreadyUsed(bytes32 requestHash, uint256 tokenId);
    error RequestConflict();
    error NotActive(uint256 tokenId);
    error NotRenewable(Status status);
    error InvalidYears();
    error TermTooLong();
    error DeadlinePassed();
    error CostAboveMax(uint256 cost, uint256 maxCost);
    error RecordTooLarge();

    function PROTOCOL_VERSION() external view returns (uint16);
    function namespaceIdFor(string memory tld) external pure returns (bytes32);
    function nameKeyFor(bytes32 namespaceId, string memory label) external pure returns (bytes32);
    function tokenIdFor(bytes32 nameKey, uint64 generation) external pure returns (uint256);
    function registerNamespace(string calldata tld, bool migrationRequired) external returns (bytes32);
    function attestNamespace(
        bytes32 namespaceId,
        bytes32 evidenceHash,
        uint64 observedAt,
        uint64 validUntil,
        bool issuanceEnabled
    ) external;
    function setNamespaceIssuance(bytes32 namespaceId, bool enabled) external;
    function configurePolicy(
        bytes32 namespaceId,
        address grantSigner,
        uint256 annualRenewalPrice,
        uint64 totalClaimLimit
    ) external;
    function configureScope(
        bytes32 namespaceId,
        bytes32 communityId,
        address submitter,
        uint64 totalClaimLimit,
        bool enabled
    ) external;
    function setNamePolicy(bytes32 namespaceId, string calldata label, uint256 initialPrice, address reservedFor)
        external;
    function authority(bytes32 namespaceId) external view returns (Authority memory);
    function policy(bytes32 namespaceId) external view returns (Policy memory);
    function scope(bytes32 namespaceId, bytes32 communityId) external view returns (Scope memory);
    function quote(bytes32 namespaceId, bytes32 communityId, string calldata label)
        external
        view
        returns (NameQuote memory);
    function requestHash(FreeClaim calldata claim) external view returns (bytes32);
    function recipientAcceptanceHash(FreeClaim calldata claim) external view returns (bytes32);
    function claimFreeName(FreeClaim calldata claim, bytes calldata grantSignature, bytes calldata recipientSignature)
        external
        returns (uint256);
    function claimReceipt(bytes32 communityId, bytes32 requestId) external view returns (ClaimReceipt memory);
    function currentToken(bytes32 namespaceId, string calldata label)
        external
        view
        returns (uint256 tokenId, uint64 generation, Status status_);
    function status(uint256 tokenId) external view returns (Status);
    function namespaceOf(uint256 tokenId) external view returns (bytes32);
    function nameKeyOf(uint256 tokenId) external view returns (bytes32);
    function generationOf(uint256 tokenId) external view returns (uint64);
    function labelOf(uint256 tokenId) external view returns (string memory);
    function effectiveOwner(uint256 tokenId) external view returns (address);
    function registrant(uint256 tokenId) external view returns (address);
    function expiresAt(uint256 tokenId) external view returns (uint64);
    function lockedRenewalPrice(uint256 tokenId) external view returns (uint256);
    function paymentToken() external view returns (address);
    function renew(uint256 tokenId, uint8 years_, uint256 maxCost, uint256 deadline) external;
    function setRecord(uint256 tokenId, bytes32 key, bytes calldata value) external;
    function setRecordManager(uint256 tokenId, address manager) external;
    function record(uint256 tokenId, bytes32 key) external view returns (bytes memory);
    function recordManager(uint256 tokenId) external view returns (address);
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;
    function setTreasury(address treasury_) external;
    function sweep() external;
}
