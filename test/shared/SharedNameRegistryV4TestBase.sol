// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {SharedNameRegistryV4} from "../../src/SharedNameRegistryV4.sol";
import {ISharedNameRegistryV4 as IShared} from "../../src/interfaces/ISharedNameRegistryV4.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

abstract contract SharedNameRegistryV4TestBase is Test {
    // Disposable local fixtures only. These are not selected live fees or keys.
    uint256 internal constant GRANT_KEY = 0x12345;
    uint256 internal constant HOLDER_KEY = 0x23456;
    uint256 internal constant RENEWAL_PRICE = 5e6;
    bytes32 internal constant COMMUNITY = keccak256("fixture-community-instance");
    address internal admin = makeAddr("platform-admin");
    address internal treasury = makeAddr("platform-treasury");
    address internal submitter = makeAddr("claim-submitter");
    address internal stranger = makeAddr("stranger");
    address internal holder;
    address internal grantSigner;
    MockUSDC internal token;
    SharedNameRegistryV4 internal registry;
    bytes32 internal ns;
    uint256 internal requests;

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(1_800_000_000);
        vm.roll(100);
        holder = vm.addr(HOLDER_KEY);
        grantSigner = vm.addr(GRANT_KEY);
        token = new MockUSDC();
        registry = new SharedNameRegistryV4(admin, address(token), treasury);
        ns = _namespace("testtld", false);
        token.mint(holder, 1000e6);
        vm.prank(holder);
        token.approve(address(registry), type(uint256).max);
    }

    function _namespace(string memory tld, bool migration) internal returns (bytes32 id) {
        vm.startPrank(admin);
        id = registry.registerNamespace(tld, migration);
        registry.attestNamespace(
            id, keccak256("fixture-hns-proof"), uint64(block.timestamp), uint64(block.timestamp + 1 days), !migration
        );
        registry.configurePolicy(id, grantSigner, RENEWAL_PRICE, 100);
        if (!migration) {
            registry.authorizeScope(
                _authorization(id, COMMUNITY), submitter, 50, uint64(block.timestamp),
                uint64(block.timestamp + 1800), 0
            );
        }
        vm.stopPrank();
    }

    function _authorization(bytes32 id, bytes32 community) internal view returns (IShared.ScopeAuthorization memory) {
        return IShared.ScopeAuthorization({
            namespaceId: id,
            communityId: community,
            installationId: keccak256(abi.encode("fixture-installation", community)),
            controller: holder,
            namespaceEvidenceHash: keccak256("fixture-hns-proof"),
            evidenceHash: keccak256(abi.encode("fixture-community-authorization", id, community))
        });
    }

    function _authorize(IShared.ScopeAuthorization memory a, uint64 limit, uint64 until) internal {
        uint64 revision = registry.scope(a.namespaceId, a.communityId).revision;
        vm.prank(admin);
        registry.authorizeScope(a, submitter, limit, uint64(block.timestamp), until, revision);
    }

    function _claim(bytes32 id, string memory label) internal returns (IShared.FreeClaim memory c) {
        IShared.NameQuote memory q = registry.quote(id, COMMUNITY, label);
        c = IShared.FreeClaim({
            requestId: bytes32(++requests),
            communityId: COMMUNITY,
            namespaceId: id,
            label: label,
            recipient: holder,
            generation: q.generation,
            authorityRevision: q.authorityRevision,
            policyRevision: q.policyRevision,
            scopeRevision: q.scopeRevision,
            scopeAuthorizationHash: q.scopeAuthorizationHash,
            issuedAt: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 600),
            years_: 1,
            maxCost: 0
        });
    }

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signatures(IShared.FreeClaim memory c) internal view returns (bytes memory grant, bytes memory consent) {
        bytes32 digest = registry.requestHash(c);
        grant = _signature(GRANT_KEY, digest);
        consent = _signature(HOLDER_KEY, registry.recipientAcceptanceHash(c));
    }

    function _submit(IShared.FreeClaim memory c) internal returns (uint256) {
        (bytes memory grant, bytes memory consent) = _signatures(c);
        vm.prank(submitter);
        return registry.claimFreeName(c, grant, consent);
    }

    function _expectSubmit(bytes4 reason, IShared.FreeClaim memory c) internal {
        _expectSubmit(abi.encodePacked(reason), c);
    }

    function _expectSubmit(bytes memory reason, IShared.FreeClaim memory c) internal {
        (bytes memory grant, bytes memory consent) = _signatures(c);
        vm.expectRevert(reason);
        vm.prank(submitter);
        registry.claimFreeName(c, grant, consent);
    }

    function _expectAuthorize(
        bytes4 reason, IShared.ScopeAuthorization memory a, uint64 limit, uint64 until
    ) internal {
        uint64 revision = registry.scope(a.namespaceId, a.communityId).revision;
        vm.expectRevert(reason);
        vm.prank(admin);
        registry.authorizeScope(a, submitter, limit, uint64(block.timestamp), until, revision);
    }

    function _issue(string memory label) internal returns (uint256) {
        return _submit(_claim(ns, label));
    }
}
