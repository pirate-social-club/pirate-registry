// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Record key derivation from SPEC section 6.9. Values are opaque to
/// the registry; resolvers validate and decode them.
library RecordKeys {
    /// @param relativeName lowercase name relative to the SLD, no trailing
    /// dot, "" for the apex.
    function dns(string memory relativeName, uint16 rrtype) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("dns"), relativeName, rrtype));
    }

    /// @param coinType ENSIP-9 or ENSIP-11 coin type.
    function addr(uint256 coinType) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("addr"), coinType));
    }

    function text(string memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("text"), key));
    }

    function contenthash() internal pure returns (bytes32) {
        return keccak256(abi.encode(string("contenthash")));
    }
}
