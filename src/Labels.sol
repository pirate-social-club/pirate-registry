// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Label rules from SPEC section 6.3: 1 to 63 bytes of a-z, 0-9 and
/// hyphen, no leading or trailing hyphen, and no hyphen at both the third and
/// fourth positions (which also excludes `xn--`).
library Labels {
    function isValid(bytes memory label) internal pure returns (bool) {
        uint256 length = label.length;
        if (length == 0 || length > 63) return false;
        if (label[0] == "-" || label[length - 1] == "-") return false;
        if (length >= 4 && label[2] == "-" && label[3] == "-") return false;
        for (uint256 i; i < length; ++i) {
            bytes1 c = label[i];
            bool allowed = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!allowed) return false;
        }
        return true;
    }
}
