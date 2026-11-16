// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Labels} from "./Labels.sol";

/// @notice Protocol-3 logical identities. These do not prove namespace admission.
library SharedNameKeys {
    bytes32 internal constant NAMESPACE_DOMAIN = keccak256("pirate.namespace/1");
    bytes32 internal constant NAME_DOMAIN = keccak256("pirate.name/1");
    bytes32 internal constant TOKEN_DOMAIN = keccak256("pirate.name-token/1");

    error NonCanonicalLabel();
    error InvalidIdentity();

    function namespaceIdFor(string memory tld) internal pure returns (bytes32) {
        if (!Labels.isValid(bytes(tld))) revert NonCanonicalLabel();
        return keccak256(abi.encode(NAMESPACE_DOMAIN, keccak256(bytes(tld))));
    }

    function nameKeyFor(bytes32 namespaceId, string memory label) internal pure returns (bytes32) {
        if (namespaceId == bytes32(0)) revert InvalidIdentity();
        if (!Labels.isValid(bytes(label))) revert NonCanonicalLabel();
        return keccak256(abi.encode(NAME_DOMAIN, namespaceId, keccak256(bytes(label))));
    }

    function tokenIdFor(bytes32 nameKey, uint64 generation) internal pure returns (uint256) {
        if (nameKey == bytes32(0) || generation == 0) revert InvalidIdentity();
        return uint256(keccak256(abi.encode(TOKEN_DOMAIN, nameKey, generation)));
    }
}
